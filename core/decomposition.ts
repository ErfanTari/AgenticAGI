import { applyRepairPasses, extractFirstJsonObject } from './structured.js';
import { transparency } from './transparency.js';
import type { DecompositionResult, DecomposedUnit, LLMHandler, Message, RouteKind } from './types.js';
import type { ResolvedEntry } from './intake.js';
import { promptLoader } from './prompt-loader.js';
import { TOKEN_BUDGETS } from '../config/agent.config.js';
import { localDateString } from './utils/date.js';
import { stripThinkingTags } from './llm.js';

const ROUTES: RouteKind[] = ['conversational', 'agentic', 'query'];

// Session-scoped counter — tracks how many times the heuristic repair path fires.
// Exported for test isolation.
let _decompositionRepairCount = 0;
export function _resetDecompositionCounter(): void {
  _decompositionRepairCount = 0;
}

const DECOMPOSITION_RESPONSE_SCHEMA = {
  name: 'decomposition',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['units'],
    properties: {
      units: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['route', 'content'],
          properties: {
            route: { type: 'string', enum: ROUTES },
            content: { type: 'string' },
            taskType: { type: 'string', enum: ['coding', 'general'] },
          },
        },
      },
    },
  },
} as const;

const QUERY_PATTERNS = [
  /\b(show|find|recall|look up)\b/i,
  /\blist\s+(?:my|the|all|active|recent)\b/i,
  /\btell\s+me\s+about\b/i,
  /\bwhat\s+do\s+i\s+know\b/i,
  /\bwhat\s+happened\b/i,
  /\bwho\s+is\b/i,
  /\bwhen\s+is\b/i,
  /\bsimilar\s+projects?\b/i,
  /\bmy\s+(projects|todos|plans|notes|history|deadlines)\b/i,
  /\bwhat\s+(other|active)\s+projects?\b/i,
  /\bshow\s+me\b/i,
  /\bremember\s+(?:last\s+time|when|the\s+last|the\s+\w+\s+we)\b/i,
];

const AGENTIC_PATTERNS = [
  /\b(build|create|write|make|start|run|implement|fix|update|edit|generate)\b/i,
  /\bsearch\b.*\b(and|then)\b/i,
  /\bsave\b.*\b(file|folder|memory|workspace)\b/i,
  /\bset\s+up\b/i,
  /\bplan\b.*\bfor\b/i,
  /\bfirst\b[\s\S]*\bthen\b/i,
  /\bafter\s+that\b/i,
  /\btake\s+that\b/i,
  /\bextend\b/i,
  /\badd\b/i,
];

const GREETING_ONLY = /^\s*(hi|hello|hey|good\s+(morning|afternoon|evening)|howdy|greetings)\s*[!.?]*\s*$/i;

// Use the full stripThinkingTags from llm.ts which covers Gemma 4's
// <|channel>thought...  tags in addition to <think> and <thought>.
const stripThinking = (raw: string): string => stripThinkingTags(raw);

/**
 * Sanitize assistant responses before storing in conversation history.
 * CRITICAL: Gemma 4 documents that thinking content MUST NOT be stored in
 * conversation history — doing so causes KV cache eviction cascades.
 */
export function sanitizeForHistory(content: string): string {
  return stripThinkingTags(content);
}

function validateRoute(value: unknown): value is RouteKind {
  return typeof value === 'string' && ROUTES.includes(value as RouteKind);
}

function validateUnits(value: unknown): DecomposedUnit[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const units = (value as { units?: unknown }).units;
  if (!Array.isArray(units)) return [];

  // FIX 5: Normalize stringified units — Qwen sometimes emits {"units": ["{\"route\":...}"]}
  // Also filter bare primitives (numbers, booleans) which are garbage output.
  let stringifiedCount = 0;
  let filteredCount = 0;
  for (let i = 0; i < units.length; i++) {
    if (typeof units[i] === 'number' || typeof units[i] === 'boolean') {
      units[i] = null;
      filteredCount++;
    } else if (typeof units[i] === 'string') {
      try { units[i] = JSON.parse(units[i] as string); stringifiedCount++; } catch { units[i] = null; filteredCount++; }
    }
  }
  if (filteredCount > 0) {
    console.debug(`[decomposition] filtered ${filteredCount} bare primitive(s)`);
  }
  if (stringifiedCount > 0) {
    console.debug(`[decomposition] normalized ${stringifiedCount} stringified unit(s)`);
  }

  // Gemma 4 flat-key reconstruction:
  // Gemma 4 small sometimes emits {"units": ["route", "agentic", "content", "do the thing"]}
  // — key-value pairs flattened into adjacent string elements instead of objects.
  // Attempt to reconstruct objects before discarding.
  const allStrings = units.length >= 4 && units.every(u => typeof u === 'string' || u === null);
  if (allStrings) {
    const reconstructed: Array<{ route: string; content: string }> = [];
    for (let i = 0; i + 3 < units.length; i += 4) {
      const k1 = units[i] as string;
      const v1 = units[i + 1] as string;
      const k2 = units[i + 2] as string;
      const v2 = units[i + 3] as string;
      if (k1 === 'route' && k2 === 'content' && ROUTES.includes(v1 as RouteKind)) {
        reconstructed.push({ route: v1, content: v2 });
      }
    }
    if (reconstructed.length > 0) {
      console.debug(`[decomposition] Gemma 4 flat-key reconstruction: recovered ${reconstructed.length} unit(s)`);
      // Replace the flat array with the reconstructed objects so validation passes
      units.splice(0, units.length, ...reconstructed);
    }
  }

  const normalized: DecomposedUnit[] = [];
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (!unit || typeof unit !== 'object' || Array.isArray(unit)) continue;
    const route = (unit as { route?: unknown }).route;
    const content = (unit as { content?: unknown }).content;
    if (!validateRoute(route) || typeof content !== 'string') continue;
    const trimmed = content.trim();
    if (!trimmed) continue;
    normalized.push({
      id: `unit_${i + 1}`,
      route,
      content: trimmed,
      order: i,
    });
  }
  return normalized;
}

