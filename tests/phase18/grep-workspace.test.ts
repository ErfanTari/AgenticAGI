/**
 * Phase 18 — grep_workspace skill tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';

let tmpDir: string;
let origWorkspace: string;

function setup(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-ws-test-'));
  origWorkspace = (PATHS as Record<string, string>).workspace;
  (PATHS as Record<string, string>).workspace = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(tmpDir, 'workspace'), { recursive: true });
}

function teardown(): void {
  (PATHS as Record<string, string>).workspace = origWorkspace;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('grep_workspace skill', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('1. finds a matching line in a single file', async () => {
    const { default: grepWorkspace } = await import('../../core/skills/tools/grep_workspace.js');
    fs.writeFileSync(path.join(tmpDir, 'workspace', 'a.txt'), 'Hello World\nGoodbye World\n');
    const result = await grepWorkspace.execute({ pattern: 'Hello' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Hello World');
  });

  it('2. returns no matches message when pattern not found', async () => {
    const { default: grepWorkspace } = await import('../../core/skills/tools/grep_workspace.js');
    fs.writeFileSync(path.join(tmpDir, 'workspace', 'b.txt'), 'foo bar baz');
    const result = await grepWorkspace.execute({ pattern: 'nothere' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('No matches');
  });

  it('3. file_glob filter limits search to matching files', async () => {
    const { default: grepWorkspace } = await import('../../core/skills/tools/grep_workspace.js');
    fs.writeFileSync(path.join(tmpDir, 'workspace', 'code.ts'), 'const x = 1;');
    fs.writeFileSync(path.join(tmpDir, 'workspace', 'notes.txt'), 'const y = 2;');
    const result = await grepWorkspace.execute({ pattern: 'const', file_glob: '*.ts' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('code.ts');
    expect(result.output).not.toContain('notes.txt');
  });

  it('4. max_results truncation message appears when exceeded', async () => {
    const { default: grepWorkspace } = await import('../../core/skills/tools/grep_workspace.js');
    // Write a file with many matching lines
    const lines = Array.from({ length: 10 }, (_, i) => `match line ${i}`).join('\n');
    fs.writeFileSync(path.join(tmpDir, 'workspace', 'many.txt'), lines);
    const result = await grepWorkspace.execute({ pattern: 'match', max_results: 3 });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Truncated');
  });

  it('5. skips node_modules directory', async () => {
    const { default: grepWorkspace } = await import('../../core/skills/tools/grep_workspace.js');
    fs.mkdirSync(path.join(tmpDir, 'workspace', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'workspace', 'node_modules', 'hidden.txt'), 'secret pattern');
    const result = await grepWorkspace.execute({ pattern: 'secret pattern' });
    expect(result.success).toBe(true);
    expect(result.output).not.toContain('node_modules');
  });

  it('6. skips binary files (NUL byte in first 8KB)', async () => {
    const { default: grepWorkspace } = await import('../../core/skills/tools/grep_workspace.js');
    const buf = Buffer.concat([Buffer.from('binary'), Buffer.alloc(1, 0), Buffer.from('content')]);
    fs.writeFileSync(path.join(tmpDir, 'workspace', 'bin.bin'), buf);
    const result = await grepWorkspace.execute({ pattern: 'binary' });
    expect(result.success).toBe(true);
    // Should not match binary file
    expect(result.output).not.toContain('bin.bin');
  });

  it('7. case-insensitive match', async () => {
    const { default: grepWorkspace } = await import('../../core/skills/tools/grep_workspace.js');
    fs.writeFileSync(path.join(tmpDir, 'workspace', 'case.txt'), 'HELLO world');
    const result = await grepWorkspace.execute({ pattern: 'hello' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('HELLO world');
  });

  it('8. output includes file path and line number', async () => {
    const { default: grepWorkspace } = await import('../../core/skills/tools/grep_workspace.js');
    fs.writeFileSync(path.join(tmpDir, 'workspace', 'lines.txt'), 'first\nsecond match\nthird');
    const result = await grepWorkspace.execute({ pattern: 'second' });
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/lines\.txt:\d+:/);
  });
});
