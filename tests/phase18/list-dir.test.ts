/**
 * Phase 18 — list_dir skill tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';

let tmpDir: string;
let origWorkspace: string;

function setup(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'list-dir-test-'));
  origWorkspace = (PATHS as Record<string, string>).workspace;
  (PATHS as Record<string, string>).workspace = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(tmpDir, 'workspace'), { recursive: true });
}

function teardown(): void {
  (PATHS as Record<string, string>).workspace = origWorkspace;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('list_dir skill', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('1. non-recursive listing returns dirs and files', async () => {
    const { default: listDir } = await import('../../core/skills/tools/list_dir.js');
    fs.writeFileSync(path.join(tmpDir, 'workspace', 'a.txt'), 'a');
    fs.mkdirSync(path.join(tmpDir, 'workspace', 'subdir'));
    const result = await listDir.execute({ path: '.' });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output!);
    expect(parsed.files).toContain('a.txt');
    expect(parsed.dirs).toContain('subdir/');
  });

  it('2. recursive listing returns all files', async () => {
    const { default: listDir } = await import('../../core/skills/tools/list_dir.js');
    fs.mkdirSync(path.join(tmpDir, 'workspace', 'nested', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'workspace', 'nested', 'deep', 'file.ts'), '');
    const result = await listDir.execute({ path: '.', recursive: true });
    expect(result.success).toBe(true);
    expect(result.output).toContain('nested/deep/file.ts');
  });

  it('3. recursive listing skips node_modules', async () => {
    const { default: listDir } = await import('../../core/skills/tools/list_dir.js');
    fs.mkdirSync(path.join(tmpDir, 'workspace', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'workspace', 'node_modules', 'lib.js'), '');
    const result = await listDir.execute({ path: '.', recursive: true });
    expect(result.success).toBe(true);
    expect(result.output).not.toContain('node_modules');
  });

  it('4. path traversal is blocked (boundary check)', async () => {
    const { default: listDir } = await import('../../core/skills/tools/list_dir.js');
    const result = await listDir.execute({ path: '../../../etc' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('boundary');
  });

  it('5. listing a non-existent path returns error', async () => {
    const { default: listDir } = await import('../../core/skills/tools/list_dir.js');
    const result = await listDir.execute({ path: 'does_not_exist' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found|Path not found/);
  });

  it('6. empty workspace root listing shows empty structure', async () => {
    const { default: listDir } = await import('../../core/skills/tools/list_dir.js');
    const result = await listDir.execute({ path: '.' });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output!);
    expect(Array.isArray(parsed.files)).toBe(true);
    expect(Array.isArray(parsed.dirs)).toBe(true);
  });
});
