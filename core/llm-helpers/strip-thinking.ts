/**
 * Strips <think>/<thinking> reasoning blocks from model output.
 * Complements the comprehensive stripThinkingTags() in core/llm.ts which
 * handles additional formats (Gemma4 channel tags, Qwen patterns, etc.).
 * This module specifically adds <thinking>...</thinking> support and
 * provides the bytesRemoved metric for transparency events.
 */

const THINKING_PATTERNS = [
  /<think>[\s\S]*?<\/think>/g,
  /<thinking>[\s\S]*?<\/thinking>/g,
];

export function stripThinking(raw: string): { stripped: string; bytesRemoved: number } {
  let stripped = raw;
  let totalRemoved = 0;
  for (const pattern of THINKING_PATTERNS) {
    const matches = stripped.match(pattern) ?? [];
    totalRemoved += matches.reduce((sum, m) => sum + m.length, 0);
    stripped = stripped.replace(pattern, '');
  }
  return { stripped: stripped.trim(), bytesRemoved: totalRemoved };
}
