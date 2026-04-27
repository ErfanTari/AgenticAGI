import { describe, it, expect, vi, beforeEach } from 'vitest';

const runWithRetryMock = vi.fn();

vi.mock('../../core/react.js', () => ({
  runWithRetry: (...args: unknown[]) => runWithRetryMock(...args),
}));

describe('Phase 16: QueryLoop repeated generated file guard', () => {
  beforeEach(() => {
    runWithRetryMock.mockReset();
  });

  it('auto-overwrites on second generate_and_save_file call for same path instead of blocking', async () => {
    const { runQueryLoop } = await import('../../core/query-loop.js');

    // Both calls succeed (second one uses auto-overwrite)
    runWithRetryMock.mockResolvedValue({
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

    // Second call proceeds with overwrite:true instead of being blocked
    expect(runWithRetryMock).toHaveBeenCalledTimes(2);
    expect(runWithRetryMock).toHaveBeenNthCalledWith(
      2,
      'generate_and_save_file',
      expect.objectContaining({ path: 'mechanical_watch.py', overwrite: true }),
      expect.any(Function),
    );
    expect(result.stoppedBecause).toBe('no_action');
    expect(result.reply).toContain('already been created');
  });
});
