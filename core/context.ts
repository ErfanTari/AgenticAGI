import type { Message, ResolvedMemory, Intent, LLMHandler } from './types.js';
import type { Skill } from './skills/types.js';
import type { IndexEntry } from './memory/types.js';
import { getNotebookCounts } from './memory/mod.js';
import { encode } from 'gpt-tokenizer';
import { transparency } from './transparency.js';
import { queryEntries } from './memory/index.js';
import { fetchByCode } from './memory/fetch.js';
import { sessionCache } from './memory/session-cache.js';
import { createLMStudioChatSessionHandler } from './llm.js';
import { applyProjectGravityToScores } from './memory/search.js';

const SYSTEM_PROMPT = `You are a personal AI agent with memory, skills, and reasoning capabilities.

Your capabilities:
- Memory system: WHO, WHAT, WHEN, HOW, WHY, NOW, PLAN notebooks
- Skills: web_search, calculator, file_reader, file_writer, run_bash, web_fetch, download_file, url_extract, memory_read, content_writer, relationship_write, implement_and_test
- You can search the web, write files, run code, and remember information across sessions

Use skills for their domains. Never substitute your own reasoning:
- calculator: ANY math. Never compute directly.
- web_search: ANY current events or real-time data. Never answer from training.
- file_reader: ANY file read. Never invent contents.
- run_bash: ANY commands. Never simulate output.
- memory_read: ANY user data or saved entries. Never guess.
Use skills. No exceptions.

Safety: ALWAYS ask for confirmation before destructive operations (delete files, wipe data, rebuild from scratch). Never silently execute irreversible actions.

How to respond:
- Use memory context when it contains relevant information
- Be direct and helpful — do not refuse tasks you can do
- Never expose your internal reasoning process
- Never show thinking steps, analysis, or decision trees
- Respond only with the final answer

Identity: You are zaraban, an AI agent built on AgenticAGI. If asked your name or what to call you, answer "zaraban". Do not say you lack a name.

When asked what you can do:
- List your notebooks and skills clearly
- Give concrete examples of what you can help with

Valid memory entry codes follow this format: [NOTEBOOK].[TYPE]-[NUMBER]

Valid notebooks and their types:
WHO: CT (contact), ORG (organization)
WHAT: KN (knowledge)
WHEN: CA (calendar), DL (deadline)
HOW: PR (procedure)
WHY: MT (meta reflection), QU (open question)
NOW: TD (todo), RP (report)
PLAN: PL (planning entry)

Never use a type code not listed above.
Never invent new type codes.`;

const MAX_TOKENS = 1500;
const HARD_CEILING = 2000;
const WARNING_THRESHOLD = Math.floor(MAX_TOKENS * 0.8); // 80% = 1200 tokens

// Rolling context summary thresholds
const SUMMARY_THRESHOLD = 6; // When history has > 6 turns (12 messages), summarize old turns
const KEEP_RECENT = 3; // Keep last 3 turns (6 messages) verbatim

// Phase 16 — Compaction circuit breaker
const COMPACTION_MAX_FAILURES = 3;
let _compactionFailures = 0;
export function _resetCompactionCircuit(): void { _compactionFailures = 0; }

// --- fetchOwnerPersona with 60-second TTL cache (Bug 9 fix) ---

interface PersonaCache {
  value: string | null;
  expiresAt: number;
}

let _personaCache: PersonaCache | null = null;
const PERSONA_CACHE_TTL_MS = 60_000;

export function fetchOwnerPersona(): string | null {
  const now = Date.now();
  if (_personaCache && now < _personaCache.expiresAt) {
    return _personaCache.value;
  }

  let value: string | null = null;
  try {
    const whoCtEntries = queryEntries({ nb: 'WHO', type: 'CT', status: 'active' });
    if (whoCtEntries.length > 0) {
      const entry = whoCtEntries[0];
      const fetched = fetchByCode(entry.code);
      value = fetched ? `## Owner Persona\n${entry.name}: ${entry.summary ?? ''}` : null;
    }
  } catch {
    value = null;
  }

  _personaCache = { value, expiresAt: now + PERSONA_CACHE_TTL_MS };
  return value;
}

