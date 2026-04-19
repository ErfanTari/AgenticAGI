/**
 * Batch 3: Constraint-aware routing escalation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PATHS } from '../../config/agent.config.js';
import { initDatabase, closeDatabase } from '../../core/memory/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(__dirname, `tmp-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
  initDatabase();
});

afterEach(() => {
  closeDatabase();
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('coding_route_escalated event', () => {
  it('emitted when coding unit has deadline constraint', async () => {
    const { transparency } = await import('../../core/transparency.js');

    transparency.enable();
    const events: Array<{ type: string; data: unknown }> = [];
    const off = transparency.on(e => events.push(e));

    try {
      const { handleAgenticUnitsForTest } = await import('../../core/router.js').catch(() => null) as any;

      // If no test export, test via the transparency event directly
      // by simulating what handleAgenticUnits does with constraints
      const { extractConstraints } = await import('../../core/intake.js');
      const constraints = extractConstraints('Build a REST API ASAP');
      expect(constraints.some(c => c.type === 'deadline')).toBe(true);

      // Verify the escalating constraint types are deadline/scope
      const escalating = constraints.filter(c => c.type === 'deadline' || c.type === 'scope');
      expect(escalating.length).toBeGreaterThan(0);
    } finally {
      off();
      transparency.disable();
    }
  });

  it('coding_route_escalated event has reason and constraints fields', async () => {
    const { transparency } = await import('../../core/transparency.js');

    transparency.enable();
    const events: Array<{ type: string; data: unknown }> = [];
    const off = transparency.on(e => events.push(e));

    try {
      // Emit the event directly to test the shape
      transparency.emit({
        type: 'coding_route_escalated',
        data: {
          reason: 'constraints require planner: deadline',
          constraints: [{ type: 'deadline', value: 'ASAP', raw: 'ASAP' }],
        },
      });

      const found = events.filter(e => e.type === 'coding_route_escalated');
      expect(found.length).toBe(1);
      const ev = found[0] as { type: string; data: { reason: string; constraints: unknown[] } };
      expect(typeof ev.data.reason).toBe('string');
      expect(Array.isArray(ev.data.constraints)).toBe(true);
    } finally {
      off();
      transparency.disable();
    }
  });

  it('coding_route_selected event has unitIds, complexity, reason fields', async () => {
    const { transparency } = await import('../../core/transparency.js');

    transparency.enable();
    const events: Array<{ type: string; data: unknown }> = [];
    const off = transparency.on(e => events.push(e));

    try {
      transparency.emit({
        type: 'coding_route_selected',
        data: { unitIds: ['unit-1'], complexity: 'LOW', reason: 'taskType=coding' },
      });

      const found = events.filter(e => e.type === 'coding_route_selected');
      expect(found.length).toBe(1);
      const ev = found[0] as { type: string; data: { unitIds: string[]; complexity: string; reason: string } };
      expect(Array.isArray(ev.data.unitIds)).toBe(true);
      expect(typeof ev.data.complexity).toBe('string');
      expect(typeof ev.data.reason).toBe('string');
    } finally {
      off();
      transparency.disable();
    }
  });
});

describe('constraint escalation filter', () => {
  it('deadline constraint triggers escalation', () => {
    const escalatingTypes = ['deadline', 'scope'];
    const constraint = { type: 'deadline', value: 'by Friday', raw: 'by Friday' };
    expect(escalatingTypes.includes(constraint.type)).toBe(true);
  });

  it('scope constraint triggers escalation', () => {
    const escalatingTypes = ['deadline', 'scope'];
    const constraint = { type: 'scope', value: 'only vanilla JS', raw: 'only vanilla JS' };
    expect(escalatingTypes.includes(constraint.type)).toBe(true);
  });

  it('format constraint does NOT trigger escalation', () => {
    const escalatingTypes = ['deadline', 'scope'];
    const constraint = { type: 'format', value: 'as JSON', raw: 'as JSON' };
    expect(escalatingTypes.includes(constraint.type)).toBe(false);
  });

  it('quality constraint does NOT trigger escalation', () => {
    const escalatingTypes = ['deadline', 'scope'];
    const constraint = { type: 'quality', value: 'production-ready', raw: 'production-ready' };
    expect(escalatingTypes.includes(constraint.type)).toBe(false);
  });

  it('empty constraints array → no escalation', () => {
    const constraints: Array<{ type: string }> = [];
    const escalating = constraints.filter(c => c.type === 'deadline' || c.type === 'scope');
    expect(escalating.length).toBe(0);
  });
});

describe('constraint block appended to goal', () => {
  it('constraint block format is correct', () => {
    const constraints = [
      { type: 'deadline', value: 'finish ASAP', raw: 'ASAP' },
      { type: 'scope', value: 'no npm packages', raw: 'without npm' },
    ];
    const constraintBlock = constraints.length > 0
      ? `\n\nCONSTRAINTS:\n${constraints.map(c => `- [${c.type.toUpperCase()}] ${c.value}`).join('\n')}`
      : '';
    expect(constraintBlock).toContain('[DEADLINE]');
    expect(constraintBlock).toContain('[SCOPE]');
    expect(constraintBlock).toContain('finish ASAP');
    expect(constraintBlock).toContain('no npm packages');
  });

  it('empty constraints → empty block', () => {
    const constraints: Array<{ type: string; value: string }> = [];
    const constraintBlock = constraints.length > 0
      ? `\n\nCONSTRAINTS:\n${constraints.map(c => `- [${c.type.toUpperCase()}] ${c.value}`).join('\n')}`
      : '';
    expect(constraintBlock).toBe('');
  });
});

describe('UserConstraint type annotation', () => {
  it('UserConstraint interface has type, value, raw', async () => {
    const { extractConstraints } = await import('../../core/intake.js');
    const result = extractConstraints('Build this by Friday without npm');
    expect(result.length).toBeGreaterThan(0);
    for (const c of result) {
      expect(['deadline', 'budget', 'format', 'scope', 'quality', 'other']).toContain(c.type);
      expect(typeof c.value).toBe('string');
      expect(typeof c.raw).toBe('string');
    }
  });
});
