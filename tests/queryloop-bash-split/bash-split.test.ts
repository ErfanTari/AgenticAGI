import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const promptPath = resolve(process.cwd(), 'prompts/query-loop-base.md');
const prompt = readFileSync(promptPath, 'utf-8');

const queryLoopPath = resolve(process.cwd(), 'core/query-loop.ts');
const queryLoop = readFileSync(queryLoopPath, 'utf-8');

describe('queryloop-bash-split: per-brand download rules', () => {
  it('prompt contains Sequential Per-Brand Download heading', () => {
    expect(prompt).toContain('Sequential Per-Brand Download');
  });

  it('prompt contains never-one-script-for-all-brands rule', () => {
    expect(prompt).toContain('Never generate one bash script for all brands at once');
  });

  it('prompt contains one run_bash call per brand rule', () => {
    expect(prompt).toContain('One `run_bash` call per brand');
  });

  it('prompt contains FINAL_STATUS consolidated output format', () => {
    expect(prompt).toContain('FINAL_STATUS:');
  });

  it('prompt does NOT contain old Phase 2 Batch Download heading', () => {
    expect(prompt).not.toContain('Phase 2 — Batch Download');
  });

  it('prompt still contains 204800 integrity threshold', () => {
    expect(prompt).toContain('204800');
  });

  it('query-loop.ts contains consecutiveRepairCount circuit breaker variable', () => {
    expect(queryLoop).toContain('consecutiveRepairCount');
  });

  it('query-loop.ts emits query_loop_repair_loop_detected transparency event', () => {
    expect(queryLoop).toContain('query_loop_repair_loop_detected');
  });
});
