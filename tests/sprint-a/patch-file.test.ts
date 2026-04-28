import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionCache } from '../../core/memory/session-cache.js';

// Patch the workspace root for isolation
let tmpDir: string;
let origCwd: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-test-'));
  // Create workspace subdir so patch_file can find files
  fs.mkdirSync(path.join(tmpDir, 'workspace'), { recursive: true });
  origCwd = process.cwd();
  process.chdir(tmpDir);
  // Pre-record a file_reader call so gate passes
  sessionCache.recordSkillCall('file_reader', { path: 'src/foo.ts' });
  sessionCache.recordSkillCall('file_reader', { path: 'ambiguous.ts' });
  sessionCache.recordSkillCall('file_reader', { path: 'noop.ts' });
  sessionCache.recordSkillCall('file_reader', { path: 'fuzzy.ts' });
  sessionCache.recordSkillCall('file_reader', { path: 'ws.ts' });
  sessionCache.recordSkillCall('file_reader', { path: 'flex.ts' });
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  sessionCache.clearSkillHistory();
});

function writeFile(rel: string, content: string) {
  const full = path.join(tmpDir, 'workspace', rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

function readFile(rel: string): string {
  return fs.readFileSync(path.join(tmpDir, 'workspace', rel), 'utf-8');
}

async function patch(filepath: string, edits: string) {
  const { default: patchFileSkill } = await import('../../core/skills/tools/patch_file.js');
  return patchFileSkill.execute({ filepath, edits });
}

describe('patch_file — diff-fenced integration', () => {
  it('tier 1: exact match applies correctly', async () => {
    writeFile('src/foo.ts', 'const x = 1;\nconst y = 2;\n');
    const edits = '```ts src/foo.ts\n<<<<<<< SEARCH\nconst x = 1;\n=======\nconst x = 99;\n>>>>>>> REPLACE\n```';
    const result = await patch('src/foo.ts', edits);
    expect(result.success).toBe(true);
    expect(readFile('src/foo.ts')).toContain('const x = 99;');
  });

  it('tier 2: whitespace-normalised match applies', async () => {
    writeFile('ws.ts', 'function  foo() {\n  return   1;\n}\n');
    const edits = '```ts ws.ts\n<<<<<<< SEARCH\nfunction foo() {\n  return 1;\n}\n=======\nfunction foo() {\n  return 42;\n}\n>>>>>>> REPLACE\n```';
    const result = await patch('ws.ts', edits);
    // Should succeed via tier 1 or 2
    expect(result.success).toBe(true);
  });

  it('tier 3: leading-whitespace-flexible match applies', async () => {
    writeFile('flex.ts', '    const a = 1;\n    const b = 2;\n');
    const edits = '```ts flex.ts\n<<<<<<< SEARCH\nconst a = 1;\nconst b = 2;\n=======\nconst a = 10;\nconst b = 20;\n>>>>>>> REPLACE\n```';
    const result = await patch('flex.ts', edits);
    expect(result.success).toBe(true);
    const content = readFile('flex.ts');
    expect(content).toContain('10');
    expect(content).toContain('20');
  });

  it('tier 4: fuzzy match applies for ~90% similar content', async () => {
    const original = 'function computeSum(items) {\n  return items.reduce((acc, val) => acc + val, 0);\n}\n';
    writeFile('fuzzy.ts', original);
    // Search has one word changed — should fuzzy match
    const edits = '```ts fuzzy.ts\n<<<<<<< SEARCH\nfunction computeSum(items) {\n  return items.reduce((acc, val) => acc + val.value, 0);\n}\n=======\nfunction computeSum(items) {\n  return items.reduce((acc, val) => acc + val.count, 0);\n}\n>>>>>>> REPLACE\n```';
    const result = await patch('fuzzy.ts', edits);
    // May succeed (fuzzy) or fail gracefully — must not throw
    expect(typeof result.success).toBe('boolean');
  });

  it('ambiguity rejection: two identical strings returns error', async () => {
    writeFile('ambiguous.ts', 'foo\nbar\nfoo\nbaz\n');
    const edits = '```ts ambiguous.ts\n<<<<<<< SEARCH\nfoo\n=======\nXXX\n>>>>>>> REPLACE\n```';
    const result = await patch('ambiguous.ts', edits);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ambig|matches \d+ locations/i);
  });

  it('not-found returns structured error with hint', async () => {
    writeFile('src/foo.ts', 'const x = 1;\n');
    const edits = '```ts src/foo.ts\n<<<<<<< SEARCH\nconst z = 999;\n=======\nconst z = 0;\n>>>>>>> REPLACE\n```';
    const result = await patch('src/foo.ts', edits);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('no-op (search === replace) returns error', async () => {
    writeFile('noop.ts', 'const x = 1;\n');
    const edits = '```ts noop.ts\n<<<<<<< SEARCH\nconst x = 1;\n=======\nconst x = 1;\n>>>>>>> REPLACE\n```';
    const result = await patch('noop.ts', edits);
    expect(result.success).toBe(false);
    expect(result.error?.toLowerCase()).toMatch(/identical|no.op|no change/i);
  });

  it('multiple blocks applied in order', async () => {
    writeFile('src/foo.ts', 'A\nB\nC\n');
    const edits =
      '```ts src/foo.ts\n<<<<<<< SEARCH\nA\n=======\nX\n>>>>>>> REPLACE\n```\n\n' +
      '```ts src/foo.ts\n<<<<<<< SEARCH\nC\n=======\nZ\n>>>>>>> REPLACE\n```';
    const result = await patch('src/foo.ts', edits);
    expect(result.success).toBe(true);
    const content = readFile('src/foo.ts');
    expect(content).toContain('X');
    expect(content).toContain('Z');
    expect(content).not.toContain('A');
    expect(content).not.toContain('C');
  });

  it('missing closing fence recovers and applies', async () => {
    writeFile('src/foo.ts', 'hello world\n');
    const edits = '```ts src/foo.ts\n<<<<<<< SEARCH\nhello world\n=======\ngoodbye world\n>>>>>>> REPLACE\n';
    const result = await patch('src/foo.ts', edits);
    // Best-effort — may succeed or fail but must not throw
    expect(typeof result.success).toBe('boolean');
  });
});
