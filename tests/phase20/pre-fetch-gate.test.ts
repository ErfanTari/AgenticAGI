import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { initDatabase, closeDatabase, getDb } from '../../core/memory/index.js';
import { PATHS } from '../../config/agent.config.js';
import { extractCodes, extractIdentityTarget, extractSearchTerms, detectListingQuery, quickResolve } from '../../core/memory/quick-resolve.js';
import { sanitizeFinalOutput } from '../../core/llm.js';

let tmpDir: string;
const origDb = PATHS.db;
const origMemory = PATHS.memory;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase20-test-'));
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
  const codes = [
    { code: 'WHO.CT-000076', nb: 'WHO', type: 'CT', name: 'Zaraban', status: 'active', summary: 'AI agent platform', path: '/tmp/zaraban.md', updated: '2026-04-07' },
    { code: 'WHO.CT-000001', nb: 'WHO', type: 'CT', name: 'Erfan Tari', status: 'active', summary: 'Owner and developer', path: '/tmp/erfan.md', updated: '2026-04-07' },
    { code: 'WHO.ORG-000001', nb: 'WHO', type: 'ORG', name: 'Acme Inc', status: 'active', summary: 'Partner company', path: '/tmp/acme.md', updated: '2026-04-07' },
    { code: 'PLAN.PJ-000003', nb: 'PLAN', type: 'PJ', name: 'Activation X-Ray', status: 'active', summary: 'AI interpretability project', path: '/tmp/xray.md', updated: '2026-04-07' },
    { code: 'PLAN.PJ-000002', nb: 'PLAN', type: 'PJ', name: 'Tennis 3D', status: 'active', summary: '3D visualization project', path: '/tmp/tennis.md', updated: '2026-04-07' },
    { code: 'WHAT.KN-000010', nb: 'WHAT', type: 'KN', name: 'Favorite Color', status: 'active', summary: 'Ceramic blue', path: '/tmp/color.md', updated: '2026-04-07' },
    { code: 'HOW.PR-000044', nb: 'HOW', type: 'PR', name: 'Code Review Procedure', status: 'active', summary: 'Standard review steps', path: '/tmp/review.md', updated: '2026-04-07' },
    { code: 'NOW.TD-000020', nb: 'NOW', type: 'TD', name: 'Fix bug in agent', status: 'active', summary: 'High priority', path: '/tmp/bug.md', updated: '2026-04-07' },
    { code: 'NOW.TD-000021', nb: 'NOW', type: 'TD', name: 'Write tests', status: 'active', summary: 'Phase 20 tests', path: '/tmp/tests.md', updated: '2026-04-07' },
  ];

  for (const entry of codes) {
    db.prepare(`
      INSERT OR IGNORE INTO index_entries (code, nb, type, name, status, summary, path, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entry.code, entry.nb, entry.type, entry.name, entry.status, entry.summary, entry.path, entry.updated);
  }
}

describe('Phase 20 — Pre-Fetch Gate', () => {

  // ── extractCodes (6 tests) ──

  describe('extractCodes', () => {
    it('extracts bare code WHO.CT-000076', () => {
      expect(extractCodes('WHO.CT-000076')).toEqual(['WHO.CT-000076']);
    });

    it('extracts code with underscore suffix', () => {
      expect(extractCodes('WHO.CT-000076_zaraban')).toEqual(['WHO.CT-000076']);
    });

    it('extracts code embedded in question', () => {
      const codes = extractCodes('who is WHO.CT-000076_zaraban?');
      expect(codes).toContain('WHO.CT-000076');
    });

    it('extracts multiple codes with suffixes', () => {
      const codes = extractCodes('Compare WHO.CT-000076_zaraban with PLAN.PJ-000003_xray');
      expect(codes).toContain('WHO.CT-000076');
      expect(codes).toContain('PLAN.PJ-000003');
    });

    it('returns empty for non-codes', () => {
      expect(extractCodes('hello world')).toEqual([]);
    });

    it('returns empty for partial codes', () => {
      expect(extractCodes('WHO.CT-007')).toEqual([]);
    });
  });

  // ── extractIdentityTarget (6 tests) ──

  describe('extractIdentityTarget', () => {
    it('detects "who is X"', () => {
      expect(extractIdentityTarget('who is Zaraban')).toBe('Zaraban');
    });

    it('detects "who is X?" with question mark', () => {
      expect(extractIdentityTarget('who is Erfan Tari?')).toBe('Erfan Tari');
    });

    it('detects "tell me about X"', () => {
      expect(extractIdentityTarget('tell me about Erfan Tari')).toBe('Erfan Tari');
    });

    it('detects "what does X do"', () => {
      expect(extractIdentityTarget('what does Zaraban do')).toBe('Zaraban');
    });

    it('strips embedded code from target', () => {
      const target = extractIdentityTarget('who is WHO.CT-000076_zaraban?');
      expect(target).toBeTruthy();
      expect(target).not.toContain('WHO.CT');
    });

    it('returns null for non-identity questions', () => {
      expect(extractIdentityTarget('build me a website')).toBeNull();
      expect(extractIdentityTarget('hello')).toBeNull();
    });
  });

  // ── detectListingQuery (5 tests) ──

  describe('detectListingQuery', () => {
    it('detects "show all contacts"', () => {
      const result = detectListingQuery('show all contacts');
      expect(result).toEqual({ nb: 'WHO', type: 'CT' });
    });

    it('detects "list projects"', () => {
      const result = detectListingQuery('list projects');
      expect(result).toEqual({ nb: 'PLAN', type: 'PJ' });
    });

    it('detects "what are my todos"', () => {
      const result = detectListingQuery('what are my todos');
      expect(result).toEqual({ nb: 'NOW', type: 'TD' });
    });

    it('returns null without listing language', () => {
      expect(detectListingQuery('contacts are important')).toBeNull();
    });

    it('returns null for unrecognized keywords', () => {
      expect(detectListingQuery('show all bananas')).toBeNull();
    });
  });

  // ── quickResolve integration (5 tests) ──

  describe('quickResolve', () => {
    it('resolves code lookup', async () => {
      const result = await quickResolve('WHO.CT-000076');
      expect(result.resolved).toBe(true);
      expect(result.strategy).toBe('code_lookup');
      expect(result.entries[0]?.code).toBe('WHO.CT-000076');
    });

    it('resolves identity question', async () => {
      const result = await quickResolve('who is Zaraban');
      expect(result.resolved).toBe(true);
      expect(result.entries.some(e => e.name.toLowerCase().includes('zaraban'))).toBe(true);
    });

    it('resolves listing query', async () => {
      const result = await quickResolve('show all contacts');
      expect(result.resolved).toBe(true);
      expect(result.strategy).toBe('type_scan');
      expect(result.entries.length).toBeGreaterThan(0);
      expect(result.entries.every(e => e.nb === 'WHO' && e.type === 'CT')).toBe(true);
    });

    it('returns resolved:false for agentic request', async () => {
      const result = await quickResolve('build me a website');
      expect(result.resolved).toBe(false);
    });

    it('returns resolved:false for greeting', async () => {
      const result = await quickResolve('hello');
      expect(result.resolved).toBe(false);
    });
  });

  // ── sanitizeFinalOutput (3 tests) ──

  describe('sanitizeFinalOutput', () => {
    it('strips control tokens', () => {
      const dirty = 'Zaraban is an AI.<|tool_call|><|tool_response|>';
      const clean = sanitizeFinalOutput(dirty);
      expect(clean).toBe('Zaraban is an AI.');
    });

    it('strips thinking preambles', () => {
      const dirty = 'Let me search the memory for this.\nZaraban is an AI.';
      const clean = sanitizeFinalOutput(dirty);
      expect(clean).not.toContain('Let me search');
      expect(clean).toContain('Zaraban is an AI.');
    });

    it('preserves clean text', () => {
      expect(sanitizeFinalOutput('Hello, I am Zaraban.')).toBe('Hello, I am Zaraban.');
    });
  });

  // ── extractSearchTerms (2 tests) ──

  describe('extractSearchTerms', () => {
    it('extracts quoted phrases', () => {
      const terms = extractSearchTerms('find "Tennis 3D" for me');
      expect(terms).toContain('Tennis 3D');
    });

    it('extracts capitalized phrases', () => {
      const terms = extractSearchTerms('show me Activation X-Ray');
      expect(terms.length).toBeGreaterThan(0);
    });
  });
});
