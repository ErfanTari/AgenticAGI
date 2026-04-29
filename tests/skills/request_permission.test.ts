import { describe, it, expect, vi } from 'vitest';
import { requestPermissionSkill } from '../../core/skills/tools/request_permission.js';

vi.mock('../../core/memory/index.js', () => ({ savePendingPermissionRequest: vi.fn() }));
vi.mock('../../core/transparency.js', () => ({
  transparency: { emit: vi.fn(), on: vi.fn(), enable: vi.fn(), disable: vi.fn() },
}));
vi.mock('../../core/permission.js', () => ({ getActivePermissionMode: vi.fn().mockReturnValue('workspace-write') }));

describe('request_permission skill', () => {
  it('has read-only permissionLevel', () => {
    expect(requestPermissionSkill.permissionLevel).toBe('read-only');
  });

  it('standard call with all three fields succeeds', async () => {
    const result = await requestPermissionSkill.execute({
      skill: 'run_bash',
      required_level: 'full-access',
      reason: 'Need to run curl to download PDFs',
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('run_bash');
  });

  it('accepts "tool" as alias for "skill"', async () => {
    const result = await requestPermissionSkill.execute({
      tool: 'run_bash',
      required_level: 'full-access',
      reason: 'Download catalogs',
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('run_bash');
  });

  it('auto-detects required_level from skill name when omitted', async () => {
    const result = await requestPermissionSkill.execute({
      skill: 'run_bash',
      reason: 'Need bash to run npm install',
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('full-access');
  });

  it('auto-detects required_level via tool alias', async () => {
    const result = await requestPermissionSkill.execute({
      tool: 'download_file',
      reason: 'Save catalog PDFs to workspace',
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('workspace-write');
  });

  it('fails with clear error when skill/tool both missing', async () => {
    const result = await requestPermissionSkill.execute({ reason: 'something' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/skill.*tool/i);
  });

  it('fails with clear error when reason missing', async () => {
    const result = await requestPermissionSkill.execute({ skill: 'run_bash', required_level: 'full-access' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/reason/i);
  });

  it('fails with list of known skills when required_level cannot be inferred', async () => {
    const result = await requestPermissionSkill.execute({ skill: 'unknown_skill_xyz', reason: 'something' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/required_level/i);
  });
});
