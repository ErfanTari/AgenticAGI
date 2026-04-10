import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { initDatabase, closeDatabase } from '../../core/memory/index.js';
import { PATHS } from '../../config/agent.config.js';
import { upsertEntry } from '../../core/memory/write.js';

let tmpDir: string;
const origDb = PATHS.db;
const origMemory = PATHS.memory;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whodedup-test-'));
  (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
  fs.mkdirSync(path.join(tmpDir, 'memory'), { recursive: true });
  // Create necessary subdirectories
  fs.mkdirSync(path.join(tmpDir, 'memory', 'WHO', 'contacts'), { recursive: true });
  initDatabase(path.join(tmpDir, 'test.sqlite'));
});

afterEach(() => {
  closeDatabase();
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Phase 15: WHO Deduplication', () => {
  it('Stage 1: deduplicates by email fingerprint', () => {
    // Create original contact with email
    const result1 = upsertEntry({
      nb: 'WHO',
      type: 'CT',
      name: 'Sara Ahmadi',
      status: 'active',
      summary: 'Designer at Acme',
      body: 'Contact info:\n- email: sara@acme.com\n- phone: 555-1234',
    });
    expect(result1.created).toBe(true);
    const originalCode = result1.code;

    // Try to create duplicate with same email but different name
    const result2 = upsertEntry({
      nb: 'WHO',
      type: 'CT',
      name: 'Sara',
      status: 'active',
      summary: 'Sara from Acme',
      body: 'email: sara@acme.com — frontend designer',
    });

    // Should NOT create a new entry — should merge
    expect(result2.created).toBe(false);
    expect(result2.code).toBe(originalCode);
  });

  it('Stage 2: deduplicates by fuzzy name match — first name only', () => {
    const result1 = upsertEntry({
      nb: 'WHO',
      type: 'CT',
      name: 'Bob Johnson',
      status: 'active',
      summary: 'Developer',
      body: 'Works at TechCorp.',
    });
    expect(result1.created).toBe(true);

    // Create with first name only — should match "Bob Johnson"
    const result2 = upsertEntry({
      nb: 'WHO',
      type: 'CT',
      name: 'Bob',
      status: 'active',
      summary: 'Bob the developer',
      body: 'Additional info about Bob.',
    });

    expect(result2.created).toBe(false);
    expect(result2.code).toBe(result1.code);
  });

  it('Stage 2: does NOT merge unrelated people with similar names', () => {
    upsertEntry({
      nb: 'WHO',
      type: 'CT',
      name: 'Alice Smith',
      status: 'active',
      summary: 'Manager',
      body: 'Alice Smith, project manager.',
    });

    // Different person entirely
    const result2 = upsertEntry({
      nb: 'WHO',
      type: 'CT',
      name: 'Alice Cooper',
      status: 'active',
      summary: 'Musician',
      body: 'Alice Cooper, musician.',
    });

    // Should create a NEW entry because "Cooper" != "Smith"
    expect(result2.created).toBe(true);
  });

  it('does not apply dedup to non-WHO notebooks', () => {
    const result1 = upsertEntry({
      nb: 'WHAT',
      type: 'PJ',
      name: 'Alpha Project',
      status: 'active',
      summary: 'Main project',
      body: 'contact: alpha@company.com',
    });

    const result2 = upsertEntry({
      nb: 'WHAT',
      type: 'PJ',
      name: 'Alpha',
      status: 'active',
      summary: 'Different project',
      body: 'alpha@company.com related',
    });

    // PLAN.PJ entries don't get deduped by fingerprint/fuzzy
    // "Alpha Project" vs "Alpha" — different names, different types, no dedup
    expect(result1.created).toBe(true);
    expect(result2.created).toBe(true);
  });

  it('exact name match still works normally', () => {
    const result1 = upsertEntry({
      nb: 'WHO',
      type: 'CT',
      name: 'Carlos Mendez',
      status: 'active',
      summary: 'Engineer',
      body: 'Carlos Mendez, engineer.',
    });

    const result2 = upsertEntry({
      nb: 'WHO',
      type: 'CT',
      name: 'Carlos Mendez',
      status: 'active',
      summary: 'Senior Engineer',
      body: 'Carlos Mendez, senior engineer now.',
    });

    expect(result1.created).toBe(true);
    expect(result2.created).toBe(false);
    expect(result2.code).toBe(result1.code);
  });
});
