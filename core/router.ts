import fs from 'node:fs';
import path from 'node:path';
import { buildContext } from './context.js';
import { executePlan, runPostFlightSynthesis, buildUserReport } from './executor.js';
import { transparency, withSpan, getCurrentRequestId } from './transparency.js';
import { localDateString } from './utils/date.js';
import type { WorkingMemory } from './memory/working-memory.js';
import { stripThinkingTags } from './llm.js';
import { decomposeTask } from './planner.js';
import { fetchByCode, hybridSearch, queryEntries, updateEntry, upsertEntry } from './memory/mod.js';
import { writeReflection } from './memory/episodic.js';
import { addRelationship, getRelationshipsFrom } from './memory/relationships.js';
import { getSkillCompactDescriptions, getSkillsByPermission, getAllSkills } from './skills/registry.js';
import { getActivePermissionMode } from './permission.js';
import { isMemoryDisabled } from './memory-flag.js';
import { runSkill } from './skills/runner.js';
import { memoryAgent } from './memory/memory-agent.js';
import { type ArtifactContext, runQueryLoop } from './query-loop.js';
import { PATHS } from '../config/agent.config.js';
import { runWithRetry } from './react.js';
import { resolveTemplates } from './planner.js';

// Fix 3/5: Module-level session artifact cache — persists across turns in the same session
let _lastSessionArtifact: ArtifactContext | undefined = undefined;
/** Exported for testing only */
export function _resetSessionArtifact(): void { _lastSessionArtifact = undefined; }

/**
 * Build a concise manifest of files in the workspace directory.
 * Format: "workspace/file.html (3min ago)\nworkspace/file2.js (5min ago)"
 * Depth-limited to direct children + one level of subdirectory — skips node_modules.
 */
export function buildWorkspaceManifest(): string {
  const workspaceDir = PATHS.workspace;
  if (!fs.existsSync(workspaceDir)) return '';
  try {
    const now = Date.now();
    const lines: string[] = [];

    function scanDir(dir: string, prefix: string, depth: number): void {
      if (depth > 1) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        const relPath = `workspace/${prefix}${entry.name}`;
        if (entry.isDirectory()) {
          scanDir(fullPath, `${prefix}${entry.name}/`, depth + 1);
        } else {
          try {
            const stat = fs.statSync(fullPath);
            const ageMs = now - stat.mtimeMs;
            const ageMin = Math.round(ageMs / 60000);
            const ageStr = ageMin < 60
              ? `${ageMin}min ago`
              : `${Math.round(ageMin / 60)}h ago`;
            lines.push(`${relPath} (${ageStr})`);
          } catch { /* skip inaccessible */ }
        }
      }
    }

    scanDir(workspaceDir, '', 0);
    // Sort by most recently modified first (age string parse is cheap enough)
    lines.sort((a, b) => {
      const getMin = (s: string) => {
        const m = s.match(/\((\d+)(min|h) ago\)/);
        if (!m) return 9999;
        return parseInt(m[1]) * (m[2] === 'h' ? 60 : 1);
      };
      return getMin(a) - getMin(b);
    });
    return lines.slice(0, 30).join('\n'); // cap at 30 entries to stay token-efficient
  } catch {
    return '';
  }
}
import type {
  DecomposedUnit,
  LLMHandler,
  Message,
  ResolvedMemory,
  RouteKind,
  UnitMemoryResult,
} from './types.js';
import type { ExecutionResult } from './executor.js';
import type { TaskGoal, TaskPlan, VerificationResult } from './schemas.js';

// ─── Factual Assertion Patterns (FIX D) ─────────────────────────────────────

const PROJECT_START_PATTERNS = [
  /\b(?:started|created|launched|began)\s+(?:a\s+)?(?:new\s+)?project(?:\s+today)?\s+(?:called\s+)?([A-Z][A-Za-z0-9_-]*(?:\s+[A-Z][A-Za-z0-9_-]*)*)(?=[.,]|$)/i,
  /\bnew project called\s+([A-Z][A-Za-z0-9_-]*(?:\s+[A-Z][A-Za-z0-9_-]*)*)(?=[.,]|$)/i,
];

const PERSON_ROLE_PATTERN = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+is\s+the\s+([a-z][a-z\s-]+?)(?=(?:\s+and\s+[A-Z][a-z])|(?:\s+on\s+(?:it|[A-Z]))|(?:\s+for\s+(?:it|[A-Z]))|[.,]|$)/g;
const PERSON_PROJECT_PATTERNS = [
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:works|worked)\s+(?:on|for)\s+(?:the\s+)?([A-Z][A-Za-z0-9_-]*(?:\s+[A-Z][A-Za-z0-9_-]*)*|it)(?=[.,]|$)/g,
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:reviews?|reviewed|manages?|managed|leads?)\s+(?:the\s+)?([A-Z][A-Za-z0-9_-]*(?:\s+[A-Z][A-Za-z0-9_-]*)*|it)(?=[.,]|$)/g,
] as const;
const DEADLINE_PATTERN = /\b(.+?)\s+(?:is\s+)?due\s+(?:on\s+)?([A-Za-z]+\s+\d{1,2}(?:,\s*\d{4})?|\d{4}-\d{2}-\d{2})\b/i;
type ProjectLink = { code: string; name: string };

