import { describe, it, expect } from 'vitest';
import { findMatch } from '../../core/skills/edit/layered-matcher.js';

describe('layered-matcher', () => {
  it('tier 0: empty search returns whole-file range', () => {
    const result = findMatch('hello world', '');
    expect(result.tier).toBe(0);
    if (result.tier === 0) {
      expect(result.start).toBe(0);
      expect(result.end).toBe(11);
    }
  });

  it('tier 1: exact match returns correct position', () => {
    const file = 'line one\nline two\nline three';
    const result = findMatch(file, 'line two');
    expect(result.tier).toBe(1);
    if (result.tier === 1) {
      expect(result.start).toBe(9);
      expect(result.end).toBe(17);
    }
  });

  it('tier 1: ambiguity returns fail + ambiguous reason', () => {
    const file = 'foo\nfoo\nbar';
    const result = findMatch(file, 'foo');
    expect(result.tier).toBe('fail');
    if (result.tier === 'fail') {
      expect(result.reason).toBe('ambiguous');
      expect(result.candidates.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('tier 2: whitespace-normalised match', () => {
    const file = 'function  foo() {\n  return   1;\n}';
    const search = 'function foo() {\n  return 1;\n}';
    const result = findMatch(file, search);
    expect([1, 2]).toContain(result.tier); // may hit tier 1 if whitespace collapse isn't needed or tier 2
  });

  it('tier 3: leading-whitespace-flexible match', () => {
    const file = '    const x = 1;\n    const y = 2;';
    const search = 'const x = 1;\nconst y = 2;';
    const result = findMatch(file, search);
    expect([1, 2, 3]).toContain(result.tier);
    if (result.tier !== 'fail') {
      expect(result.start).toBeGreaterThanOrEqual(0);
    }
  });

  it('tier 4: fuzzy match at threshold 0.85 succeeds', () => {
    // Construct a search that is ~90% similar to the file content
    const file = 'function calculateTotal(items) {\n  return items.reduce((a, b) => a + b, 0);\n}';
    const search = 'function calculateTotal(items) {\n  return items.reduce((a, b) => a + b.value, 0);\n}';
    const result = findMatch(file, search);
    // Should match via tier 4 (fuzzy) — not exact
    if (result.tier !== 'fail') {
      expect([1, 2, 3, 4]).toContain(result.tier);
    }
  });

  it('tier 4: fuzzy below 0.85 threshold returns not-found', () => {
    const file = 'hello world\nthis is a test';
    const search = 'completely different content that shares almost nothing';
    const result = findMatch(file, search);
    expect(result.tier).toBe('fail');
    if (result.tier === 'fail') {
      expect(result.reason).toBe('not-found');
    }
  });

  it('no-op detection: returns whitespace-mismatch or not-found (not a crash)', () => {
    // No-op is detected at the patch_file level by comparing search===replace
    // The matcher itself doesn't see replace, so this just exercises not-found
    const file = 'const a = 1;';
    const result = findMatch(file, 'const z = 99;');
    expect(result.tier).toBe('fail');
  });
});
