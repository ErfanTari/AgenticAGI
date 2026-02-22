import type { Message, ResolvedMemory, Intent } from './types.js';
import type { Skill } from './skills/types.js';
import { getNotebookCounts } from './memory/mod.js';

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
const MAX_SKILL_OUTPUT_CHARS = 3000;

const SUMMARY_INTENTS: Set<string> = new Set(['summary', 'overview']);
const SUMMARY_PATTERNS = [
  /\bwhat\s+do\s+you\s+know\b/i,
  /\bshow\s+me\s+a\s+summary\b/i,
  /\boverview\b/i,
  /\bhow\s+many\s+entries\b/i,
  /\bnotebook\s+counts?\b/i,
];

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

function formatSkillOutput(skillOutput?: string): string {
  if (!skillOutput) return '';
  if (skillOutput.length <= MAX_SKILL_OUTPUT_CHARS) {
    return '## Skill Output\n' + skillOutput;
  }
  return '## Skill Output\n'
    + skillOutput.slice(0, MAX_SKILL_OUTPUT_CHARS)
    + `\n\n[skill output truncated at ${MAX_SKILL_OUTPUT_CHARS} characters]`;
}

export function buildContext(
  userMessage: string,
  resolved: ResolvedMemory | null,
  history: Message[],
  skills: Skill[],
  intent?: Intent,
  skillOutput?: string,
): Message[] {
  const systemParts = [SYSTEM_PROMPT];
  const formattedSkillOutput = formatSkillOutput(skillOutput);

  // Only include notebook counts for summary/overview queries (BUG 4)
  if (needsSummary(intent ?? 'general', userMessage)) {
    systemParts.push(getIndexSummary());
  }

  systemParts.push(formatResolved(resolved));
  systemParts.push(formatSkills(skills));

  systemParts.push(formattedSkillOutput);

  const systemContent = systemParts.filter(Boolean).join('\n\n');

  const messages: Message[] = [
    { role: 'system', content: systemContent },
  ];

  // Start with last 6 turns (12 messages)
  let recentHistory = history.slice(-12);
  messages.push(...recentHistory);
  messages.push({ role: 'user', content: userMessage });

  // Token ceiling guard (BUG 5)
  let tokens = estimateTokens(messages);

  if (tokens > MAX_TOKENS) {
    // Step 1: Reduce history to 3 turns (6 messages)
    messages.length = 1; // keep system prompt
    recentHistory = history.slice(-6);
    messages.push(...recentHistory);
    messages.push({ role: 'user', content: userMessage });
    tokens = estimateTokens(messages);
  }

  if (tokens > MAX_TOKENS) {
    // Step 2: Trim memory to summaries only (no full content)
    const summaryResolved = formatResolved(resolved, true);
    const trimmedSystem = [SYSTEM_PROMPT, summaryResolved, formatSkills(skills), formattedSkillOutput]
      .filter(Boolean).join('\n\n');
    messages[0] = { role: 'system', content: trimmedSystem };
    tokens = estimateTokens(messages);
  }

  if (tokens > HARD_CEILING) {
    // Step 3: Truncate user input to ~500 tokens (2000 chars)
    const lastIdx = messages.length - 1;
    const userContent = messages[lastIdx].content;
    if (userContent.length > 2000) {
      messages[lastIdx] = {
        role: 'user',
        content: userContent.slice(0, 2000) + '\n\n[input truncated — too long]',
      };
      console.warn(`Token ceiling hit: input truncated from ${userContent.length} chars`);
    }
  }

  return messages;
}

export function estimateTokens(messages: Message[]): number {
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(totalChars / 4);
}