function normalizeLabel(value: string): string {
  return value.trim().replace(/\s+/g, ' ').replace(/[.,]+$/, '');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectProjectStart(text: string): string | null {
  for (const pattern of PROJECT_START_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) return normalizeLabel(match[1]);
  }
  return null;
}

function parseDueDate(raw: string): string | undefined {
  const cleaned = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;

  const inferredYear = new Date().getFullYear();
  const candidate = cleaned.match(/\d{4}/) ? cleaned : `${cleaned}, ${inferredYear}`;
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) return undefined;
  // FIX-M2: Apply local timezone offset to avoid UTC drift
  const offset = parsed.getTimezoneOffset();
  const local = new Date(parsed.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 10);
}

function inferRelationLabel(fromNb: string, toNb: string, toType: string, context: string): string {
  // Person → Project
  if (fromNb === 'WHO' && (toNb === 'WHAT' || toNb === 'PLAN')) {
    if (/lead|leading|head|owns|created|started/i.test(context)) return 'owns';
    if (/review|reviewing|audit/i.test(context)) return 'reviewed';
    if (/design|designer/i.test(context)) return 'designs';
    return 'works_on'; // default for person→project
  }
  // Person → Organization
  if (fromNb === 'WHO' && toType === 'ORG') return 'works_for';
  // Project → Project
  if (fromNb === 'WHAT' && toNb === 'WHAT') return 'depends_on';
  return 'refers';
}

function maybeAddRelationship(fromCode: string, toCode: string, note: string): void {
  // Use inferRelationLabel for person→project relationships
  const relation = inferRelationLabel('WHO', 'WHAT', 'PJ', note);
  const existing = getRelationshipsFrom(fromCode, relation);
  if (existing.some(rel => rel.to_code === toCode)) {
    // Also check works_for for backward compat
    const existingWorksFor = getRelationshipsFrom(fromCode, 'works_for');
    if (existingWorksFor.some(rel => rel.to_code === toCode)) return;
  }
  addRelationship({
    from_code: fromCode,
    relation,
    to_code: toCode,
    note,
  });
}

function persistFactualAssertions(unitTexts: string[]): void {
  if (isMemoryDisabled()) return;
  Promise.resolve().then(() => {
    let currentProject: ProjectLink | null = null;

    for (const text of unitTexts) {
      try {
        const projectName = detectProjectStart(text);
        if (projectName) {
          const project = upsertEntry({
            nb: 'WHAT',
            type: 'PJ',
            name: projectName,
            status: 'active',
            summary: `Project: ${projectName}`,
            body: `## Description\n${projectName} project.\n\n## Initial Request\n${text}\n\n## Tasks\n_No tasks recorded yet_\n\n## Status\nactive`,
          });
          currentProject = { code: project.code, name: projectName };
        }

        for (const match of text.matchAll(PERSON_ROLE_PATTERN)) {
          const personName = normalizeLabel(match[1]);
          const role = normalizeLabel(match[2]);
          const person = upsertEntry({
            nb: 'WHO',
            type: 'CT',
            name: personName,
            status: 'active',
            summary: `${personName} is the ${role}`,
            body: text,
          });

          const explicitProject = text.match(new RegExp(`${escapeRegex(personName)}\\s+is\\s+the\\s+${escapeRegex(role)}\\s+(?:on|for)\\s+(?:the\\s+)?([A-Z][A-Za-z0-9_-]*(?:\\s+[A-Z][A-Za-z0-9_-]*)*)`, 'i'));
          const relatedProjectName: string | undefined = explicitProject?.[1]
            ? normalizeLabel(explicitProject[1])
            : currentProject?.name;
          if (!relatedProjectName) continue;

          const project: ProjectLink = currentProject?.name === relatedProjectName
            ? currentProject
            : (() => {
                const created = upsertEntry({
                  nb: 'WHAT',
                  type: 'PJ',
                  name: relatedProjectName,
                  status: 'active',
                  summary: `Project: ${relatedProjectName}`,
                  body: text,
                });
                return { code: created.code, name: relatedProjectName };
              })();

          currentProject = project;
          maybeAddRelationship(person.code, project.code, role);
        }

        for (const pattern of PERSON_PROJECT_PATTERNS) {
          for (const match of text.matchAll(pattern)) {
            const personName = normalizeLabel(match[1]);
            const projectName: string | undefined = match[2].toLowerCase() === 'it'
              ? currentProject?.name
              : normalizeLabel(match[2]);
            if (!projectName) continue;

            const person = upsertEntry({
              nb: 'WHO',
              type: 'CT',
              name: personName,
              status: 'active',
              summary: `${personName} works on ${projectName}`,
              body: text,
            });
            const project: ProjectLink = currentProject?.name === projectName
              ? currentProject
              : (() => {
                  const created = upsertEntry({
                    nb: 'WHAT',
                    type: 'PJ',
                    name: projectName,
                    status: 'active',
                    summary: `Project: ${projectName}`,
                    body: text,
                  });
                  return { code: created.code, name: projectName };
                })();
            currentProject = project;
            maybeAddRelationship(person.code, project.code, 'works on project');
          }
        }

        const deadline = text.match(DEADLINE_PATTERN);
        if (deadline?.[1] && deadline[2]) {
          const subject = normalizeLabel(deadline[1]);
          const dueDate = parseDueDate(deadline[2]);
          upsertEntry({
            nb: 'WHEN',
            type: 'DL',
            name: `${subject} deadline`,
            status: 'active',
            summary: `Due ${normalizeLabel(deadline[2])}`,
            body: text,
            due_date: dueDate,
          });
        }
      } catch {
        // best-effort persistence
      }
    }
  }).catch(() => {});
}

