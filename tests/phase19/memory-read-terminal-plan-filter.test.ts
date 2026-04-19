import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchByCodeMock = vi.fn();
const getRelationshipsFromMock = vi.fn(() => []);
const getRelationshipsToMock = vi.fn(() => []);
const hybridSearchMock = vi.fn();
const queryEntriesMock = vi.fn(() => []);

vi.mock('../../core/memory/mod.js', () => ({
  fetchByCode: (...args: unknown[]) => fetchByCodeMock(...args),
  getRelationshipsFrom: (...args: unknown[]) => getRelationshipsFromMock(...args),
  getRelationshipsTo: (...args: unknown[]) => getRelationshipsToMock(...args),
  hybridSearch: (...args: unknown[]) => hybridSearchMock(...args),
  queryEntries: (...args: unknown[]) => queryEntriesMock(...args),
}));

describe('memory_read terminal PLAN.EX filtering', () => {
  const failedPlan = {
    code: 'PLAN.EX-000067',
    nb: 'PLAN',
    type: 'EX',
    name: 'mechanical-watch-simulation-spec',
    status: 'failed',
    updated: '2026-04-11',
    summary: 'failed spec',
    path: '/tmp/PLAN.EX-000067.md',
  };

  const activePlan = {
    code: 'PLAN.EX-000076',
    nb: 'PLAN',
    type: 'EX',
    name: 'mechanical-watch-simulation-spec',
    status: 'active',
    updated: '2026-04-11',
    summary: 'active spec',
    path: '/tmp/PLAN.EX-000076.md',
  };

  beforeEach(() => {
    fetchByCodeMock.mockReset();
    getRelationshipsFromMock.mockClear();
    getRelationshipsToMock.mockClear();
    hybridSearchMock.mockReset();
    queryEntriesMock.mockReset();
    queryEntriesMock.mockReturnValue([]);
  });

  it('filters failed PLAN.EX entries from query search results', async () => {
    const { default: memoryReadSkill } = await import('../../core/skills/tools/memory_read.js');

    hybridSearchMock.mockResolvedValue([
      { entry: failedPlan },
      { entry: activePlan },
    ]);

    const result = await memoryReadSkill.execute({
      query: 'mechanical-watch-simulation-spec',
      nb: 'PLAN',
      type: 'EX',
    });

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.output);
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0].code).toBe(activePlan.code);
  });

  it('filters failed PLAN.EX entries from name lookup results', async () => {
    const { default: memoryReadSkill } = await import('../../core/skills/tools/memory_read.js');

    hybridSearchMock.mockResolvedValue([]);
    queryEntriesMock.mockReturnValue([failedPlan, activePlan]);

    const result = await memoryReadSkill.execute({
      name: 'mechanical-watch-simulation-spec',
      nb: 'PLAN',
      type: 'EX',
    });

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.output);
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0].code).toBe(activePlan.code);
  });

  it('still allows explicit code lookup for a failed PLAN.EX entry', async () => {
    const { default: memoryReadSkill } = await import('../../core/skills/tools/memory_read.js');

    fetchByCodeMock.mockReturnValue({
      entry: failedPlan,
      content: '---\ncode: PLAN.EX-000067\n---\n\n# Failed spec',
    });

    const result = await memoryReadSkill.execute({
      code: failedPlan.code,
      includeContent: true,
    });

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.output);
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0].code).toBe(failedPlan.code);
  });
});
