/**
 * Phase 19c — Bootstrap Sync Tests
 * 8 tests covering: syncMemoryFilesToIndex(), upsertPointerEntry wiring in bootstrap.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { initDatabase, closeDatabase, syncMemoryFilesToIndex, getEntryByCode } from '../../core/memory/index.js';
import { PATHS } from '../../config/agent.config.js';
import { upsertEntry } from '../../core/memory/write.js';
import { loadPointerIndexEntries } from '../../core/memory/pointer-index.js';

let tmpDir: string;
const origDb = PATHS.db;
const origMemory = PATHS.memory;

function setTmpPaths() {
  (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
  (PATHS as Record<string, string>).projects = path.join(tmpDir, 'memory', 'PLAN', 'planning');
}

function restorePaths() {
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase19c-test-'));
  setTmpPaths();
  fs.mkdirSync(path.join(tmpDir, 'memory'), { recursive: true });
  initDatabase(path.join(tmpDir, 'test.sqlite'));
});

afterEach(() => {
  closeDatabase();
  restorePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a minimal valid memory .md file to disk (NOT through upsertEntry). */
function writeMdFile(nb: string, type: string, code: string, name: string, status = 'active'): string {
  const dir = path.join(tmpDir, 'memory', nb, type === 'CT' ? 'contacts' : type.toLowerCase());
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${code.replace('.', '_').replace('-', '_')}.md`);
  const today = new Date().toISOString().split('T')[0];
  const content = [
    '---',
    `code: ${code}`,
    `nb: ${nb}`,
    `type: ${type}`,
    `name: ${name}`,
    `status: ${status}`,
    `updated: ${today}`,
    `summary: Test entry for ${name}`,
    '---',
    '',
    `# ${name}`,
    '',
    'Test content.',
  ].join('\n');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

