/**
 * Working Memory Document — Phase 15, Section 2
 *
 * Session-scoped document that gives the agent coherent short-term
 * memory across a task. Created at intake, updated after every step,
 * archived when the task ends.
 *
 * Files live at: workspace/working-memory/wm-[timestamp].md
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LLMHandler, Message } from '../types.js';
import type { TaskMilestone } from '../schemas.js';
import type { IntakeResult } from '../intake.js';
import type Database from 'better-sqlite3';
import { writeReflection } from './episodic.js';
import { transparency } from '../transparency.js';
import { stripThinkingTags } from '../llm.js';

// --- Types ---

export interface StepLogEntry {
  stepId: string;
  skill: string;
  outcome: 'success' | 'failure' | 'skipped';
  summary: string;
  ts: string;
}

export interface WorkingMemory {
  taskId: string;
  filePath: string;
  goal: string;
  projectContext: string;
  constraints: string[];
  milestones: TaskMilestone[];
  stepLog: StepLogEntry[];
  activeContext: Array<{ code: string; summary: string }>;
  status: 'active' | 'archived';
  createdAt: string;
  projectCode: string | null;
}

// --- Path resolution ---

function getWorkingMemoryDir(): string {
  // Resolve relative to project root (two dirs up from core/memory/)
  const moduleDir = new URL(import.meta.url).pathname;
  const projectRoot = path.resolve(path.dirname(moduleDir), '..', '..');
  return path.join(projectRoot, 'workspace', 'working-memory');
}

function buildFilePath(taskId: string): string {
  return path.join(getWorkingMemoryDir(), `${taskId}.md`);
}

// --- Markdown serialization ---

function serializeWorkingMemory(wm: WorkingMemory): string {
  const milestonesText = wm.milestones.length > 0
    ? wm.milestones.map((m, i) => `${i + 1}. [${m.id}] ${m.title} — ${m.completionCriteria}`).join('\n')
    : '(no milestones yet)';

  const stepLogText = wm.stepLog.length > 0
    ? wm.stepLog.map(e =>
        `- [${e.ts}] ${e.outcome.toUpperCase()} ${e.stepId} (${e.skill}): ${e.summary}`
      ).join('\n')
    : '(no steps logged yet)';

  const activeContextText = wm.activeContext.length > 0
    ? wm.activeContext.map(c => `- ${c.code}: ${c.summary}`).join('\n')
    : '(none)';

  const constraintsText = wm.constraints.length > 0
    ? wm.constraints.map(c => `- ${c}`).join('\n')
    : '(none)';

  // Serialize milestones as JSON for reliable round-trip (FIX-C2)
  const milestonesJson = JSON.stringify(wm.milestones);

  return `---
type: working_memory
task_id: ${wm.taskId}
project_code: ${wm.projectCode ?? 'none'}
created: ${wm.createdAt}
status: ${wm.status}
milestones_json: ${JSON.stringify(milestonesJson)}
---

# Working Memory

## Goal
${wm.goal}

## Project Context
${wm.projectContext || '(none)'}

## Constraints
${constraintsText}

## Plan — Current Best Path
${milestonesText}

## Step Log
${stepLogText}

## Active Context
${activeContextText}
`;
}

function parseWorkingMemory(content: string, filePath: string): WorkingMemory | null {
  try {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!fmMatch) return null;

    const fm: Record<string, string> = {};
    for (const line of fmMatch[1].split('\n')) {
      const sep = line.indexOf(':');
      if (sep === -1) continue;
      fm[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
    }

    if (fm.type !== 'working_memory') return null;

    const goalMatch = content.match(/## Goal\n([\s\S]*?)(?=\n## )/);
    const contextMatch = content.match(/## Project Context\n([\s\S]*?)(?=\n## )/);
    const constraintsMatch = content.match(/## Constraints\n([\s\S]*?)(?=\n## )/);
    const stepLogMatch = content.match(/## Step Log\n([\s\S]*?)(?=\n## )/);
    const activeCtxMatch = content.match(/## Active Context\n([\s\S]*)$/);

    const goal = goalMatch?.[1]?.trim() ?? '';
    const projectContext = contextMatch?.[1]?.trim() ?? '';

    // Parse constraints
    const constraintsText = constraintsMatch?.[1]?.trim() ?? '';
    const constraints = constraintsText === '(none)' || !constraintsText
      ? []
      : constraintsText.split('\n').map(l => l.replace(/^- /, '').trim()).filter(Boolean);

    // Parse step log entries
    const stepLogText = stepLogMatch?.[1]?.trim() ?? '';
    const stepLog: StepLogEntry[] = [];
    if (stepLogText && stepLogText !== '(no steps logged yet)') {
      for (const line of stepLogText.split('\n')) {
        const m = line.match(/^- \[(.+?)\] (SUCCESS|FAILURE|SKIPPED) (.+?) \((.+?)\): (.+)$/);
        if (m) {
          stepLog.push({
            ts: m[1],
            outcome: m[2].toLowerCase() as StepLogEntry['outcome'],
            stepId: m[3],
            skill: m[4],
            summary: m[5],
          });
        }
      }
    }

    // Parse active context
    const activeCtxText = activeCtxMatch?.[1]?.trim() ?? '';
    const activeContext: Array<{ code: string; summary: string }> = [];
    if (activeCtxText && activeCtxText !== '(none)') {
      for (const line of activeCtxText.split('\n')) {
        const m = line.match(/^- ([A-Z]+\.[A-Z]+-\d+): (.+)$/);
        if (m) {
          activeContext.push({ code: m[1], summary: m[2] });
        }
      }
    }

    // Parse milestones from milestones_json frontmatter (FIX-C2)
    let milestones: TaskMilestone[] = [];
    if (fm.milestones_json) {
      try {
        // milestones_json is stored as a JSON-encoded string (double-encoded)
        const jsonStr = JSON.parse(fm.milestones_json) as string;
        milestones = JSON.parse(jsonStr) as TaskMilestone[];
      } catch {
        milestones = [];
      }
    }

    return {
      taskId: fm.task_id ?? '',
      filePath,
      goal,
      projectContext,
      constraints,
      milestones,
      stepLog,
      activeContext,
      status: (fm.status as WorkingMemory['status']) ?? 'active',
      createdAt: fm.created ?? new Date().toISOString(),
      projectCode: fm.project_code === 'none' ? null : (fm.project_code ?? null),
    };
  } catch {
    return null;
  }
}

// --- Public API ---

export async function createWorkingMemory(
  goal: string,
  intakeResult: IntakeResult,
  db: Database.Database,
): Promise<WorkingMemory> {
  const timestamp = Date.now();
  const taskId = `wm-${timestamp}`;
  const createdAt = new Date().toISOString();

  // Try to fetch project context from DB
  let projectContext = '';
  if (intakeResult.projectCode) {
    try {
      const row = db.prepare('SELECT summary FROM index_entries WHERE code = ?')
        .get(intakeResult.projectCode) as { summary: string } | undefined;
      if (row?.summary) {
        projectContext = row.summary;
      }
    } catch { /* best-effort */ }
  }

  // Populate active context from resolved entries
  const activeContext: Array<{ code: string; summary: string }> = intakeResult.resolvedContext.map(r => ({
    code: r.code,
    summary: r.summary,
  }));

  const wm: WorkingMemory = {
    taskId,
    filePath: buildFilePath(taskId),
    goal,
    projectContext,
    constraints: [],
    milestones: [],
    stepLog: [],
    activeContext,
    status: 'active',
    createdAt,
    projectCode: intakeResult.projectCode,
  };

  // Write file first (FILE FIRST rule)
  const dir = path.dirname(wm.filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(wm.filePath, serializeWorkingMemory(wm), 'utf-8');

  // FIX-H3: Emit working_memory_created transparency event
  transparency.emit({ type: 'working_memory_created', data: { taskId: wm.taskId, projectCode: wm.projectCode } });

  return wm;
}