function inferFallbackRoute(message: string): RouteKind {
  if (GREETING_ONLY.test(message)) return 'conversational';
  if (AGENTIC_PATTERNS.some(pattern => pattern.test(message))) return 'agentic';
  if (QUERY_PATTERNS.some(pattern => pattern.test(message))) return 'query';
  return 'conversational';
}

function normalizeWhitespace(message: string): string {
  return message.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

function splitClauseTransitions(message: string): string[] {
  const normalized = normalizeWhitespace(message)
    .replace(
      /\s+(?=and\s+(?:show\s+me|tell\s+me|list|find|look\s+up)\b(?!\s+(?:what\s+happened|the\s+result|the\s+output)\b))/gi,
      '|||',
    );

  return normalized
    .split(/(?<=[.?!])\s+|\|\|\|/)
    .map(part => part.trim())
    .filter(Boolean);
}

function mergeAdjacentClauses(clauses: string[]): DecomposedUnit[] {
  const units: DecomposedUnit[] = [];

  for (const clause of clauses) {
    const route = inferFallbackRoute(clause);
    const previous = units.at(-1);
    if (previous && previous.route === route) {
      previous.content = `${previous.content} ${clause}`.trim();
      continue;
    }

    units.push({
      id: `unit_${units.length + 1}`,
      route,
      content: clause,
      order: units.length,
    });
  }

  return units;
}

export function isLikelyCompoundMessage(message: string): boolean {
  const clauses = splitClauseTransitions(message);
  if (clauses.length <= 1) return false;

  const routes = new Set(clauses.map(inferFallbackRoute));
  return routes.size > 1;
}

function buildHeuristicCompoundDecomposition(message: string): DecompositionResult | null {
  const clauses = splitClauseTransitions(message);
  if (clauses.length <= 1) return null;

  const units = mergeAdjacentClauses(clauses);
  if (units.length <= 1) return null;

  return { units };
}

async function retryCompoundDecomposition(
  message: string,
  llmHandler: LLMHandler,
): Promise<DecompositionResult | null> {
  const prompt: Message[] = [
    {
      role: 'system',
      content: `You decompose one user message into semantic intent units.
This message is compound. Split every distinct fact/context clause, action request, and retrieval request into separate units.
Return ONLY JSON with this shape: {"units":[{"route":"conversational|agentic|query","content":"exact original meaning for that unit"}]}.

Rules:
- Keep units in original order.
- Do not combine context clauses with action clauses.
- Do not combine action clauses with retrieval clauses.
- Preserve meaning exactly.
- Do not paraphrase.
- If two adjacent clauses have the same route and are part of the same thought, you may keep them together.`,
    },
    { role: 'user', content: message },
  ];

  try {
    const raw = await llmHandler(prompt, {
      responseSchema: DECOMPOSITION_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 700,
      disableThinking: true,
    });
    const cleaned = stripThinking(raw);
    const jsonText = extractFirstJsonObject(cleaned) ?? extractFirstJsonObject(applyRepairPasses(cleaned));
    if (!jsonText) return null;
    const parsed = JSON.parse(applyRepairPasses(jsonText)) as unknown;
    const units = validateUnits(parsed);
    if (units.length <= 1) return null;
    return { units };
  } catch {
    return null;
  }
}

export function buildSingleUnitFallback(message: string): DecompositionResult {
  return {
    units: [
      {
        id: 'unit_1',
        route: inferFallbackRoute(message),
        content: message.trim(),
        order: 0,
      },
    ],
  };
}

export async function decomposeMessage(
  message: string,
  llmHandler: LLMHandler,
  resolvedContext?: ResolvedEntry[],
): Promise<DecompositionResult> {
  if (GREETING_ONLY.test(message)) {
    const fallback = buildSingleUnitFallback(message);
    transparency.emit({ type: 'decomposition', data: fallback });
    return fallback;
  }

  const contextBlock = resolvedContext && resolvedContext.length > 0
    ? `\n\nAlready resolved from memory:\n${resolvedContext.map(e =>
        `- ${e.code}: ${e.summary}`
      ).join('\n')}`
    : '';

  const systemPrompt = promptLoader.load('decomposition', {
    current_date: localDateString(),
    context_block: contextBlock,
  });

  const prompt: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: message },
  ];

  try {
    const raw = await llmHandler(prompt, {
      responseSchema: DECOMPOSITION_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: TOKEN_BUDGETS.DECOMPOSITION,
      disableThinking: true,
    });

    const cleaned = stripThinking(raw);
    const jsonText = extractFirstJsonObject(cleaned) ?? extractFirstJsonObject(applyRepairPasses(cleaned));
    if (!jsonText) {
      console.warn(`[zaraban][decomposition] No JSON object found in response. Length: ${raw.length}. Falling back.`);
      const fallback = buildSingleUnitFallback(message);
      transparency.emit({ type: 'decomposition', data: fallback });
      return fallback;
    }

    const parsed = JSON.parse(applyRepairPasses(jsonText)) as unknown;
    let units = validateUnits(parsed);

    // FIX 7: If first attempt returned no valid units (garbage output), retry once
    // with few-shot examples before falling back to heuristic repair.
    if (units.length === 0) {
      console.warn('[decomposition] first attempt returned no valid units, retrying with few-shot examples');
      transparency.emit({ type: 'decomposition_retry', data: { message: message.slice(0, 100), repairCount: 1, reason: 'no_valid_units' } });

      const retryPrompt: Message[] = [
        {
          role: 'system',
          content: `You decompose one user message into semantic intent units.
Return ONLY JSON with this shape: {"units":[{"route":"conversational|agentic|query","content":"..."}]}.
Rules: route must be "conversational", "agentic", or "query". content must be a non-empty string.`,
        },
        { role: 'user', content: "Save John's phone number and remind me to call him tomorrow" },
        { role: 'assistant', content: '{"units":[{"route":"agentic","content":"Save John\'s phone number"},{"route":"agentic","content":"remind me to call him tomorrow"}]}' },
        { role: 'user', content: 'What is my todo list?' },
        { role: 'assistant', content: '{"units":[{"route":"query","content":"What is my todo list?"}]}' },
        { role: 'user', content: message },
      ];

      try {
        const retryRaw = await llmHandler(retryPrompt, {
          responseSchema: DECOMPOSITION_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
          maxTokens: TOKEN_BUDGETS.DECOMPOSITION,
          disableThinking: true,
        });
        const retryCleaned = stripThinking(retryRaw);
        const retryJson = extractFirstJsonObject(retryCleaned) ?? extractFirstJsonObject(applyRepairPasses(retryCleaned));
        if (retryJson) {
          const retryParsed = JSON.parse(applyRepairPasses(retryJson)) as unknown;
          const retryUnits = validateUnits(retryParsed);
          if (retryUnits.length > 0) {
            units = retryUnits;
          }
        }
      } catch {
        // Retry failed — fall through to heuristic repair below
      }
    }

    if (units.length === 0) {
      let repaired: DecompositionResult | null = null;
      if (isLikelyCompoundMessage(message)) {
        const llmRepaired = await retryCompoundDecomposition(message, llmHandler);
        repaired = llmRepaired ?? buildHeuristicCompoundDecomposition(message);
        if (!llmRepaired && repaired) {
          // Heuristic fired — log and track
          _decompositionRepairCount++;
          console.warn(`[decomposition] heuristic repair fired (session total: ${_decompositionRepairCount})`);
          transparency.emit({ type: 'decomposition_repair', data: { message: message.slice(0, 100), repairCount: _decompositionRepairCount, reason: 'model returned empty units' } });
          if (_decompositionRepairCount >= 3) {
            console.warn('[decomposition] WARNING: heuristic repair has fired 3+ times this session. The decomposition prompt may need review.');
          }
        }
      }
      if (repaired) {
        transparency.emit({ type: 'decomposition', data: repaired });
        return repaired;
      }

      const fallback = buildSingleUnitFallback(message);
      transparency.emit({ type: 'decomposition', data: fallback });
      return fallback;
    }

    if (units.length === 1 && isLikelyCompoundMessage(message)) {
      const llmRepaired = await retryCompoundDecomposition(message, llmHandler);
      const repaired = llmRepaired ?? buildHeuristicCompoundDecomposition(message);
      if (!llmRepaired && repaired) {
        // Heuristic fired — log and track
        _decompositionRepairCount++;
        console.warn(`[decomposition] heuristic repair fired (session total: ${_decompositionRepairCount})`);
        transparency.emit({ type: 'decomposition_repair', data: { message: message.slice(0, 100), repairCount: _decompositionRepairCount, reason: 'model returned single unit for compound message' } });
        if (_decompositionRepairCount >= 3) {
          console.warn('[decomposition] WARNING: heuristic repair has fired 3+ times this session. The decomposition prompt may need review.');
        }
      }
      if (repaired) {
        transparency.emit({ type: 'decomposition', data: repaired });
        return repaired;
      }
    }

    const result = { units };
    transparency.emit({ type: 'decomposition', data: result });
    return result;
  } catch {
    const fallback = buildSingleUnitFallback(message);
    transparency.emit({ type: 'decomposition', data: fallback });
    return fallback;
  }
}
