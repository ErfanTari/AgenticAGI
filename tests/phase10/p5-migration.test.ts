import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { initDatabase, closeDatabase, getDb } from '../../core/memory/index.js';
import { checkEmbeddingMigration, reIndexAllEntries } from '../../core/memory/search.js';
import { PATHS } from '../../config/agent.config.js';

describe('Priority 5: Embedding migration detection', () => {
  let tmpDir: string;
  const origDb = PATHS.db;
  const origMemory = PATHS.memory;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p10-migration-'));
    (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
    (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
    fs.mkdirSync(path.join(tmpDir, 'memory'), { recursive: true });
    initDatabase(path.join(tmpDir, 'test.sqlite'));
  });

  afterEach(() => {
    closeDatabase();
    (PATHS as Record<string, string>).db = origDb;
    (PATHS as Record<string, string>).memory = origMemory;
    delete process.env.EMBEDDING_MODEL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('P5A: first run stores the model name in settings', async () => {
    process.env.EMBEDDING_MODEL = 'model-a';
    await checkEmbeddingMigration();

    const d = getDb();
    const row = d.prepare("SELECT value FROM settings WHERE key = 'embedding_model'")
      .get() as { value: string } | undefined;
    expect(row).not.toBeUndefined();
    expect(row!.value).toBe('model-a');
  });

  it('P5B: second run with same model → no re-index', async () => {
    process.env.EMBEDDING_MODEL = 'model-a';
    const spy = vi.spyOn(console, 'warn');
    await checkEmbeddingMigration();
    await checkEmbeddingMigration();

    // No warning about model change
    const warnings = spy.mock.calls.filter(args =>
      args[0]?.includes?.('[embed-migration]') && args[0]?.includes?.('changed'),
    );
    expect(warnings.length).toBe(0);
  });

  it('P5C: model change triggers re-index warning', async () => {
    process.env.EMBEDDING_MODEL = 'model-a';
    await checkEmbeddingMigration(); // store hash for model-a

    process.env.EMBEDDING_MODEL = 'model-b';
    const spy = vi.spyOn(console, 'warn');
    await checkEmbeddingMigration(); // different model → should warn

    const warnings = spy.mock.calls.filter(args =>
      String(args[0] ?? '').includes('[embed-migration]'),
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('P5D: reIndexAllEntries does not throw even when no entries', async () => {
    await expect(reIndexAllEntries()).resolves.not.toThrow();
  });

  it('P5E: checkEmbeddingMigration never throws', async () => {
    // Even with a broken DB or missing env var
    delete process.env.EMBEDDING_MODEL;
    await expect(checkEmbeddingMigration()).resolves.not.toThrow();
  });

  it('P5F: settings table exists after initDatabase', () => {
    const d = getDb();
    // Settings table should exist (query succeeds without error)
    const rows = d.prepare("SELECT key, value FROM settings").all();
    expect(Array.isArray(rows)).toBe(true);
  });
});