const GREETING_ONLY = /^\s*(hi|hello|hey|good\s+(morning|afternoon|evening)|howdy|greetings)\s*[!.?]*\s*$/i;

interface ReplyPart {
  order: number;
  route: RouteKind;
  reply: string;
}

export interface RouteExecutionResult {
  reply: string;
  parts: ReplyPart[];
  primaryRoute: RouteKind;
  resolved: ResolvedMemory | null;
  plan?: TaskPlan;
  execution?: ExecutionResult;
  verification?: VerificationResult;
}

type ConversationalRouteResult = { parts: ReplyPart[]; resolved: ResolvedMemory | null };
type QueryRouteResult = { parts: ReplyPart[]; resolved: ResolvedMemory | null };
type AgenticRouteResult = { parts: ReplyPart[]; plan: TaskPlan; execution?: ExecutionResult; verification?: VerificationResult };

function hasResolvedPayload(
  task: ConversationalRouteResult | QueryRouteResult | AgenticRouteResult | null,
): task is ConversationalRouteResult | QueryRouteResult {
  return task !== null && 'resolved' in task;
}

function hasPlanPayload(
  task: ConversationalRouteResult | QueryRouteResult | AgenticRouteResult | null,
): task is AgenticRouteResult {
  return task !== null && 'plan' in task;
}

function aggregateResolved(results: UnitMemoryResult[]): ResolvedMemory | null {
  const entries = results.flatMap(result => result.entries);
  if (entries.length === 0) return null;

  const uniqueEntries = entries.filter((entry, index, all) =>
    all.findIndex(candidate => candidate.code === entry.code) === index,
  );
  const contents = results.flatMap(result => result.contents);
  return {
    step: 0,
    entries: uniqueEntries,
    contents,
    relationships: [],
  };
}

function buildGoals(units: DecomposedUnit[]): TaskGoal[] {
  return units.map((unit, index) => ({
    id: `goal_${index + 1}`,
    sourceUnitIds: [unit.id],
    description: unit.content,
  }));
}

function buildDecompositionSummary(units: DecomposedUnit[]): string {
  return units.map(unit => `- ${unit.id} [${unit.route}] ${unit.content}`).join('\n');
}

function buildMemoryContext(units: DecomposedUnit[], results: UnitMemoryResult[]): string {
  return units.map(unit => {
    const result = results.find(candidate => candidate.unitId === unit.id);
    if (!result) return `## ${unit.id}\nNo memory context.`;
    if (result.entries.length === 0) {
      return `## ${unit.id}\nStrategy: ${result.strategy}\nConfidence: ${result.confidence}\nNo memory matches.`;
    }

    // Bug 3: Cap active PLAN.EX entries at 2 most-recently-updated to prevent
    // stale/orphaned execution states from flooding the planner context.
    let entries = result.entries;
    const planExEntries = entries.filter(e => e.nb === 'PLAN' && e.type === 'EX');
    if (planExEntries.length > 2) {
      const sorted = [...planExEntries].sort((a, b) => b.updated.localeCompare(a.updated));
      const keep = new Set(sorted.slice(0, 2).map(e => e.code));
      entries = entries.filter(e => !(e.nb === 'PLAN' && e.type === 'EX') || keep.has(e.code));
      for (const dropped of planExEntries.slice(2)) {
        transparency.emit({ type: 'memory_context_filtered', data: { code: dropped.code, reason: 'plan_ex_cap', status: dropped.status } });
      }
    }

    const lines = entries.map(entry => `- [${entry.code}] ${entry.name}: ${entry.summary}`);
    return `## ${unit.id}\nStrategy: ${result.strategy}\nConfidence: ${result.confidence}\n${lines.join('\n')}`;
  }).join('\n\n');
}

