import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  initDatabase,
  closeDatabase,
  parseCode,
  generateCode,
  createEntry,
  fetchByCode,
  queryEntries,
} from '../../core/memory/mod.js';
import { PATHS } from '../../config/agent.config.js';

const TEST_DB = path.join(os.tmpdir(), `agentic-agi-test-${Date.now()}`, 'memory.sqlite');
const TEST_MEMORY = path.join(os.tmpdir(), `agentic-agi-test-${Date.now()}`, 'memory');

// Override PATHS for test isolation
const origDb = PATHS.db;
const origMemory = PATHS.memory;

beforeAll(() => {
  // Temporarily override PATHS for test isolation
  (PATHS as Record<string, string>).db = TEST_DB;
  (PATHS as Record<string, string>).memory = TEST_MEMORY;
  initDatabase(TEST_DB);
});

afterAll(() => {
  closeDatabase();
  // Clean up test artifacts
  const testDir = path.dirname(TEST_DB);
  fs.rmSync(testDir, { recursive: true, force: true });
  // Restore original paths
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
});

describe('parseCode', () => {
  it('parses a valid code', () => {
    const result = parseCode('WHO.CT-0024');
    expect(result).toEqual({ nb: 'WHO', type: 'CT', number: 24 });
  });

  it('returns undefined for invalid codes', () => {
    expect(parseCode('invalid')).toBeUndefined();
    expect(parseCode('WHO.CT')).toBeUndefined();
    expect(parseCode('WHO.CT-')).toBeUndefined();
    expect(parseCode('')).toBeUndefined();
  });
});

describe('generateCode', () => {
  it('generates the first code as 0001', () => {
    const code = generateCode('WHO', 'CT');
    expect(code).toBe('WHO.CT-0001');
  });

  it('throws for invalid notebook+type', () => {
    expect(() => generateCode('FAKE', 'XX')).toThrow('Invalid notebook+type');
  });
});

describe('createEntry', () => {
  it('creates a contact entry with correct code, file, and index row', () => {
    const entry = createEntry({
      nb: 'WHO',
      type: 'CT',
      name: 'Erfan Tari',
      status: 'active',
      summary: 'Owner, developer, ceramic specialist',
      body: '## Communication\n- email: erfan@anatolia.com',
    });

    // Code matches pattern
    expect(entry.code).toMatch(/^WHO\.CT-\d{4}$/);

    // File exists on disk
    expect(fs.existsSync(entry.path)).toBe(true);

    // File contains correct frontmatter and heading
    const content = fs.readFileSync(entry.path, 'utf-8');
    expect(content).toContain(`code: ${entry.code}`);
    expect(content).toContain('# Erfan Tari');

    // SQLite has the row
    const results = queryEntries({ nb: 'WHO', type: 'CT' });
    const found = results.find(r => r.code === entry.code);
    expect(found).toBeDefined();
    expect(found!.path).toBe(entry.path);
  });

  it('generates sequential codes for the same type', () => {
    const first = createEntry({
      nb: 'WHAT',
      type: 'PJ',
      name: 'Project Alpha',
      status: 'active',
      summary: 'First project',
      body: 'Details about Alpha.',
    });

    const second = createEntry({
      nb: 'WHAT',
      type: 'PJ',
      name: 'Project Beta',
      status: 'active',
      summary: 'Second project',
      body: 'Details about Beta.',
    });

    const firstNum = parseCode(first.code)!.number;
    const secondNum = parseCode(second.code)!.number;
    expect(secondNum).toBe(firstNum + 1);
  });
});

describe('fetchByCode', () => {
  it('returns entry + content for a valid code', () => {
    const entry = createEntry({
      nb: 'HOW',
      type: 'PR',
      name: 'Deploy Procedure',
      status: 'active',
      summary: 'How to deploy the app',
      body: '## Steps\n1. Build\n2. Test\n3. Deploy',
    });

    const result = fetchByCode(entry.code);
    expect(result).toBeDefined();
    expect(result!.entry.code).toBe(entry.code);
    expect(result!.content).toContain('# Deploy Procedure');
    expect(result!.content).toContain('## Steps');
  });

  it('returns undefined for a nonexistent code', () => {
    const result = fetchByCode('WHO.CT-9999');
    expect(result).toBeUndefined();
  });
});

describe('queryEntries', () => {
  it('filters by notebook', () => {
    const results = queryEntries({ nb: 'WHO' });
    expect(results.length).toBeGreaterThan(0);
    results.forEach(r => expect(r.nb).toBe('WHO'));
  });

  it('filters by status', () => {
    const results = queryEntries({ status: 'active' });
    expect(results.length).toBeGreaterThan(0);
    results.forEach(r => expect(r.status).toBe('active'));
  });

  it('filters by name (partial match)', () => {
    const results = queryEntries({ name: 'Erfan' });
    expect(results.length).toBeGreaterThan(0);
    results.forEach(r => expect(r.name).toContain('Erfan'));
  });

  it('combines multiple filters', () => {
    const results = queryEntries({ nb: 'WHO', type: 'CT', status: 'active' });
    expect(results.length).toBeGreaterThan(0);
    results.forEach(r => {
      expect(r.nb).toBe('WHO');
      expect(r.type).toBe('CT');
      expect(r.status).toBe('active');
    });
  });

  it('returns empty array when no matches', () => {
    const results = queryEntries({ nb: 'WHO', status: 'nonexistent' });
    expect(results).toEqual([]);
  });
});

describe('performance', () => {
  it('create + fetch cycle completes in under 50ms', () => {
    const start = performance.now();

    const entry = createEntry({
      nb: 'NOW',
      type: 'TD',
      name: 'Quick Task',
      status: 'open',
      summary: 'Performance test task',
      body: 'This is a quick task for performance testing.',
    });

    fetchByCode(entry.code);

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('query returns in under 10ms', () => {
    const start = performance.now();
    queryEntries({ status: 'active' });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(10);
  });
});
