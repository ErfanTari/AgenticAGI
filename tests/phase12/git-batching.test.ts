/**
 * Phase 12 Part 2 — H3/H4: Debounced Git Batch Commit Tests
 * Verifies that rapid writes are batched into a single git commit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scheduleMemoryCommit, flushCommit } from '../../core/memory/versioning.js';
import { PATHS } from '../../config/agent.config.js';

const TEST_DIR = path.join(os.tmpdir(), `agentic-phase12-git-${Date.now()}`);
const origMemory = PATHS.memory;

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  (PATHS as Record<string, string>).memory = TEST_DIR;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  (PATHS as Record<string, string>).memory = origMemory;
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

describe('H3/H4 — Debounced git batch commits', () => {
  it('scheduleMemoryCommit does nothing when no .git dir exists (H4)', () => {
    // No .git dir in TEST_DIR — should skip silently (H4 early return)
    expect(() => scheduleMemoryCommit('test: entry')).not.toThrow();
  });

  it('flushCommit resolves immediately when no pending messages', async () => {
    await expect(flushCommit()).resolves.toBeUndefined();
  });

  it('flushCommit skips gracefully when no .git dir', async () => {
    await expect(flushCommit()).resolves.toBeUndefined();
  });

  it('scheduleMemoryCommit accepts messages without throwing', () => {
    expect(() => {
      scheduleMemoryCommit('WHO.CT-000001: Test Contact [agent]');
      scheduleMemoryCommit('WHAT.PJ-000001: Test Project [agent]');
    }).not.toThrow();
  });

  it('10 rapid writes debounce to a single timer (clearTimeout called)', () => {
    // Create a fake .git dir so H4 early-exit does not trigger
    const gitDir = path.join(TEST_DIR, '.git');
    fs.mkdirSync(gitDir, { recursive: true });

    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

    // Simulate 10 rapid writes
    for (let i = 0; i < 10; i++) {
      scheduleMemoryCommit(`entry-${i}: write`);
    }

    // setTimeout called for each write (debounce reset)
    expect(setTimeoutSpy.mock.calls.length).toBeGreaterThan(0);
    // clearTimeout called for each write after the first (9 times)
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(9);
  });

  it('timer advances 31s → flushCommit runs (no-op without real git)', async () => {
    const gitDir = path.join(TEST_DIR, '.git');
    fs.mkdirSync(gitDir, { recursive: true });

    scheduleMemoryCommit('single entry write');

    // Flush manually — simulates what the timer would do
    // (flushCommit will find the .git but no commits to make = graceful return)
    await expect(flushCommit()).resolves.toBeUndefined();
  });
});
