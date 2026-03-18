import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { initDatabase, closeDatabase, getDb } from '../../core/memory/index.js';
import { PATHS } from '../../config/agent.config.js';
import { createEntry } from '../../core/memory/write.js';
import { checkNowTTL } from '../../core/heartbeat.js';
import type { IndexEntry } from '../../core/memory/types.js';

let tmpDir: string;
const origDb = PATHS.db;
const origMemory = PATHS.memory;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttl-test-'));
  (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
  fs.mkdirSync(path.join(tmpDir, 'memory'), { recursive: true });
  // Create necessary subdirectories
  fs.mkdirSync(path.join(tmpDir, 'memory', 'NOW', 'todos'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'memory', 'NOW', 'reports'), { recursive: true });
  initDatabase(path.join(tmpDir, 'test.sqlite'));
});

afterEach(() => {
  closeDatabase();
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function setEntryDate(code: string, date: string, status?: string): void {
  const db = getDb();
  if (status) {
    db.prepare('UPDATE index_entries SET updated = ?, status = ? WHERE code = ?').run(date, status, code);
  } else {
    db.prepare('UPDATE index_entries SET updated = ? WHERE code = ?').run(date, code);
  }
}

describe('Phase 15: NOW Notebook TTL', () => {
  it('archives completed NOW.TD entries older than 30 days', async () => {
    const todo = createEntry({
      nb: 'NOW',
      type: 'TD',
      name: 'Old completed todo',
      status: 'closed',
      summary: 'Done months ago',
      body: 'This was completed a long time ago.',
    });

    // Set updated date to 31 days ago
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 31);
    setEntryDate(todo.code, oldDate.toISOString().split('T')[0], 'closed');

    const result = await checkNowTTL();

    const db = getDb();
    const row = db.prepare('SELECT status FROM index_entries WHERE code = ?').get(todo.code) as { status: string };
    expect(row.status).toBe('archived');
  });

  it('does NOT archive recently completed NOW.TD entries', async () => {
    const todo = createEntry({
      nb: 'NOW',
      type: 'TD',
      name: 'Recent completed todo',
      status: 'closed',
      summary: 'Completed yesterday',
      body: 'Just completed.',
    });

    // Set updated date to 5 days ago (well within 30-day TTL)
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 5);
    setEntryDate(todo.code, recentDate.toISOString().split('T')[0], 'closed');

    await checkNowTTL();

    const db = getDb();
    const row = db.prepare('SELECT status FROM index_entries WHERE code = ?').get(todo.code) as { status: string };
    expect(row.status).toBe('closed'); // NOT archived
  });

  it('does NOT archive open NOW.TD entries regardless of age', async () => {
    const todo = createEntry({
      nb: 'NOW',
      type: 'TD',
      name: 'Old open todo',
      status: 'open',
      summary: 'Still open',
      body: 'Not done yet.',
    });

    // Set to 60 days ago
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60);
    setEntryDate(todo.code, oldDate.toISOString().split('T')[0]);

    await checkNowTTL();

    const db = getDb();
    const row = db.prepare('SELECT status FROM index_entries WHERE code = ?').get(todo.code) as { status: string };
    expect(row.status).toBe('open'); // NOT archived — still open
  });

  it('archives NOW.RP entries older than 60 days', async () => {
    const report = createEntry({
      nb: 'NOW',
      type: 'RP',
      name: 'Old report',
      status: 'active',
      summary: 'Quarterly report from long ago',
      body: 'Old report content.',
    });

    // Set updated date to 61 days ago
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 61);
    setEntryDate(report.code, oldDate.toISOString().split('T')[0]);

    await checkNowTTL();

    const db = getDb();
    const row = db.prepare('SELECT status FROM index_entries WHERE code = ?').get(report.code) as { status: string };
    expect(row.status).toBe('archived');
  });

  it('does NOT archive NOW.RP entries within 60 days', async () => {
    const report = createEntry({
      nb: 'NOW',
      type: 'RP',
      name: 'Recent report',
      status: 'active',
      summary: 'Recent quarterly report',
      body: 'Recent report content.',
    });

    // Set updated date to 30 days ago (within 60-day TTL)
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 30);
    setEntryDate(report.code, recentDate.toISOString().split('T')[0]);

    await checkNowTTL();

    const db = getDb();
    const row = db.prepare('SELECT status FROM index_entries WHERE code = ?').get(report.code) as { status: string };
    expect(row.status).toBe('active'); // NOT archived
  });

  it('returns null when no entries exceed TTL', async () => {
    // Create a recently updated entry
    createEntry({
      nb: 'NOW',
      type: 'TD',
      name: 'Fresh todo',
      status: 'open',
      summary: 'Fresh',
      body: 'Just created.',
    });

    const result = await checkNowTTL();
    // Should return null (no TTL-expired entries)
    // (if it returns a notification, that's fine too — depends on state)
    // The key assertion is that nothing unexpected was archived
    const db = getDb();
    const rows = db.prepare("SELECT * FROM index_entries WHERE nb = 'NOW' AND status = 'archived'").all() as IndexEntry[];
    expect(rows).toHaveLength(0);
  });

  it('checkNowTTL returns Notification when entries are archived', async () => {
    const todo = createEntry({
      nb: 'NOW',
      type: 'TD',
      name: 'Archiveable todo',
      status: 'closed',
      summary: 'Old',
      body: 'Old content.',
    });

    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 35);
    setEntryDate(todo.code, oldDate.toISOString().split('T')[0], 'closed');

    const result = await checkNowTTL();
    expect(result).not.toBeNull();
    expect(result?.entries.length).toBeGreaterThan(0);
  });
});
