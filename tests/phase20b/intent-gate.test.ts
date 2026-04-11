/**
 * Phase 20b — Intent-Aware Gate Tests
 *
 * Tests for command detection, context capping, and intent-aware synthesis.
 * Fixes the "RAG Prison" bug where "write a Tetris game" was trapped by
 * broad name search matches (126 entries for "workspace").
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { initDatabase, closeDatabase, getDb } from '../../core/memory/index.js';
import { PATHS } from '../../config/agent.config.js';
import { isCommandIntent, quickResolve } from '../../core/memory/quick-resolve.js';
import { createEntry } from '../../core/memory/write.js';

let tmpDir: string;
const origDb = PATHS.db;
const origMemory = PATHS.memory;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase20b-test-'));
  (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
  fs.mkdirSync(path.join(tmpDir, 'memory'), { recursive: true });
  initDatabase(path.join(tmpDir, 'test.sqlite'));
  seedDatabase();
});

afterEach(() => {
  closeDatabase();
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedDatabase(): void {
  const db = getDb();

  // Seed some normal entries
  const entries = [
    { code: 'WHO.CT-000076', nb: 'WHO', type: 'CT', name: 'Zaraban', status: 'active', summary: 'AI agent', path: '/tmp/zaraban.md', updated: '2026-04-07' },
    { code: 'WHO.CT-000001', nb: 'WHO', type: 'CT', name: 'Erfan Tari', status: 'active', summary: 'Owner', path: '/tmp/erfan.md', updated: '2026-04-07' },
    { code: 'WHAT.PJ-000003', nb: 'WHAT', type: 'PJ', name: 'Activation X-Ray', status: 'active', summary: 'Project', path: '/tmp/xray.md', updated: '2026-04-07' },
  ];

  for (const e of entries) {
    db.prepare(`
      INSERT OR IGNORE INTO index_entries (code, nb, type, name, status, summary, path, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.code, e.nb, e.type, e.name, e.status, e.summary, e.path, e.updated);
  }

  // Seed 15 entries with "workspace" in name to test context cap
  for (let i = 1; i <= 15; i++) {
    const code = `NOW.TD-${String(1000 + i).padStart(6, '0')}`;
    const name = `workspace-task-${i}`;
    db.prepare(`
      INSERT OR IGNORE INTO index_entries (code, nb, type, name, status, summary, path, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(code, 'NOW', 'TD', name, 'active', 'task', `/tmp/${name}.md`, '2026-04-07');
  }
}

describe('Phase 20b — Intent-Aware Gate', () => {

  // ── isCommandIntent (10 tests) ──

  describe('isCommandIntent', () => {
    it('detects "write a Tetris game"', () => {
      expect(isCommandIntent('write a Tetris game')).toBe(true);
    });

    it('detects "create a new project"', () => {
      expect(isCommandIntent('create a new project')).toBe(true);
    });

    it('detects "build me a website"', () => {
      expect(isCommandIntent('build me a website')).toBe(true);
    });

    it('detects "run the test suite"', () => {
      expect(isCommandIntent('run the test suite')).toBe(true);
    });

    it('detects "can you write a function"', () => {
      expect(isCommandIntent('can you write a function that sorts arrays')).toBe(true);
    });

    it('detects "please create a dashboard"', () => {
      expect(isCommandIntent('please create a dashboard for my data')).toBe(true);
    });

    it('detects "fix the bug in main.ts"', () => {
      expect(isCommandIntent('fix the bug in main.ts')).toBe(true);
    });

    it('detects agent-name prefixed imperative commands', () => {
      expect(isCommandIntent('Zaraban, build me a website')).toBe(true);
    });

    it('detects greeting-prefixed assistant commands', () => {
      expect(isCommandIntent('Hi Zaraban, create a Node.js API')).toBe(true);
    });

    it('does NOT detect "who is Zaraban"', () => {
      expect(isCommandIntent('who is Zaraban')).toBe(false);
    });

    it('does NOT detect "show all contacts"', () => {
      expect(isCommandIntent('show all contacts')).toBe(false);
    });

    it('does NOT detect "tell me about the project"', () => {
      expect(isCommandIntent('tell me about the project')).toBe(false);
    });
  });

  // ── quickResolve command bypass (5 tests) ──

  describe('quickResolve — command bypass', () => {

    it('returns resolved:false for "write a Tetris game"', async () => {
      const result = await quickResolve('write a Tetris game');
      expect(result.resolved).toBe(false);
    });

    it('returns resolved:false for "build me a website with login"', async () => {
      const result = await quickResolve('build me a website with login');
      expect(result.resolved).toBe(false);
    });

    it('returns resolved:false for "create a Snake game in JavaScript"', async () => {
      const result = await quickResolve('create a Snake game in JavaScript');
      expect(result.resolved).toBe(false);
    });

    it('returns resolved:false for agent-name prefixed build requests', async () => {
      const result = await quickResolve('Zaraban, build me a small Node.js REST API');
      expect(result.resolved).toBe(false);
    });

    it('returns resolved:false for greeting-prefixed build requests', async () => {
      const result = await quickResolve('Hi Zaraban, create a Node.js REST API with tests');
      expect(result.resolved).toBe(false);
    });

    it('still resolves code lookup even in commands', async () => {
      // "update WHO.CT-000076" contains a code AND is a command
      const result = await quickResolve('update WHO.CT-000076');
      expect(result.resolved).toBe(true);
      expect(result.strategy).toBe('code_lookup');
      expect(result.isCommand).toBe(true);
    });

    it('still resolves pure retrieval queries', async () => {
      const result = await quickResolve('who is Zaraban');
      expect(result.resolved).toBe(true);
      expect(result.isCommand).toBeFalsy();
    });
  });

  // ── Context cap (3 tests) ──

  describe('quickResolve — context cap', () => {

    it('returns resolved:false when name search matches >10 entries', async () => {
      // We seeded 15 entries with "workspace" in name
      // With cap at 10, name search should skip this term and fall through
      const result = await quickResolve('tell me about workspace');
      expect(result.resolved).toBe(false);
    });

    it('returns resolved:true when name search matches <=10 entries', async () => {
      // "Zaraban" matches 1 entry
      const result = await quickResolve('who is Zaraban');
      expect(result.resolved).toBe(true);
      expect(result.entries.length).toBeLessThanOrEqual(10);
    });

    it('listing queries are not affected by cap', async () => {
      // Listings can return many entries — they don't use name search
      const result = await quickResolve('show all contacts');
      expect(result.resolved).toBe(true);
      // Listing should still resolve even with many results
    });
  });

  // ── Regression: retrieval still works (2 tests) ──

  describe('quickResolve — retrieval regression', () => {

    it('still resolves "WHO.CT-000076" via code lookup', async () => {
      const result = await quickResolve('WHO.CT-000076');
      expect(result.resolved).toBe(true);
      expect(result.strategy).toBe('code_lookup');
      expect(result.isCommand).toBeFalsy();
    });

    it('still resolves "show all contacts" via listing', async () => {
      const result = await quickResolve('show all contacts');
      expect(result.resolved).toBe(true);
    });
  });
});
