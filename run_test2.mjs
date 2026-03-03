import { initDatabase } from './dist/core/memory/mod.js';
import { processMessage, startAgent, stopAgent } from './dist/core/agent.js';

initDatabase();
startAgent();

const TEST_PROMPT = `Based on everything you know about me and my projects, write a weekly status report.

It should cover:
- What projects are active
- What deadlines are coming up
- What todos are overdue or due this week
- One honest observation about my workload
- Save the report as workspace/weekly_report.md
- Also save it as a NOW.RP entry in memory`;

console.log('=== TEST 2: Memory Read → Synthesize → Act ===');
console.log('Sending prompt to agent via LM Studio...\n');
console.log('PROMPT:', TEST_PROMPT);
console.log('\n--- AGENT RESPONSE ---\n');

try {
  const res = await processMessage(TEST_PROMPT, []);
  console.log(res.reply);
  console.log('\n--- METADATA ---');
  console.log('Intent:', res.intent);
  console.log('Retries:', res.retries ?? 0);
} catch (err) {
  console.error('ERROR:', err);
} finally {
  stopAgent();
  process.exit(0);
}
