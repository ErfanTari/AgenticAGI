import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const prompt = readFileSync(resolve(process.cwd(), 'prompts/query-loop-base.md'), 'utf-8');

describe('queryloop-download-hardened: bash template security + timeout rules', () => {
  it('prompt contains fully hardcoded / no bash variables instruction', () => {
    expect(prompt).toMatch(/fully hardcoded|no bash variables/);
  });

  it('prompt does not contain BRAND= variable assignment in a code block', () => {
    // Extract code block content and check BRAND= is not inside one
    const codeBlocks = [...prompt.matchAll(/```bash([\s\S]*?)```/g)].map(m => m[1]);
    for (const block of codeBlocks) {
      expect(block).not.toMatch(/^\s*BRAND=/m);
    }
  });

  it('prompt does not contain $(wc -c command substitution', () => {
    expect(prompt).not.toContain('$(wc -c');
  });

  it('prompt contains flat wc-c check pattern', () => {
    expect(prompt).toContain('wc -c < workspace/Catalogs');
  });

  it('prompt contains TIMEOUT_SKIP rule', () => {
    expect(prompt).toContain('TIMEOUT_SKIP');
  });

  it('prompt blocks web_fetch on previously timed-out URLs', () => {
    expect(prompt).toMatch(/do not use .?web_fetch.? on a URL that previously timed out/i);
  });
});
