import type { SkillResult } from './types.js';
import { getSkill } from './registry.js';
import { enforcePermission, getActivePermissionMode } from '../permission.js';

const SKILL_OUTPUT_LIMITS: Record<string, number> = {
  web_search: 3000,
  web_fetch: 3000,
  url_extract: 3000,
  file_reader: 4000,
  run_bash: 2000,
  grep_workspace: 2000,
  list_dir: 1500,
  glob: 1500,
  memory_read: 2000,
  memory_history: 2000,
};
const DEFAULT_OUTPUT_LIMIT = 2000;

function truncateOutput(output: string, skillName: string): string {
  const limit = SKILL_OUTPUT_LIMITS[skillName] ?? DEFAULT_OUTPUT_LIMIT;
  if (output.length <= limit) return output;
  const head = Math.floor(limit * 0.7);
  const tail = Math.floor(limit * 0.2);
  const elided = output.length - head - tail;
  return output.slice(0, head) + `\n...[${elided} chars elided — use file_reader or skill_schema to fetch if needed]...\n` + output.slice(-tail);
}

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
    const result = await skill.execute(input);
    if (result.success && result.output) {
      return { ...result, output: truncateOutput(result.output, name) };
    }
    return result;
  } catch (e) {
    return { success: false, output: '', error: String(e) };
  }
}
