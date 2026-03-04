import readline from 'node:readline';
import { initDatabase } from './core/memory/mod.js';
import { processMessage, startAgent, stopAgent } from './core/agent.js';
import { transparency } from './core/transparency.js';
import { attachConsoleRenderer } from './core/transparency-renderer.js';
import type { Message } from './core/types.js';

// Initialize transparency bus based on environment
const TRANSPARENT = process.env.TRANSPARENT === 'true';
const DEBUG_PLANNER = process.env.DEBUG_PLANNER === 'true';
const DEBUG_DEEP = process.env.DEBUG_DEEP === 'true';

if (TRANSPARENT || DEBUG_DEEP) {
  transparency.enable();
  attachConsoleRenderer();
} else if (DEBUG_PLANNER) {
  transparency.enable();
  attachConsoleRenderer(['intent', 'complexity', 'plan', 'step_start', 'step_result', 'memory_write']);
}

// Initialize
initDatabase();
startAgent();

const history: Message[] = [];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log('Agent ready. Type a message and press Enter. Type "quit" to exit.\n');

function prompt() {
  rl.question('you > ', async (input) => {
    const trimmed = input.trim();
    if (!trimmed) return prompt();
    if (trimmed === 'quit' || trimmed === 'exit') {
      stopAgent();
      rl.close();
      process.exit(0);
    }

    try {
      const res = await processMessage(trimmed, history);

      // Keep conversation history (last 6 turns)
      history.push({ role: 'user', content: trimmed });
      history.push({ role: 'assistant', content: res.reply });
      if (history.length > 12) history.splice(0, 2);

      console.log(`\nagent > ${res.reply}`);
      if (res.intent !== 'greeting') {
        const meta = [`intent=${res.intent}`];
        if (res.created) meta.push(`created=${res.created.code}`);
        if (res.retries) meta.push(`retries=${res.retries}`);
        if (res.resolved) meta.push(`step=${res.resolved.step}, entries=${res.resolved.entries.length}`);
        console.log(`       [${meta.join(', ')}]`);
      }
      console.log();
    } catch (err) {
      console.error(`\nerror > ${err}\n`);
    }

    prompt();
  });
}

prompt();
