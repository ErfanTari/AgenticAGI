import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionCache } from '../../core/memory/session-cache.js';
import { runSkill } from '../../core/skills/runner.js';
import { getActivePermissionMode } from '../../core/permission.js';

let tmpDir: string;
let origCwd: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-test-'));
  fs.mkdirSync(path.join(tmpDir, 'workspace'), { recursive: true });
  origCwd = process.cwd();
  process.chdir(tmpDir);
  sessionCache.clearSkillHistory();
  // Use full-access permission mode so permission check passes
  process.env.PERMISSION_MODE = 'full-access';
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  sessionCache.clearSkillHistory();
  delete process.env.PERMISSION_MODE;
});

function writeWorkspaceFile(rel: string, content: string) {
  const full = path.join(tmpDir, 'workspace', rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

describe('read-before-edit gate', () => {
  it('patch_file without prior read is rejected', async () => {
    writeWorkspaceFile('target.ts', 'const x = 1;');
    const result = await runSkill('patch_file', {
      filepath: 'target.ts',
      edits: '```ts target.ts\n<<<<<<< SEARCH\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> REPLACE\n```',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/file_reader|read-before-edit/i);
  });

  it('patch_file after file_reader is allowed', async () => {
    writeWorkspaceFile('target.ts', 'const x = 1;\n');
    sessionCache.recordSkillCall('file_reader', { path: 'target.ts' });
    const result = await runSkill('patch_file', {
      filepath: 'target.ts',
      edits: '```ts target.ts\n<<<<<<< SEARCH\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> REPLACE\n```',
    });
    // Gate passes; patch may succeed or fail on content, but not on gate
    expect(result.error ?? '').not.toMatch(/read-before-edit/i);
  });

  it('patch_file after grep_workspace is allowed', async () => {
    writeWorkspaceFile('target.ts', 'const x = 1;\n');
    sessionCache.recordSkillCall('grep_workspace', { path: 'target.ts' });
    const result = await runSkill('patch_file', {
      filepath: 'target.ts',
      edits: '```ts target.ts\n<<<<<<< SEARCH\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> REPLACE\n```',
    });
    expect(result.error ?? '').not.toMatch(/read-before-edit/i);
  });

  it('file_writer overwrite without read is rejected', async () => {
    writeWorkspaceFile('existing.ts', 'original content');
    const result = await runSkill('file_writer', {
      path: 'existing.ts',
      content: 'new content',
      overwrite: true,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/file_reader|read-before-edit/i);
  });

  it('file_writer creating a new file is allowed without prior read', async () => {
    const result = await runSkill('file_writer', {
      path: 'brand-new.ts',
      content: 'hello',
    });
    // Gate should pass for new files (no overwrite flag, file doesn't exist)
    // Result depends on file_writer implementation, but gate should not block
    expect(result.error ?? '').not.toMatch(/read-before-edit/i);
  });
});
