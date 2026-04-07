import type { SkillResult } from './types.js';
import { getSkill } from './registry.js';
import { enforcePermission, getActivePermissionMode } from '../permission.js';

export async function runSkill(
  name: string,
  input: Record<string, unknown>,
): Promise<SkillResult> {
  const skill = getSkill(name);
  if (!skill) {
    return { success: false, output: '', error: `Skill '${name}' not found` };
  }
  const check = enforcePermission(name, skill.permissionLevel, getActivePermissionMode());
  if (!check.allowed) {
    return { success: false, output: '', error: check.error };
  }
  try {
    return await skill.execute(input);
  } catch (e) {
    return { success: false, output: '', error: String(e) };
  }
}
