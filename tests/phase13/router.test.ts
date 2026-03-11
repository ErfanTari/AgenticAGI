import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildContext: vi.fn(),
  decomposeTask: vi.fn(),
  executePlan: vi.fn(),
  verifyExecution: vi.fn(),
  buildUserReport: vi.fn(),
  hybridSearch: vi.fn(),
  queryEntries: vi.fn(),
  updateEntry: vi.fn(),
  upsertEntry: vi.fn(),
  writeReflection: vi.fn(),
  getSkillDescriptions: vi.fn(),
  runSkill: vi.fn(),
  addRelationship: vi.fn(),
  getRelationshipsFrom: vi.fn(),
}));

vi.mock('../../core/context.js', () => ({
  buildContext: mocks.buildContext,
}));

vi.mock('../../core/planner.js', () => ({
  decomposeTask: mocks.decomposeTask,
}));

vi.mock('../../core/executor.js', () => ({
  executePlan: mocks.executePlan,
  verifyExecution: mocks.verifyExecution,
  buildUserReport: mocks.buildUserReport,
}));

vi.mock('../../core/memory/mod.js', () => ({
  fetchByCode: vi.fn((code: string) => ({ content: `content for ${code}` })),
  hybridSearch: mocks.hybridSearch,
  queryEntries: mocks.queryEntries,
  updateEntry: mocks.updateEntry,
  upsertEntry: mocks.upsertEntry,
}));

vi.mock('../../core/memory/episodic.js', () => ({
  writeReflection: mocks.writeReflection,
}));

vi.mock('../../core/memory/relationships.js', () => ({
  addRelationship: mocks.addRelationship,
  getRelationshipsFrom: mocks.getRelationshipsFrom,
}));

vi.mock('../../core/skills/registry.js', () => ({
  getSkillDescriptions: mocks.getSkillDescriptions,
}));

vi.mock('../../core/skills/runner.js', () => ({
  runSkill: mocks.runSkill,
}));

import { routeDecomposedUnits } from '../../core/router.js';

