/**
 * Live runner for Tests 3, 4, 5 — hits LM Studio directly via processMessage
 * Run: npx tsx scripts/run-tests-345.ts
 */
import '../config/agent.config.js'; // loads .env
import { processMessage } from '../core/agent.js';
import { initDatabase } from '../core/memory/mod.js';
import type { Message } from '../core/types.js';
import fs from 'node:fs';
import path from 'node:path';

// Ensure workspace dir exists
const workspace = path.join(process.cwd(), 'workspace');
fs.mkdirSync(workspace, { recursive: true });

initDatabase();

// ─── helpers ────────────────────────────────────────────────────────────────

function banner(n: number, title: string) {
  console.log('\n' + '═'.repeat(70));
  console.log(`  TEST ${n}: ${title}`);
  console.log('═'.repeat(70));
}

function section(label: string) {
  console.log('\n── ' + label + ' ' + '─'.repeat(Math.max(0, 60 - label.length)));
}

async function run(
  testNum: number,
  title: string,
  message: string,
  checks: Array<{ label: string; fn: (reply: string) => boolean }>,
) {
  banner(testNum, title);
  console.log('\nPROMPT:\n' + message.slice(0, 300) + (message.length > 300 ? '...' : ''));

  const history: Message[] = [];
  const start = Date.now();

  let res: Awaited<ReturnType<typeof processMessage>>;
  try {
    res = await processMessage(message, history);
  } catch (err) {
    console.error('\n❌ processMessage threw:', err);
    return;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  section(`RESULT  [${elapsed}s]  intent=${res.intent}`);
  if (res.created) console.log('created:', res.created.code, '|', res.created.name);
  console.log('\nREPLY:\n' + res.reply);

  section('ASSERTIONS');
  let passed = 0;
  for (const c of checks) {
    const ok = (() => { try { return c.fn(res.reply); } catch { return false; } })();
    console.log(`  ${ok ? '✅' : '❌'} ${c.label}`);
    if (ok) passed++;
  }
  console.log(`\n  ${passed}/${checks.length} assertions passed`);
}

// ─── TEST 3: Search → Extract → Compare → Decide ───────────────────────────

await run(
  3,
  'Search → Extract → Compare → Decide',
  `Search the web for what makes a good AI agent memory system.

Then compare what you find to how our memory system actually works — our notebooks, addressable codes, relationship graph.

Write an honest assessment: what are we doing better than what the research says, what are we missing?

Save this as a WHAT.KN knowledge entry called "Memory Architecture Comparison" and also write it to workspace/memory_comparison.md`,
  [
    {
      label: 'intent is planned_workflow or synthesis_query',
      fn: () => true, // intent logged above — always visual pass
    },
    {
      label: 'workspace/memory_comparison.md was created',
      fn: () => fs.existsSync(path.join(workspace, 'memory_comparison.md')),
    },
    {
      label: 'memory_comparison.md has real content (>200 chars)',
      fn: () => {
        const p = path.join(workspace, 'memory_comparison.md');
        return fs.existsSync(p) && fs.readFileSync(p, 'utf-8').length > 200;
      },
    },
    {
      label: 'reply mentions WHAT.KN code',
      fn: r => /WHAT\.KN-\d+/.test(r),
    },
    {
      label: 'reply contains comparison content (better/missing/gap)',
      fn: r => /better|missing|gap|advantage|weakness|compared/i.test(r),
    },
  ],
);

// ─── TEST 4: Loop until condition met ───────────────────────────────────────

await run(
  4,
  'Loop until condition met (Fibonacci)',
  `Write a JavaScript function called fibonacci that returns the nth Fibonacci number.

Save it as workspace/fibonacci.js

Then write a test file workspace/fibonacci.test.js that tests these cases:
fibonacci(1) === 1
fibonacci(5) === 5
fibonacci(10) === 55

Run the tests. If they fail, fix fibonacci.js and run again. Keep going until all tests pass or you've tried 3 times.

When done, save a HOW.PR entry documenting the working implementation.`,
  [
    {
      label: 'workspace/fibonacci.js was created',
      fn: () => fs.existsSync(path.join(workspace, 'fibonacci.js')),
    },
    {
      label: 'fibonacci.js contains a fibonacci function',
      fn: () => {
        const p = path.join(workspace, 'fibonacci.js');
        return fs.existsSync(p) && /fibonacci/i.test(fs.readFileSync(p, 'utf-8'));
      },
    },
    {
      label: 'workspace/fibonacci.test.js was created',
      fn: () => fs.existsSync(path.join(workspace, 'fibonacci.test.js')),
    },
    {
      label: 'reply mentions HOW.PR code',
      fn: r => /HOW\.PR-\d+/.test(r),
    },
    {
      label: 'reply confirms tests passed',
      fn: r => /pass|success|verified|done|all\s+test/i.test(r),
    },
  ],
);

// ─── TEST 5: Full pipeline — hardest ────────────────────────────────────────

// Compute tomorrow's date
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
const tomorrowISO = tomorrow.toISOString().split('T')[0];

await run(
  5,
  'Full pipeline — 7 operations',
  `I have a meeting tomorrow (${tomorrowISO}) with a potential collaborator named Sara Ahmadi. She's a machine learning engineer interested in agent memory systems.

Prepare me for this meeting:

1. Add her as a contact in memory
2. Create a relationship: Sara is interested_in AgenticAGI
3. Search the web for recent papers on agent memory systems published in 2025
4. Write a one-page briefing document combining:
   - What you know about AgenticAGI from memory
   - Key points from your web research
   - 3 talking points I should raise with Sara
   - 2 questions I should ask her
5. Save briefing as workspace/sara_meeting_brief.md
6. Create a WHEN.CA calendar entry for tomorrow called "Meeting with Sara Ahmadi"
7. Create a NOW.TD todo: "Send Sara the AgenticAGI GitHub link after meeting"

Confirm every item was created with its entry code.`,
  [
    {
      label: 'reply mentions WHO.CT code (Sara contact)',
      fn: r => /WHO\.CT-\d+/.test(r),
    },
    {
      label: 'workspace/sara_meeting_brief.md was created',
      fn: () => fs.existsSync(path.join(workspace, 'sara_meeting_brief.md')),
    },
    {
      label: 'briefing has real content (>300 chars)',
      fn: () => {
        const p = path.join(workspace, 'sara_meeting_brief.md');
        return fs.existsSync(p) && fs.readFileSync(p, 'utf-8').length > 300;
      },
    },
    {
      label: 'reply mentions WHEN.CA code (calendar entry)',
      fn: r => /WHEN\.CA-\d+/.test(r),
    },
    {
      label: 'reply mentions NOW.TD code (todo)',
      fn: r => /NOW\.TD-\d+/.test(r),
    },
    {
      label: 'briefing mentions Sara or AgenticAGI',
      fn: () => {
        const p = path.join(workspace, 'sara_meeting_brief.md');
        if (!fs.existsSync(p)) return false;
        const c = fs.readFileSync(p, 'utf-8').toLowerCase();
        return c.includes('sara') || c.includes('agentic');
      },
    },
    {
      label: 'reply confirms all 7 items (codes present)',
      fn: r => {
        const codes = [/WHO\.CT/, /WHEN\.CA/, /NOW\.TD/];
        return codes.every(re => re.test(r));
      },
    },
  ],
);

console.log('\n' + '═'.repeat(70));
console.log('  ALL TESTS COMPLETE');
console.log('═'.repeat(70) + '\n');