function buildResolvedContext(label: string, resolved: ResolvedMemory | null): string {
  if (!resolved || resolved.entries.length === 0) return '';

  const lines = resolved.entries.map(entry => `- [${entry.code}] ${entry.name}: ${entry.summary}`);
  return `${label}:\n${lines.join('\n')}`;
}

function formatQueryReply(unit: DecomposedUnit, result: UnitMemoryResult): string {
  if (result.entries.length === 0) {
    return `No matching entries found for "${unit.content}".`;
  }

  const lines = result.entries.map(entry => `- [${entry.code}] ${entry.name} (${entry.status}): ${entry.summary}`);
  return `${unit.content}\n${lines.join('\n')}`;
}

function extractMathExpression(message: string): string | null {
  const percentOf = message.match(/(\d+(?:\.\d+)?)\s+percent\s+of\s+(\d+(?:\.\d+)?)/i);
  if (percentOf) return `${percentOf[1]} / 100 * ${percentOf[2]}`;

  const pctMatch = message.match(/(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)/i);
  if (pctMatch) return `${pctMatch[1]} / 100 * ${pctMatch[2]}`;

  const wordMath = message.match(
    /(?:(?:what|how\s+much)\s+is\s+)?(\d+(?:\.\d+)?)\s+(plus|minus|times|divided\s+by|multiplied\s+by)\s+(\d+(?:\.\d+)?)/i,
  );
  if (wordMath) {
    const ops: Record<string, string> = {
      plus: '+',
      minus: '-',
      times: '*',
      'divided by': '/',
      'multiplied by': '*',
    };
    return `${wordMath[1]} ${ops[wordMath[2].toLowerCase()] ?? wordMath[2]} ${wordMath[3]}`;
  }

  const directMath = message.match(/(\d+(?:\.\d+)?\s*[\+\-\*\/×÷\^%]\s*\d+(?:\.\d+)?(?:\s*[\+\-\*\/×÷\^%]\s*\d+(?:\.\d+)?)*)/);
  return directMath?.[1]?.trim().replace(/×/g, '*').replace(/÷/g, '/') ?? null;
}

async function handleConversationalUnits(
  units: DecomposedUnit[],
  results: UnitMemoryResult[],
  history: Message[],
  llmHandler: LLMHandler,
): Promise<ConversationalRouteResult> {
  if (units.length === 1 && GREETING_ONLY.test(units[0].content)) {
    return {
      parts: [{ order: units[0].order, route: 'conversational', reply: 'Hello! How can I help you today?' }],
      resolved: null,
    };
  }

  const arithmeticNotes: string[] = [];
  for (const unit of units) {
    const expression = extractMathExpression(unit.content);
    if (!expression) continue;
    const result = await runSkill('calculator', { expression });
    if (result.success) {
      arithmeticNotes.push(`- ${unit.content} => ${result.output}`);
    }
  }

  const resolved = aggregateResolved(results);
  const compoundPrompt = [
    'Respond to these conversational units together:',
    ...units.map(unit => `- ${unit.content}`),
    arithmeticNotes.length > 0 ? `Arithmetic results:\n${arithmeticNotes.join('\n')}` : '',
  ].filter(Boolean).join('\n');

  const messages = await buildContext(
    compoundPrompt,
    resolved,
    history,
    [],
    'general',
    arithmeticNotes.length > 0 ? arithmeticNotes.join('\n') : undefined,
    llmHandler,
  );
  const reply = stripThinkingTags(await llmHandler(messages, { disableThinking: true })).trim();

  // FIX D: fire-and-forget factual assertion persistence (no-await, doesn't affect reply)
  persistFactualAssertions(units.map(unit => unit.content));

  return {
    parts: [{ order: Math.min(...units.map(unit => unit.order)), route: 'conversational', reply }],
    resolved,
  };
}

