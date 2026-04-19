import { beforeEach, describe, expect, it, vi } from 'vitest';

const callLLMMock = vi.fn();
const fetchByCodeMock = vi.fn();
const runSkillMock = vi.fn();

vi.mock('../../core/llm.js', () => ({
  callLLM: (...args: unknown[]) => callLLMMock(...args),
}));

vi.mock('../../core/memory/fetch.js', () => ({
  fetchByCode: (...args: unknown[]) => fetchByCodeMock(...args),
}));

vi.mock('../../core/skills/runner.js', () => ({
  runSkill: (...args: unknown[]) => runSkillMock(...args),
}));

describe('generate_and_save_file terminal PLAN.EX guard', () => {
  beforeEach(() => {
    callLLMMock.mockReset();
    fetchByCodeMock.mockReset();
    runSkillMock.mockReset();
  });

  it('allows failed PLAN.EX spec_code — terminal status does not block spec reads (FIX 1)', async () => {
    const { default: generateAndSaveFileSkill } = await import('../../core/skills/tools/generate_and_save_file.js');

    fetchByCodeMock.mockReturnValue({
      entry: {
        code: 'PLAN.EX-000075',
        nb: 'PLAN',
        type: 'EX',
        name: 'mechanical-watch-simulation-spec',
        status: 'failed',
        updated: '2026-04-11',
        summary: 'failed spec',
        path: '/tmp/PLAN.EX-000075.md',
      },
      content: '---\ncode: PLAN.EX-000075\nstatus: failed\n---\n\n# Build a mechanical watch simulation in Python.',
    });

    callLLMMock.mockResolvedValue('print("mechanical watch")');
    runSkillMock.mockResolvedValue({ success: true, output: 'wrote file' });

    const result = await generateAndSaveFileSkill.execute({
      path: 'mechanical_watch.py',
      spec_code: 'PLAN.EX-000075',
    });

    // Terminal status must NOT block generation — spec body is valid for reading
    expect(result.success).toBe(true);
    expect(callLLMMock).toHaveBeenCalled();
    expect(runSkillMock).toHaveBeenCalled();
  });
});
