import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { SkillResult } from './types.js';
import { getSkill } from './registry.js';
import { enforcePermission, getActivePermissionMode } from '../permission.js';
import { transparency, type SpanContext } from '../transparency.js';
import { savePendingPermissionRequest } from '../memory/index.js';
import { sessionCache } from '../memory/session-cache.js';

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

// ── Read-before-edit gate ────────────────────────────────────────────────────

const READ_BEFORE_EDIT_TURNS = 50; // last N recorded calls to check
const EDIT_SKILLS = new Set(['patch_file', 'file_writer']);
const READ_SKILLS = ['file_reader', 'grep_workspace'];

function preCallGate(skillName: string, input: Record<string, unknown>): SkillResult | null {
  if (!EDIT_SKILLS.has(skillName)) return null;

  const targetPath = String(input.filepath ?? input.filePath ?? input.path ?? '');
  if (!targetPath) return null;

  // file_writer is only gated when overwriting an existing file
  if (skillName === 'file_writer') {
    const overwrite = input.overwrite === true;
    const append = input.append === true;
    if (!overwrite && !append) {
      // Creating a new file — check existence
      const wsPath = targetPath.startsWith('workspace/')
        ? targetPath
        : `workspace/${targetPath.replace(/^\.\//, '')}`;
      const absPath = `${process.cwd()}/${wsPath}`;
      if (!existsSync(absPath)) return null; // new file, no gate
    }
  }

  const recent = sessionCache.getRecentSkillResults(READ_SKILLS, READ_BEFORE_EDIT_TURNS);
  const hasRead = recent.some(r => {
    const p = String(r.args.filepath ?? r.args.filePath ?? r.args.path ?? '');
    return p === targetPath ||
      p.endsWith('/' + targetPath) ||
      targetPath.endsWith('/' + p);
  });

  if (!hasRead) {
    return {
      success: false,
      output: '',
      error: `read-before-edit: you must call file_reader on '${targetPath}' before editing. The current file contents are required for the SEARCH block to match. Call: {"action":"file_reader","input":{"path":"${targetPath}"}}`,
    };
  }
  return null;
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
    // Only auto-trigger escalation UI when the skill has a valid permission level.
    // Skills with undefined/invalid permissionLevel (e.g. test-registered mocks) just
    // get a plain denial — no DB write or escalation event.
    const validLevels = ['read-only', 'workspace-write', 'full-access'];
    if (skill.permissionLevel && validLevels.includes(skill.permissionLevel)) {
      const reason = typeof input.description === 'string' && input.description
        ? input.description
        : `The agent needs to run '${name}' to continue the task`;
      const savedGoal = typeof input.__goal === 'string' ? input.__goal : undefined;
      savePendingPermissionRequest(name, skill.permissionLevel, reason, savedGoal);
      transparency.emit({ type: 'permission_escalation_requested', data: { skill: name, required: skill.permissionLevel, reason } });
      return {
        success: false,
        output: '',
        error: `Permission required: '${name}' needs '${skill.permissionLevel}'. A permission request has been sent to the UI — please approve or deny to continue.`,
      };
    }
    return { success: false, output: '', error: check.error };
  }

  // Read-before-edit gate (patch_file and overwriting file_writer require a prior read)
  const gateRejection = preCallGate(name, input);
  if (gateRejection) return gateRejection;

  const spanId = randomUUID();
  const spanStart = Date.now();
  const label = labelForSkill(name, input);
  transparency.emit({
    type: 'span_start',
    data: { spanId, parentSpanId: parentCtx?.spanId, label, ts: spanStart },
  });
  // Inject signal into input so skills that support it (run_bash, web_fetch, web_search) can abort
  // Remove internal __goal field (used only for permission request context, not for skill execution)
  const { __goal, ...cleanInput } = input;
  const effectiveInput = signal ? { ...cleanInput, __signal: signal } : cleanInput;
  try {
    const result = await skill.execute(effectiveInput);
    const outcome: SkillResult = result.success && result.output
      ? { ...result, output: truncateOutput(result.output, name) }
      : result;
    transparency.emit({
      type: 'span_end',
      data: { spanId, durationMs: Date.now() - spanStart, status: outcome.success ? 'ok' : 'error' },
    });
    // Record successful read calls for the read-before-edit gate
    if (outcome.success && (name === 'file_reader' || name === 'grep_workspace')) {
      sessionCache.recordSkillCall(name, cleanInput);
    }
    return outcome;
  } catch (e) {
    transparency.emit({
      type: 'span_end',
      data: { spanId, durationMs: Date.now() - spanStart, status: 'error' },
    });
    return { success: false, output: '', error: String(e) };
  }
}