/** Reset persona cache — used in tests */
export function _resetPersonaCache(): void {
  _personaCache = null;
}

const SUMMARY_PATTERNS = [
  /\bwhat\s+do\s+you\s+know\b/i,
  /\bshow\s+me\s+a\s+summary\b/i,
  /\boverview\b/i,
  /\bhow\s+many\s+entries\b/i,
  /\bnotebook\s+counts?\b/i,
];

export interface ContextHistory {
  turns: Message[];
  summary?: string;
}

/**
 * Trim history to fit within a token budget, walking backwards to keep the most recent turns.
 * BUG-6 fix: always returns at least the most recent message, even if it alone exceeds budget.
 * BUG-M1 fix: always preserve the last 2 turns (1 user + 1 assistant) regardless of budget.
 *             Falls back to just the last user message if even 2 turns exceed budget.
 */
export function trimHistoryToTokenBudget(history: Message[], budget: number): Message[] {
  if (history.length === 0) return [];

  // Always guarantee at least the last 2 turns (pair) if available
  const minKeep = Math.min(2, history.length);
  const mandatorySlice = history.slice(-minKeep);

  const kept: Message[] = [...mandatorySlice];
  let tokens = estimateTokens(kept.map(m => m.content).join('\n'));

  // Walk backwards from just before the mandatory slice and add more if budget allows
  for (let i = history.length - minKeep - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(history[i].content);
    if (tokens + msgTokens > budget) break;
    kept.unshift(history[i]);
    tokens += msgTokens;
  }

  return kept;
}

/**
 * BM25F-inspired ranking with recency decay, importance, utility, and page boost.
 * Replaces the old rankByRelevance for richer scoring.
 */
export function rankByLightRAG(
  entries: IndexEntry[],
  message: string,
  currentProjectCode?: string | null,
): IndexEntry[] {
  const msgWords = message.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const msgWordSet = new Set(msgWords);
  const now = Date.now();

  // BM25F params
  const k1 = 1.2;
  const b = 0.75;
  const NAME_WEIGHT = 5;
  const SUMMARY_WEIGHT = 3;
  const DECAY_SCALE = 0.05; // days

  const scored = entries.map(entry => {
    const nameTokens = entry.name.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const summaryTokens = (entry.summary ?? '').toLowerCase().split(/\s+/).filter(w => w.length > 2);

    // BM25F: weighted term frequency in name + summary fields
    let bm25Score = 0;
    for (const qw of msgWordSet) {
      const tf_name = nameTokens.filter(w => w === qw).length;
      const tf_summary = summaryTokens.filter(w => w === qw).length;

      const tf_weighted = NAME_WEIGHT * tf_name + SUMMARY_WEIGHT * tf_summary;
      const dl = nameTokens.length * NAME_WEIGHT + summaryTokens.length * SUMMARY_WEIGHT;
      const avgdl = 10 * NAME_WEIGHT + 20 * SUMMARY_WEIGHT; // approximate

      bm25Score += (tf_weighted * (k1 + 1)) / (tf_weighted + k1 * (1 - b + b * (dl / avgdl)));
    }

    // Recency decay: e^(-0.05 * days)
    const updatedMs = new Date(entry.updated).getTime();
    const ageDays = (now - updatedMs) / (1000 * 60 * 60 * 24);
    const recencyScore = Math.exp(-DECAY_SCALE * ageDays);

    // Importance and utility contributions
    const entryAny = entry as unknown as Record<string, unknown>;
    const importanceBoost = ((entryAny.importance_score as number) ?? 0.5) * 0.1;
    const utilityBoost = ((entryAny.utility_score as number) ?? 1.0) * 0.1;

    // Page boost
    const activePage = (entryAny.active_page as number) ?? 1;
    const pageBoost = activePage === 1 ? 1.2 : 0.8;

    // PINNED entries get maximum boost
    const pinned = (entryAny.pinned as number) ?? 0;
    const pinnedBoost = pinned === 1 ? 2.0 : 1.0;

    const totalScore = (bm25Score + recencyScore + importanceBoost + utilityBoost) * pageBoost * pinnedBoost;

    return { entry, score: totalScore };
  });

  const projectAdjusted = applyProjectGravityToScores(scored, currentProjectCode);
  return projectAdjusted.sort((a, b) => b.score - a.score).map(s => s.entry);
}

