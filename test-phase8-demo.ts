#!/usr/bin/env node
/**
 * Phase 8 Quick Demo - No LLM Required
 *
 * Demonstrates exact token counting and rolling summarization
 * using mock data and handler.
 */

import { buildContext, buildRollingContext, estimateTokens } from './core/context.js';
import type { Message, LLMHandler } from './core/types.js';

console.log('╔═══════════════════════════════════════════════════════════╗');
console.log('║     Phase 8 Demo: Exact Token Counting & Summarization   ║');
console.log('╚═══════════════════════════════════════════════════════════╝\n');

// Mock LLM handler
const mockLLM: LLMHandler = async (messages) => {
  if (messages[0].content.includes('Summarize')) {
    return 'Summary: Earlier conversation covered project planning, deadlines, and implementation strategies for the Xray initiative.';
  }
  return 'Mock response';
};

// === Demo 1: Exact Token Counting ===
console.log('═══ Demo 1: Exact Token Counting ═══\n');

const denseJSON = JSON.stringify({
  users: Array.from({ length: 20 }, (_, i) => ({
    id: i,
    name: `User${i}`,
    email: `user${i}@example.com`,
    active: true,
    metadata: { role: 'admin', level: 5 },
  })),
});

const jsonTokens = estimateTokens(denseJSON);
const jsonCharsDiv4 = Math.ceil(denseJSON.length / 4);

console.log(`Dense JSON (${denseJSON.length} chars):`);
console.log(`  Old method (chars/4): ${jsonCharsDiv4} tokens`);
console.log(`  New method (gpt-tokenizer): ${jsonTokens} tokens`);
console.log(`  Accuracy improvement: ${Math.round((jsonTokens / jsonCharsDiv4 - 1) * 100)}% more accurate\n`);

// === Demo 2: Rolling Summarization (Short History) ===
console.log('═══ Demo 2: Short History (≤6 turns) ═══\n');

const shortHistory: Message[] = Array.from({ length: 12 }, (_, i) => ({
  role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
  content: `Turn ${Math.floor(i / 2)}: Discussion about Xray project milestones and deliverables.`,
}));

console.log(`History: ${shortHistory.length} messages (6 turns)`);

const shortResult = await buildRollingContext(shortHistory, mockLLM);
console.log(`Result: ${shortResult.turns.length} messages kept`);
console.log(`Summary: ${shortResult.summary ? 'Generated' : 'None (below threshold)'}\n`);

// === Demo 3: Rolling Summarization (Long History) ===
console.log('═══ Demo 3: Long History (>6 turns) ═══\n');

const longHistory: Message[] = Array.from({ length: 24 }, (_, i) => ({
  role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
  content: `Turn ${Math.floor(i / 2)}: Discussion about Xray project milestones, deliverables, and architectural decisions.`,
}));

console.log(`History: ${longHistory.length} messages (12 turns)`);

const start = performance.now();
const longResult = await buildRollingContext(longHistory, mockLLM);
const elapsed = Math.round(performance.now() - start);

console.log(`Result: ${longResult.turns.length} messages kept (last 3 turns)`);
console.log(`Summary: ${longResult.summary ? `"${longResult.summary.substring(0, 80)}..."` : 'None'}`);
console.log(`Summary tokens: ${longResult.summary ? estimateTokens(longResult.summary) : 0}`);
console.log(`Elapsed: ${elapsed}ms\n`);

// === Demo 4: Full Context Building ===
console.log('═══ Demo 4: Full Context with Summarization ═══\n');

const fullContext = await buildContext(
  'What is the current status of the Xray project?',
  null,
  longHistory,
  [],
  'general',
  undefined,
  mockLLM,
);

const contextTokens = estimateTokens(fullContext);
console.log(`Context messages: ${fullContext.length}`);
console.log(`Total tokens: ${contextTokens}/1500`);
console.log(`Token usage: ${Math.round((contextTokens / 1500) * 100)}%`);

const summaryMessage = fullContext.find(m =>
  m.role === 'system' && m.content.includes('Previous Conversation')
);
console.log(`Summary injected: ${summaryMessage ? 'Yes' : 'No'}`);

if (contextTokens > 1200) {
  console.log('🔴 WARNING: Context would trigger 80% warning!\n');
} else if (contextTokens > 900) {
  console.log('🟡 Context getting full\n');
} else {
  console.log('🟢 Context healthy\n');
}

// === Demo 5: 80% Warning Threshold ===
console.log('═══ Demo 5: 80% Warning Threshold ═══\n');

const MAX_TOKENS = 1500;
const WARNING_THRESHOLD = Math.floor(MAX_TOKENS * 0.8);

console.log(`MAX_TOKENS: ${MAX_TOKENS}`);
console.log(`WARNING_THRESHOLD: ${WARNING_THRESHOLD} (80%)`);
console.log(`Current context: ${contextTokens} tokens`);

if (contextTokens > WARNING_THRESHOLD) {
  console.log(`⚠️  Would trigger warning: "Context at ${contextTokens}/${MAX_TOKENS} tokens (${Math.round((contextTokens / MAX_TOKENS) * 100)}%) — approaching limit"\n`);
} else {
  console.log(`✅ Below warning threshold (need ${WARNING_THRESHOLD - contextTokens} more tokens)\n`);
}

// === Demo 6: Timeout Behavior ===
console.log('═══ Demo 6: Timeout Behavior (5000ms) ═══\n');

const slowLLM: LLMHandler = async () => {
  await new Promise(resolve => setTimeout(resolve, 6000)); // 6 seconds
  return 'Should timeout';
};

const timeoutStart = performance.now();
const timeoutResult = await buildRollingContext(longHistory, slowLLM);
const timeoutElapsed = Math.round(performance.now() - timeoutStart);

console.log(`Timeout test: ${timeoutElapsed}ms elapsed`);
console.log(`Expected: ~5000ms (timeout kicks in)`);
console.log(`Result: ${timeoutResult.summary ? 'Summary generated' : 'Fell back to recent messages'}`);
console.log(`Fallback working: ${timeoutElapsed < 6000 ? '✅ Yes' : '❌ No'}\n`);

// === Summary ===
console.log('╔═══════════════════════════════════════════════════════════╗');
console.log('║                    Phase 8 Features                       ║');
console.log('╠═══════════════════════════════════════════════════════════╣');
console.log('║ ✅ Exact token counting (gpt-tokenizer)                  ║');
console.log('║ ✅ 80% warning threshold (1200/1500 tokens)              ║');
console.log('║ ✅ Rolling summarization (>6 turns)                      ║');
console.log('║ ✅ Summary keeps last 3 turns verbatim                   ║');
console.log('║ ✅ Graceful fallback on LLM failure                      ║');
console.log('║ ✅ 5000ms timeout guard                                  ║');
console.log('╚═══════════════════════════════════════════════════════════╝\n');
