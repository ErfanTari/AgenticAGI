/**
 * Batch 2: Constraint extraction from intake
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

describe('extractConstraints', () => {
  it('detects deadline constraint — "by Friday"', async () => {
    const { extractConstraints } = await import('../../core/intake.js');
    const result = extractConstraints('Build me a REST API by Friday');
    expect(result.some(c => c.type === 'deadline')).toBe(true);
  });

  it('detects deadline constraint — "ASAP"', async () => {
    const { extractConstraints } = await import('../../core/intake.js');
    const result = extractConstraints('Fix this bug ASAP');
    expect(result.some(c => c.type === 'deadline')).toBe(true);
  });

  it('detects deadline constraint — "within 2 weeks"', async () => {
    const { extractConstraints } = await import('../../core/intake.js');
    const result = extractConstraints('I need this done within 2 weeks');
    expect(result.some(c => c.type === 'deadline')).toBe(true);
  });

  it('detects format constraint — "as JSON"', async () => {
    const { extractConstraints } = await import('../../core/intake.js');
    const result = extractConstraints('Give me the output as JSON');
    expect(result.some(c => c.type === 'format')).toBe(true);
  });

  it('detects format constraint — "single-file"', async () => {
    const { extractConstraints } = await import('../../core/intake.js');
    const result = extractConstraints('Create a single-file HTML page');
    expect(result.some(c => c.type === 'format')).toBe(true);
  });

  it('detects scope constraint — "only"', async () => {
    const { extractConstraints } = await import('../../core/intake.js');
    const result = extractConstraints('Only use vanilla JavaScript, no frameworks');
    expect(result.some(c => c.type === 'scope')).toBe(true);
  });

  it('detects scope constraint — "without npm"', async () => {
    const { extractConstraints } = await import('../../core/intake.js');
    const result = extractConstraints('Build it without npm dependencies');
    expect(result.some(c => c.type === 'scope')).toBe(true);
  });

  it('detects quality constraint — "production-ready"', async () => {
    const { extractConstraints } = await import('../../core/intake.js');
    const result = extractConstraints('I need production-ready code with tests');
    expect(result.some(c => c.type === 'quality')).toBe(true);
  });

  it('returns empty array for message with no constraints', async () => {
    const { extractConstraints } = await import('../../core/intake.js');
    const result = extractConstraints('Build me a landing page');
    expect(result).toHaveLength(0);
  });

  it('deduplicates identical constraint matches', async () => {
    const { extractConstraints } = await import('../../core/intake.js');
    const result = extractConstraints('Only use vanilla JS, only plain text');
    const scopeConstraints = result.filter(c => c.type === 'scope');
    // Should not have exact duplicates
    const rawValues = scopeConstraints.map(c => c.raw.toLowerCase());
    const unique = new Set(rawValues);
    expect(unique.size).toBe(rawValues.length);
  });

  it('constraint object has type, value, and raw fields', async () => {
    const { extractConstraints } = await import('../../core/intake.js');
    const result = extractConstraints('Finish this by tomorrow');
    expect(result.length).toBeGreaterThan(0);
    const c = result[0];
    expect(typeof c.type).toBe('string');
    expect(typeof c.value).toBe('string');
    expect(typeof c.raw).toBe('string');
  });
});

describe('IntakeResult includes constraints', () => {
  it('runIntake returns constraints array (may be empty)', async () => {
    const { runIntake } = await import('../../core/intake.js');
    const { getDb } = await import('../../core/memory/index.js');
    const db = getDb();
    const mockLLM = async () => JSON.stringify({
      summary: 'test',
      person: null,
      project: null,
      time: null,
      agentic: false,
      procedure: false,
      query: false,
    });
    const result = await runIntake('Build me a page', db, mockLLM as any);
    expect(Array.isArray(result.constraints)).toBe(true);
  });

  it('runIntake populates constraints for messages with recognized patterns', async () => {
    const { runIntake } = await import('../../core/intake.js');
    const { getDb } = await import('../../core/memory/index.js');
    const db = getDb();
    const mockLLM = async () => JSON.stringify({
      summary: 'test',
      person: null,
      project: null,
      time: null,
      agentic: true,
      procedure: false,
      query: false,
    });
    const result = await runIntake('Build me a REST API ASAP without any npm packages', db, mockLLM as any);
    expect(result.constraints.length).toBeGreaterThan(0);
    expect(result.constraints.some(c => c.type === 'deadline')).toBe(true);
  });
});

describe('user_constraints_extracted transparency event', () => {
  it('emitted when constraints are found', async () => {
    const { transparency } = await import('../../core/transparency.js');
    const { runIntake } = await import('../../core/intake.js');
    const { getDb } = await import('../../core/memory/index.js');

    transparency.enable();
    const events: Array<{ type: string; data: unknown }> = [];
    const off = transparency.on(e => events.push(e));

    try {
      const db = getDb();
      const mockLLM = async () => JSON.stringify({
        summary: 'test', person: null, project: null, time: null,
        agentic: false, procedure: false, query: false,
      });
      await runIntake('Finish by tomorrow and keep it minimal', db, mockLLM as any);
      const found = events.filter(e => e.type === 'user_constraints_extracted');
      expect(found.length).toBe(1);
    } finally {
      off();
      transparency.disable();
    }
  });

  it('NOT emitted when message has no constraints', async () => {
    const { transparency } = await import('../../core/transparency.js');
    const { runIntake } = await import('../../core/intake.js');
    const { getDb } = await import('../../core/memory/index.js');

    transparency.enable();
    const events: Array<{ type: string }> = [];
    const off = transparency.on(e => events.push(e));

    try {
      const db = getDb();
      const mockLLM = async () => JSON.stringify({
        summary: 'hello', person: null, project: null, time: null,
        agentic: false, procedure: false, query: false,
      });
      await runIntake('Hello, how are you?', db, mockLLM as any);
      const found = events.filter(e => e.type === 'user_constraints_extracted');
      expect(found).toHaveLength(0);
    } finally {
      off();
      transparency.disable();
    }
  });
});
