import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const promptPath = resolve(process.cwd(), 'prompts/query-loop-base.md');
const prompt = readFileSync(promptPath, 'utf-8');

const queryLoopPath = resolve(process.cwd(), 'core/query-loop.ts');
const queryLoop = readFileSync(queryLoopPath, 'utf-8');

describe('queryloop-bash-split: per-brand download rules', () => {
  it('prompt contains Phase 2 sequential per-target download heading', () => {
    expect(prompt).toContain('Phase 2 — Download');
  });

  it('prompt forbids batching multiple targets into one script', () => {
    expect(prompt).toContain('Never batch multiple targets into one script');
  });

  it('prompt requires one download call per target', () => {
    expect(prompt).toContain('One download_file (or fallback curl) per target');
  });

  it('prompt contains FINAL_STATUS consolidated output format', () => {
    expect(prompt).toContain('FINAL_STATUS:');
  });

  it('prompt does NOT contain old Phase 2 Batch Download heading', () => {
    expect(prompt).not.toContain('Phase 2 — Batch Download');
  });

  it('prompt contains post-download size sanity threshold', () => {
    expect(prompt).toMatch(/200\s*KB/i);
  });

  it('query-loop.ts contains consecutiveRepairCount circuit breaker variable', () => {
    expect(queryLoop).toContain('consecutiveRepairCount');
  });

  it('query-loop.ts emits query_loop_repair_loop_detected transparency event', () => {
    expect(queryLoop).toContain('query_loop_repair_loop_detected');
  });
});
