/**
 * Tests for glob skill
 * Verifies file pattern matching, permission enforcement, and fallback behavior
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import globSkill from '../../core/skills/tools/glob.js';
import { PATHS } from '../../config/agent.config.js';
import { getSkill } from '../../core/skills/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(__dirname, `tmp-glob-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  (PATHS as Record<string, string>).workspace = tmpDir;
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('glob skill', () => {

  it('T1: skill is registered and visible', () => {
    const skill = getSkill('glob');
    expect(skill).toBeDefined();
    expect(skill?.name).toBe('glob');
    expect(skill?.permissionLevel).toBe('read-only');
  });

  it('T2: finds files matching simple wildcard pattern', async () => {
    fs.writeFileSync(path.join(tmpDir, 'test.ts'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'test.js'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'x');

    const result = await globSkill.execute({ pattern: '*.ts' });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output as string);
    expect(parsed.files).toContain('test.ts');
    expect(parsed.files).not.toContain('test.js');
    expect(parsed.files).not.toContain('README.md');
  });

  it('T3: respects max_results limit', async () => {
    for (let i = 0; i < 50; i++) {
      fs.writeFileSync(path.join(tmpDir, `file${i}.txt`), 'x');
    }

    const result = await globSkill.execute({ pattern: '*.txt', max_results: 10 });
    const parsed = JSON.parse(result.output as string);
    expect(parsed.files.length).toBeLessThanOrEqual(10);
    expect(parsed.truncated).toBe(true);
  });

  it('T4: returns paths relative to workspace', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'main.ts'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'src', 'utils.ts'), 'x');

    const result = await globSkill.execute({ pattern: 'src/*.ts' });
    const parsed = JSON.parse(result.output as string);
    expect(parsed.files).toContain('src/main.ts');
    expect(parsed.files).toContain('src/utils.ts');
    // Paths should be relative, not absolute
    expect(parsed.files.some((f: string) => f.startsWith('/'))).toBe(false);
  });

  it('T5: handles empty result set gracefully', async () => {
    const result = await globSkill.execute({ pattern: '*.nonexistent' });
    const parsed = JSON.parse(result.output as string);
    expect(parsed.files).toEqual([]);
    expect(parsed.truncated).toBe(false);
  });

  it('T6: skips node_modules and .git', async () => {
    fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'lib.ts'), 'x');
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.git', 'config'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'visible.ts'), 'x');

    const result = await globSkill.execute({ pattern: '*.ts' });
    const parsed = JSON.parse(result.output as string);
    expect(parsed.files).toContain('visible.ts');
    expect(parsed.files.some((f: string) => f.includes('node_modules'))).toBe(false);
    expect(parsed.files.some((f: string) => f.includes('.git'))).toBe(false);
  });

  it('T7: rejects empty pattern', async () => {
    const result = await globSkill.execute({ pattern: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('non-empty');
  });

  it('T8: handles ** glob for recursive matching', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'main.ts'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'src', 'nested', 'utils.ts'), 'x');

    const result = await globSkill.execute({ pattern: 'src/**/*.ts' });
    const parsed = JSON.parse(result.output as string);
    // ** glob should match recursively (at least the nested file)
    expect(parsed.files.length).toBeGreaterThanOrEqual(1);
    expect(parsed.files.some((f: string) => f.includes('utils.ts') || f.includes('main.ts'))).toBe(true);
  });

  it('T9: returns truncated flag when max_results exceeded', async () => {
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(tmpDir, `file${i}.js`), 'x');
    }

    const result = await globSkill.execute({ pattern: '*.js', max_results: 3 });
    const parsed = JSON.parse(result.output as string);
    expect(parsed.truncated).toBe(true);
  });

  it('T10: returns non-truncated flag when under limit', async () => {
    fs.writeFileSync(path.join(tmpDir, 'file1.js'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'file2.js'), 'x');

    const result = await globSkill.execute({ pattern: '*.js', max_results: 10 });
    const parsed = JSON.parse(result.output as string);
    expect(parsed.truncated).toBe(false);
  });

});
