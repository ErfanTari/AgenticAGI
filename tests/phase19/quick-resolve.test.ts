import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { extractCodes, extractSearchTerms, quickResolve } from '../../core/memory/quick-resolve.js';
import type { QuickResolveResult } from '../../core/memory/quick-resolve.js';
import { initDatabase, insertEntry } from '../../core/memory/index.js';
import { upsertEntry } from '../../core/memory/write.js';
import { PATHS } from '../../config/agent.config.js';

describe('extractCodes', () => {
  it('extracts a single code from a message', () => {
    expect(extractCodes('Show me WHO.CT-000001')).toEqual(['WHO.CT-000001']);
  });

  it('extracts multiple distinct codes', () => {
    const result = extractCodes('Compare WHO.CT-000001 with WHAT.PJ-000003');
    expect(result).toHaveLength(2);
    expect(result).toContain('WHO.CT-000001');
    expect(result).toContain('WHAT.PJ-000003');
  });

  it('deduplicates repeated codes', () => {
    expect(extractCodes('WHO.CT-000001 and WHO.CT-000001 again')).toEqual(['WHO.CT-000001']);
  });

  it('returns empty array when no codes present', () => {
    expect(extractCodes('Hello, how are you?')).toEqual([]);
  });

  it('does not match incomplete codes', () => {
    expect(extractCodes('WHO.CT without a number')).toEqual([]);
    expect(extractCodes('WHO.CT-12')).toEqual([]);
  });
});

describe('extractSearchTerms', () => {
  it('extracts double-quoted strings', () => {
    const result = extractSearchTerms('find "tennis 3d game" in memory');
    expect(result).toContain('tennis 3d game');
  });

  it('extracts single-quoted strings', () => {
    const result = extractSearchTerms("show me 'activation x-ray' details");
    expect(result).toContain('activation x-ray');
  });

  it('extracts capitalized multi-word phrases', () => {
    const result = extractSearchTerms('tell me about Tennis 3D Game');
    expect(result.some(t => t.includes('Tennis'))).toBe(true);
  });

  it('falls back to non-stopword tokens', () => {
    const result = extractSearchTerms('find the ceramic color work');
    expect(result.length).toBeGreaterThan(0);
    expect(result.some(t => t.toLowerCase() === 'ceramic' || t.toLowerCase() === 'color')).toBe(true);
  });

  it('returns empty for very short stopword-only messages', () => {
    expect(extractSearchTerms('hi')).toEqual([]);
  });

  it('deduplicates identical terms', () => {
    const result = extractSearchTerms('"tennis" and "tennis"');
    const count = result.filter(t => t === 'tennis').length;
    expect(count).toBeLessThanOrEqual(1);
  });
});

describe('quickResolve', () => {
  let tmpDir: string;
  let contactCode: string;
  let projectCode: string;
  let todoCode: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'phase19-quick-resolve-'));
    (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
    (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
    (PATHS as Record<string, string>).index = path.join(tmpDir, 'index');

    initDatabase();

    // Seed test entries
    const { code: cc } = upsertEntry({
      nb: 'WHO',
      type: 'CT',
      name: 'John Smith',
      status: 'active',
      summary: 'A test contact',
      body: '# John Smith\n\nA test contact for quick-resolve testing.',
    });
    contactCode = cc;

    const { code: pc } = upsertEntry({
      nb: 'WHAT',
      type: 'PJ',
      name: 'Tennis 3D Game',
      status: 'active',
      summary: 'A 3D tennis game project',
      body: '# Tennis 3D Game\n\nA 3D tennis game project for testing.',
    });
    projectCode = pc;

    const { code: tc } = upsertEntry({
      nb: 'NOW',
      type: 'TD',
      name: 'Buy groceries',
      status: 'active',
      summary: 'Weekly grocery shopping',
      body: '# Buy groceries\n\nWeekly grocery shopping list.',
    });
    todoCode = tc;
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    (PATHS as Record<string, string>).memory = path.join(process.cwd(), 'memory');
    (PATHS as Record<string, string>).db = path.join(process.cwd(), 'index', 'memory.sqlite');
    (PATHS as Record<string, string>).index = path.join(process.cwd(), 'index');
  });

  it('resolves direct code lookup — single code', async () => {
    const result = await quickResolve(`Show me ${contactCode}`);
    expect(result.resolved).toBe(true);
    expect(result.strategy).toBe('code_lookup');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].code).toBe(contactCode);
  });

  it('resolves direct code lookup — fetches body', async () => {
    const result = await quickResolve(`Show me ${contactCode}`);
    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0].length).toBeGreaterThan(0);
  });

  it('resolves direct code lookup — multiple codes', async () => {
    const result = await quickResolve(`Compare ${contactCode} and ${projectCode}`);
    expect(result.resolved).toBe(true);
    expect(result.strategy).toBe('code_lookup');
    expect(result.entries).toHaveLength(2);
  });

  it('resolves name search for known entry', async () => {
    const result = await quickResolve('tell me about Tennis 3D Game');
    expect(result.resolved).toBe(true);
    expect(result.strategy).toBe('name_search');
    expect(result.entries.length).toBeGreaterThanOrEqual(1);
    // The matched entry should be the Tennis 3D Game project
    expect(result.entries.some(e => e.name === 'Tennis 3D Game')).toBe(true);
  });

  it('returns resolved:false for greetings', async () => {
    const result = await quickResolve('hello, how are you?');
    expect(result.resolved).toBe(false);
    expect(result.strategy).toBe('none');
    expect(result.entries).toHaveLength(0);
  });

  it('returns resolved:false for agentic requests with no known names', async () => {
    const result = await quickResolve('build me a website with a login page');
    expect(result.resolved).toBe(false);
    expect(result.strategy).toBe('none');
  });

  it('returns resolved:false for code that does not exist in database', async () => {
    const result = await quickResolve('Show me WHO.CT-999999');
    expect(result.resolved).toBe(false);
  });
});
