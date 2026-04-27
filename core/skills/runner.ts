import { randomUUID } from 'node:crypto';
import type { SkillResult } from './types.js';
import { getSkill } from './registry.js';
import { enforcePermission, getActivePermissionMode } from '../permission.js';
import { transparency, type SpanContext } from '../transparency.js';

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

export function labelForSkill(skillName: string, input: Record<string, unknown>): string {
  if (input.path && typeof input.path === 'string') {
    return `Skill: ${skillName} (path=${input.path})`;
  }
  if (input.command && typeof input.command === 'string') {
    const cmd = String(input.command).slice(0, 40);
    return `Skill: ${skillName} (cmd=${cmd})`;
  }
  if (input.query && typeof input.query === 'string') {
    const q = String(input.query).slice(0, 40);
    return `Skill: ${skillName} (query=${q})`;
  }
  return `Skill: ${skillName}`;
}

export async function runSkill(
  name: string,
  input: Record<string, unknown>,
  parentCtx?: SpanContext,
  signal?: AbortSignal,
): Promise<SkillResult> {
  if (signal?.aborted) {
    return { success: false, output: '', error: 'aborted' };
  }
  const skill = getSkill(name);
  if (!skill) {
    return { success: false, output: '', error: `Skill '${name}' not found` };
  }
  const check = enforcePermission(name, skill.permissionLevel, getActivePermissionMode());
  if (!check.allowed) {
    return { success: false, output: '', error: check.error };
  }
  const spanId = randomUUID();
  const spanStart = Date.now();
  const label = labelForSkill(name, input);
  transparency.emit({
    type: 'span_start',
    data: { spanId, parentSpanId: parentCtx?.spanId, label, ts: spanStart },
  });
  // Inject signal into input so skills that support it (run_bash, web_fetch, web_search) can abort
  const effectiveInput = signal ? { ...input, __signal: signal } : input;
  try {
    const result = await skill.execute(effectiveInput);
    const outcome: SkillResult = result.success && result.output
      ? { ...result, output: truncateOutput(result.output, name) }
      : result;
    transparency.emit({
      type: 'span_end',
      data: { spanId, durationMs: Date.now() - spanStart, status: outcome.success ? 'ok' : 'error' },
    });
    return outcome;
  } catch (e) {
    transparency.emit({
      type: 'span_end',
      data: { spanId, durationMs: Date.now() - spanStart, status: 'error' },
    });
    return { success: false, output: '', error: String(e) };
  }
}
