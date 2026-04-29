import { describe, it, expect } from 'vitest';
import { SUBAGENT_PROFILES } from '../../core/subagents/registry.js';
import { getAllSkills } from '../../core/skills/registry.js';

describe('profile tool restrictions', () => {
  const allSkillNames = new Set(getAllSkills().map(s => s.name));

  it('explore profile only whitelists read-only skills', () => {
    const { toolWhitelist } = SUBAGENT_PROFILES.explore;
    // Every whitelisted skill should exist in the registry
    for (const name of toolWhitelist) {
      expect(allSkillNames.has(name), `${name} not in registry`).toBe(true);
    }
    // No write skills allowed
    const writeSkills = ['file_writer', 'patch_file', 'run_bash', 'memory_write', 'generate_and_save_file'];
    for (const name of writeSkills) {
      expect(toolWhitelist.includes(name), `${name} should NOT be in explore whitelist`).toBe(false);
    }
  });

  it('plan profile only whitelists memory tools', () => {
    const { toolWhitelist } = SUBAGENT_PROFILES.plan;
    for (const name of toolWhitelist) {
      expect(allSkillNames.has(name), `${name} not in registry`).toBe(true);
    }
    // No file I/O or bash
    const forbidden = ['file_reader', 'file_writer', 'run_bash', 'patch_file', 'grep_workspace'];
    for (const name of forbidden) {
      expect(toolWhitelist.includes(name), `${name} should NOT be in plan whitelist`).toBe(false);
    }
  });

  it('task profile includes file/edit/run/verify suite but not screenshot_url', () => {
    const { toolWhitelist } = SUBAGENT_PROFILES.task;
    for (const name of toolWhitelist) {
      expect(allSkillNames.has(name), `${name} not in registry`).toBe(true);
    }
    expect(toolWhitelist.includes('file_reader')).toBe(true);
    expect(toolWhitelist.includes('patch_file')).toBe(true);
    expect(toolWhitelist.includes('run_bash')).toBe(true);
    // screenshot_url not in task scope (requires headless browser, not needed for code tasks)
    expect(toolWhitelist.includes('screenshot_url')).toBe(false);
  });
});
