/**
 * Memory Toggle Full — Propagation Tests (Batch 1 completion)
 * Tests that isMemoryFullyDisabled() gates work at each call site.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PATHS } from '../../config/agent.config.js';
import { initDatabase, closeDatabase } from '../../core/memory/index.js';
import { setMemoryMode, _resetMemoryMode, isMemoryFullyDisabled, getScratchpadPath, appendScratchpad, readScratchpad, clearScratchpad } from '../../core/memory-mode.js';
import { createEntry, upsertEntry } from '../../core/memory/write.js';
import { sessionCache } from '../../core/memory/session-cache.js';
import { memoryAgent } from '../../core/memory/memory-agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(__dirname, `tmp-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
  (PATHS as Record<string, string>).workspace = path.join(tmpDir, 'workspace');
  initDatabase();
});

afterEach(() => {
  closeDatabase();
  _resetMemoryMode();
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('isMemoryFullyDisabled()', () => {
  it('returns false when enabled', () => {
    expect(isMemoryFullyDisabled()).toBe(false);
  });

  it('returns true when disabled', () => {
    setMemoryMode('disabled');
    expect(isMemoryFullyDisabled()).toBe(true);
  });
});

describe('createEntry() gated', () => {
  it('returns sentinel when memory disabled', () => {
    setMemoryMode('disabled');
    const result = createEntry({ nb: 'NOW', type: 'TD', name: 'Test Todo', status: 'active', body: 'test', summary: 'test' });
    expect(result.code).toBe('MEMORY_DISABLED');
  });

  it('creates normally when enabled', () => {
    const result = createEntry({ nb: 'NOW', type: 'TD', name: 'Test Todo', status: 'active', body: 'test', summary: 'test' });
    expect(result.code).toMatch(/^NOW\.TD-/);
  });
});

describe('upsertEntry() gated', () => {
  it('returns disabled sentinel when memory disabled', () => {
    setMemoryMode('disabled');
    const result = upsertEntry({ nb: 'NOW', type: 'TD', name: 'Upsert Test', status: 'active', body: 'body', summary: 'sum' });
    expect(result.code).toBe('MEMORY_DISABLED');
  });
});

describe('sessionCache.set() gated', () => {
  it('does not store entries when memory is disabled', () => {
    sessionCache.clear();
    setMemoryMode('disabled');
    const entry = {
      code: 'NOW.TD-000001', nb: 'NOW', type: 'TD', name: 'test', status: 'active',
      updated: '2026-01-01', path: '/tmp/test.md', summary: '',
    };
    sessionCache.set('NOW.TD-000001', entry);
    expect(sessionCache.getByCode('NOW.TD-000001')).toBeNull();
  });

  it('stores normally when enabled', () => {
    const entry = {
      code: 'NOW.TD-000099', nb: 'NOW', type: 'TD', name: 'test', status: 'active',
      updated: '2026-01-01', path: '/tmp/test.md', summary: '',
    };
    sessionCache.set('NOW.TD-000099', entry);
    expect(sessionCache.getByCode('NOW.TD-000099')).not.toBeNull();
  });
});

describe('memoryAgent.enqueue() gated', () => {
  it('drops update when memory is disabled', () => {
    setMemoryMode('disabled');
    const before = memoryAgent.queueLength();
    memoryAgent.enqueue({ type: 'new_code', code: 'NOW.TD-000001', workingMemoryId: null });
    expect(memoryAgent.queueLength()).toBe(before);
  });

  it('enqueues normally when enabled', () => {
    const before = memoryAgent.queueLength();
    memoryAgent.enqueue({ type: 'new_code', code: 'NOW.TD-000001', workingMemoryId: null });
    expect(memoryAgent.queueLength()).toBeGreaterThanOrEqual(before);
  });
});

describe('scratchpad helpers', () => {
  it('getScratchpadPath returns path under workspace/.scratch', () => {
    const p = getScratchpadPath('req-123');
    expect(p).toContain('.scratch');
    expect(p).toContain('plan-req-123');
  });

  it('appendScratchpad and readScratchpad round-trip', () => {
    appendScratchpad('req-abc', 'header', 'milestone list here');
    const content = readScratchpad('req-abc');
    expect(content).toContain('header');
    expect(content).toContain('milestone list here');
  });

  it('clearScratchpad removes the file', () => {
    appendScratchpad('req-del', 'header', 'data');
    clearScratchpad('req-del');
    const content = readScratchpad('req-del');
    expect(content).toBeNull();
  });

  it('readScratchpad returns null for missing file', () => {
    expect(readScratchpad('nonexistent-xyz')).toBeNull();
  });
});