/**
 * Rank memory entries by relevance to the current message.
 * Alias for rankByLightRAG for backwards compatibility.
 */
export function rankByRelevance(
  entries: IndexEntry[],
  message: string,
  currentProjectCode?: string | null,
): IndexEntry[] {
  return rankByLightRAG(entries, message, currentProjectCode);
}

export function getIndexSummary(): string {
  const rows = getNotebookCounts();
  if (rows.length === 0) return 'Memory is empty.';
  return 'Memory index: ' + rows.map(r => `${r.nb}: ${r.count} entries`).join(', ');
}

function needsSummary(_intent: Intent, userMessage?: string): boolean {
  if (userMessage) {
    return SUMMARY_PATTERNS.some(p => p.test(userMessage));
  }
  return false;
}

/**
 * Build rolling context with summarization for long histories.
 * When history exceeds SUMMARY_THRESHOLD turns, summarize old turns and keep recent turns verbatim.
 * Falls back gracefully if summarization fails.
 */
export async function buildRollingContext(
  history: Message[],
  llmHandler: LLMHandler,
): Promise<ContextHistory> {
  const sessionLLM = createLMStudioChatSessionHandler(llmHandler);
  // Count turns (pair of user+assistant messages)
  const turnCount = Math.floor(history.length / 2);

  if (turnCount <= SUMMARY_THRESHOLD) {
    // Short history, no summarization needed
    return { turns: history };
  }

  // Split: old turns to summarize, recent turns to keep verbatim
  const recentMessageCount = KEEP_RECENT * 2; // 3 turns = 6 messages
  const oldMessages = history.slice(0, -recentMessageCount);
  const recentMessages = history.slice(-recentMessageCount);

  // Try to summarize old turns with timeout
  try {
    const summaryPrompt: Message[] = [
      {
        role: 'system',
        content: 'Summarize the conversation history below into 2-3 concise sentences. Focus on key topics, decisions, and context needed for future turns. Omit greetings and pleasantries.',
      },
      {
        role: 'user',
        content: oldMessages.map(m => `${m.role}: ${m.content}`).join('\n\n'),
      },
    ];

    // Wrap summarization with 5000ms timeout
    const SUMMARIZATION_TIMEOUT = 5000;
    const summary = await Promise.race([
      sessionLLM(summaryPrompt, { maxTokens: 150 }),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('Summarization timeout after 5000ms')), SUMMARIZATION_TIMEOUT)
      ),
    ]);

    return {
      turns: recentMessages,
      summary: summary.trim(),
    };
  } catch (err) {
    // Graceful fallback: if summarization fails or times out, just return recent turns without summary
    console.warn('[context] Summary generation failed, keeping recent turns only:', String(err));
    return { turns: recentMessages };
  }
}

function formatResolved(resolved: ResolvedMemory | null, summaryOnly?: boolean): string {
  if (!resolved || resolved.entries.length === 0) return '';

  const parts: string[] = ['## Resolved Memory'];

  for (const entry of resolved.entries) {
    parts.push(`- [${entry.code}] ${entry.name} (${entry.status}): ${entry.summary}`);
  }

  if (!summaryOnly && resolved.contents.length > 0) {
    parts.push('\n## Full Content');
    for (const content of resolved.contents) {
      parts.push(content);
    }
  }

  if (resolved.relationships.length > 0) {
    parts.push('\n## Relationships');
    for (const rel of resolved.relationships) {
      parts.push(`- ${rel.from_code} ${rel.relation} ${rel.to_code}${rel.note ? ` (${rel.note})` : ''}`);
    }
  }

  return parts.join('\n');
}

function formatSkills(skills: Skill[]): string {
  if (skills.length === 0) return '';
  return 'Available capabilities: ' + skills.map(s => s.description).join('; ');
}

