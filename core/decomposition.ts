import { applyRepairPasses, extractFirstJsonObject } from './structured.js';
import { transparency } from './transparency.js';
import type { DecompositionResult, DecomposedUnit, LLMHandler, Message, RouteKind } from './types.js';
import type { ResolvedEntry } from './intake.js';

const ROUTES: RouteKind[] = ['conversational', 'agentic', 'query'];

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

function stripThinking(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .trim();
}

function validateRoute(value: unknown): value is RouteKind {
  return typeof value === 'string' && ROUTES.includes(value as RouteKind);
}

function validateUnits(value: unknown): DecomposedUnit[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const units = (value as { units?: unknown }).units;
  if (!Array.isArray(units)) return [];

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

  const prompt: Message[] = [
    {
      role: 'system',
      content: `You decompose one user message into semantic intent units.
Return ONLY JSON with this shape: {"units":[{"route":"conversational|agentic|query","content":"exact original meaning for that unit"}]}.

Rules:
- Preserve meaning exactly.
- Do not correct grammar.
- Do not paraphrase.
- Remove filler only when it is not part of the user's meaning.
- Keep units in original order.
- A unit must be self-contained.
- Use "conversational" for discussion or questions expecting a response.
- Use "agentic" for requests to perform actions or create/modify things.
- Use "query" for requests to retrieve information from memory, history, or project context.
- If the whole message is one unit, return one unit.${contextBlock}`,
    },
    { role: 'user', content: message },
  ];

  try {
    const raw = await llmHandler(prompt, {
      responseSchema: DECOMPOSITION_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 600,
    });

    const cleaned = stripThinking(raw);
    const jsonText = extractFirstJsonObject(cleaned) ?? extractFirstJsonObject(applyRepairPasses(cleaned));
    if (!jsonText) {
      const fallback = buildSingleUnitFallback(message);
      transparency.emit({ type: 'decomposition', data: fallback });
      return fallback;
    }

    const parsed = JSON.parse(applyRepairPasses(jsonText)) as unknown;
    const units = validateUnits(parsed);
    if (units.length === 0) {
      const repaired = isLikelyCompoundMessage(message)
        ? (await retryCompoundDecomposition(message, llmHandler)) ?? buildHeuristicCompoundDecomposition(message)
        : null;
      if (repaired) {
        transparency.emit({ type: 'decomposition', data: repaired });
        return repaired;
      }

      const fallback = buildSingleUnitFallback(message);
      transparency.emit({ type: 'decomposition', data: fallback });
      return fallback;
    }

    if (units.length === 1 && isLikelyCompoundMessage(message)) {
      const repaired = (await retryCompoundDecomposition(message, llmHandler)) ?? buildHeuristicCompoundDecomposition(message);
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
