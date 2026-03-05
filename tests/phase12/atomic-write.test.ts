/**
 * FIX 3 — Atomic File Write.
 * Verifies that atomicWriteFile uses .tmp → rename, and that .tmp files
 * are cleaned up on next database initialization.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomicWriteFile } from '../../core/memory/write.js';
import { initDatabase, closeDatabase } from '../../core/memory/index.js';
import { createEntry } from '../../core/memory/write.js';
import { PATHS } from '../../config/agent.config.js';

const TEST_DIR = path.join(os.tmpdir(), `agentic-phase12-atomic-${Date.now()}`);
const origDb = PATHS.db;
const origMemory = PATHS.memory;

beforeAll(() => {
  fs.mkdirSync(path.join(TEST_DIR, 'memory'), { recursive: true });
  (PATHS as Record<string, string>).db = path.join(TEST_DIR, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(TEST_DIR, 'memory');
  initDatabase(path.join(TEST_DIR, 'test.sqlite'));
});

afterAll(async () => {
  closeDatabase();
  const { _resetGitInstance } = await import('../../core/memory/versioning.js');
  _resetGitInstance();
  await new Promise(r => setTimeout(r, 100));
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
});

describe('FIX 3 — atomicWriteFile', () => {
  it('writes file successfully via tmp → rename', () => {
    const filePath = path.join(TEST_DIR, 'test-atomic.md');
    atomicWriteFile(filePath, '# Hello\n\nworld\n');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('# Hello\n\nworld\n');
    // .tmp file must NOT remain after successful write
    expect(fs.existsSync(filePath + '.tmp')).toBe(false);
  });

  it('does not leave a .tmp file visible at the target path during write', () => {
    const filePath = path.join(TEST_DIR, 'test-atomic2.md');
    // Normal write should leave no .tmp artifact
    atomicWriteFile(filePath, '# Content\n');
    expect(fs.existsSync(filePath + '.tmp')).toBe(false);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('startup cleans up leftover .tmp files in memory directory', () => {
    // Simulate a crashed write: create a .tmp file in the memory dir
    const tmpFile = path.join(TEST_DIR, 'memory', 'WHO', 'contacts', 'orphaned.md.tmp');
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
    fs.writeFileSync(tmpFile, '# Orphaned content\n');
    expect(fs.existsSync(tmpFile)).toBe(true);

    // Re-initialize the database — this triggers bootstrapIndexFromMemoryFiles
    // which cleans up .tmp files
    closeDatabase();
    initDatabase(path.join(TEST_DIR, 'test.sqlite'));

    // The .tmp file should be cleaned up
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  it('createEntry produces a file at expected path (integration)', async () => {
    const entry = createEntry({
      nb: 'WHO',
      type: 'CT',
      name: 'Test Contact Atomic',
      status: 'active',
      summary: 'Test for atomic write',
      body: 'Testing atomic write functionality.',
    });
    // Give async git commit a moment to settle
    await new Promise(r => setTimeout(r, 50));
    expect(fs.existsSync(entry.path)).toBe(true);
    // No .tmp file should remain
    expect(fs.existsSync(entry.path + '.tmp')).toBe(false);
  });
});
