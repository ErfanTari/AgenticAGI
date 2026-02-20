import type { Message, ResolvedMemory } from './types.js';
import type { Skill } from './skills/types.js';
import { getNotebookCounts } from './memory/mod.js';

const SYSTEM_PROMPT = `You are a knowledgeable personal assistant with access to a structured memory system.
Answer based on the provided memory context. Be concise and direct.
If the memory context doesn't contain enough information, say so honestly.
Reference entries by their code (e.g., WHO.CT-000001) when relevant.`;

export function getIndexSummary(): string {
  const rows = getNotebookCounts();
  if (rows.length === 0) return 'Memory is empty.';
  return 'Memory index: ' + rows.map(r => `${r.nb}: ${r.count} entries`).join(', ');
}

function formatResolved(resolved: ResolvedMemory | null): string {
  if (!resolved || resolved.entries.length === 0) return '';

  const parts: string[] = ['## Resolved Memory'];

  for (const entry of resolved.entries) {
    parts.push(`- [${entry.code}] ${entry.name} (${entry.status}): ${entry.summary}`);
  }

  if (resolved.contents.length > 0) {
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

export function buildContext(
  userMessage: string,
  resolved: ResolvedMemory | null,
  history: Message[],
  skills: Skill[],
): Message[] {
  const systemParts = [
    SYSTEM_PROMPT,
    getIndexSummary(),
    formatResolved(resolved),
    formatSkills(skills),
  ].filter(Boolean);

  const messages: Message[] = [
    { role: 'system', content: systemParts.join('\n\n') },
  ];

  // Last 6 turns (12 messages: user + assistant pairs)
  const recentHistory = history.slice(-12);
  messages.push(...recentHistory);

  messages.push({ role: 'user', content: userMessage });

  return messages;
}

export function estimateTokens(messages: Message[]): number {
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(totalChars / 4);
}
