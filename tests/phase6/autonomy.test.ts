import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AUTONOMY_CONFIG, PATHS } from '../../config/agent.config.js';
import {
  initDatabase,
  closeDatabase,
  createEntry,
  queryEntries,
  getEntryByCode,
  updateEntry,
} from '../../core/memory/mod.js';
import {
  getAutonomyStatus,
  runAutonomyCycle,
  startAutonomyLoop,
  stopAutonomyLoop,
} from '../../core/autonomy.js';

const TEST_DIR = path.join(os.tmpdir(), `agentic-agi-autonomy-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'memory.sqlite');
const TEST_MEMORY = path.join(TEST_DIR, 'memory');

const origDb = PATHS.db;
const origMemory = PATHS.memory;

beforeAll(() => {
  (PATHS as Record<string, string>).db = TEST_DB;
  (PATHS as Record<string, string>).memory = TEST_MEMORY;
  initDatabase(TEST_DB);
});

afterAll(() => {
  stopAutonomyLoop();
  closeDatabase();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
});

describe('autonomy loop', () => {
  it('supports loop status + explicit on/off controls', () => {
    stopAutonomyLoop();
    const before = getAutonomyStatus();
    expect(before.loopActive).toBe(false);

    const started = startAutonomyLoop({ force: true });
    expect(started).toBe(true);
    const during = getAutonomyStatus();
    expect(during.loopActive).toBe(true);

    stopAutonomyLoop();
    const after = getAutonomyStatus();
    expect(after.loopActive).toBe(false);
  });

  it('processes open NOW.TD tasks and creates NOW.RP report entries', async () => {
    const task = createEntry({
      nb: 'NOW',
      type: 'TD',
      name: 'Math task',
      status: 'open',
      summary: 'what is 144 divided by 12',
      body: 'Please solve this calculation.',
    });

    const result = await runAutonomyCycle();
    expect(result.processed).toBeGreaterThan(0);
    expect(result.completed).toBeGreaterThan(0);

    const updatedTask = getEntryByCode(task.code);
    expect(updatedTask).toBeDefined();
    expect(updatedTask!.status).toBe('closed');

    const reports = queryEntries({ nb: 'NOW', type: 'RP' })
      .filter(r => r.name.includes(task.code));
    expect(reports.length).toBeGreaterThan(0);
  });

  it('marks task as open again when task execution fails', async () => {
    const missingFile = path.join(TEST_DIR, 'never-created-missing-file.txt');
    fs.rmSync(missingFile, { force: true });

    const badTask = createEntry({
      nb: 'NOW',
      type: 'TD',
      name: 'Missing file read task',
      status: 'open',
      summary: `read the file ${missingFile}`,
      body: 'Attempt reading a file that does not exist.',
    });

    const result = await runAutonomyCycle({ maxTasks: 1 });
    expect(result.processed).toBe(1);

    const updated = getEntryByCode(badTask.code);
    expect(updated).toBeDefined();
    expect(updated!.status).toBe('open');
    expect(updated!.summary).toContain('[autonomy] attempt');
    expect(updated!.summary).toContain('failed');
  });

  it('closes task after max attempts reached', async () => {
    // Isolate queue for deterministic attempt counting.
    const openTasks = queryEntries({ nb: 'NOW', type: 'TD', status: 'open' });
    for (const task of openTasks) {
      updateEntry(task.code, { status: 'closed' });
    }

    const missingFile = path.join(TEST_DIR, `max-attempts-missing-${Date.now()}.txt`);
    const stuckTask = createEntry({
      nb: 'NOW',
      type: 'TD',
      name: 'Stuck task',
      status: 'open',
      summary: `read the file ${missingFile}`,
      body: 'This should keep failing.',
    });

    for (let i = 0; i < AUTONOMY_CONFIG.maxAttemptsPerTask; i += 1) {
      await runAutonomyCycle({ maxTasks: 1 });
    }

    const updated = getEntryByCode(stuckTask.code);
    expect(updated).toBeDefined();
    expect(updated!.status).toBe('closed');
    expect(updated!.summary).toContain('[autonomy/failed]');
  });
});
