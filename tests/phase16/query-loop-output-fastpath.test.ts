import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runWithRetryMock = vi.fn();

vi.mock('../../core/react.js', () => ({
  runWithRetry: (...args: unknown[]) => runWithRetryMock(...args),
}));

describe('Phase 16: QueryLoop output-folder fast path', () => {
  const workspaceRoot = path.join(process.cwd(), 'workspace');
  const requestedDir = path.join(workspaceRoot, 'outputs', 'vitest-fastpath');

  beforeEach(() => {
    runWithRetryMock.mockReset();
    fs.rmSync(requestedDir, { recursive: true, force: true });
    fs.rmSync(`${requestedDir}-1`, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(requestedDir, { recursive: true, force: true });
    fs.rmSync(`${requestedDir}-1`, { recursive: true, force: true });
  });

  it('rewrites file paths into the resolved fresh output directory', async () => {
    fs.mkdirSync(requestedDir, { recursive: true });

    const { runQueryLoop } = await import('../../core/query-loop.js');

    runWithRetryMock.mockResolvedValueOnce({
      success: true,
      output: 'Written to outputs/vitest-fastpath-1/server.js',
      retries: 0,
    });

    let llmCallCount = 0;
    const mockLLM = async () => {
      llmCallCount += 1;
      if (llmCallCount === 1) {
        return '<action>file_writer</action>\n<path>outputs/vitest-fastpath/server.js</path>\n<content>console.log("ok")</content>';
      }
      return 'Done.';
    };

    const result = await runQueryLoop(
      'Create a small server in a fresh output folder under outputs/vitest-fastpath/.',
      mockLLM as never,
    );

    expect(runWithRetryMock).toHaveBeenCalledWith(
      'file_writer',
      expect.objectContaining({ path: 'outputs/vitest-fastpath-1/server.js' }),
      expect.any(Function),
    );
    expect(result.stoppedBecause).toBe('no_action');
  });

  it('auto-completes immediately after a successful single-artifact generation', async () => {
    const { runQueryLoop } = await import('../../core/query-loop.js');

    runWithRetryMock.mockResolvedValueOnce({
      success: true,
      output: 'Generated and saved outputs/vitest-fastpath/index.html',
      retries: 0,
    });

    let llmCallCount = 0;
    const mockLLM = async () => {
      llmCallCount += 1;
      return '<action>generate_and_save_file</action>\n<path>outputs/vitest-fastpath/index.html</path>\n<description>Create a complete single-file bakery website.</description>';
    };

    const result = await runQueryLoop(
      'Create a complete single-file bakery website and save it as outputs/vitest-fastpath/index.html.',
      mockLLM as never,
    );

    expect(llmCallCount).toBe(1);
    expect(result.stoppedBecause).toBe('goal_complete');
    expect(result.reply).toContain('outputs/vitest-fastpath/index.html');
  });
});
