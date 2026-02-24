import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { classifyIntent } from '../../core/intent.js';
import { processMessage } from '../../core/agent.js';
import {
  runHeartbeat,
  checkVisionAlignment,
  checkOverdueTodos,
} from '../../core/heartbeat.js';
import type { Message, LLMHandler } from '../../core/types.js';
import {
  initDatabase,
  closeDatabase,
  createEntry,
} from '../../core/memory/mod.js';
import { addRelationship } from '../../core/memory/relationships.js';
import { getDb } from '../../core/memory/index.js';
import { PATHS } from '../../config/agent.config.js';

// --- Test setup ---

const TEST_DIR = path.join(os.tmpdir(), `stress-planning-${Date.now()}`);
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

// --- Helpers ---

function archiveAllVisions(): void {
  const d = getDb();
  d.prepare("UPDATE index_entries SET status = 'archived' WHERE nb = 'WHY' AND type = 'MT' AND name LIKE '%North Star%'").run();
}

function archiveAllPlansAndProjects(): void {
  const d = getDb();
  d.prepare("UPDATE index_entries SET status = 'archived' WHERE (nb = 'PLAN' AND type = 'PL') OR (nb = 'WHAT' AND type = 'PJ')").run();
}

// --- Group 3: Vision + Planning ---

