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

describe('generate_and_save_file reasoning stripping', () => {
  beforeEach(() => {
    callLLMMock.mockReset();
    fetchByCodeMock.mockReset();
    runSkillMock.mockReset();
  });

  it('recovers code content that appears after an orphaned think block', async () => {
    const { default: generateAndSaveFileSkill } = await import('../../core/skills/tools/generate_and_save_file.js');

    callLLMMock.mockResolvedValue([
      '<think>',
      'Thinking Process:',
      '1. Analyze the task.',
      '2. Prepare the response.',
      '```javascript',
      "const express = require('express');",
      'module.exports = express;',
      '```',
    ].join('\n'));

    runSkillMock.mockResolvedValue({ success: true, output: 'written' });

    const result = await generateAndSaveFileSkill.execute({
      path: 'server.js',
      description: 'Create a simple Node.js server entry file.',
    });

    expect(result.success).toBe(true);
    expect(runSkillMock).toHaveBeenCalledWith(
      'file_writer',
      expect.objectContaining({
        path: 'server.js',
        content: "const express = require('express');\nmodule.exports = express;",
      }),
    );
  });
});
