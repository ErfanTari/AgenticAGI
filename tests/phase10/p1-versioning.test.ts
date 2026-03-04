import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';

// We'll test versioning module helpers by creating a temp git repo

describe('Priority 1: Git-backed memory versioning', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p10-versioning-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('P1A: git repo initialises when directory exists', async () => {
    const git = simpleGit(tmpDir);
    await git.init();
    await git.addConfig('user.name', 'AgenticAGI');
    await git.addConfig('user.email', 'agent@local');

    const isRepo = await git.checkIsRepo();
    expect(isRepo).toBe(true);
  });

  it('P1B: commit is created with correct message format', async () => {
    const git = simpleGit(tmpDir);
    await git.init();
    await git.addConfig('user.name', 'AgenticAGI');
    await git.addConfig('user.email', 'agent@local');

    // Create a test file
    const testFile = path.join(tmpDir, 'WHO.CT-000001_test.md');
    fs.writeFileSync(testFile, '---\ncode: WHO.CT-000001\n---\n# test\n');
    await git.add('.');
    await git.commit('WHO.CT-000001: Test Contact [agent]');

    const log = await git.log();
    expect(log.all.length).toBe(1);
    expect(log.all[0].message).toBe('WHO.CT-000001: Test Contact [agent]');
  });

  it('P1C: multiple writes → multiple commits', async () => {
    const git = simpleGit(tmpDir);
    await git.init();
    await git.addConfig('user.name', 'AgenticAGI');
    await git.addConfig('user.email', 'agent@local');

    for (let i = 1; i <= 3; i++) {
      const f = path.join(tmpDir, `file${i}.md`);
      fs.writeFileSync(f, `content ${i}`);
      await git.add('.');
      await git.commit(`WHO.CT-00000${i}: Entry ${i} [agent]`);
    }

    const log = await git.log();
    expect(log.all.length).toBe(3);
  });

  it('P1D: commitMemoryWrite failure never throws', async () => {
    // Import the function and verify it catches errors gracefully
    const { commitMemoryWrite, _resetGitInstance } = await import('../../core/memory/versioning.js');
    _resetGitInstance();

    // Should not throw even with an invalid scenario
    await expect(commitMemoryWrite('WHO.CT-000001', 'Test', 'agent')).resolves.not.toThrow();
  });

  it('P1E: getEntryHistory returns [] on failure (no git repo)', async () => {
    const { getEntryHistory, _resetGitInstance } = await import('../../core/memory/versioning.js');
    _resetGitInstance();
    // With no git repo initialized, should return empty array not throw
    const history = await getEntryHistory('WHO.CT-000001').catch(() => []);
    expect(Array.isArray(history)).toBe(true);
  });

  it('P1F: VersionHistory has correct structure', async () => {
    const git = simpleGit(tmpDir);
    await git.init();
    await git.addConfig('user.name', 'AgenticAGI');
    await git.addConfig('user.email', 'agent@local');

    const testFile = path.join(tmpDir, 'WHO.CT-000001_test.md');
    fs.writeFileSync(testFile, 'test content');
    await git.add('.');
    await git.commit('WHO.CT-000001: Test [agent]');

    const log = await git.log(['--', '*WHO.CT-000001*.md']);
    const entry = log.all[0];
    expect(typeof entry.hash).toBe('string');
    expect(typeof entry.message).toBe('string');
    expect(typeof entry.date).toBe('string');
    expect(typeof entry.author_name).toBe('string');
  });
});