export async function appendStepLog(
  wm: WorkingMemory,
  entry: StepLogEntry,
): Promise<void> {
  wm.stepLog.push(entry);
  fs.writeFileSync(wm.filePath, serializeWorkingMemory(wm), 'utf-8');
}

export async function updatePlan(
  wm: WorkingMemory,
  revisedMilestones: TaskMilestone[],
): Promise<void> {
  wm.milestones = revisedMilestones;
  fs.writeFileSync(wm.filePath, serializeWorkingMemory(wm), 'utf-8');
  // FIX-H3: Emit working_memory_updated transparency event
  transparency.emit({ type: 'working_memory_updated', data: { taskId: wm.taskId, event: 'plan_updated' } });
}

export async function addToActiveContext(
  wm: WorkingMemory,
  code: string,
  summary: string,
): Promise<void> {
  // Deduplicate
  if (!wm.activeContext.some(c => c.code === code)) {
    wm.activeContext.push({ code, summary });
    fs.writeFileSync(wm.filePath, serializeWorkingMemory(wm), 'utf-8');
  }
}

/** Returns a human-readable step log string for injection into archive/summary prompts. */
export function getStepSummary(wm: WorkingMemory): string {
  if (wm.stepLog.length === 0) return '(none recorded)';
  return wm.stepLog
    .map(s => `- ${s.skill}: ${s.summary.slice(0, 100)}`)
    .join('\n');
}

