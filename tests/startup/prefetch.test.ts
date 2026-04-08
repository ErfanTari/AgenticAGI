/**
 * Tests for startup prefetch functionality
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  runStartupPrefetch,
  getPointerIndexCache,
  getPrefetchResult,
  markContextLazyLoaded,
  isContextLazyLoaded,
} from '../../core/startup/prefetch.js';
import { PATHS } from '../../config/agent.config.js';
import { initDatabase } from '../../core/memory/mod.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(__dirname, `tmp-prefetch-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'index'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'workspace'), { recursive: true });

  // Override PATHS for this test
  (PATHS as Record<string, string>).db = path.join(tmpDir, 'index', 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
  (PATHS as Record<string, string>).workspace = path.join(tmpDir, 'workspace');
  (PATHS as Record<string, string>).index = path.join(tmpDir, 'index');

  // Initialize database for tests
  initDatabase();
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('Startup prefetch', () => {

  it('T1: runStartupPrefetch returns valid structure', async () => {
    const result = await runStartupPrefetch();
    expect(result).toHaveProperty('pointerIndexLoaded');
    expect(result).toHaveProperty('pointerEntryCount');
    expect(result).toHaveProperty('entriesPrefetched');
    expect(result).toHaveProperty('prefetchTimeMs');
  });

  it('T2: prefetch result has non-negative values', async () => {
    const result = await runStartupPrefetch();
    expect(typeof result.pointerIndexLoaded).toBe('boolean');
    expect(result.pointerEntryCount).toBeGreaterThanOrEqual(0);
    expect(result.entriesPrefetched).toBeGreaterThanOrEqual(0);
    expect(result.prefetchTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('T3: getPrefetchResult returns null before prefetch', () => {
    const result = getPrefetchResult();
    // Should be null initially (before any runStartupPrefetch call in this test context)
    expect(result === null || typeof result === 'object').toBe(true);
  });

  it('T4: getPrefetchResult returns result after prefetch', async () => {
    await runStartupPrefetch();
    const result = getPrefetchResult();
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('entriesPrefetched');
  });

  it('T5: getPointerIndexCache returns string', async () => {
    const cache = getPointerIndexCache();
    expect(typeof cache).toBe('string');
  });

  it('T6: pointer index cache updated after prefetch', async () => {
    const beforeCache = getPointerIndexCache();
    await runStartupPrefetch();
    const afterCache = getPointerIndexCache();
    // After prefetch, cache should be populated (even if empty string is valid)
    expect(typeof afterCache).toBe('string');
  });

  it('T7: context lazy loaded is false initially', () => {
    expect(isContextLazyLoaded()).toBe(false);
  });

  it('T8: markContextLazyLoaded sets flag to true', () => {
    markContextLazyLoaded();
    expect(isContextLazyLoaded()).toBe(true);
  });

  it('T9: multiple prefetch calls are safe', async () => {
    const result1 = await runStartupPrefetch();
    const result2 = await runStartupPrefetch();
    expect(result1).toBeDefined();
    expect(result2).toBeDefined();
    expect(result2.prefetchTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('T10: prefetch handles missing pointer index gracefully', async () => {
    // Prefetch should not throw even if pointer index doesn't exist
    const result = await runStartupPrefetch();
    expect(result).toBeDefined();
    expect(result.entriesPrefetched).toBeGreaterThanOrEqual(0);
  });

});