async function handleQueryUnits(
  units: DecomposedUnit[],
  results: UnitMemoryResult[],
): Promise<QueryRouteResult> {
  const parts: ReplyPart[] = [];
  const resolvedResults: UnitMemoryResult[] = [];

  for (const unit of units) {
    const current = results.find(result => result.unitId === unit.id);
    if (!current) continue;

    if (current.entries.length > 0) {
      parts.push({ order: unit.order, route: 'query', reply: formatQueryReply(unit, current) });
      resolvedResults.push(current);
      continue;
    }

    const broadened = await hybridSearch(unit.content, { limit: 4 });
    const broadResult: UnitMemoryResult = {
      unitId: unit.id,
      strategy: current.strategy,
      confidence: current.confidence,
      entries: broadened.map(item => item.entry),
      contents: broadened.flatMap(item => {
        const fetched = fetchByCode(item.entry.code);
        return fetched ? [fetched.content] : [];
      }),
    };
    parts.push({ order: unit.order, route: 'query', reply: formatQueryReply(unit, broadResult) });
    resolvedResults.push(broadResult);
  }

  return { parts, resolved: aggregateResolved(resolvedResults) };
}

async function writeCompletionMemoryFromPostFlight(
  plan: TaskPlan,
  execution: ExecutionResult,
  verification: VerificationResult,
  _reflection: { went_well: string; to_improve: string; learned: string },
  llmHandler: LLMHandler,
): Promise<void> {
  const milestoneEventCode = execution.milestoneResults?.at(-1)?.eventCode;
  if (milestoneEventCode) {
    const outcome = verification.verified ? 'success' : (execution.completed.length > 0 ? 'partial' : 'failure');
    writeReflection(milestoneEventCode, {
      code: milestoneEventCode,
      trigger: plan.goal,
      task_name: plan.goal,
      skill_sequence: execution.completed.map(step => step.skill),
      outcome,
      failure_reason: execution.abortReason,
      linked_codes: execution.linkedCodes ?? [],
      session_id: plan.createdAt,
    }, llmHandler).catch(() => {});
  }

  const matchingBrains = queryEntries({ nb: 'PLAN', type: 'PJ', name: plan.goal });
  if (matchingBrains.length > 0) {
    try {
      updateEntry(matchingBrains[0].code, {
        summary: `${verification.verified ? 'Completed' : 'Updated'} on ${localDateString()} — ${plan.goal.slice(0, 80)}`,
      });
    } catch {
      // Project brain update is best-effort.
    }
  }
}

async function writeCompletionMemory(
  plan: TaskPlan,
  execution: ExecutionResult,
  verification: VerificationResult,
  llmHandler: LLMHandler,
): Promise<void> {
  const milestoneEventCode = execution.milestoneResults?.at(-1)?.eventCode;
  if (milestoneEventCode) {
    const outcome = verification.verified ? 'success' : (execution.completed.length > 0 ? 'partial' : 'failure');
    writeReflection(milestoneEventCode, {
      code: milestoneEventCode,
      trigger: plan.goal,
      task_name: plan.goal,
      skill_sequence: execution.completed.map(step => step.skill),
      outcome,
      failure_reason: execution.abortReason,
      linked_codes: execution.linkedCodes ?? [],
      session_id: plan.createdAt,
    }, llmHandler).catch(() => {});
  }

  const matchingBrains = queryEntries({ nb: 'PLAN', type: 'PJ', name: plan.goal });
  if (matchingBrains.length > 0) {
    try {
      updateEntry(matchingBrains[0].code, {
        summary: `${verification.verified ? 'Completed' : 'Updated'} on ${localDateString()} — ${plan.goal.slice(0, 80)}`,
      });
    } catch {
      // Project brain update is best-effort.
    }
  }
}

/**
 * Lightweight executor for "simple" plans (LOW/MEDIUM complexity).
 * Runs steps sequentially — no milestone overhead, no verification LLM call,
 * no PLAN.EX persistence. Returns the last meaningful step output as the reply.
 */
async function runSimplePlan(
  plan: TaskPlan,
  llmHandler: LLMHandler,
  parentCtx?: import('./transparency.js').SpanContext,
  signal?: AbortSignal,
): Promise<{ reply: string; artifactContext?: ArtifactContext }> {
  if (!parentCtx) transparency.emit({ type: 'orphan_span', data: { label: 'SimplePlan: run steps' } });
  const effectiveRequestId = parentCtx?.requestId ?? getCurrentRequestId() ?? 'unknown';
  return withSpan('SimplePlan: run steps', parentCtx, effectiveRequestId, async () => {
  const stepResults = new Map<string, string>();
  let lastOutput = '';
  let artifactContext: ArtifactContext | undefined;

  transparency.emit({ type: 'route', data: { level: 'simple', reason: 'plan self-assessed as simple', path: 'simple_runner' } });

  for (const step of plan.steps) {
    if (signal?.aborted) throw new DOMException('Aborted by user', 'AbortError');
    // Resolve {{template}} references from prior step outputs
    const resolvedInput = resolveTemplates(
      step.input as Record<string, unknown>,
      stepResults,
    ) as Record<string, string>;

    const result = await runWithRetry(step.skill, resolvedInput, llmHandler, 2);

    const output = result.success
      ? (typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? ''))
      : (result.error ?? 'Step failed');

    if (step.storeResultAs) {
      stepResults.set(step.storeResultAs, output);
    }
    stepResults.set(step.id, output);

    if (result.success) {
      lastOutput = result.display ?? output;
      // Track artifact context if a file was written
      if ((step.skill === 'generate_and_save_file' || step.skill === 'file_writer') && resolvedInput.path) {
        artifactContext = {
          path: resolvedInput.path as string,
          format: (resolvedInput.format as string) ?? 'html',
          description: (resolvedInput.description as string) ?? (resolvedInput.spec_code as string) ?? plan.goal,
        };
      }
    }
  }

  return { reply: lastOutput || 'Done.', artifactContext };
  }); // end withSpan
}

