import { describe, it, expect } from 'vitest';
import { parseDiffFenced } from '../../core/skills/edit/diff-fenced-parser.js';

const mkBlock = (lang: string, file: string, search: string, replace: string) =>
  `\`\`\`${lang} ${file}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n\`\`\``;

describe('diff-fenced-parser', () => {
  it('parses a single block', () => {
    const out = `\`\`\`ts src/foo.ts\n<<<<<<< SEARCH\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> REPLACE\n\`\`\``;
    const blocks = parseDiffFenced(out);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].filePath).toBe('src/foo.ts');
    expect(blocks[0].language).toBe('ts');
    expect(blocks[0].search).toBe('const x = 1;');
    expect(blocks[0].replace).toBe('const x = 2;');
    expect(blocks[0].blockIndex).toBe(0);
  });

  it('parses multiple blocks for the same file', () => {
    const out =
      mkBlock('ts', 'a.ts', 'old1', 'new1') + '\n\n' +
      mkBlock('ts', 'a.ts', 'old2', 'new2');
    const blocks = parseDiffFenced(out);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].search).toBe('old1');
    expect(blocks[1].search).toBe('old2');
    expect(blocks[1].blockIndex).toBe(1);
  });

  it('parses blocks for multiple files', () => {
    const out =
      mkBlock('ts', 'a.ts', 'alpha', 'ALPHA') + '\n\n' +
      mkBlock('py', 'b.py', 'beta', 'BETA');
    const blocks = parseDiffFenced(out);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].filePath).toBe('a.ts');
    expect(blocks[1].filePath).toBe('b.py');
  });

  it('handles trailing whitespace on marker lines', () => {
    const out = '```ts c.ts\n<<<<<<< SEARCH   \nold\n=======   \nnew\n>>>>>>> REPLACE   \n```';
    const blocks = parseDiffFenced(out);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe('old');
    expect(blocks[0].replace).toBe('new');
  });

  it('normalizes CRLF line endings', () => {
    const out = '```ts d.ts\r\n<<<<<<< SEARCH\r\nfoo\r\n=======\r\nbar\r\n>>>>>>> REPLACE\r\n```';
    const blocks = parseDiffFenced(out);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe('foo');
    expect(blocks[0].replace).toBe('bar');
  });

  it('best-effort recovery on missing closing fence', () => {
    const out = '```ts e.ts\n<<<<<<< SEARCH\nmissing close\n=======\nfixed\n>>>>>>> REPLACE\n';
    const blocks = parseDiffFenced(out);
    // Should still extract the block despite no closing ```
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe('missing close');
  });
});
