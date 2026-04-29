import { describe, it, expect } from 'vitest';
import { getAllSkills } from '../../core/skills/registry.js';

describe('Sprint B skill registration', () => {
  it('all four new skills registered in correct permission tiers', () => {
    const skills = getAllSkills();
    const byName = Object.fromEntries(skills.map(s => [s.name, s]));

    expect(byName['fetch_url_clean']).toBeDefined();
    expect(byName['fetch_url_clean'].permissionLevel).toBe('read-only');

    expect(byName['view_image']).toBeDefined();
    expect(byName['view_image'].permissionLevel).toBe('read-only');

    expect(byName['download_file']).toBeDefined();
    expect(byName['download_file'].permissionLevel).toBe('workspace-write');

    expect(byName['screenshot_url']).toBeDefined();
    expect(byName['screenshot_url'].permissionLevel).toBe('workspace-write');
  });

  it('total skill count includes all Sprint B skills (27+)', () => {
    const skills = getAllSkills();
    expect(skills.length).toBeGreaterThanOrEqual(27);
  });
});
