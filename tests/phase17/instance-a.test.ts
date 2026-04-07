/**
 * Phase 17A — Security & Permission Layer
 * Instance A: Workspace boundary, binary detection, permission enforcement,
 *             config validation, registry freeze
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;
let origCwd: string;

function setupWorkspace(): void {
  origCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p17a-'));
  fs.mkdirSync(path.join(tmpDir, 'workspace'), { recursive: true });
  process.chdir(tmpDir);
}

function teardownWorkspace(): void {
  process.chdir(origCwd);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─── Boundary validation ─────────────────────────────────────────────────────

describe('Task 1 + 2: Workspace boundary validation', () => {
  beforeEach(setupWorkspace);
  afterEach(teardownWorkspace);

  it('test 1: file_reader blocks path traversal to /etc/passwd', async () => {
    const { default: fileReaderSkill } = await import('../../core/skills/tools/file_reader.js');
    const result = await fileReaderSkill.execute({ path: '../../../etc/passwd' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('boundary');
  });

  it('test 2: file_writer blocks symlink pointing outside workspace', async () => {
    const { fileWriter } = await import('../../core/skills/tools/file_writer.js');
    // Create a symlink inside workspace that points to the parent (outside workspace)
    const linkPath = path.join(tmpDir, 'workspace', 'evil_link');
    fs.symlinkSync(os.tmpdir(), linkPath);

    const result = await fileWriter.execute({ path: 'evil_link/secret.txt', content: 'x' });
    expect(result.success).toBe(false);
  });

  it('test 3: file_reader with valid workspace path proceeds to read', async () => {
    const { default: fileReaderSkill } = await import('../../core/skills/tools/file_reader.js');
    fs.writeFileSync(path.join(tmpDir, 'workspace', 'hello.txt'), 'hello world');
    const result = await fileReaderSkill.execute({ path: 'hello.txt' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello world');
  });

  it('test 4: file_writer creating new file in workspace subdir is allowed', async () => {
    const { fileWriter } = await import('../../core/skills/tools/file_writer.js');
    const result = await fileWriter.execute({ path: 'subdir/newfile.txt', content: 'created' });
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'workspace', 'subdir', 'newfile.txt'))).toBe(true);
  });
});

// ─── Binary detection ─────────────────────────────────────────────────────────

describe('Task 2: Binary file detection', () => {
  beforeEach(setupWorkspace);
  afterEach(teardownWorkspace);

  it('test 5: file with NUL bytes is blocked with Binary error', async () => {
    const { default: fileReaderSkill } = await import('../../core/skills/tools/file_reader.js');
    const binPath = path.join(tmpDir, 'workspace', 'binary.txt');
    fs.writeFileSync(binPath, Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x57, 0x6f, 0x72, 0x6c, 0x64]));
    const result = await fileReaderSkill.execute({ path: 'binary.txt' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Binary');
  });

  it('test 6: plain text file is not blocked by binary check', async () => {
    const { default: fileReaderSkill } = await import('../../core/skills/tools/file_reader.js');
    const txtPath = path.join(tmpDir, 'workspace', 'plain.txt');
    fs.writeFileSync(txtPath, 'Hello, this is plain text with no null bytes.');
    const result = await fileReaderSkill.execute({ path: 'plain.txt' });
    expect(result.success).toBe(true);
  });

  it('test 7: empty file is not blocked by binary check', async () => {
    const { default: fileReaderSkill } = await import('../../core/skills/tools/file_reader.js');
    const emptyPath = path.join(tmpDir, 'workspace', 'empty.txt');
    fs.writeFileSync(emptyPath, '');
    const result = await fileReaderSkill.execute({ path: 'empty.txt' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('');
  });
});

// ─── Permission enforcement ───────────────────────────────────────────────────

describe('Task 4: Permission enforcement', () => {
  it('test 8: run_bash denied in read-only mode', async () => {
    const { enforcePermission } = await import('../../core/permission.js');
    const result = enforcePermission('run_bash', 'full-access', 'read-only');
    expect(result.allowed).toBe(false);
    expect(result.error).toContain('Permission denied');
  });

  it('test 9: file_writer denied in read-only mode', async () => {
    const { enforcePermission } = await import('../../core/permission.js');
    const result = enforcePermission('file_writer', 'workspace-write', 'read-only');
    expect(result.allowed).toBe(false);
    expect(result.error).toContain('Permission denied');
  });

  it('test 10: web_search allowed in read-only mode', async () => {
    const { enforcePermission } = await import('../../core/permission.js');
    const result = enforcePermission('web_search', 'read-only', 'read-only');
    expect(result.allowed).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('test 11: run_bash allowed in full-access mode', async () => {
    const { enforcePermission } = await import('../../core/permission.js');
    const result = enforcePermission('run_bash', 'full-access', 'full-access');
    expect(result.allowed).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

// ─── Config validation ────────────────────────────────────────────────────────

describe('Task 6: Config Zod validation', () => {
  it('test 12: missing LLM_ENDPOINT causes process.exit(1)', async () => {
    const { validateConfig, _resetConfig } = await import('../../core/config.js');
    _resetConfig();

    const savedEndpoint = process.env.LLM_ENDPOINT;
    const savedModel = process.env.LLM_MODEL;
    delete process.env.LLM_ENDPOINT;
    delete process.env.LLM_MODEL;

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit(1) called');
    });

    try {
      expect(() => validateConfig()).toThrow('process.exit(1) called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      if (savedEndpoint !== undefined) process.env.LLM_ENDPOINT = savedEndpoint;
      if (savedModel !== undefined) process.env.LLM_MODEL = savedModel;
      _resetConfig();
    }
  });

  it('test 13: valid env returns typed Config object', async () => {
    const { validateConfig, _resetConfig } = await import('../../core/config.js');
    _resetConfig();

    const savedEndpoint = process.env.LLM_ENDPOINT;
    const savedModel = process.env.LLM_MODEL;
    process.env.LLM_ENDPOINT = 'http://localhost:1234';
    process.env.LLM_MODEL = 'test-model';

    try {
      const config = validateConfig();
      expect(config.LLM_ENDPOINT).toBe('http://localhost:1234');
      expect(config.LLM_MODEL).toBe('test-model');
    } finally {
      if (savedEndpoint !== undefined) process.env.LLM_ENDPOINT = savedEndpoint;
      else delete process.env.LLM_ENDPOINT;
      if (savedModel !== undefined) process.env.LLM_MODEL = savedModel;
      else delete process.env.LLM_MODEL;
      _resetConfig();
    }
  });
});

// ─── Registry freeze ──────────────────────────────────────────────────────────

describe('Task 8: Skill registry singleton freeze', () => {
  it('test 14: registering after freeze emits warning and leaves registry unchanged', async () => {
    const { registerSkill, getSkill } = await import('../../core/skills/registry.js');

    // Registry is already frozen at import time — try to register a new skill
    const warnSpy = vi.spyOn(console, 'warn');
    const mockSkill = {
      name: 'test_frozen_skill',
      description: 'should be blocked',
      permissionLevel: 'read-only' as const,
      inputSchema: { type: 'object' as const, properties: {}, required: [] },
      async execute() { return { success: true, output: '' }; },
    };

    registerSkill(mockSkill);
    expect(getSkill('test_frozen_skill')).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('frozen'));
    warnSpy.mockRestore();
  });

  it('test 15: _resetRegistry lifts freeze and allows registration', async () => {
    const { registerSkill, getSkill, _resetRegistry } = await import('../../core/skills/registry.js');

    _resetRegistry();

    const mockSkill = {
      name: 'test_after_reset',
      description: 'should register',
      permissionLevel: 'read-only' as const,
      inputSchema: { type: 'object' as const, properties: {}, required: [] },
      async execute() { return { success: true, output: '' }; },
    };

    registerSkill(mockSkill);
    expect(getSkill('test_after_reset')).toBeDefined();
    expect(getSkill('test_after_reset')?.name).toBe('test_after_reset');

    // Cleanup
    _resetRegistry();
  });
});
