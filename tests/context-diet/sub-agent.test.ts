/**
 * Sub-agent primitive tests (Batch 3)
 *
 * Verifies:
 * 1. spawnSubAgent calls runQueryLoop with scoped skills only
 * 2. Skill intersection: skills not in permittedSkills are filtered out
 * 3. contextHandoff is included in the scoped goal (capped at ~2000 chars)
 * 4. inheritConstraints prefix is prepended to the goal
 * 5. Success detection: stoppedBecause=no_action → success=true
 * 6. Sub-agent result shape is complete
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock runQueryLoop ────────────────────────────────────────────────────────

const mockQueryLoopResult = {
  reply: 'Sub-agent done.',
  iterations: 2,
  skillsUsed: ['calculator'],
  stoppedBecause: 'no_action' as const,
};

vi.mock('../../core/query-loop.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    runQueryLoop: vi.fn().mockResolvedValue(mockQueryLoopResult),
  };
});

// ─── Mock registry ────────────────────────────────────────────────────────────

vi.mock('../../core/skills/registry.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    getSkillsByPermission: vi.fn().mockReturnValue([
      { name: 'calculator' },
      { name: 'memory_read' },
      { name: 'web_search' },
    ]),
  };
});

// ─── Mock permission / memory-mode ───────────────────────────────────────────

vi.mock('../../core/permission.js', () => ({
  getActivePermissionMode: vi.fn().mockReturnValue('read-only'),
  enforcePermission: vi.fn(),
}));

vi.mock('../../core/memory-mode.js', () => ({
  getMemoryMode: vi.fn().mockReturnValue('enabled'),
  isMemoryFullyDisabled: vi.fn().mockReturnValue(false),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('spawnSubAgent', () => {
  let runQueryLoop: ReturnType<typeof vi.fn>;
  let spawnSubAgent: (task: import('../../core/sub-agent.js').SubAgentTask, handler: unknown) => Promise<import('../../core/sub-agent.js').SubAgentResult>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const qlMod = await import('../../core/query-loop.js');
    runQueryLoop = qlMod.runQueryLoop as ReturnType<typeof vi.fn>;
    const mod = await import('../../core/sub-agent.js');
    spawnSubAgent = mod.spawnSubAgent;
  });

  it('calls runQueryLoop with the scoped goal', async () => {
    const result = await spawnSubAgent(
      { goal: 'calculate 2+2', allowedSkills: ['calculator'] },
      vi.fn(),
    );
    expect(runQueryLoop).toHaveBeenCalledOnce();
    const [scopedGoal] = runQueryLoop.mock.calls[0] as [string, ...unknown[]];
    expect(scopedGoal).toContain('calculate 2+2');
  });

  it('filters allowed skills against permitted skills', async () => {
    await spawnSubAgent(
      { goal: 'test', allowedSkills: ['calculator', 'run_bash'] }, // run_bash not in permitted
      vi.fn(),
    );
    const opts = runQueryLoop.mock.calls[0][5] as { allowedSkillsOverride: string[] };
    expect(opts.allowedSkillsOverride).toContain('calculator');
    expect(opts.allowedSkillsOverride).not.toContain('run_bash');
  });

  it('prepends inheritConstraints to goal', async () => {
    await spawnSubAgent(
      { goal: 'do something', allowedSkills: ['calculator'], inheritConstraints: ['no bash', 'read-only'] },
      vi.fn(),
    );
    const [scopedGoal] = runQueryLoop.mock.calls[0] as [string, ...unknown[]];
    expect(scopedGoal).toContain('[CONSTRAINTS: no bash; read-only]');
    expect(scopedGoal).toContain('do something');
  });

  it('includes contextHandoff capped at 2000 chars', async () => {
    const longHandoff = 'x'.repeat(3000);
    await spawnSubAgent(
      { goal: 'g', allowedSkills: ['calculator'], contextHandoff: longHandoff },
      vi.fn(),
    );
    const [scopedGoal] = runQueryLoop.mock.calls[0] as [string, ...unknown[]];
    expect(scopedGoal).toContain('[CONTEXT FROM PARENT]');
    // handoff capped at 2000
    expect(scopedGoal).not.toContain('x'.repeat(2001));
  });

  it('passes maxIterationsOverride from task', async () => {
    await spawnSubAgent(
      { goal: 'g', allowedSkills: ['calculator'], maxIterations: 42 },
      vi.fn(),
    );
    const opts = runQueryLoop.mock.calls[0][5] as { maxIterationsOverride: number };
    expect(opts.maxIterationsOverride).toBe(42);
  });

  it('marks success=true when stoppedBecause=no_action', async () => {
    const result = await spawnSubAgent({ goal: 'g', allowedSkills: ['calculator'] }, vi.fn());
    expect(result.success).toBe(true);
    expect(result.reply).toBe('Sub-agent done.');
  });

  it('marks success=false when stoppedBecause=circuit_breaker', async () => {
    runQueryLoop.mockResolvedValueOnce({ ...mockQueryLoopResult, stoppedBecause: 'circuit_breaker' });
    const result = await spawnSubAgent({ goal: 'g', allowedSkills: ['calculator'] }, vi.fn());
    expect(result.success).toBe(false);
  });

  it('marks success=true when stoppedBecause=goal_complete', async () => {
    runQueryLoop.mockResolvedValueOnce({ ...mockQueryLoopResult, stoppedBecause: 'goal_complete' });
    const result = await spawnSubAgent({ goal: 'g', allowedSkills: ['calculator'] }, vi.fn());
    expect(result.success).toBe(true);
  });

  it('result includes iterations and skillsUsed', async () => {
    const result = await spawnSubAgent({ goal: 'g', allowedSkills: ['calculator'] }, vi.fn());
    expect(result.iterations).toBe(2);
    expect(result.skillsUsed).toEqual(['calculator']);
  });
});
