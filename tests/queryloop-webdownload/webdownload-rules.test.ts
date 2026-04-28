import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const promptPath = resolve(process.cwd(), 'prompts/query-loop-base.md');
const prompt = readFileSync(promptPath, 'utf-8');

describe('query-loop-base.md web-download hardening rules', () => {
  it('contains Multi-Target Web-Work Rules section', () => {
    expect(prompt).toContain('Multi-Target Web-Work Rules');
  });

  it('contains Phase 1 Gather instruction', () => {
    expect(prompt).toContain('Phase 1 — Gather');
  });

  it('contains Phase 2 Batch Download instruction', () => {
    expect(prompt).toContain('Phase 2 — Batch Download');
  });

  it('contains filetype:pdf search operator instruction', () => {
    expect(prompt).toContain('filetype:pdf');
  });

  it('contains 204800 byte integrity threshold', () => {
    expect(prompt).toContain('204800');
  });

  it('contains issuu.com flipbook blocklist entry', () => {
    expect(prompt).toContain('issuu.com');
  });

  it('contains pubhtml5.com flipbook blocklist entry', () => {
    expect(prompt).toContain('pubhtml5.com');
  });

  it('contains User-Agent Mozilla/5.0 bot-bypass header', () => {
    expect(prompt).toContain('User-Agent: Mozilla/5.0');
  });

  it('contains context ballooning discipline rule', () => {
    expect(prompt).toContain('context ballooning');
  });
});