/**
 * FIX 2: Detects if the message is a continuation request.
 * Phrases like "resume", "continue", "keep going" signal to reuse prior PLAN.EX state.
 */
function isContinuationIntent(message: string): boolean {
  const trimmed = message.trim().toLowerCase();
  const CONTINUATION_PATTERN = /\b(resume|continue|keep going|go on|proceed|next|what's next|what's the next step|what do i do next)\b/;
  return CONTINUATION_PATTERN.test(trimmed);
}

/**
 * FIX 2: Retrieves the active PLAN.EX entry if one exists.
 * Returns the entry code and full body content for continuation context.
 */
async function getActivePlanEx(): Promise<{ code: string; body: string } | null> {
  try {
    const { queryEntries } = await import('./memory/index.js');
    const { fetchByCode } = await import('./memory/fetch.js');

    // Query for active PLAN.EX entries (status = 'active' or 'in_progress')
    const entries = queryEntries({ nb: 'PLAN', type: 'EX', status: 'active' });
    if (entries.length === 0) {
      const inProgressEntries = queryEntries({ nb: 'PLAN', type: 'EX', status: 'in_progress' });
      if (inProgressEntries.length === 0) return null;
      const entry = inProgressEntries[0];
      const body = fetchByCode(entry.code);
      return {
        code: entry.code,
        body: typeof body === 'string' ? body : (body?.content ?? ''),
      };
    }

    const entry = entries[0];
    const body = fetchByCode(entry.code);
    return {
      code: entry.code,
      body: typeof body === 'string' ? body : (body?.content ?? ''),
    };
  } catch {
    return null;
  }
}

