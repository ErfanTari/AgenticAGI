#!/usr/bin/env node
/**
 * Phase 8 Interactive Demo
 *
 * Demonstrates:
 * - Priority 1: Exact token counting with 80% warning
 * - Priority 2: Rolling context summarization (>6 turns)
 */

import readline from 'node:readline';
import { initDatabase } from './core/memory/mod.js';
import { processMessage, startAgent, stopAgent } from './core/agent.js';
import { estimateTokens, buildContext } from './core/context.js';
import { callLLM } from './core/llm.js';
import type { Message } from './core/types.js';

// Initialize
initDatabase();
startAgent();

const history: Message[] = [];
let turnCount = 0;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log('╔═══════════════════════════════════════════════════════════╗');
console.log('║          Phase 8 Demo: Token Counting & Summarization    ║');
console.log('╚═══════════════════════════════════════════════════════════╝');
console.log('');
console.log('Features to observe:');
console.log('  1. Token counts shown after each message');
console.log('  2. 80% warning when context approaches 1200 tokens');
console.log('  3. Rolling summarization kicks in after 6 turns');
console.log('');
console.log('Commands:');
console.log('  /stats  - Show detailed context statistics');
console.log('  /clear  - Clear conversation history');
console.log('  quit    - Exit');
console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log('');

async function showStats() {
  console.log('\n╔═══ Context Statistics ═══╗');
  console.log(`  Turns: ${turnCount}`);
  console.log(`  Messages in history: ${history.length}`);

  if (history.length > 0) {
    // Build context to see what would be sent to LLM
    const context = await buildContext(
      'test message',
      null,
      history,
      [],
      'general',
      undefined,
      callLLM,
    );

    const totalTokens = estimateTokens(context);
    const percentage = Math.round((totalTokens / 1500) * 100);

    console.log(`  Context tokens: ${totalTokens}/1500 (${percentage}%)`);

    if (turnCount > 6) {
      console.log(`  ⚠️  Rolling summarization active (>6 turns)`);
      const summaryMsg = context.find(m =>
        m.role === 'system' && m.content.includes('Previous Conversation')
      );
      if (summaryMsg) {
        const summaryTokens = estimateTokens(summaryMsg.content);
        console.log(`  Summary tokens: ${summaryTokens}`);
      }
    }

    if (percentage >= 80) {
      console.log('  🔴 WARNING: Approaching token limit!');
    } else if (percentage >= 60) {
      console.log('  🟡 Context getting full');
    } else {
      console.log('  🟢 Context healthy');
    }
  }

  console.log('╚══════════════════════════╝\n');
}

function prompt() {
  const prefix = turnCount > 6 ? '📝' : '💬';
  rl.question(`${prefix} you (turn ${turnCount + 1}) > `, async (input) => {
    const trimmed = input.trim();
    if (!trimmed) return prompt();

    // Commands
    if (trimmed === 'quit' || trimmed === 'exit') {
      console.log('\n👋 Goodbye!\n');
      stopAgent();
      rl.close();
      process.exit(0);
    }

    if (trimmed === '/stats') {
      await showStats();
      return prompt();
    }

    if (trimmed === '/clear') {
      history.length = 0;
      turnCount = 0;
      console.log('\n🗑️  History cleared\n');
      return prompt();
    }

    try {
      const startTime = performance.now();
      const res = await processMessage(trimmed, history);
      const elapsed = Math.round(performance.now() - startTime);

      // Add to history (NO LIMIT - let rolling summarization handle it)
      history.push({ role: 'user', content: trimmed });
      history.push({ role: 'assistant', content: res.reply });
      turnCount++;

      // Calculate token stats
      const userTokens = estimateTokens(trimmed);
      const replyTokens = estimateTokens(res.reply);
      const totalTokens = userTokens + replyTokens;

      console.log(`\n🤖 agent > ${res.reply}`);

      // Show metadata
      const meta: string[] = [];
      if (res.intent !== 'greeting') {
        meta.push(`intent=${res.intent}`);
      }
      if (res.created) meta.push(`created=${res.created.code}`);
      if (res.retries) meta.push(`retries=${res.retries}`);
      if (res.resolved) meta.push(`resolved=${res.resolved.entries.length} entries`);

      if (meta.length > 0) {
        console.log(`          [${meta.join(', ')}]`);
      }

      // Show token info
      console.log(`          [tokens: ${totalTokens} | elapsed: ${elapsed}ms]`);

      // Build context to check if we're approaching limit
      const context = await buildContext(
        'test',
        null,
        history,
        [],
        'general',
        undefined,
        callLLM,
      );
      const contextTokens = estimateTokens(context);
      const percentage = Math.round((contextTokens / 1500) * 100);

      // Show warnings
      if (percentage >= 80) {
        console.log(`          🔴 CONTEXT WARNING: ${contextTokens}/1500 tokens (${percentage}%)`);
      }

      if (turnCount === 7) {
        console.log(`\n✨ Rolling summarization just activated! Old turns are now being summarized.\n`);
      }

      console.log();
    } catch (err) {
      console.error(`\n❌ error > ${err}\n`);
    }

    prompt();
  });
}

console.log('💡 Tip: Have a long conversation (>6 turns) to see rolling summarization in action!\n');
prompt();