describe('Phase 13: route dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildContext.mockResolvedValue([
      { role: 'system', content: 'context system' },
      { role: 'user', content: 'context user' },
    ]);
    mocks.getSkillDescriptions.mockReturnValue('file_writer: write files');
    mocks.decomposeTask.mockResolvedValue({
      goal: 'Build app',
      steps: [{ id: 'step1', description: 'Write file', skill: 'file_writer', input: { path: 'app.ts' }, dependsOn: [] }],
      goals: [{ id: 'goal_1', sourceUnitIds: ['u3'], description: 'build app' }],
      milestones: [{
        id: 'm1',
        goalIds: ['goal_1'],
        title: 'Build',
        description: 'Build the app',
        completionCriteria: 'File written',
        steps: [{ id: 'step1', description: 'Write file', skill: 'file_writer', input: { path: 'app.ts' }, dependsOn: [] }],
      }],
      complexity: 'LOW',
      needsConfirmation: false,
      estimatedDuration: '1m',
      createdAt: '2026-03-06T00:00:00.000Z',
    });
    mocks.executePlan.mockResolvedValue({
      success: true,
      completed: [{ stepId: 'step1', skill: 'file_writer', output: 'done', retries: 0 }],
      failed: [],
      milestoneResults: [{
        milestoneId: 'm1',
        title: 'Build',
        success: true,
        completedStepIds: ['step1'],
        failedStepIds: [],
        eventCode: 'WHEN.EV-000001',
      }],
      linkedCodes: [],
    });
    mocks.verifyExecution.mockResolvedValue({ verified: true, confidence: 0.9, issues: [] });
    mocks.buildUserReport.mockReturnValue('agentic reply');
    mocks.hybridSearch.mockResolvedValue([]);
    mocks.queryEntries.mockReturnValue([]);
    mocks.updateEntry.mockReturnValue(undefined);
    mocks.upsertEntry.mockImplementation((input: { nb: string; type: string; name: string }) => ({
      code: `${input.nb}.${input.type}-000001`,
      created: true,
    }));
    mocks.writeReflection.mockResolvedValue('WHEN.RF-000001');
    mocks.runSkill.mockResolvedValue({ success: true, output: '2 + 2 = 4', retries: 0 });
    mocks.getRelationshipsFrom.mockReturnValue([]);
    mocks.addRelationship.mockReturnValue(undefined);
  });

  it('batches conversational units, sends query units to resolver, and plans agentic units together', async () => {
    const llm = vi.fn(async () => 'conversation reply');
    const units = [
      { id: 'u1', route: 'conversational' as const, content: 'talk me through this', order: 0 },
      { id: 'u2', route: 'query' as const, content: 'show me active projects', order: 1 },
      { id: 'u3', route: 'agentic' as const, content: 'build the client', order: 2 },
      { id: 'u4', route: 'agentic' as const, content: 'write tests for it', order: 3 },
    ];
    const results = [
      { unitId: 'u1', strategy: 'bm25' as const, confidence: 0.6, entries: [], contents: [] },
      {
        unitId: 'u2',
        strategy: 'bm25' as const,
        confidence: 0.7,
        entries: [{
          code: 'WHAT.PJ-000001',
          nb: 'WHAT',
          type: 'PJ',
          name: 'Project Atlas',
          status: 'active',
          updated: '2026-03-06',
          summary: 'Atlas summary',
          path: '/tmp/atlas.md',
        }],
        contents: ['Atlas content'],
      },
      { unitId: 'u3', strategy: 'procedure' as const, confidence: 0.8, entries: [], contents: [] },
      { unitId: 'u4', strategy: 'procedure' as const, confidence: 0.8, entries: [], contents: [] },
    ];

    const routed = await routeDecomposedUnits(units, results, [], llm);

    expect(llm).toHaveBeenCalledTimes(1);
    expect(mocks.decomposeTask).toHaveBeenCalledTimes(1);
    expect(mocks.decomposeTask.mock.calls[0][0]).toBe('build the client\nwrite tests for it');
    expect(mocks.decomposeTask.mock.calls[0][1].goals).toHaveLength(2);
    expect(mocks.decomposeTask.mock.calls[0][1].memoryContext).toContain('PRIOR QUERY CONTEXT');
    expect(mocks.decomposeTask.mock.calls[0][1].memoryContext).toContain('WHAT.PJ-000001');
    expect(mocks.hybridSearch).not.toHaveBeenCalled();
    expect(mocks.writeReflection).toHaveBeenCalledTimes(1);
    expect(routed.reply).toContain('conversation reply');
    expect(routed.reply).toContain('show me active projects');
    expect(routed.reply).toContain('agentic reply');
    expect(routed.parts.map(part => part.route)).toEqual(['conversational', 'query', 'agentic']);
  });

  it('uses broader hybrid search for empty pure query units without calling the planner or LLM', async () => {
    const llm = vi.fn(async () => 'should not be used');
    mocks.hybridSearch.mockResolvedValue([{
      entry: {
        code: 'WHAT.PJ-000002',
        nb: 'WHAT',
        type: 'PJ',
        name: 'Recovered Project',
        status: 'active',
        updated: '2026-03-06',
        summary: 'Recovered from hybrid search',
        path: '/tmp/recovered.md',
      },
      score: 0.9,
    }]);

    const routed = await routeDecomposedUnits(
      [{ id: 'u1', route: 'query', content: 'find recovered project', order: 0 }],
      [{ unitId: 'u1', strategy: 'bm25', confidence: 0, entries: [], contents: [] }],
      [],
      llm,
    );

    expect(mocks.hybridSearch).toHaveBeenCalledTimes(1);
    expect(mocks.decomposeTask).not.toHaveBeenCalled();
    expect(llm).not.toHaveBeenCalled();
    expect(routed.reply).toContain('Recovered Project');
  });

  it('persists conversational project and person facts, including project relationships', async () => {
    const llm = vi.fn(async () => 'conversation reply');

    await routeDecomposedUnits(
      [
        { id: 'u1', route: 'conversational', content: 'I started a new project today called Zaraban Analytics.', order: 0 },
        { id: 'u2', route: 'conversational', content: 'Sara is the lead designer and James is the backend engineer.', order: 1 },
      ],
      [
        { unitId: 'u1', strategy: 'bm25', confidence: 0, entries: [], contents: [] },
        { unitId: 'u2', strategy: 'bm25', confidence: 0, entries: [], contents: [] },
      ],
      [],
      llm,
    );

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mocks.upsertEntry).toHaveBeenCalledWith(expect.objectContaining({
      nb: 'WHAT',
      type: 'PJ',
      name: 'Zaraban Analytics',
    }));
    expect(mocks.upsertEntry).toHaveBeenCalledWith(expect.objectContaining({
      nb: 'WHO',
      type: 'CT',
      name: 'Sara',
      summary: 'Sara is the lead designer',
    }));
    expect(mocks.upsertEntry).toHaveBeenCalledWith(expect.objectContaining({
      nb: 'WHO',
      type: 'CT',
      name: 'James',
      summary: 'James is the backend engineer',
    }));
    expect(mocks.addRelationship).toHaveBeenCalledTimes(2);
  });
});
