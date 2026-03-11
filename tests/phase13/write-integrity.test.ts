import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PATHS } from '../../config/agent.config.js';
import { closeDatabase, getDb, initDatabase } from '../../core/memory/index.js';
import { createEntry, upsertEntry } from '../../core/memory/write.js';
import { _resetGitInstance } from '../../core/memory/versioning.js';

describe('Phase 13: memory write integrity', () => {
  let tmpDir: string;
  let originalDb: string;
  let originalMemory: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase13-write-'));
    originalDb = PATHS.db;
    originalMemory = PATHS.memory;
    (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
    (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
    fs.mkdirSync(PATHS.memory, { recursive: true });
    initDatabase(PATHS.db);
  });

  afterEach(async () => {
    closeDatabase();
    (PATHS as Record<string, string>).db = originalDb;
    (PATHS as Record<string, string>).memory = originalMemory;
    _resetGitInstance();
    await new Promise(resolve => setTimeout(resolve, 50));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps due_date, status, and summary aligned between markdown and SQLite on create/update', () => {
    const entry = createEntry({
      nb: 'PLAN',
      type: 'PL',
      name: 'Ship UI',
      status: 'active',
      summary: 'Initial summary',
      body: 'Initial body',
      due_date: '2026-03-15',
    });

    const createdContent = fs.readFileSync(entry.path, 'utf-8');
    expect(createdContent).toContain('due_date: 2026-03-15');

    upsertEntry({
      nb: 'PLAN',
      type: 'PL',
      name: 'Ship UI',
      status: 'blocked',
      summary: 'Updated summary',
      body: 'Updated body',
      due_date: '2026-03-20',
    });

    const row = getDb().prepare(
      'SELECT status, summary, due_date FROM index_entries WHERE code = ?'
    ).get(entry.code) as { status: string; summary: string; due_date: string | null };
    const updatedContent = fs.readFileSync(entry.path, 'utf-8');

    expect(row).toEqual({
      status: 'blocked',
      summary: 'Updated summary',
      due_date: '2026-03-20',
    });
    expect(updatedContent).toContain('status: blocked');
    expect(updatedContent).toContain('summary: Updated summary');
    expect(updatedContent).toContain('due_date: 2026-03-20');
    expect(updatedContent).toContain('Updated body');
  });

  it('recreates a missing markdown file before updating SQLite state', () => {
    const entry = createEntry({
      nb: 'WHAT',
      type: 'PJ',
      name: 'Missing File Project',
      status: 'active',
      summary: 'Original summary',
      body: 'Original body',
    });

    fs.unlinkSync(entry.path);
    expect(fs.existsSync(entry.path)).toBe(false);

    upsertEntry({
      nb: 'WHAT',
      type: 'PJ',
      name: 'Missing File Project',
      status: 'active',
      summary: 'Recreated summary',
      body: 'Recreated body',
    });

    const row = getDb().prepare(
      'SELECT path, summary FROM index_entries WHERE code = ?'
    ).get(entry.code) as { path: string; summary: string };

    expect(fs.existsSync(row.path)).toBe(true);
    expect(row.summary).toBe('Recreated summary');
    expect(fs.readFileSync(row.path, 'utf-8')).toContain('Recreated body');
  });
});