export type ContextMode = 'default' | 'agentic_coding';

export async function buildContext(
  userMessage: string,
  resolved: ResolvedMemory | null,
  history: Message[],
  skills: Skill[],
  intent?: Intent,
  currentProjectCode?: string | null,
  skillOutput?: string,
  llmHandler?: LLMHandler,
  contextMode?: ContextMode,
): Promise<Message[]> {
  const sessionLLM = llmHandler ? createLMStudioChatSessionHandler(llmHandler) : undefined;
  // Phase 18 — contextMode overrides token limits for coding tasks
  const effectiveMaxTokens = contextMode === 'agentic_coding' ? 8000 : MAX_TOKENS;
  const effectiveHardCeiling = contextMode === 'agentic_coding' ? 16000 : HARD_CEILING;
  const effectiveCompactionThreshold = contextMode === 'agentic_coding' ? 5600 : Math.floor(MAX_TOKENS * 0.7);

  if (contextMode === 'agentic_coding') {
    transparency.emit({
      type: 'context_mode_applied',
      data: { mode: contextMode, softLimit: effectiveMaxTokens, hardCeiling: effectiveHardCeiling },
    });
  }
  const systemParts = [SYSTEM_PROMPT];

  // Inject owner persona from WHO.CT (cached, non-throwing)
  const persona = fetchOwnerPersona();
  if (persona) {
    systemParts.push(persona);
  }

  // Only include notebook counts for summary/overview queries (BUG 4)
  if (needsSummary(intent ?? 'general', userMessage)) {
    systemParts.push(getIndexSummary());
  }

  // BUG-H2 fix: rank memory entries by relevance BEFORE formatting and injecting into prompt.
  // Previously rankByRelevance was called AFTER formatResolved, making it dead code.
  if (resolved && resolved.entries.length > 1) {
    resolved = {
      ...resolved,
      entries: rankByRelevance(resolved.entries, userMessage, currentProjectCode),
    };
  }

  systemParts.push(formatResolved(resolved));
  systemParts.push(formatSkills(skills));

  // Inject active PLAN.CT constraints into every step's context
  // Phase 15 Conflict 1: check session cache before SQLite for each constraint entry
  try {
    const constraints = queryEntries({ nb: 'PLAN', type: 'CT' }).filter(e => e.status === 'active');
    if (constraints.length > 0) {
      const constraintLines = constraints.map(c => {
        // Prefer session cache for summary (avoids redundant SQLite fetch)
        const cached = sessionCache.getByCode(c.code);
        const summary = (cached ?? c).summary;
        return `- [${c.code}] ${c.name}: ${summary}`;
      });
      systemParts.push('## Active Constraints\n' +
        constraintLines.join('\n') +
        '\n\nIMPORTANT: These are user-authored constraints. NEVER silently modify or remove them. If the user asks to change a constraint, warn them that this is a protected user rule and ask for explicit confirmation before proceeding.');
    }
  } catch { /* non-fatal */ }

  // Inject skill output into context
  if (skillOutput) {
    systemParts.push('## Skill Output\n' + skillOutput);
  }

  // Use rolling context summarization if llmHandler provided and history is long
  // Then trim to token budget
  let recentHistory: Message[];
  let conversationSummary: string | undefined;
  if (sessionLLM && history.length > SUMMARY_THRESHOLD * 2) {
    const rollingContext = await buildRollingContext(history, sessionLLM);
    recentHistory = rollingContext.turns;
    conversationSummary = rollingContext.summary;
  } else {
    // Default: last 6 turns (12 messages) — same as before
    recentHistory = history.slice(-12);
  }

  // Conversation summary is concatenated into the system message, NOT a separate array entry.
  // Qwen3.5's jinja template requires exactly one system message at index 0.
  if (conversationSummary) {
    systemParts.push(`## Previous Conversation\n${conversationSummary}`);
  }

  const systemContent = systemParts.filter(Boolean).join('\n\n');

  const messages: Message[] = [
    { role: 'system', content: systemContent },
  ];

  messages.push(...recentHistory);
  messages.push({ role: 'user', content: userMessage });

  // Context compaction at 70% of token budget (P5)
  // Pinned messages (content starting with [PINNED]) are immune to compaction
  let tokens = estimateTokens(messages);
  let alreadyCompacted = false;

  if (tokens > effectiveCompactionThreshold && sessionLLM && history.length > 4 && _compactionFailures < COMPACTION_MAX_FAILURES) {
    // Compact non-pinned history
    const nonPinned = recentHistory.filter(m => !m.content.startsWith('[PINNED]'));
    const pinned = recentHistory.filter(m => m.content.startsWith('[PINNED]'));

    if (nonPinned.length > 2) {
      try {
        const summaryPrompt: Message[] = [
          {
            role: 'system',
            content: 'Summarize this conversation history in 2-3 sentences. Keep key facts and decisions.',
          },
          {
            role: 'user',
            content: nonPinned.map(m => `${m.role}: ${m.content}`).join('\n\n'),
          },
        ];
        const compactedSummary = await sessionLLM(summaryPrompt, { maxTokens: 150 });
        // Compaction summary is appended to the system message content, not a separate entry
        const compactedContent = messages[0].content + '\n\n## Compacted History\n' + compactedSummary.trim();
        messages[0] = { role: 'system', content: compactedContent };
        recentHistory = [...pinned];
        messages.length = 1;
        messages[0] = { role: 'system', content: compactedContent };
        messages.push(...recentHistory);
        messages.push({ role: 'user', content: userMessage });
        const afterTokens = estimateTokens(messages);
        transparency.emit({ type: 'context_compacted', data: { before: tokens, after: afterTokens } });
        tokens = afterTokens;
        _compactionFailures = 0; // reset on success
        alreadyCompacted = true;
      } catch (err) {
        _compactionFailures++;
        if (_compactionFailures >= COMPACTION_MAX_FAILURES) {
          console.warn(`[context] Compaction circuit open after ${_compactionFailures} consecutive failures — skipping compaction`);
        } else {
          console.warn(`[context] Compaction failed (${_compactionFailures}/${COMPACTION_MAX_FAILURES}):`, err);
        }
      }
    }
  }

  // Auto-compact token threshold trigger (100K)
  const AUTO_COMPACT_THRESHOLD = 100_000;
  if (tokens > AUTO_COMPACT_THRESHOLD && sessionLLM && _compactionFailures < COMPACTION_MAX_FAILURES && !alreadyCompacted) {
    const nonPinned = recentHistory.filter(m => !m.content.startsWith('[PINNED]'));
    const pinned = recentHistory.filter(m => m.content.startsWith('[PINNED]'));

    if (nonPinned.length > 2) {
      try {
        const summaryPrompt: Message[] = [
          {
            role: 'system',
            content: 'Summarize this conversation history in 2-3 sentences. Keep key facts and decisions.',
          },
          {
            role: 'user',
            content: nonPinned.map(m => `${m.role}: ${m.content}`).join('\n\n'),
          },
        ];
        const compactedSummary = await sessionLLM(summaryPrompt, { maxTokens: 150 });
        const compactedContent = messages[0].content + '\n\n## Compacted History\n' + compactedSummary.trim();
        messages[0] = { role: 'system', content: compactedContent };
        recentHistory = [...pinned];
        messages.length = 1;
        messages[0] = { role: 'system', content: compactedContent };
        messages.push(...recentHistory);
        messages.push({ role: 'user', content: userMessage });
        tokens = estimateTokens(messages);
        transparency.emit({ type: 'context_compacted', data: { before: AUTO_COMPACT_THRESHOLD, after: tokens } });
        _compactionFailures = 0; // reset on success
      } catch (err) {
        _compactionFailures++;
        if (_compactionFailures >= COMPACTION_MAX_FAILURES) {
          console.warn(`[context] Compaction circuit open after ${_compactionFailures} consecutive failures — skipping compaction`);
        } else {
          console.warn(`[context] Auto-compaction failed (${_compactionFailures}/${COMPACTION_MAX_FAILURES}):`, err);
        }
      }
    }
  }

  // Token ceiling guard (BUG 5)
  tokens = estimateTokens(messages);

  // Warn if context exceeds 80% of budget
  if (tokens > WARNING_THRESHOLD && tokens <= effectiveMaxTokens) {
    console.warn(`[context] Context at ${tokens}/${effectiveMaxTokens} tokens (${Math.round(tokens/effectiveMaxTokens*100)}%) — approaching limit`);
  }

  if (tokens > effectiveMaxTokens) {
    // Step 1: Token-budget-aware history trim (keep as many turns as fit in budget)
    messages.length = 1; // keep system prompt
    const historyBudget = Math.floor(effectiveMaxTokens * 0.4);
    const tokenTrimmed = trimHistoryToTokenBudget(history, historyBudget);
    // Fallback to 3-turn limit if trimmer returns nothing
    recentHistory = tokenTrimmed.length > 0 ? tokenTrimmed : history.slice(-6);
    messages.push(...recentHistory);
    messages.push({ role: 'user', content: userMessage });
    tokens = estimateTokens(messages);
  }

  if (tokens > effectiveMaxTokens) {
    // Step 2: Trim memory to summaries only, truncate large skill output
    const summaryResolved = formatResolved(resolved, true);
    const trimParts = [SYSTEM_PROMPT, summaryResolved, formatSkills(skills)];
    if (skillOutput) {
      // Keep skill output but cap at ~2000 chars to fit in token budget
      const maxSkillChars = 2000;
      const truncatedSkill = skillOutput.length > maxSkillChars
        ? skillOutput.slice(0, maxSkillChars) + '\n\n[skill output truncated]'
        : skillOutput;
      trimParts.push('## Skill Output\n' + truncatedSkill);
    }
    const trimmedSystem = trimParts.filter(Boolean).join('\n\n');
    messages[0] = { role: 'system', content: trimmedSystem };
    tokens = estimateTokens(messages);
  }

  if (tokens > effectiveMaxTokens) {
    // Step 3: Drop all history, keep only system + user message
    messages.length = 1; // keep only system
    messages.push({ role: 'user', content: userMessage });
    tokens = estimateTokens(messages);
  }

  if (tokens > effectiveHardCeiling) {
    // Final: Truncate user input to fit under ceiling
    const lastIdx = messages.length - 1;
    const userContent = messages[lastIdx].content;
    const userTokens = estimateTokens(userContent);

    if (userTokens > 500) {
      // Approximate char position that fits ~500 tokens
      const targetTokens = 500;
      const approxChars = Math.floor(userContent.length * (targetTokens / userTokens));
      const truncated = userContent.slice(0, approxChars);

      messages[lastIdx] = {
        role: 'user',
        content: truncated + '\n\n[input truncated — too long]',
      };
      console.warn(`Token ceiling hit: input truncated from ${userTokens} tokens`);
    }
  }

  // Emit context_built transparency event
  const sections: string[] = ['system'];
  if (conversationSummary) sections.push('conversation_summary');
  if (recentHistory.length > 0) sections.push('history');
  if (resolved && resolved.entries.length > 0) sections.push('memory');
  if (skills.length > 0) sections.push('skills');
  if (skillOutput) sections.push('skill_output');
  sections.push('user_message');

  transparency.emit({
    type: 'context_built',
    data: { tokens: estimateTokens(messages), sections },
  });

  // FIX 2: Guard — LM Studio jinja templates require the last message to be role=user.
  // If the last message is role=assistant, the template will generate a malformed prompt.
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role !== 'user') {
    throw new Error(
      `buildContext: last message must be role=user, got role=${lastMsg?.role ?? 'undefined'}`,
    );
  }

  return messages;
}

/**
 * Count exact tokens using gpt-tokenizer.
 * Can accept either a string or Message array.
 */
export function estimateTokens(input: string | Message[]): number {
  if (typeof input === 'string') {
    return encode(input).length;
  }
  // Message array
  const combined = input.map(m => m.content).join('\n');
  return encode(combined).length;
}
