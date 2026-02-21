import type { SkillResult } from './types.js';
import { getSkill } from './registry.js';

export async function runSkill(
  name: string,
  input: Record<string, unknown>,
): Promise<SkillResult> {
  const skill = getSkill(name);
  if (!skill) {
    return { success: false, output: '', error: `Skill '${name}' not found` };
  }
  try {
    return await skill.execute(input);
  } catch (e) {
    return { success: false, output: '', error: String(e) };
  }
}
