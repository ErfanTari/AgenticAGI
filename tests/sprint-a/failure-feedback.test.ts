import { describe, it, expect } from 'vitest';
import { buildFailureFeedback } from '../../core/skills/edit/failure-feedback.js';
import type { EditBlock } from '../../core/skills/edit/diff-fenced-parser.js';

const block = (filePath: string, search = 'old', replace = 'new'): EditBlock => ({
  filePath, language: 'ts', search, replace, blockIndex: 0,
});

describe('failure-feedback', () => {
  it('not-found with no candidates mentions file_reader', () => {
    const fb = buildFailureFeedback(
      block('src/foo.ts'),
      'completely unrelated content',
      { tier: 'fail', reason: 'not-found', candidates: [] },
    );
    expect(fb.classification).toBe('not-found');
    expect(fb.hint).toContain('src/foo.ts');
    expect(fb.hint.toLowerCase()).toContain('file_reader');
  });

  it('ambiguous includes match count in hint', () => {
    const candidates = [
      { start: 0, end: 3, preview: 'old\nfoo', ratio: 1.0 },
      { start: 10, end: 13, preview: 'old\nbar', ratio: 1.0 },
    ];
    const fb = buildFailureFeedback(
      block('a.ts'),
      'file content with old twice\nold again',
      { tier: 'fail', reason: 'ambiguous', candidates },
    );
    expect(fb.classification).toBe('ambiguous');
    expect(fb.hint).toContain('2');
  });

  it('whitespace-mismatch hint mentions the file path and indentation', () => {
    const fileContents = '  function foo() {\n    return 1;\n  }';
    const fb = buildFailureFeedback(
      block('b.ts'),
      fileContents,
      { tier: 'fail', reason: 'whitespace-mismatch', candidates: [] },
    );
    expect(fb.classification).toBe('whitespace-mismatch');
    expect(fb.hint).toContain('b.ts');
    expect(fb.hint.toLowerCase()).toMatch(/indent|space|tab/);
  });

  it('no-op hint says SEARCH and REPLACE are identical', () => {
    const fb = buildFailureFeedback(
      block('c.ts', 'same', 'same'),
      'same content here',
      { tier: 'fail', reason: 'no-op', candidates: [] },
    );
    expect(fb.classification).toBe('no-op');
    expect(fb.hint.toLowerCase()).toContain('identical');
  });
});
