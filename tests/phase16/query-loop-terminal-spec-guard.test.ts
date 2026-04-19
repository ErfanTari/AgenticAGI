import { beforeEach, describe, expect, it, vi } from 'vitest';

const runWithRetryMock = vi.fn();
const getEntryByCodeMock = vi.fn();

vi.mock('../../core/react.js', () => ({
  runWithRetry: (...args: unknown[]) => runWithRetryMock(...args),
}));

vi.mock('../../core/memory/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../core/memory/index.js')>('../../core/memory/index.js');
  return {
    ...actual,
    getEntryByCode: (...args: unknown[]) => getEntryByCodeMock(...args),
  };
});

describe('Phase 16: QueryLoop terminal spec_code guard', () => {
  beforeEach(() => {
    runWithRetryMock.mockReset();
    getEntryByCodeMock.mockReset();
  });

  it('does not execute generate_and_save_file for terminal PLAN.EX spec_code', async () => {
    const { runQueryLoop } = await import('../../core/query-loop.js');

    getEntryByCodeMock.mockReturnValue({
      code: 'PLAN.EX-000075',
      nb: 'PLAN',
      type: 'EX',
      name: 'mechanical-watch-simulation-spec',
      status: 'failed',
      updated: '2026-04-11',
      summary: 'failed spec',
      path: '/tmp/PLAN.EX-000075.md',
    });

    let llmCallCount = 0;
    const mockLLM = async () => {
      llmCallCount++;
      if (llmCallCount === 1) {
        return '<action>generate_and_save_file</action>\n<path>mechanical_watch.py</path>\n<spec_code>PLAN.EX-000075</spec_code>';
      }
      return 'Task complete. I will not reuse the failed execution spec.';
    };

    const result = await runQueryLoop('Create a mechanical watch simulator in Python.', mockLLM as never);

    expect(runWithRetryMock).not.toHaveBeenCalled();
    expect(result.stoppedBecause).toBe('no_action');
    expect(result.reply).toContain('failed execution spec');
  });
});
