import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import {
  initDatabase,
  closeDatabase,
  createEntry,
  getDb,
} from '../../core/memory/mod.js';
import { processMessage } from '../../core/agent.js';
import { runHeartbeat } from '../../core/heartbeat.js';

const TEST_DIR = path.join(os.tmpdir(), `agentic-agi-p7-p3-${Date.now()}`);
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
  closeDatabase();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
});

describe('Phase 7 Priority 3 — Basic planning + vision entry', () => {
  it('P3A: creates vision entry with North Star structure', async () => {
    const res = await processMessage(
      'create a vision entry: build tools that extend human cognition while keeping humans in control',
      [],
      { llmHandler: async () => { throw new Error('llm unavailable for deterministic fallback'); } },
    );

    expect(res.intent).toBe('memory_write');
    expect(res.created).toBeDefined();
    expect(res.created!.nb).toBe('WHY');
    expect(res.created!.type).toBe('MT');
    expect(res.created!.name).toContain('North Star');

    const markdown = fs.readFileSync(res.created!.path, 'utf-8');
    expect(markdown).toContain('## Vision');
    expect(markdown).toContain('build tools that extend human cognition while keeping humans in control');
    expect(markdown).toContain('## Mission');
    expect(markdown).toContain('## Filter');
  });

  it('P3B: heartbeat queues vision alignment question for unconnected active projects', async () => {
    const northStar = createEntry({
      nb: 'WHY',
      type: 'MT',
      name: 'North Star',
      status: 'active',
      summary: 'vision anchor',
      body: '## Vision\nkeep humans in control',
    });
    const project = createEntry({
      nb: 'WHAT',
      type: 'PJ',
      name: 'Unlinked Project',
      status: 'active',
      summary: 'needs vision link',
      body: 'Project body',
    });

    const result = await runHeartbeat();
    const visionNotice = result.notifications.find(n => n.type === 'vision_alignment');
    expect(visionNotice).toBeDefined();
    expect(visionNotice!.message).toContain(`Project '${project.name}' has no stated connection to your vision`);
    expect(visionNotice!.entries.some(e => e.code === project.code)).toBe(true);

    const d = getDb();
    const queueRows = d.prepare('SELECT message FROM heartbeat_queue WHERE message LIKE ?').all('%Still relevant?%') as Array<{ message: string }>;
    expect(queueRows.length).toBeGreaterThan(0);
    expect(queueRows[0].message).toContain('Still relevant?');

    // keep northStar referenced to avoid lint-like unused warning patterns in strict setups
    expect(northStar.code).toMatch(/^WHY\.MT-/);
  });

  it('P3C: vision check is skipped when no North Star exists', async () => {
    const d = getDb();
    d.prepare("UPDATE index_entries SET name = 'Archived Vision' WHERE nb = 'WHY' AND type = 'MT'").run();

    createEntry({
      nb: 'WHAT',
      type: 'PJ',
      name: 'Project Without Vision Check',
      status: 'active',
      summary: 'no north star present',
      body: 'body',
    });

    const result = await runHeartbeat();
    expect(result.notifications.some(n => n.type === 'vision_alignment')).toBe(false);
  });

  it('P3D: creates PLAN.PL entry with due_date from natural language', async () => {
    const res = await processMessage(
      'plan to complete Phase 7 by March 15',
      [],
      { llmHandler: async () => { throw new Error('llm unavailable for deterministic fallback'); } },
    );

    expect(res.intent).toBe('memory_write');
    expect(res.created).toBeDefined();
    expect(res.created!.nb).toBe('PLAN');
    expect(res.created!.type).toBe('PL');

    const row = getDb().prepare('SELECT due_date FROM index_entries WHERE code = ?').get(res.created!.code) as { due_date: string | null };
    expect(row.due_date).toBe('2026-03-15');
  });

  it('P3E: heartbeat flags overdue PLAN.PL entries', async () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 3);
    const due = oldDate.toISOString().slice(0, 10);

    const plan = createEntry({
      nb: 'PLAN',
      type: 'PL',
      name: 'Overdue plan check',
      status: 'active',
      summary: 'should be flagged',
      body: 'body',
      due_date: due,
    });

    const result = await runHeartbeat();
    const overdueNotice = result.notifications.find(n => n.type === 'overdue_plan');
    expect(overdueNotice).toBeDefined();
    expect(overdueNotice!.entries.some(e => e.code === plan.code)).toBe(true);
  });
});
