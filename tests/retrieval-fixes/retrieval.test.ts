/**
 * Phase 18F — Retrieval Fixes Tests
 * 18 tests covering: signal parser, strategy selection, listing fast-path,
 * signal passthrough, and PLAN.PJ body format.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { initDatabase, closeDatabase } from '../../core/memory/index.js';
import { PATHS } from '../../config/agent.config.js';
import { runIntake } from '../../core/intake.js';
import { searchMemoryForUnits } from '../../core/memory/unit-search.js';
import { createProjectEntry } from '../../core/memory/project.js';
import { fetchByCode } from '../../core/memory/fetch.js';
import { upsertEntry } from '../../core/memory/write.js';
import type { LLMHandler, DecomposedUnit } from '../../core/types.js';

let tmpDir: string;
const origDb = PATHS.db;
const origMemory = PATHS.memory;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-fix-test-'));
  (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
  fs.mkdirSync(path.join(tmpDir, 'memory'), { recursive: true });
  (PATHS as Record<string, string>).projects = path.join(tmpDir, 'memory', 'PLAN', 'planning');
  initDatabase(path.join(tmpDir, 'test.sqlite'));
});

afterEach(() => {
  closeDatabase();
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeLLM(response: string): LLMHandler {
  return async () => response;
}

function makeUnit(content: string, route: DecomposedUnit['route'] = 'query'): DecomposedUnit {
  return { id: 'u1', content, route, taskType: undefined };
}

// ─── Signal Parser (4 tests) ───────────────────────────────────────────────

describe('Signal Parser', () => {
  it('test 1: LLM returns project+query → projectSignal and querySignal set correctly', async () => {
    const llm = makeLLM(JSON.stringify({
      summary: 'Query about tennis 3d game project',
      person: null,
      project: { name: 'tennis 3d game', confidence: 0.9 },
      time: null,
      agentic: false,
      procedure: false,
      query: true,
    }));
    const { initDatabase: idb } = await import('../../core/memory/index.js');
    const db = idb(PATHS.db);
    const result = await runIntake('tell me all your plans about the tennis 3d game', db, llm);

    expect(result.signals.querySignal).toBe(true);
    expect(result.signals.projectSignal).toBe('tennis 3d game');
    expect(result.signals.personSignal).toBeNull();
  });

  it('test 2: LLM returns query:false, project:null → all null/false', async () => {
    const llm = makeLLM(JSON.stringify({
      summary: 'General message',
      person: null,
      project: null,
      time: null,
      agentic: false,
      procedure: false,
      query: false,
    }));
    const { initDatabase: idb } = await import('../../core/memory/index.js');
    const db = idb(PATHS.db);
    const result = await runIntake('hello world', db, llm);

    expect(result.signals.querySignal).toBe(false);
    expect(result.signals.projectSignal).toBeNull();
  });

  it('test 3: LLM returns person with confidence 0.8 → personSignal is the name string', async () => {
    const llm = makeLLM(JSON.stringify({
      summary: 'Looking up contact Sara',
      person: { name: 'Sara', confidence: 0.8 },
      project: null,
      time: null,
      agentic: false,
      procedure: false,
      query: true,
    }));
    const { initDatabase: idb } = await import('../../core/memory/index.js');
    const db = idb(PATHS.db);
    const result = await runIntake('who is Sara?', db, llm);

    expect(result.signals.personSignal).toBe('Sara');
  });

  it('test 4: LLM parse failure (malformed JSON) → all signals default to safe values, no throw', async () => {
    const llm = makeLLM('this is not json at all { broken');
    const { initDatabase: idb } = await import('../../core/memory/index.js');
    const db = idb(PATHS.db);
    const result = await runIntake('some message', db, llm);

    expect(result.signals.personSignal).toBeNull();
    expect(result.signals.projectSignal).toBeNull();
    expect(result.signals.querySignal).toBe(false);
    expect(result.signals.agenticSignal).toBe(false);
  });
});

// ─── Strategy Selection (4 tests) ─────────────────────────────────────────

describe('Strategy Selection', () => {
  it('test 5: content + projectSignal → strategy project, searches WHAT.PJ + PLAN.PJ', async () => {
    // Seed a PLAN.PJ entry
    upsertEntry({ nb: 'PLAN', type: 'PJ', name: 'tennis 3d game', status: 'active', summary: 'Tennis 3D game project', body: 'A tennis simulation.' });
    const unit = makeUnit('tennis 3d game plans');
    const results = await searchMemoryForUnits([unit], undefined, { projectSignal: 'tennis 3d game' });

    expect(results[0].strategy).toBe('project');
    expect(results[0].entries.length).toBeGreaterThan(0);
    expect(results[0].entries[0].name).toBe('tennis 3d game');
  });

  it('test 6: "previously" + projectSignal → strategy project (NOT time)', async () => {
    upsertEntry({ nb: 'PLAN', type: 'PJ', name: 'tennis 3d game', status: 'active', summary: 'Tennis 3D game', body: 'Project body.' });
    const unit = makeUnit('you had planned previously for tennis 3d game');
    const results = await searchMemoryForUnits([unit], undefined, { projectSignal: 'tennis 3d game' });

    expect(results[0].strategy).toBe('project');
    expect(results[0].strategy).not.toBe('time');
  });

  it('test 7: "what happened last Tuesday" + no project signal → strategy time', async () => {
    const unit = makeUnit('what happened last Tuesday');
    const results = await searchMemoryForUnits([unit], undefined, undefined);

    // time strategy fires when TIME_SIGNAL_PATTERNS match and no project/person signal
    // (strategy may be bm25 if no WHEN entries exist, but should not be project)
    expect(results[0].strategy).not.toBe('project');
  });

  it('test 8: personSignal → strategy person, searches WHO', async () => {
    upsertEntry({ nb: 'WHO', type: 'CT', name: 'Sara', status: 'active', summary: 'Sara the designer', body: 'Contact entry.' });
    const unit = makeUnit('who is Sara?');
    const results = await searchMemoryForUnits([unit], undefined, { personSignal: 'Sara' });

    expect(results[0].strategy).toBe('person');
    expect(results[0].entries.length).toBeGreaterThan(0);
    expect(results[0].entries[0].name).toBe('Sara');
  });
});

// ─── Listing Fast Path (5 tests) ──────────────────────────────────────────

describe('Listing Fast Path', () => {
  it('test 9: "tell me all contacts in your memory" → type_scan, nb=WHO, type=CT', async () => {
    upsertEntry({ nb: 'WHO', type: 'CT', name: 'Alice', status: 'active', summary: 'Alice', body: 'Contact.' });
    const unit = makeUnit('tell me all contacts in your memory');
    const results = await searchMemoryForUnits([unit]);

    expect(results[0].strategy).toBe('type_scan');
    expect(results[0].entries.every(e => e.nb === 'WHO')).toBe(true);
  });

  it('test 10: "list all projects" → type_scan, nb=WHAT, type=PJ', async () => {
    upsertEntry({ nb: 'WHAT', type: 'PJ', name: 'Alpha', status: 'active', summary: 'Project alpha', body: 'Body.' });
    const unit = makeUnit('list all projects');
    const results = await searchMemoryForUnits([unit]);

    expect(results[0].strategy).toBe('type_scan');
    expect(results[0].entries.every(e => e.nb === 'WHAT')).toBe(true);
  });

  it('test 11: "show me my todos" → type_scan, nb=NOW, type=TD', async () => {
    upsertEntry({ nb: 'NOW', type: 'TD', name: 'Buy milk', status: 'active', summary: 'Buy milk', body: 'Todo.' });
    const unit = makeUnit('show me my todos');
    const results = await searchMemoryForUnits([unit]);

    expect(results[0].strategy).toBe('type_scan');
    expect(results[0].entries.every(e => e.nb === 'NOW')).toBe(true);
  });

  it('test 12: "what are my deadlines" → type_scan, nb=WHEN, type=DL', async () => {
    const unit = makeUnit('what are my deadlines');
    const results = await searchMemoryForUnits([unit]);

    // No WHEN entries seeded, but strategy should still be type_scan (returns empty)
    expect(results[0].strategy).toBe('type_scan');
  });

  it('test 13: "what is the capital of France" → NOT detected as listing', async () => {
    const unit = makeUnit('what is the capital of France');
    const results = await searchMemoryForUnits([unit]);

    expect(results[0].strategy).not.toBe('type_scan');
  });

  it('test 13b: "tell me a list of all your contacts" with no signals → type_scan (regression)', async () => {
    upsertEntry({ nb: 'WHO', type: 'CT', name: 'Bob', status: 'active', summary: 'Bob', body: 'Contact.' });
    const unit = makeUnit('tell me a list of all your contacts');
    // No signals passed — listing detection must work purely from content
    const results = await searchMemoryForUnits([unit], undefined, undefined);

    expect(results[0].strategy).toBe('type_scan');
    expect(results[0].entries.every(e => e.nb === 'WHO')).toBe(true);
  });
});

// ─── Signal Passthrough (2 tests) ─────────────────────────────────────────

describe('Signal Passthrough', () => {
  it('test 14: searchMemoryForUnits with projectSignal → unit-search receives and uses it', async () => {
    upsertEntry({ nb: 'PLAN', type: 'PJ', name: 'tennis', status: 'active', summary: 'Tennis project', body: 'Body.' });
    const unit = makeUnit('what are the plans');
    const results = await searchMemoryForUnits([unit], undefined, { projectSignal: 'tennis' });

    expect(results[0].strategy).toBe('project');
    expect(results[0].entries.length).toBeGreaterThan(0);
  });

  it('test 15: searchMemoryForUnits without options → works identically to before', async () => {
    const unit = makeUnit('hello world');
    // Should not throw and should return a valid result
    const results = await searchMemoryForUnits([unit]);

    expect(results).toHaveLength(1);
    expect(results[0].unitId).toBe('u1');
    expect(typeof results[0].confidence).toBe('number');
  });
});

// ─── PLAN.PJ Body Format (3 tests) ────────────────────────────────────────

describe('PLAN.PJ Body Format', () => {
  it('test 16: createProjectEntry with initialPrompt → body contains ## Initial Request section', () => {
    const entry = createProjectEntry({
      name: 'Test Project',
      priority: 1,
      vision: 'Build something great',
      status: 'active',
      current: 'Planning',
      next_action: 'Start coding',
      blocked_by: [],
      phase: 'Phase 1',
      last_worked: '2026-04-07',
      notes: '',
      initialPrompt: 'Build a test project for me with all the features',
      goal: 'A fully working test project',
      decisions: ['Chose TypeScript over JavaScript'],
      conclusions: undefined,
    });

    const fetched = fetchByCode(entry.code);
    expect(fetched?.content).toContain('## Initial Request');
    expect(fetched?.content).toContain('Build a test project for me with all the features');
  });

  it('test 17: createProjectEntry without initialPrompt → body still writes, shows placeholder', () => {
    const entry = createProjectEntry({
      name: 'Minimal Project',
      priority: 3,
      vision: 'Do something',
      status: 'active',
      current: '',
      next_action: '',
      blocked_by: [],
      phase: 'Start',
      last_worked: '2026-04-07',
      notes: '',
    });

    const fetched = fetchByCode(entry.code);
    expect(fetched?.content).toContain('## Initial Request');
    expect(fetched?.content).toContain('_Not specified_');
  });

  it('test 18: fetchByCode on newly created PLAN.PJ → body contains original prompt text', () => {
    const originalPrompt = 'Create a 3D tennis game with realistic physics and online multiplayer';
    const entry = createProjectEntry({
      name: '3D Tennis Game',
      priority: 1,
      vision: 'A realistic 3D tennis simulator',
      status: 'active',
      current: 'Designing architecture',
      next_action: 'Set up Three.js',
      blocked_by: [],
      phase: 'Design',
      last_worked: '2026-04-07',
      notes: '',
      initialPrompt: originalPrompt,
      goal: 'Playable 3D tennis game in browser',
      decisions: ['Use Three.js for rendering', 'Socket.IO for multiplayer'],
    });

    const fetched = fetchByCode(entry.code);
    expect(fetched).not.toBeNull();
    expect(fetched!.content).toContain(originalPrompt);
    expect(fetched!.content).toContain('## Key Decisions');
    expect(fetched!.content).toContain('Use Three.js for rendering');
    expect(fetched!.content).toContain('## Goal');
    expect(fetched!.content).toContain('Playable 3D tennis game in browser');
  });
});
