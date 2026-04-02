/**
 * Test 1: Memory → Plan → Execute → Verify
 * Uses an isolated temp workspace + memory path and a deterministic LLM stub so
 * the planner/executor pipeline is stable in local and CI environments.
 *
 * Expected flow:
 *   planned_workflow
 *   → memory_write WHAT.PJ (PersianPoetry project)
 *   → memory_write NOW.TD (research Persian poetry APIs)
 *   → file_writer (workspace/poetry.html)
 *   → run_bash (verify file exists + has content)
 *   → reply confirms all codes
 *
 * Run individually: pnpm vitest run tests/phase9/test1-persian-poetry.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { initDatabase, closeDatabase } from '../../core/memory/mod.js';
import { processMessage } from '../../core/agent.js';
import type { LLMHandler, Message } from '../../core/types.js';
import fs from 'node:fs';

// Phase 16: stub assessComplexity so this test continues to exercise
// the decomposeTask+executePlan pipeline.
vi.mock('../../core/planner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/planner.js')>();
  return {
    ...actual,
    assessComplexity: vi.fn().mockResolvedValue({ level: 'HIGH', reason: 'test-stub', estimatedSteps: 5 }),
  };
});
import path from 'node:path';
import os from 'node:os';
import { PATHS } from '../../config/agent.config.js';

const TEST_DIR = path.join(os.tmpdir(), `phase9-persian-poetry-${Date.now()}`);
const TEST_MEMORY = path.join(TEST_DIR, 'memory');
const ORIG_CWD = process.cwd();
const origMemory = PATHS.memory;

function createPersianPoetryLLM(): LLMHandler {
  return async (messages) => {
    const content = messages.map(m => m.content).join(' ');

    if (content.includes('task complexity analyzer')) {
      return JSON.stringify({
        isComplex: true,
        reason: 'Multi-step project setup task',
        estimatedSteps: 4,
        requiresSkills: ['memory_write', 'file_writer', 'run_bash'],
      });
    }

    if (content.includes('task planner')) {
      const html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>PersianPoetry</title></head><body><main><h1>PersianPoetry</h1><p>Hafiz poems with Persian and English translations side by side.</p><article><h2>Sample Poem</h2><p>Persian: الا يا ايها الساقي</p><p>English: O cupbearer, bring the wine.</p></article></main></body></html>';
      return JSON.stringify({
        goal: 'Create the PersianPoetry starter project and prototype',
        steps: [
          {
            id: 'step1',
            description: 'Save the PersianPoetry project in memory',
            skill: 'memory_write',
            input: {
              nb: 'WHAT',
              type: 'PJ',
              name: 'PersianPoetry',
              summary: 'Web app for Hafiz poems with Persian and English translations',
              body: 'PersianPoetry is a web app that displays Hafiz poems with Persian and English translations side by side.',
              status: 'active',
            },
            dependsOn: [],
            storeResultAs: 'project_result',
            optional: false,
          },
          {
            id: 'step2',
            description: 'Create a research todo in memory',
            skill: 'memory_write',
            input: {
              nb: 'NOW',
              type: 'TD',
              name: 'Research Persian poetry APIs',
              summary: 'Research existing Persian poetry APIs this week',
              body: 'Research existing Persian poetry APIs and datasets for PersianPoetry this week.',
              status: 'active',
            },
            dependsOn: [],
            storeResultAs: 'todo_result',
            optional: false,
          },
          {
            id: 'step3',
            description: 'Write the HTML prototype',
            skill: 'file_writer',
            input: {
              path: 'workspace/poetry.html',
              content: html,
            },
            dependsOn: [],
            storeResultAs: 'file_result',
            optional: false,
          },
          {
            id: 'step4',
            description: 'Verify the HTML file exists and has content',
            skill: 'run_bash',
            input: {
              command: 'test -s poetry.html && echo \"verified poetry.html\"',
            },
            dependsOn: ['step3'],
            storeResultAs: 'verify_result',
            optional: false,
          },
        ],
        estimatedDuration: '5s',
      });
    }

    if (content.includes('verification assistant')) {
      return JSON.stringify({
        verified: true,
        confidence: 1,
        issues: [],
      });
    }

    return 'ok';
  };
}

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, 'workspace'), { recursive: true });
  fs.mkdirSync(TEST_MEMORY, { recursive: true });
  process.chdir(TEST_DIR);
  (PATHS as Record<string, string>).memory = TEST_MEMORY;
  // Use an isolated in-memory database — prevents polluting the live memory.sqlite
  initDatabase(':memory:');
});

afterAll(() => {
  closeDatabase();
  (PATHS as Record<string, string>).memory = origMemory;
  process.chdir(ORIG_CWD);
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe('Test 1: Memory → Plan → Execute → Verify (PersianPoetry)', () => {
  it('runs full 5-step pipeline and surfaces entry codes', async () => {
    const history: Message[] = [];

    const msg = [
      "I'm starting a new side project called PersianPoetry,",
      "it's a web app that displays Hafiz poems with Persian and English translations side by side.",
      "",
      "Do the following:",
      "1. Save it as a project in memory",
      "2. Create a todo to research existing Persian poetry APIs this week",
      "3. Write a basic HTML prototype with one sample poem hardcoded, save it as workspace/poetry.html",
      "4. Check the file exists and has content",
      "5. Tell me the entry code for the project and confirm everything was created",
    ].join('\n');

    console.log('\n=== TEST 1 RUNNING ===');
    const start = Date.now();
    const res = await processMessage(msg, history, { llmHandler: createPersianPoetryLLM() });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    // ─── Print full output for inspection ───────────────────────────────────
    console.log(`\n[${elapsed}s] intent=${res.intent}`);
    if (res.created) console.log('created:', res.created.code, '|', res.created.name);
    console.log('\n--- REPLY ---\n', res.reply);

    // ─── Assertions ─────────────────────────────────────────────────────────

    // A1: Must be a planned workflow (5 steps = multi-step task)
    expect(res.intent, 'Expected planned_workflow for multi-step task').toBe('planned_workflow');

    // A2: workspace/poetry.html must exist
    const htmlPath = path.resolve(process.cwd(), 'workspace', 'poetry.html');
    expect(fs.existsSync(htmlPath), 'workspace/poetry.html must be created').toBe(true);

    const html = fs.readFileSync(htmlPath, 'utf-8');
    console.log('\npoetry.html preview (first 200 chars):\n', html.slice(0, 200));
    expect(html.length, 'poetry.html must have real content').toBeGreaterThan(100);

    // A3: HTML should mention Hafiz/Hafez (accept both transliterations)
    const htmlLower = html.toLowerCase();
    expect(htmlLower.includes('hafiz') || htmlLower.includes('hafez') || htmlLower.includes('persian'), 'HTML should mention Hafiz/Hafez or Persian').toBe(true);

    // A4: Reply must contain WHAT.PJ code
    const projectCode = res.reply.match(/WHAT\.PJ-\d+/)?.[0];
    console.log('WHAT.PJ code:', projectCode ?? 'NOT FOUND ❌');
    expect(projectCode, 'Reply must include WHAT.PJ entry code').toBeTruthy();

    // A5: Reply must contain NOW.TD code
    const todoCode = res.reply.match(/NOW\.TD-\d+/)?.[0];
    console.log('NOW.TD code:', todoCode ?? 'NOT FOUND ❌');
    expect(todoCode, 'Reply must include NOW.TD entry code').toBeTruthy();

    // A6: Reply must confirm success
    expect(res.reply.toLowerCase()).toMatch(/created|saved|written|confirmed|done/);

  }, 300_000); // 5 min — LLM planning takes time
});
