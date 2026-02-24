import type { Message, ResolvedMemory, Intent, LLMHandler } from './types.js';
import type { Skill } from './skills/types.js';
import { getNotebookCounts } from './memory/mod.js';
import { encode } from 'gpt-tokenizer';

const SYSTEM_PROMPT = `You are a knowledgeable personal assistant with access to a structured memory system.
Answer based on the provided memory context. Be concise and direct.
If the memory context doesn't contain enough information, say so honestly.
Reference entries by their code (e.g., WHO.CT-000001) when relevant.

Valid memory entry codes follow this format: [NOTEBOOK].[TYPE]-[NUMBER]

Valid notebooks and their types:
WHO: CT (contact), ORG (organization)
WHAT: PJ (project), KN (knowledge)
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

const SUMMARY_INTENTS: Set<string> = new Set(['summary', 'overview']);
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

export function getIndexSummary(): string {
  const rows = getNotebookCounts();
  if (rows.length === 0) return 'Memory is empty.';
  return 'Memory index: ' + rows.map(r => `${r.nb}: ${r.count} entries`).join(', ');
}

function needsSummary(intent: Intent, userMessage?: string): boolean {
  if (SUMMARY_INTENTS.has(intent)) return true;
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

  // Try to summarize old turns
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

    const summary = await llmHandler(summaryPrompt, { maxTokens: 150 });

    return {
      turns: recentMessages,
      summary: summary.trim(),
    };
  } catch (err) {
    // Graceful fallback: if summarization fails, just return recent turns without summary
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

export async function buildContext(
  userMessage: string,
  resolved: ResolvedMemory | null,
  history: Message[],
  skills: Skill[],
  intent?: Intent,
  skillOutput?: string,
  llmHandler?: LLMHandler,
): Promise<Message[]> {
  const systemParts = [SYSTEM_PROMPT];

  // Only include notebook counts for summary/overview queries (BUG 4)
  if (needsSummary(intent ?? 'general', userMessage)) {
    systemParts.push(getIndexSummary());
  }

  systemParts.push(formatResolved(resolved));
  systemParts.push(formatSkills(skills));

  // Inject skill output into context
  if (skillOutput) {
    systemParts.push('## Skill Output\n' + skillOutput);
  }

  const systemContent = systemParts.filter(Boolean).join('\n\n');

  const messages: Message[] = [
    { role: 'system', content: systemContent },
  ];

  // Use rolling context summarization if llmHandler provided and history is long
  let recentHistory = history.slice(-12); // Default: last 6 turns
  let conversationSummary: string | undefined;

  if (llmHandler && history.length > SUMMARY_THRESHOLD * 2) {
    const rollingContext = await buildRollingContext(history, llmHandler);
    recentHistory = rollingContext.turns;
    conversationSummary = rollingContext.summary;
  }

  // Inject conversation summary if present
  if (conversationSummary) {
    messages.push({
      role: 'system',
      content: `## Previous Conversation\n${conversationSummary}`,
    });
  }

  messages.push(...recentHistory);
  messages.push({ role: 'user', content: userMessage });

  // Token ceiling guard (BUG 5)
  let tokens = estimateTokens(messages);

  // Warn if context exceeds 80% of budget
  if (tokens > WARNING_THRESHOLD && tokens <= MAX_TOKENS) {
    console.warn(`[context] Context at ${tokens}/${MAX_TOKENS} tokens (${Math.round(tokens/MAX_TOKENS*100)}%) — approaching limit`);
  }

  if (tokens > MAX_TOKENS) {
    // Step 1: Reduce history to 3 turns (6 messages)
    messages.length = 1; // keep system prompt
    recentHistory = history.slice(-6);
    messages.push(...recentHistory);
    messages.push({ role: 'user', content: userMessage });
    tokens = estimateTokens(messages);
  }

  if (tokens > MAX_TOKENS) {
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

  if (tokens > MAX_TOKENS) {
    // Step 3: Drop all history, keep only system + user message
    messages.length = 1; // keep only system
    messages.push({ role: 'user', content: userMessage });
    tokens = estimateTokens(messages);
  }

  if (tokens > HARD_CEILING) {
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
