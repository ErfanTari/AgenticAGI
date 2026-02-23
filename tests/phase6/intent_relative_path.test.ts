import { describe, it, expect } from 'vitest';
import { classifyIntent } from '../../core/intent.js';

describe('intent file path extraction', () => {
  it('keeps relative nested file paths intact for file_reader', () => {
    const c = classifyIntent('read the file user_workspace/test.txt');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('file_reader');
    expect(String(c.skillInput?.path)).toBe('user_workspace/test.txt');
  });
});
