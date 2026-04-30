import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const promptPath = resolve(process.cwd(), 'prompts/query-loop-base.md');
const prompt = readFileSync(promptPath, 'utf-8');

describe('query-loop-base.md web-download hardening rules', () => {
  it('contains multi-target web branch (C3)', () => {
    expect(prompt).toContain('C3 — Multiple targets');
  });

  it('contains Phase 1 Gather instruction', () => {
    expect(prompt).toContain('Phase 1 — Gather');
  });

  it('contains Phase 2 download instruction', () => {
    expect(prompt).toContain('Phase 2 — Download');
  });

  it('chains discovery before download (url_extract + web_fetch + download_file)', () => {
    expect(prompt).toContain('url_extract');
    expect(prompt).toContain('web_fetch');
    expect(prompt).toContain('download_file');
  });

  it('contains post-download size sanity (small file = invalid)', () => {
    expect(prompt).toMatch(/200\s*KB/i);
  });

  it('contains issuu flipbook blocklist entry', () => {
    expect(prompt).toMatch(/issuu/i);
  });

  it('contains pubhtml5 flipbook blocklist entry', () => {
    expect(prompt).toMatch(/pubhtml5/i);
  });

  it('contains HEAD/probe guidance before large downloads', () => {
    expect(prompt).toMatch(/curl\s+-sI/i);
  });

  it('consolidates status after multi-target work (no mid-loop spam)', () => {
    expect(prompt).toContain('Emit no per-target STATUS mid-loop');
    // Phase 25.4: the QueryLoop fallback must use QUERY_LOOP_RESULT, NOT
    // FINAL_STATUS. FINAL_STATUS is reserved for the deterministic
    // web_download_multi_target engine; mimicking it from QueryLoop poisons
    // the diag's mimicry detector.
    expect(prompt).toContain('QUERY_LOOP_RESULT');
  });

  it('does NOT teach the LLM to mimic the engine FINAL_STATUS line', () => {
    // The fallback path produces its own report format. The LLM must not be
    // primed to emit FINAL_STATUS (the engine label) — that defeats the
    // mimicry detector and makes diag attribution ambiguous.
    const lines = prompt.split('\n');
    // It is OK to mention FINAL_STATUS in a NEGATIVE context (e.g. "do not
    // mimic FINAL_STATUS"), so we only fail if a positive emit-instruction
    // appears.
    const positiveEmit = lines.find(l =>
      /\b(emit|output|return|produce|print)\b/i.test(l) &&
      /FINAL_STATUS\s*:/.test(l) &&
      !/(NOT|reserved|engine|mimic)/i.test(l)
    );
    expect(positiveEmit).toBeUndefined();
  });
});