describe('Group 3: Vision + Planning', () => {
  // Clean vision/plan/project state before each test
  beforeEach(() => {
    archiveAllVisions();
    archiveAllPlansAndProjects();
  });

  // 3A — Vision entry created from natural language
  it('3A: vision entry created from natural language with valid WHY.MT code', async () => {
    const mockLLM: LLMHandler = async (messages: Message[]) => {
      if (messages[0].content.includes('memory writing assistant')) {
        return JSON.stringify({
          nb: 'WHY', type: 'MT', name: 'North Star Vision',
          status: 'active',
          summary: 'Build tools that extend human cognition while keeping humans in control',
          body: 'Our North Star: build tools that extend human cognition while keeping humans in control',
        });
      }
      return 'ok';
    };

    const res = await processMessage(
      'create a vision: build tools that extend human cognition while keeping humans in control',
      [], { llmHandler: mockLLM },
    );

    expect(res.intent).toBe('memory_write');
    expect(res.created).toBeDefined();
    expect(res.created!.nb).toBe('WHY');
    expect(res.created!.type).toBe('MT');
    expect(res.created!.name).toMatch(/North Star|Vision/i);
    expect(res.created!.code).toMatch(/^WHY\.MT-\d{6}$/);
    // Body contains vision text
    const content = fs.readFileSync(res.created!.path, 'utf-8');
    expect(content).toContain('extend human cognition');
  });

  // 3B — Vision alignment check runs in heartbeat, flags unconnected project
  it('3B: unconnected WHAT.PJ project flagged by vision_drift in heartbeat', async () => {
    createEntry({
      nb: 'WHY', type: 'MT', name: 'North Star Vision',
      status: 'active', summary: 'Build the best ceramic analysis platform',
      body: 'Our North Star is ceramic analysis excellence',
    });

    const project = createEntry({
      nb: 'WHAT', type: 'PJ', name: 'Unrelated Social Media Sprint',
      status: 'active', summary: 'Launch social media campaign for shoes',
      body: 'Focus on shoe marketing',
    });

    const hbResult = await runHeartbeat();
    const drift = hbResult.notifications.find(n => n.type === 'vision_drift');
    expect(drift).toBeDefined();
    expect(drift!.entries.some(e => e.code === project.code)).toBe(true);
    expect(drift!.message).toContain('may not align');
    // Notification message mentions the project
    expect(drift!.entries.some(e => e.name === project.name)).toBe(true);
  });

  // 3C — Vision check skipped with no North Star
  it('3C: no North Star entry → checkVisionAlignment returns null, no crash, other checks run', async () => {
    // archiveAllVisions already ran in beforeEach — no active vision exists
    const result = checkVisionAlignment();
    expect(result).toBeNull();

    // Other heartbeat checks still run normally
    const hb = await runHeartbeat();
    // Should not crash — ran_at is set
    expect(hb.ran_at).toBeTruthy();
  });

  // 3D — Connected project not flagged
  it('3D: project with refers relationship to vision is NOT flagged as drifting', () => {
    const vision = createEntry({
      nb: 'WHY', type: 'MT', name: 'North Star Vision',
      status: 'active', summary: 'AI tools for human cognition',
      body: 'Vision text',
    });

    const connectedProject = createEntry({
      nb: 'WHAT', type: 'PJ', name: 'Unrelated But Connected',
      status: 'active', summary: 'This has no keyword overlap at all',
      body: 'Random content about shoes and marketing',
    });

    // Add refers relationship: project → refers → vision
    addRelationship({ from_code: connectedProject.code, relation: 'refers', to_code: vision.code });

    const result = checkVisionAlignment();
    // Connected project should NOT appear in drift entries
    if (result) {
      expect(result.entries.some(e => e.code === connectedProject.code)).toBe(false);
    }
    // Passes — no false positive for connected project
  });

  // 3E — PLAN.PL entry with due_date from natural language
  it('3E: "plan to complete Phase 8 due 2026-03-15" creates PLAN.PL with due_date', async () => {
    const mockLLM: LLMHandler = async (messages: Message[]) => {
      if (messages[0].content.includes('memory writing assistant')) {
        return JSON.stringify({
          nb: 'PLAN', type: 'PL', name: 'Phase 8 Completion',
          status: 'active', summary: 'Complete Phase 8', body: 'Plan to complete Phase 8',
        });
      }
      return 'ok';
    };

    const res = await processMessage('create a plan to complete Phase 8 due 2026-03-15', [], { llmHandler: mockLLM });
    expect(res.intent).toBe('memory_write');
    expect(res.created).toBeDefined();
    expect(res.created!.code).toMatch(/^PLAN\.PL-\d{6}$/);

    // Verify due_date stored in SQLite
    const d = getDb();
    const entry = d.prepare('SELECT due_date FROM index_entries WHERE code = ?').get(res.created!.code) as { due_date: string | null };
    expect(entry.due_date).toBe('2026-03-15');
  });

  // 3F — "due tomorrow" parsed correctly
  it('3F: "plan to review architecture due tomorrow" has correct due_date', () => {
    const c = classifyIntent('plan to review architecture due tomorrow');
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const expected = tomorrow.toISOString().slice(0, 10);
    expect(c.due_date).toBe(expected);
  });

  // 3G — Overdue PLAN entries flagged in heartbeat
  it('3G: PLAN.PL with past due_date and status=active is flagged overdue', () => {
    const plan = createEntry({
      nb: 'PLAN', type: 'PL', name: 'Overdue Stress Plan',
      status: 'active', summary: 'Should be flagged as overdue',
      body: 'This plan is past its due date',
      due_date: '2020-01-01',
    });

    const result = checkOverdueTodos();
    expect(result).not.toBeNull();
    expect(result!.entries.some(e => e.code === plan.code)).toBe(true);

    // Verify status was updated to overdue
    const d = getDb();
    const updated = d.prepare('SELECT status FROM index_entries WHERE code = ?').get(plan.code) as { status: string };
    expect(updated.status).toBe('overdue');
  });

  // 3H — Completed PLAN entries not flagged
  it('3H: PLAN.PL with past due_date but status=closed is NOT flagged overdue', () => {
    const plan = createEntry({
      nb: 'PLAN', type: 'PL', name: 'Completed Past Plan',
      status: 'closed', summary: 'Already done',
      body: 'This was completed',
      due_date: '2020-01-01',
    });

    const result = checkOverdueTodos();
    // The completed plan should NOT appear in overdue entries
    if (result) {
      expect(result.entries.some(e => e.code === plan.code)).toBe(false);
    }
  });

  // 3I — Vision keyword overlap logic works
  it('3I: keyword overlap detected for aligned plan, not for unaligned', () => {
    createEntry({
      nb: 'WHY', type: 'MT', name: 'North Star Vision',
      status: 'active', summary: 'human cognition AI tools',
      body: 'Our vision is human cognition AI tools',
    });

    const aligned = createEntry({
      nb: 'PLAN', type: 'PL', name: 'AI cognition assistant',
      status: 'active', summary: 'Building cognition tools',
      body: 'Aligned plan',
    });

    const unaligned = createEntry({
      nb: 'PLAN', type: 'PL', name: 'Ceramic kiln temperature',
      status: 'active', summary: 'Kiln temperature monitoring',
      body: 'Completely different domain',
    });

    const result = checkVisionAlignment();
    expect(result).not.toBeNull();

    // Aligned plan should NOT be flagged (has keyword overlap: "cognition", "tools")
    expect(result!.entries.some(e => e.code === aligned.code)).toBe(false);

    // Unaligned plan SHOULD be flagged (no keyword overlap)
    expect(result!.entries.some(e => e.code === unaligned.code)).toBe(true);
  });
});