async function handleAgenticUnits(
  units: DecomposedUnit[],
  results: UnitMemoryResult[],
  llmHandler: LLMHandler,
  priorContext: ResolvedMemory | null = null,
  workingMemory?: WorkingMemory,
  _history?: Message[],
  constraints?: import('./types.js').UserConstraint[],
  parentCtx?: import('./transparency.js').SpanContext,
  signal?: AbortSignal,
): Promise<AgenticRouteResult> {
  const goalMessage = units.map(unit => unit.content).join('\n');
  const minOrder = Math.min(...units.map(unit => unit.order));

  // Always call decomposeTask — the model self-assesses complexity in the plan JSON.
  // "simple" (LOW/MEDIUM) → runSimplePlan (no milestone overhead)
  // "complex" (HIGH/MAX)  → full executePlan pipeline
  const goals = buildGoals(units);
  const memoryContext = [
    buildMemoryContext(units, results),
    buildResolvedContext('PRIOR QUERY CONTEXT', priorContext),
  ].filter(Boolean).join('\n\n');
  // Phase 15 Conflict 5: pass projectCode so decomposeTask can use project brain cache
  const permissionMode = getActivePermissionMode();
  const memoryEnabledOpt = { memoryEnabled: !isMemoryDisabled() };
  const allowedSkills = getSkillsByPermission(permissionMode, memoryEnabledOpt);
  const allSkillsList = getAllSkills();
  const blockedSkillNames = allSkillsList
    .filter(s => !allowedSkills.some(a => a.name === s.name))
    .map(s => s.name);
  const workspaceFiles = buildWorkspaceManifest();

  // FIX 2: Build continuation context for resumable PLAN.EX entries
  let continuationContext = '';
  if (units.some(unit => isContinuationIntent(unit.content))) {
    try {
      const activePlan = await getActivePlanEx();
      if (activePlan) {
        continuationContext = activePlan.body.slice(0, 2000); // Cap at 2000 chars to avoid bloat
        transparency.emit({ type: 'continuation_context_loaded', data: { code: activePlan.code, length: continuationContext.length } });
      }
    } catch {
      // FIX 2: Continuation context building is advisory — fall through on error
    }
  }

  const plan = await decomposeTask(goalMessage, {
    skills: getSkillCompactDescriptions(permissionMode, memoryEnabledOpt),
    goals,
    memoryContext,
    decompositionSummary: buildDecompositionSummary(units),
    projectCode: workingMemory?.projectCode ?? null,
    permissionMode,
    blockedSkillNames,
    workspaceFiles: workspaceFiles || undefined,
    recentArtifact: _lastSessionArtifact,
    continuationContext: continuationContext || undefined,
    constraints: constraints ?? [],
  }, llmHandler, parentCtx, signal);

  if (plan.needsConfirmation) {
    const milestoneLines = (plan.milestones ?? []).map(milestone => `- ${milestone.title}: ${milestone.description}`);
    const reply = [
      'Confirmation required before executing this plan.',
      ...milestoneLines,
    ].join('\n');
    return {
      parts: [{ order: minOrder, route: 'agentic', reply }],
      plan,
    };
  }

  // Phase 18 — Coding route: any unit with taskType==='coding' goes to QueryLoop
  // Constraint escalation: deadline or scope constraints → escalate to planner (HIGH)
  const codingUnits = units.filter(u => u.taskType === 'coding');
  if (codingUnits.length > 0) {
    const escalatingConstraints = (constraints ?? []).filter(c => c.type === 'deadline' || c.type === 'scope');
    if (escalatingConstraints.length > 0) {
      transparency.emit({
        type: 'coding_route_escalated',
        data: {
          reason: `constraints require planner: ${escalatingConstraints.map(c => c.type).join(', ')}`,
          constraints: escalatingConstraints,
        },
      });
      // Fall through to the complexity-based routing below (treated as HIGH)
      plan.complexity = 'HIGH';
    } else {
      transparency.emit({
        type: 'coding_route_selected',
        data: {
          unitIds: codingUnits.map(u => u.id),
          complexity: plan.complexity ?? 'unknown',
          reason: 'taskType=coding',
        },
      });
      const constraintBlock = (constraints ?? []).length > 0
        ? `\n\nCONSTRAINTS:\n${constraints!.map(c => `- [${c.type.toUpperCase()}] ${c.value}`).join('\n')}`
        : '';
      const loopResult = await runQueryLoop(goalMessage + constraintBlock, llmHandler, workingMemory, _history, undefined, undefined, parentCtx, signal);
      if (loopResult.artifactContext) {
        _lastSessionArtifact = loopResult.artifactContext;
      }
      return {
        parts: [{ order: minOrder, route: 'agentic', reply: loopResult.reply }],
        plan,
      };
    }
  }

  // FIX 5B: Defensive fallback for unrecognized complexity values
  // The planner should only emit LOW/MEDIUM/HIGH/MAX after FIX 5A coercion, but add
  // a defense-in-depth guard in case a future model regression emits a novel unknown value.
  const KNOWN_COMPLEXITY = new Set(['LOW', 'MEDIUM', 'HIGH', 'MAX']);
  const planComplexity = plan.complexity ?? 'LOW';
  if (!KNOWN_COMPLEXITY.has(planComplexity)) {
    console.warn(
      `[zaraban][router] Unrecognized complexity "${planComplexity}" — defaulting to LOW (queryLoop)`
    );
    transparency.emit({
      type: 'route',
      data: {
        level: 'LOW',
        reason: `unknown complexity "${planComplexity}" defaulted to LOW`,
        path: 'query_loop',
      },
    });
  }

  // Route based on the plan's self-assessed complexity
  const isSimple = planComplexity === 'LOW' || planComplexity === 'MEDIUM';
  if (isSimple) {
    const simpleResult = await runSimplePlan(plan, llmHandler, parentCtx, signal);
    if (simpleResult.artifactContext) {
      _lastSessionArtifact = simpleResult.artifactContext;
    }
    return {
      parts: [{ order: minOrder, route: 'agentic', reply: simpleResult.reply }],
      plan,
    };
  }

  const execution = await executePlan(plan, llmHandler, workingMemory, parentCtx, signal);
  // Skip LLM synthesis call when executor already escalated (e.g. hard abort, too many failures)
  let verification: import('./schemas.js').VerificationResult;
  if (execution.escalated) {
    verification = { verified: false, confidence: 0, issues: [execution.escalationMessage ?? 'Execution escalated'], suggestion: undefined };
    writeCompletionMemory(plan, execution, verification, llmHandler).catch(() => {});
  } else {
    // FIX 6: Single merged post-flight call replaces verifyExecution + writeCompletionMemory separately
    const postFlight = await runPostFlightSynthesis(plan, execution, llmHandler);
    verification = postFlight.verification;
    // Write reflection using the merged result
    writeCompletionMemoryFromPostFlight(plan, execution, verification, postFlight.reflection, llmHandler).catch(() => {});
  }
  // FIX-5: If executor didn't enqueue task_complete (e.g. escalated path), enqueue it now
  if (!execution.taskCompleteEnqueued) {
    memoryAgent.enqueue({
      type: 'task_complete',
      workingMemory: workingMemory ?? undefined,
      workingMemoryId: workingMemory?.taskId ?? null,
    });
  }
  const reply = stripThinkingTags(buildUserReport(plan, execution, verification)).trim();

  return {
    parts: [{ order: minOrder, route: 'agentic', reply }],
    plan,
    execution,
    verification,
  };
}

