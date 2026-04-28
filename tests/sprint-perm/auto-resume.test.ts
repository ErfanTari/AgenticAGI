import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  savePendingPermissionRequest,
  loadPendingPermissionRequest,
  clearPendingPermissionRequest,
  initDatabase,
  closeDatabase,
} from '../../core/memory/index.js';
import { PATHS } from '../../config/agent.config.js';

describe('Permission Escalation Auto-Resume', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join('/tmp', 'perm-resume-'));
    (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
    (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
    initDatabase();
  });

  afterEach(() => {
    closeDatabase();
    (PATHS as Record<string, string>).db = path.join(tmpDir, '..', 'test.sqlite');
    (PATHS as Record<string, string>).memory = path.join(tmpDir, '..', 'memory');
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  it('saves and loads goal with permission request', () => {
    savePendingPermissionRequest('run_bash', 'full-access', 'Create folder structure', 'research porcelain manufacturers');

    const loaded = loadPendingPermissionRequest();
    expect(loaded).not.toBeNull();
    expect(loaded?.skill).toBe('run_bash');
    expect(loaded?.required).toBe('full-access');
    expect(loaded?.reason).toBe('Create folder structure');
    expect(loaded?.goal).toBe('research porcelain manufacturers');
  });

  it('handles missing goal gracefully (backward compat)', () => {
    // Old requests without goal should still load
    savePendingPermissionRequest('run_bash', 'full-access', 'Some reason');

    const loaded = loadPendingPermissionRequest();
    expect(loaded?.skill).toBe('run_bash');
    expect(loaded?.goal).toBeUndefined();
  });

  it('clears permission request and goal', () => {
    savePendingPermissionRequest('run_bash', 'full-access', 'Reason', 'my goal');

    let loaded = loadPendingPermissionRequest();
    expect(loaded).not.toBeNull();

    clearPendingPermissionRequest();

    loaded = loadPendingPermissionRequest();
    expect(loaded).toBeNull();
  });

  it('overwrites previous permission request', () => {
    savePendingPermissionRequest('run_bash', 'full-access', 'Reason 1', 'goal 1');
    savePendingPermissionRequest('web_fetch', 'read-only', 'Reason 2', 'goal 2');

    const loaded = loadPendingPermissionRequest();
    // Singleton table — last one wins
    expect(loaded?.skill).toBe('web_fetch');
    expect(loaded?.goal).toBe('goal 2');
  });
});
