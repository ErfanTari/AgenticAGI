import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const prompt = readFileSync(resolve(process.cwd(), 'prompts/query-loop-base.md'), 'utf-8');

describe('queryloop-download-hardened: bash template security + timeout rules', () => {
  it('prompt requires hardcoded curl fallback (no shell variables)', () => {
    expect(prompt).toMatch(/hardcode all values as literals|No shell variables/i);
  });

  it('prompt does not contain BRAND= variable assignment in a code block', () => {
    const codeBlocks = [...prompt.matchAll(/```bash([\s\S]*?)```/g)].map(m => m[1]);
    for (const block of codeBlocks) {
      expect(block).not.toMatch(/^\s*BRAND=/m);
    }
  });

  it('prompt does not contain $(wc -c command substitution', () => {
    expect(prompt).not.toContain('$(wc -c');
  });

  it('prompt uses HEAD probe before large ambiguous downloads', () => {
    expect(prompt).toMatch(/curl\s+-sI.*content-type/i);
  });

  it('prompt contains TIMEOUT_SKIP rule', () => {
    expect(prompt).toContain('TIMEOUT_SKIP');
  });

  it('prompt warns about huge bodies / timeout context before blind fetch', () => {
    expect(prompt).toMatch(/prior timeout|potentially large body/i);
  });
});
