/**
 * Phase 18 — patch_file skill tests
 * 8 tests covering: success, not-found, ambiguous, symlink, large file, empty replace
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir: string;
let origCwd: string;

function setup(): void {
  origCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-file-test-'));
  fs.mkdirSync(path.join(tmpDir, 'workspace'), { recursive: true });
  process.chdir(tmpDir);
}

function teardown(): void {
  process.chdir(origCwd);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('patch_file skill', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('1. successful single replacement', async () => {
    const { default: patchFile } = await import('../../core/skills/tools/patch_file.js');
    fs.writeFileSync(path.join(tmpDir, 'workspace', 'hello.txt'), 'Hello World!');
    const result = await patchFile.execute({
      filepath: 'hello.txt',
      search_string: 'World',
      replace_string: 'Zaraban',
    });
    expect(result.success).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, 'workspace', 'hello.txt'), 'utf-8');
    expect(content).toBe('Hello Zaraban!');
  });

  it('2. search_string not found returns error', async () => {
    const { default: patchFile } = await import('../../core/skills/tools/patch_file.js');
    fs.writeFileSync(path.join(tmpDir, 'workspace', 'hello.txt'), 'Hello World!');
    const result = await patchFile.execute({
      filepath: 'hello.txt',
      search_string: 'NotHere',
      replace_string: 'X',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('3. search_string appearing twice returns ambiguity error', async () => {
    const { default: patchFile } = await import('../../core/skills/tools/patch_file.js');
    fs.writeFileSync(path.join(tmpDir, 'workspace', 'dup.txt'), 'foo bar foo baz');
    const result = await patchFile.execute({
      filepath: 'dup.txt',
      search_string: 'foo',
      replace_string: 'qux',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('ambiguous');
    expect(result.error).toContain('2');
  });

  it('4. path traversal is blocked (boundary check)', async () => {
    const { default: patchFile } = await import('../../core/skills/tools/patch_file.js');
    const result = await patchFile.execute({
      filepath: '../../../etc/passwd',
      search_string: 'root',
      replace_string: 'hacked',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('boundary');
  });

  it('5. symlink pointing outside workspace is blocked', async () => {
    const { default: patchFile } = await import('../../core/skills/tools/patch_file.js');
    const linkPath = path.join(tmpDir, 'workspace', 'evil_link');
    fs.symlinkSync(os.tmpdir(), linkPath);
    const result = await patchFile.execute({
      filepath: 'evil_link/target.txt',
      search_string: 'x',
      replace_string: 'y',
    });
    expect(result.success).toBe(false);
    expect(result.error?.toLowerCase()).toMatch(/symlink|boundary/);
  });

  it('6. file larger than 10MB is blocked', async () => {
    const { default: patchFile } = await import('../../core/skills/tools/patch_file.js');
    const bigPath = path.join(tmpDir, 'workspace', 'big.txt');
    // Create a file that's just over 10MB by writing chunks
    const MB10 = 10 * 1024 * 1024 + 1;
    const buf = Buffer.alloc(MB10, 'x');
    fs.writeFileSync(bigPath, buf);
    const result = await patchFile.execute({
      filepath: 'big.txt',
      search_string: 'x',
      replace_string: 'y',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('limit');
  });

  it('7. empty replace_string deletes the matched block', async () => {
    const { default: patchFile } = await import('../../core/skills/tools/patch_file.js');
    fs.writeFileSync(path.join(tmpDir, 'workspace', 'del.txt'), 'Hello REMOVE_ME World');
    const result = await patchFile.execute({
      filepath: 'del.txt',
      search_string: ' REMOVE_ME',
      replace_string: '',
    });
    expect(result.success).toBe(true);
    const content = fs.readFileSync(path.join(tmpDir, 'workspace', 'del.txt'), 'utf-8');
    expect(content).toBe('Hello World');
  });

  it('8. output message includes character counts', async () => {
    const { default: patchFile } = await import('../../core/skills/tools/patch_file.js');
    fs.writeFileSync(path.join(tmpDir, 'workspace', 'msg.txt'), 'abc 123 def');
    const result = await patchFile.execute({
      filepath: 'msg.txt',
      search_string: '123',
      replace_string: 'XYZ',
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('3 chars');
  });
});
