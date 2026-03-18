import { describe, it, expect, beforeEach } from 'vitest';
import { sessionCache } from '../../core/memory/session-cache.js';
import type { IndexEntry } from '../../core/memory/types.js';

function makeEntry(code: string, name: string): IndexEntry {
  return {
    code,
    nb: 'WHO',
    type: 'CT',
    name,
    status: 'active',
    updated: '2026-03-16',
    summary: `Summary for ${name}`,
    path: `/fake/path/${code}.md`,
  };
}

describe('Phase 15: SessionCache', () => {
  beforeEach(() => {
    sessionCache.clear();
  });

  it('stores and retrieves an entry by code', () => {
    const entry = makeEntry('WHO.CT-000001', 'Alice Smith');
    sessionCache.set(entry.code, entry);
    const result = sessionCache.getByCode('WHO.CT-000001');
    expect(result).not.toBeNull();
    expect(result?.name).toBe('Alice Smith');
  });

  it('retrieves an entry by name (case-insensitive)', () => {
    const entry = makeEntry('WHO.CT-000002', 'Bob Jones');
    sessionCache.set(entry.code, entry);
    expect(sessionCache.getByName('bob jones')).not.toBeNull();
    expect(sessionCache.getByName('BOB JONES')).not.toBeNull();
    expect(sessionCache.getByName('Bob Jones')).not.toBeNull();
  });

  it('returns null for unknown code', () => {
    expect(sessionCache.getByCode('WHO.CT-999999')).toBeNull();
  });

  it('returns null for unknown name', () => {
    expect(sessionCache.getByName('nobody')).toBeNull();
  });

  it('clear() removes all entries', () => {
    const entry = makeEntry('WHO.CT-000003', 'Charlie');
    sessionCache.set(entry.code, entry);
    expect(sessionCache.size()).toBe(1);
    sessionCache.clear();
    expect(sessionCache.size()).toBe(0);
    expect(sessionCache.getByCode('WHO.CT-000003')).toBeNull();
    expect(sessionCache.getByName('charlie')).toBeNull();
  });

  it('overwrites an existing entry on set()', () => {
    const entry1 = makeEntry('WHO.CT-000004', 'Dave');
    const entry2 = { ...entry1, summary: 'Updated summary' };
    sessionCache.set(entry1.code, entry1);
    sessionCache.set(entry2.code, entry2);
    const result = sessionCache.getByCode('WHO.CT-000004');
    expect(result?.summary).toBe('Updated summary');
  });

  it('tracks size correctly', () => {
    expect(sessionCache.size()).toBe(0);
    sessionCache.set('WHO.CT-000010', makeEntry('WHO.CT-000010', 'Entry10'));
    sessionCache.set('WHO.CT-000011', makeEntry('WHO.CT-000011', 'Entry11'));
    expect(sessionCache.size()).toBe(2);
  });
});
