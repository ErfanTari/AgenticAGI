import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryEntries: vi.fn(),
  fetchByCode: vi.fn(),
  getEntryByCode: vi.fn(),
  searchBM25: vi.fn(),
  fetchEmbeddings: vi.fn(),
  searchVectors: vi.fn(),
}));

vi.mock('../../core/memory/mod.js', () => ({
  queryEntries: mocks.queryEntries,
  fetchByCode: mocks.fetchByCode,
  getEntryByCode: mocks.getEntryByCode,
}));

vi.mock('../../core/memory/fts.js', () => ({
  searchBM25: mocks.searchBM25,
}));

vi.mock('../../core/memory/embeddings.js', () => ({
  fetchEmbeddings: mocks.fetchEmbeddings,
  searchVectors: mocks.searchVectors,
}));

import { searchMemoryForUnits } from '../../core/memory/unit-search.js';
import { sessionCache } from '../../core/memory/session-cache.js';

describe('Phase 13: unit memory search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionCache.clear();
    mocks.queryEntries.mockReturnValue([]);
    mocks.fetchByCode.mockReturnValue(null);
    mocks.getEntryByCode.mockReturnValue(undefined);
    mocks.searchBM25.mockReturnValue([]);
    mocks.fetchEmbeddings.mockResolvedValue([[0.1, 0.2, 0.3]]);
    mocks.searchVectors.mockReturnValue([]);
  });

  it('searches all units in parallel and preserves result alignment', async () => {
    const started: string[] = [];
    mocks.fetchEmbeddings.mockImplementation(async ([query]: string[]) => {
      started.push(query);
      await new Promise(resolve => setTimeout(resolve, 40));
      return [[0.1, 0.2, 0.3]];
    });

    const units = [
      { id: 'u1', route: 'query' as const, content: 'alpha request', order: 0 },
      { id: 'u2', route: 'query' as const, content: 'beta request', order: 1 },
    ];

    const start = performance.now();
    const results = await searchMemoryForUnits(units);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(75);
    expect(started).toEqual(['alpha request', 'beta request']);
    expect(results.map(result => result.unitId)).toEqual(['u1', 'u2']);
  });

  it('applies signal priority in TypeScript before fallback search', async () => {
    mocks.queryEntries.mockImplementation((filter: { nb?: string; name?: string }) => {
      if (filter.nb === 'WHO') {
        return [{
          code: 'WHO.CT-000001',
          nb: 'WHO',
          type: 'CT',
          name: 'Sara Moradi',
          status: 'active',
          updated: '2026-03-06',
          summary: 'Reviewer',
          path: '/tmp/WHO.CT-000001.md',
        }];
      }
      return [];
    });
    mocks.fetchByCode.mockReturnValue({ content: 'Sara Moradi reviewed the project.' });

    const [result] = await searchMemoryForUnits([
      { id: 'u1', route: 'query', content: 'who is Sara Moradi', order: 0 },
    ]);

    expect(result.strategy).toBe('person');
    expect(result.confidence).toBe(1);
    expect(mocks.searchBM25).not.toHaveBeenCalled();
  });

  // FIX A: Person pattern tightening tests
  it('FIX A: "Create a REST API server" should NOT match person', async () => {
    const [result] = await searchMemoryForUnits([
      { id: 'u1', route: 'conversational' as const, content: 'Create a REST API server', order: 0 },
    ]);
    expect(result.strategy).not.toBe('person');
  });

  it('FIX A: "Sara reviewed the code" should match person "Sara"', async () => {
    mocks.queryEntries.mockImplementation((filter: { nb?: string; name?: string }) => {
      if (filter.nb === 'WHO') {
        return [{
          code: 'WHO.CT-000010',
          nb: 'WHO',
          type: 'CT',
          name: 'Sara',
          status: 'active',
          updated: '2026-03-06',
          summary: 'Developer',
          path: '/tmp/WHO.CT-000010.md',
        }];
      }
      return [];
    });

    const [result] = await searchMemoryForUnits([
      { id: 'u1', route: 'conversational' as const, content: 'Sara reviewed the code', order: 0 },
    ]);
    expect(result.strategy).toBe('person');
  });

  it('FIX A: "Remember the snake game" should NOT match person', async () => {
    const [result] = await searchMemoryForUnits([
      { id: 'u1', route: 'conversational' as const, content: 'Remember the snake game', order: 0 },
    ]);
    expect(result.strategy).not.toBe('person');
  });

  it('FIX A: "Tell James about the bug" should match person "James"', async () => {
    mocks.queryEntries.mockImplementation((filter: { nb?: string; name?: string }) => {
      if (filter.nb === 'WHO') {
        return [{
          code: 'WHO.CT-000011',
          nb: 'WHO',
          type: 'CT',
          name: 'James',
          status: 'active',
          updated: '2026-03-06',
          summary: 'Developer',
          path: '/tmp/WHO.CT-000011.md',
        }];
      }
      return [];
    });

    const [result] = await searchMemoryForUnits([
      { id: 'u1', route: 'conversational' as const, content: 'Tell James about the bug', order: 0 },
    ]);
    expect(result.strategy).toBe('person');
  });

  it('FIX A: "James Chen is the lead" should match person "James Chen"', async () => {
    mocks.queryEntries.mockImplementation((filter: { nb?: string; name?: string }) => {
      if (filter.nb === 'WHO') {
        return [{
          code: 'WHO.CT-000012',
          nb: 'WHO',
          type: 'CT',
          name: 'James Chen',
          status: 'active',
          updated: '2026-03-06',
          summary: 'Team Lead',
          path: '/tmp/WHO.CT-000012.md',
        }];
      }
      return [];
    });

    const [result] = await searchMemoryForUnits([
      { id: 'u1', route: 'conversational' as const, content: 'James Chen is the lead', order: 0 },
    ]);
    expect(result.strategy).toBe('person');
  });

  it('falls back to BM25 when a person signal has no WHO hits', async () => {
    const entry = {
      code: 'PLAN.PJ-000099',
      nb: 'WHAT',
      type: 'PJ',
      name: 'Architecture Notes',
      status: 'active',
      updated: '2026-03-06',
      summary: 'Notes about reviewed architecture',
      path: '/tmp/PLAN.PJ-000099.md',
    };
    mocks.searchBM25.mockReturnValue([{ code: entry.code, score: 0.1 }]);
    mocks.getEntryByCode.mockReturnValue(entry);
    mocks.fetchByCode.mockReturnValue({ content: 'Architecture review notes.' });

    const [result] = await searchMemoryForUnits([
      { id: 'u1', route: 'conversational' as const, content: 'Sara reviewed the architecture', order: 0 },
    ]);

    expect(result.strategy).toBe('bm25');
  });

  it('skips vector search when BM25 confidence is high enough', async () => {
    const entry = {
      code: 'PLAN.PJ-000001',
      nb: 'WHAT',
      type: 'PJ',
      name: 'ceramic roadmap',
      status: 'active',
      updated: '2026-03-06',
      summary: 'ceramic roadmap with milestones',
      path: '/tmp/PLAN.PJ-000001.md',
    };
    mocks.searchBM25.mockReturnValue([{ code: entry.code, score: 0.1 }]);
    mocks.getEntryByCode.mockReturnValue(entry);
    mocks.fetchByCode.mockReturnValue({ content: 'Project details.' });

    const [result] = await searchMemoryForUnits([
      { id: 'u1', route: 'query', content: 'ceramic roadmap', order: 0 },
    ]);

    expect(result.strategy).toBe('bm25');
    expect(mocks.fetchEmbeddings).not.toHaveBeenCalled();
  });
});
