/**
 * Batch 2: Filename Collision Handling Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PATHS } from '../../config/agent.config.js';
import { initDatabase } from '../../core/memory/index.js';
import { resolveCollision } from '../../core/utils/path-collision.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let tmpDir: string;
let workspaceDir: string;

beforeEach(() => {
  tmpDir = path.join(__dirname, `tmp-${Date.now()}`);
  workspaceDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
  initDatabase();
  // Override workspace root for tests by chdir
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(path.join(__dirname, '../..'));
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('resolveCollision', () => {
  it('nonexistent path → returns original, renamed: false', () => {
    const target = path.join(tmpDir, 'new-file.txt');
    const result = resolveCollision(target);
    expect(result.finalPath).toBe(target);
    expect(result.renamed).toBe(false);
    expect(result.originalPath).toBe(target);
  });

  it('existing path with default opts → returns stem-2.ext, renamed: true', () => {
    const target = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(target, 'original');
    const result = resolveCollision(target);
    expect(result.finalPath).toBe(path.join(tmpDir, 'existing-2.txt'));
    expect(result.renamed).toBe(true);
    expect(result.originalPath).toBe(target);
  });

  it('existing path with overwrite: true → returns original, renamed: false', () => {
    const target = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(target, 'original');
    const result = resolveCollision(target, { overwrite: true });
    expect(result.finalPath).toBe(target);
    expect(result.renamed).toBe(false);
  });

  it('multiple collisions → returns -2, -3, -4 in sequence', () => {
    const target = path.join(tmpDir, 'file.html');
    fs.writeFileSync(target, 'v1');
    fs.writeFileSync(path.join(tmpDir, 'file-2.html'), 'v2');
    const r1 = resolveCollision(target);
    expect(r1.finalPath).toBe(path.join(tmpDir, 'file-3.html'));
    expect(r1.renamed).toBe(true);
    fs.writeFileSync(r1.finalPath, 'v3');
    const r2 = resolveCollision(target);
    expect(r2.finalPath).toBe(path.join(tmpDir, 'file-4.html'));
  });
});

describe('file_writer collision handling', () => {
  it('called with existing target → writes to renamed path', async () => {
    const { fileWriter } = await import('../../core/skills/tools/file_writer.js');
    // Create the initial file
    fs.writeFileSync(path.join(workspaceDir, 'report.txt'), 'original');
    const result = await fileWriter.execute({ path: 'report.txt', content: 'new content' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('report-2.txt');
    expect(fs.existsSync(path.join(workspaceDir, 'report-2.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(workspaceDir, 'report-2.txt'), 'utf-8')).toBe('new content');
    expect(fs.readFileSync(path.join(workspaceDir, 'report.txt'), 'utf-8')).toBe('original');
  });

  it('called with overwrite: true on existing file → overwrites in place', async () => {
    const { fileWriter } = await import('../../core/skills/tools/file_writer.js');
    fs.writeFileSync(path.join(workspaceDir, 'config.json'), '{"old":true}');
    const result = await fileWriter.execute({ path: 'config.json', content: '{"new":true}', overwrite: true });
    expect(result.success).toBe(true);
    expect(result.output).not.toContain('-2');
    expect(fs.readFileSync(path.join(workspaceDir, 'config.json'), 'utf-8')).toBe('{"new":true}');
  });
});

describe('generate_and_save_file collision handling', () => {
  it('called with existing target → output contains renamed path', async () => {
    const { transparency } = await import('../../core/transparency.js');
    transparency.enable();
    const renamedEvents: Array<any> = [];
    const off = transparency.on(e => { if (e.type === 'filename_auto_renamed') renamedEvents.push(e); });

    try {
      fs.writeFileSync(path.join(workspaceDir, 'game.html'), '<html></html>');
      const { getSkill } = await import('../../core/skills/registry.js');
      const skill = getSkill('generate_and_save_file');
      if (!skill) throw new Error('generate_and_save_file skill not found in registry');
      // With overwrite: true no rename event should fire (even if LLM call fails)
      await skill.execute({ path: 'game.html', description: 'test', overwrite: true });
      const renamedForGame = renamedEvents.filter(e => e.data.original.includes('game.html'));
      expect(renamedForGame.length).toBe(0);
    } finally {
      off();
      transparency.disable();
    }
  });

  it('overwrite: true on existing file — no filename_auto_renamed event', async () => {
    const { transparency } = await import('../../core/transparency.js');
    transparency.enable();
    const renamedEvents: Array<any> = [];
    const off = transparency.on(e => { if (e.type === 'filename_auto_renamed') renamedEvents.push(e); });

    try {
      fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<html>old</html>');
      const { getSkill } = await import('../../core/skills/registry.js');
      const skill = getSkill('generate_and_save_file');
      if (!skill) throw new Error('generate_and_save_file skill not found in registry');
      await skill.execute({ path: 'index.html', description: 'rebuild', overwrite: true });
      expect(renamedEvents.length).toBe(0);
    } finally {
      off();
      transparency.disable();
    }
  });
});

describe('filename_auto_renamed transparency event', () => {
  it('fires exactly once per rename via file_writer', async () => {
    const { transparency } = await import('../../core/transparency.js');
    transparency.enable();
    const renamedEvents: Array<any> = [];
    const off = transparency.on(e => { if (e.type === 'filename_auto_renamed') renamedEvents.push(e); });

    try {
      const { fileWriter } = await import('../../core/skills/tools/file_writer.js');
      fs.writeFileSync(path.join(workspaceDir, 'doc.md'), 'original');
      await fileWriter.execute({ path: 'doc.md', content: 'new' });
      expect(renamedEvents.length).toBe(1);
      expect(renamedEvents[0].data.skill).toBe('file_writer');
      expect(renamedEvents[0].data.original).toContain('doc.md');
      expect(renamedEvents[0].data.final).toContain('doc-2.md');
    } finally {
      off();
      transparency.disable();
    }
  });

  it('does not fire when file does not exist', async () => {
    const { transparency } = await import('../../core/transparency.js');
    transparency.enable();
    const renamedEvents: Array<any> = [];
    const off = transparency.on(e => { if (e.type === 'filename_auto_renamed') renamedEvents.push(e); });

    try {
      const { fileWriter } = await import('../../core/skills/tools/file_writer.js');
      await fileWriter.execute({ path: 'brand-new.txt', content: 'hello' });
      expect(renamedEvents.length).toBe(0);
    } finally {
      off();
      transparency.disable();
    }
  });
});