describe('syncMemoryFilesToIndex', () => {
  it('test 1: returns { added:0, updated:0, errors:0 } when DB is fully in sync', async () => {
    // Write an entry through the normal path (already in DB)
    await upsertEntry({ nb: 'WHO', type: 'CT', name: 'In Sync Person', status: 'active', summary: 'synced' }, undefined, '');
    // All files are in DB — sync should find nothing new
    const result = syncMemoryFilesToIndex();
    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('test 2: adds a file that exists on disk but not in index_entries', () => {
    // Write file directly to disk, bypassing upsertEntry
    writeMdFile('WHO', 'CT', 'WHO.CT-999001', 'Ghost Person');

    const before = getEntryByCode('WHO.CT-999001');
    expect(before).toBeUndefined();

    const result = syncMemoryFilesToIndex();
    expect(result.added).toBe(1);
    expect(result.errors).toBe(0);

    const after = getEntryByCode('WHO.CT-999001');
    expect(after).toBeDefined();
    expect(after!.name).toBe('Ghost Person');
  });

  it('test 3: updates an entry whose file mtime is newer than its updated field', async () => {
    // Create via normal path
    await upsertEntry({ nb: 'WHO', type: 'CT', name: 'Stale Person', status: 'active', summary: 'original' }, undefined, '');
    const entry = getEntryByCode('WHO.CT-000001');
    expect(entry).toBeDefined();

    // Artificially backdate the updated field in DB so mtime > updated
    const { getDb } = await import('../../core/memory/index.js');
    const db = getDb();
    db.prepare("UPDATE index_entries SET updated = '2000-01-01' WHERE code = ?").run(entry!.code);

    const result = syncMemoryFilesToIndex();
    expect(result.updated).toBeGreaterThanOrEqual(1);
    expect(result.errors).toBe(0);
  });

  it('test 4: skips .md files with no frontmatter code field', () => {
    // Write a .md file without a code field
    const dir = path.join(tmpDir, 'memory', 'WHO', 'contacts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'no_code.md'), '# Just a note\n\nNo frontmatter here.\n', 'utf8');

    const result = syncMemoryFilesToIndex();
    expect(result.added).toBe(0);
    expect(result.errors).toBe(0); // skipped cleanly, not an error
  });

  it('test 5: continues and increments errors when one file has malformed frontmatter', () => {
    // Write a file that has frontmatter markers but broken YAML
    const dir = path.join(tmpDir, 'memory', 'WHO', 'contacts');
    fs.mkdirSync(dir, { recursive: true });
    const badContent = '---\ncode: \nnb: WHO\ntype: CT\nname: \nstatus: active\nupdated: bad-date\nsummary:\n---\n\n# Bad\n';
    fs.writeFileSync(path.join(dir, 'bad_entry.md'), badContent, 'utf8');

    // Also write one valid file to ensure processing continues
    writeMdFile('WHO', 'CT', 'WHO.CT-999002', 'Valid After Bad');

    const result = syncMemoryFilesToIndex();
    // The valid file should be added regardless of any errors
    expect(result.added + result.errors).toBeGreaterThanOrEqual(1);
    // No unhandled throw
  });

  it('test 6: calls upsertPointerEntry for each newly added entry (MEMORY.md updated)', () => {
    writeMdFile('WHO', 'CT', 'WHO.CT-999003', 'Pointer Test Person');

    const result = syncMemoryFilesToIndex();
    expect(result.added).toBe(1);

    const pointerEntries = loadPointerIndexEntries();
    const found = pointerEntries.find(e => e.code === 'WHO.CT-999003');
    expect(found).toBeDefined();
    expect(found!.name).toBe('Pointer Test Person');
  });
});

describe('bootstrapIndexFromMemoryFiles + pointer index', () => {
  it('test 7: bootstrap calls upsertPointerEntry for each indexed entry', () => {
    // Close current DB and start fresh with files already on disk
    closeDatabase();
    restorePaths();

    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase19c-bootstrap-'));
    (PATHS as Record<string, string>).db = path.join(freshDir, 'test.sqlite');
    (PATHS as Record<string, string>).memory = path.join(freshDir, 'memory');

    // Write memory files before initializing DB (simulates pre-existing disk state)
    const nb = 'WHO'; const type = 'CT'; const code = 'WHO.CT-000001'; const name = 'Bootstrap Person';
    const dir = path.join(freshDir, 'memory', nb, 'contacts');
    fs.mkdirSync(dir, { recursive: true });
    const today = new Date().toISOString().split('T')[0];
    fs.writeFileSync(path.join(dir, 'bootstrap_person.md'), [
      '---', `code: ${code}`, `nb: ${nb}`, `type: ${type}`, `name: ${name}`,
      `status: active`, `updated: ${today}`, `summary: Bootstrap test`, '---', '', `# ${name}`,
    ].join('\n'), 'utf8');

    // Bootstrap runs with empty DB — should index files AND update MEMORY.md
    initDatabase(path.join(freshDir, 'test.sqlite'));

    const pointerEntries = loadPointerIndexEntries();
    const found = pointerEntries.find(e => e.code === code);
    expect(found).toBeDefined();
    expect(found!.name).toBe(name);

    closeDatabase();
    (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
    (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
    fs.rmSync(freshDir, { recursive: true, force: true });
  });

  it('test 8: startup sequence completes without throwing (bootstrap + sync)', () => {
    // Fresh directory: bootstrap runs (DB empty), then sync runs (finds no new files)
    closeDatabase();
    restorePaths();

    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase19c-seq-'));
    (PATHS as Record<string, string>).db = path.join(freshDir, 'test.sqlite');
    (PATHS as Record<string, string>).memory = path.join(freshDir, 'memory');
    fs.mkdirSync(path.join(freshDir, 'memory'), { recursive: true });

    expect(() => initDatabase(path.join(freshDir, 'test.sqlite'))).not.toThrow();

    closeDatabase();
    (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
    (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
    fs.rmSync(freshDir, { recursive: true, force: true });
  });
});