export async function routeDecomposedUnits(
  units: DecomposedUnit[],
  results: UnitMemoryResult[],
  history: Message[],
  llmHandler: LLMHandler,
  workingMemory?: WorkingMemory,
  constraints?: import('./types.js').UserConstraint[],
  parentCtx?: import('./transparency.js').SpanContext,
  signal?: AbortSignal,
): Promise<RouteExecutionResult> {
  if (!parentCtx) transparency.emit({ type: 'orphan_span', data: { label: 'Route: dispatch units' } });
  const effectiveRequestId = parentCtx?.requestId ?? getCurrentRequestId() ?? 'unknown';
  return withSpan('Route: dispatch units', parentCtx, effectiveRequestId, async (ctx) => {
  const conversationalUnits = units.filter(unit => unit.route === 'conversational');
  const queryUnits = units.filter(unit => unit.route === 'query');
  const agenticUnits = units.filter(unit => unit.route === 'agentic');

  const conversationalTask = conversationalUnits.length > 0
    ? handleConversationalUnits(
      conversationalUnits,
      results.filter(result => conversationalUnits.some(unit => unit.id === result.unitId)),
      history,
      llmHandler,
    )
    : Promise.resolve(null);

  const queryTask = queryUnits.length > 0
    ? handleQueryUnits(
      queryUnits,
      results.filter(result => queryUnits.some(unit => unit.id === result.unitId)),
    )
    : Promise.resolve(null);

  const queryResult = await queryTask;

  const agenticTask = agenticUnits.length > 0
    ? handleAgenticUnits(
      agenticUnits,
      results.filter(result => agenticUnits.some(unit => unit.id === result.unitId)),
      llmHandler,
      queryResult?.resolved ?? null,
      workingMemory,
      history,
      constraints,
      ctx,
      signal,
    )
    : Promise.resolve(null);

  const [conversationalResult, agenticResult] = await Promise.all([conversationalTask, agenticTask]);
  const resolvedTasks = [conversationalResult, queryResult, agenticResult].filter(
    (task): task is ConversationalRouteResult | QueryRouteResult | AgenticRouteResult => task !== null,
  );
  const parts = resolvedTasks.flatMap(task => task.parts).sort((a, b) => a.order - b.order);
  const resolved = resolvedTasks.filter(hasResolvedPayload).map(task => task.resolved).find(value => value !== undefined) ?? null;
  const agenticExecution = resolvedTasks.find(hasPlanPayload);

  return {
    reply: parts.map(part => part.reply).join('\n\n').trim(),
    parts,
    primaryRoute: agenticUnits.length > 0 ? 'agentic' : (queryUnits.length > 0 && conversationalUnits.length === 0 ? 'query' : 'conversational'),
    resolved,
    plan: agenticExecution?.plan,
    execution: agenticExecution?.execution,
    verification: agenticExecution?.verification,
  };
  }); // end withSpan
}

/**
 * Execute a previously confirmed plan. Called by the plan confirmation interceptor
 * in agent.ts when the user confirms a plan that had needsConfirmation: true.
 */
export async function executeConfirmedPlan(
  plan: import('./schemas.js').TaskPlan,
  llmHandler: LLMHandler,
  workingMemory?: WorkingMemory,
): Promise<{ reply: string; execution: import('./executor.js').ExecutionResult; verification: import('./schemas.js').VerificationResult }> {
  const execution = await executePlan(plan, llmHandler, workingMemory);
  let verification: import('./schemas.js').VerificationResult;
  if (execution.escalated) {
    verification = { verified: false, confidence: 0, issues: [execution.escalationMessage ?? 'Execution escalated'], suggestion: undefined };
    writeCompletionMemory(plan, execution, verification, llmHandler).catch(() => {});
  } else {
    const postFlight = await runPostFlightSynthesis(plan, execution, llmHandler);
    verification = postFlight.verification;
    writeCompletionMemoryFromPostFlight(plan, execution, verification, postFlight.reflection, llmHandler).catch(() => {});
  }
  if (!execution.taskCompleteEnqueued) {
    memoryAgent.enqueue({
      type: 'task_complete',
      workingMemory: workingMemory ?? undefined,
      workingMemoryId: workingMemory?.taskId ?? null,
    });
  }
  const reply = stripThinkingTags(buildUserReport(plan, execution, verification)).trim();
  return { reply, execution, verification };
}
