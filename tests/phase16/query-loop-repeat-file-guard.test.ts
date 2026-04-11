import { describe, it, expect, vi, beforeEach } from 'vitest';

const runWithRetryMock = vi.fn();

vi.mock('../../core/react.js', () => ({
  runWithRetry: (...args: unknown[]) => runWithRetryMock(...args),
}));

describe('Phase 16: QueryLoop repeated generated file guard', () => {
  beforeEach(() => {
    runWithRetryMock.mockReset();
  });

  it('does not execute generate_and_save_file twice for the same successful path', async () => {
    const { runQueryLoop } = await import('../../core/query-loop.js');

    runWithRetryMock.mockResolvedValueOnce({
      success: true,
      output: 'Generated and saved mechanical_watch.py',
      retries: 0,
    });

    let llmCallCount = 0;
    const mockLLM = async () => {
      llmCallCount++;
      if (llmCallCount === 1) {
        return '{"action":"generate_and_save_file","input":{"path":"mechanical_watch.py","description":"Create a Python Tkinter mechanical watch simulation."}}';
      }
      if (llmCallCount === 2) {
        return '{"action":"generate_and_save_file","input":{"path":"mechanical_watch.py","description":"Create a Python Tkinter mechanical watch simulation."}}';
      }
      return 'Task complete. The file mechanical_watch.py has already been created.';
    };

    const result = await runQueryLoop('Create a mechanical watch simulator in Python.', mockLLM as never);

    expect(runWithRetryMock).toHaveBeenCalledTimes(1);
    expect(runWithRetryMock).toHaveBeenCalledWith(
      'generate_and_save_file',
      expect.objectContaining({ path: 'mechanical_watch.py' }),
      expect.any(Function),
    );
    expect(result.stoppedBecause).toBe('no_action');
    expect(result.reply).toContain('already been created');
    expect(result.skillsUsed).toEqual(['generate_and_save_file']);
  });
});