export async function archiveWorkingMemory(
  wm: WorkingMemory,
  _db: Database.Database,
  llm: LLMHandler,
): Promise<void> {
  wm.status = 'archived';

  // Ask LLM for an archive summary (best-effort)
  let archiveSummary = `Completed task: ${wm.goal.slice(0, 80)}`;
  try {
    const stepSummaryText = getStepSummary(wm);
    const archiveMessages: Message[] = [
      {
        role: 'system',
        content: 'Summarize what was accomplished in this working memory session in 2-3 sentences. Be factual and brief.',
      },
      {
        role: 'user',
        content: `Goal: ${wm.goal}\n\nCompleted steps (${wm.stepLog.length} total):\n${stepSummaryText}`,
      },
    ];
    archiveSummary = stripThinkingTags((await llm(archiveMessages, { maxTokens: 500 })).trim());
  } catch { /* LLM call is best-effort */ }

  // Write WHEN.RF reflection (FIX 7 requirement)
  writeReflection(wm.taskId, {
    code: wm.taskId,
    trigger: wm.goal,
    task_name: wm.goal.slice(0, 80),
    skill_sequence: [...new Set(wm.stepLog.map(s => s.skill))],
    outcome: wm.stepLog.some(s => s.outcome === 'failure') ? 'partial' : 'success',
    linked_codes: wm.activeContext.map(c => c.code),
    session_id: wm.createdAt,
  }, llm).catch(() => { /* best-effort */ });

  // Write updated file with archive summary, then delete (FILE FIRST rule)
  try {
    const archivedContent = serializeWorkingMemory(wm);
    const withArchive = archivedContent + `\n## Archive Summary\n${archiveSummary}\n`;
    fs.writeFileSync(wm.filePath, withArchive, 'utf-8');
  } catch { /* file write failure is non-fatal */ }

  // Delete the working memory file from disk
  try {
    if (fs.existsSync(wm.filePath)) {
      fs.unlinkSync(wm.filePath);
    }
  } catch { /* best-effort deletion */ }

  // FIX-H3: Emit working_memory_archived transparency event
  transparency.emit({ type: 'working_memory_archived', data: { taskId: wm.taskId } });
}

export async function markMilestoneComplete(
  wm: WorkingMemory,
  milestoneId: string,
): Promise<void> {
  const milestone = wm.milestones.find(m => m.id === milestoneId);
  if (milestone) {
    // Mark the title with ✓ if not already marked
    if (!milestone.title.startsWith('✓ ')) {
      milestone.title = `✓ ${milestone.title}`;
    }
    fs.writeFileSync(wm.filePath, serializeWorkingMemory(wm), 'utf-8');
  }
}

export async function loadWorkingMemory(
  taskIdOrProjectCode: string,
): Promise<WorkingMemory | null> {
  try {
    const dir = getWorkingMemoryDir();
    if (!fs.existsSync(dir)) return null;

    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse(); // newest first

    for (const file of files) {
      const filePath = path.join(dir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const wm = parseWorkingMemory(content, filePath);
      if (!wm) continue;

      // Phase 15 Conflict 2: only return active working memory (not archived)
      if (
        wm.status === 'active' &&
        (
          wm.taskId === taskIdOrProjectCode ||
          wm.projectCode === taskIdOrProjectCode
        )
      ) {
        // FIX-H3: Emit working_memory_loaded transparency event
        transparency.emit({ type: 'working_memory_loaded', data: { taskId: wm.taskId, projectCode: wm.projectCode } });
        return wm;
      }
    }

    return null;
  } catch {
    return null;
  }
}
