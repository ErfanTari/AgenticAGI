import { describe, it, expect } from 'vitest';
import { cleanCode } from '../../core/skills/tools/memory_read.js';

describe('cleanCode — bracket sanitizer', () => {
  it('strips leading [ and trailing ]', () => {
    expect(cleanCode('[WHO.CT-000001]')).toBe('WHO.CT-000001');
  });

  it('leaves a clean code unchanged', () => {
    expect(cleanCode('WHO.CT-000001')).toBe('WHO.CT-000001');
  });

  it('strips only leading [ when no trailing ]', () => {
    expect(cleanCode('[WHO.CT-000001')).toBe('WHO.CT-000001');
  });

  it('strips only trailing ] when no leading [', () => {
    expect(cleanCode('WHO.CT-000001]')).toBe('WHO.CT-000001');
  });

  it('does not strip brackets in the middle of a code', () => {
    expect(cleanCode('WHO.[CT]-000001')).toBe('WHO.[CT]-000001');
  });

  it('trims surrounding whitespace', () => {
    expect(cleanCode('  [WHO.CT-000001]  ')).toBe('WHO.CT-000001');
  });

  it('handles PLAN.PJ codes', () => {
    expect(cleanCode('[PLAN.PJ-000003]')).toBe('PLAN.PJ-000003');
  });
});
