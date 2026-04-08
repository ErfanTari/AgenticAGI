/**
 * Tests for grep_workspace ripgrep integration
 * Verifies ripgrep subprocess, JSON parsing, and JS fallback behavior
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import grepWorkspaceSkill from '../../core/skills/tools/grep_workspace.js';
import { PATHS } from '../../config/agent.config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(__dirname, `tmp-grep-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  (PATHS as Record<string, string>).workspace = tmpDir;
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('grep_workspace with ripgrep', () => {

  it('T1: finds matches in simple text file (JS fallback)', async () => {
    // Create a test file
    const testFile = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(testFile, 'Hello World\nFoo Bar\nHello Again\n');

    const result = await grepWorkspaceSkill.execute({ pattern: 'hello' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('test.txt');
    expect(result.output).toContain('Hello World');
    expect(result.output).toContain('Hello Again');
  });

  it('T2: respects max_results limit', async () => {
    const testFile = path.join(tmpDir, 'many.txt');
    const lines = Array.from({ length: 100 }, (_, i) => `match ${i}`).join('\n');
    fs.writeFileSync(testFile, lines);

    const result = await grepWorkspaceSkill.execute({ pattern: 'match', max_results: 5 });
    expect(result.success).toBe(true);
    const matchLines = result.output.split('\n').filter(l => l.includes('many.txt'));
    expect(matchLines.length).toBeLessThanOrEqual(5);
  });

  it('T3: applies file_glob filter', async () => {
    fs.writeFileSync(path.join(tmpDir, 'include.ts'), 'function foo() {}');
    fs.writeFileSync(path.join(tmpDir, 'exclude.js'), 'function foo() {}');

    const result = await grepWorkspaceSkill.execute({ pattern: 'function', file_glob: '*.ts' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('include.ts');
    expect(result.output).not.toContain('exclude.js');
  });

  it('T4: handles binary files gracefully', async () => {
    const binFile = path.join(tmpDir, 'binary.bin');
    const buf = Buffer.alloc(100);
    buf[50] = 0x00; // Insert null byte
    fs.writeFileSync(binFile, buf);
    fs.writeFileSync(path.join(tmpDir, 'text.txt'), 'match here');

    const result = await grepWorkspaceSkill.execute({ pattern: 'match' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('text.txt');
  });

  it('T5: returns no matches when nothing found', async () => {
    fs.writeFileSync(path.join(tmpDir, 'empty.txt'), 'foo bar baz');

    const result = await grepWorkspaceSkill.execute({ pattern: 'notfound' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('No matches found.');
  });

  it('T6: case-insensitive search', async () => {
    fs.writeFileSync(path.join(tmpDir, 'case.txt'), 'Hello\nHELLO\nhello\nHeLLo');

    const result = await grepWorkspaceSkill.execute({ pattern: 'hello' });
    expect(result.success).toBe(true);
    const count = (result.output.match(/case.txt/g) || []).length;
    expect(count).toBe(4);
  });

  it('T7: rejects empty pattern', async () => {
    const result = await grepWorkspaceSkill.execute({ pattern: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('non-empty');
  });

  it('T8: handles regex patterns with fallback', async () => {
    fs.writeFileSync(path.join(tmpDir, 'regex.txt'), 'abc123\nxyz789\nabc999');

    // Valid regex pattern
    const result = await grepWorkspaceSkill.execute({ pattern: 'abc\\d+' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('regex.txt');
  });

  it('T9: skips node_modules and .git directories', async () => {
    fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'test.txt'), 'match');
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.git', 'config'), 'match');
    fs.writeFileSync(path.join(tmpDir, 'visible.txt'), 'match');

    const result = await grepWorkspaceSkill.execute({ pattern: 'match' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('visible.txt');
    expect(result.output).not.toContain('node_modules');
    expect(result.output).not.toContain('.git');
  });

  it('T10: returns success when workspace missing', async () => {
    (PATHS as Record<string, string>).workspace = '/nonexistent/path';

    const result = await grepWorkspaceSkill.execute({ pattern: 'test' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('does not exist');
  });

});
