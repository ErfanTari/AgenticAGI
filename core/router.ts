import { buildContext } from './context.js';
import { executePlan, verifyExecution, buildUserReport } from './executor.js';
import { localDateString } from './utils/date.js';
import type { WorkingMemory } from './memory/working-memory.js';
import { stripThinkingTags } from './llm.js';
import { decomposeTask, assessComplexity } from './planner.js';
import { fetchByCode, hybridSearch, queryEntries, updateEntry, upsertEntry } from './memory/mod.js';
import { writeReflection } from './memory/episodic.js';
import { addRelationship, getRelationshipsFrom } from './memory/relationships.js';
import { getSkillDescriptions } from './skills/registry.js';
import { runSkill } from './skills/runner.js';
import { memoryAgent } from './memory/memory-agent.js';
import { runQueryLoop } from './query-loop.js';
import type {
  Classification,
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
            body: text,
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
    const lines = result.entries.map(entry => `- [${entry.code}] ${entry.name}: ${entry.summary}`);
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
  const reply = stripThinkingTags(await llmHandler(messages)).trim();

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

async function handleAgenticUnits(
  units: DecomposedUnit[],
  results: UnitMemoryResult[],
  llmHandler: LLMHandler,
  priorContext: ResolvedMemory | null = null,
  workingMemory?: WorkingMemory,
): Promise<AgenticRouteResult> {
  const goalMessage = units.map(unit => unit.content).join('\n');
  const minOrder = Math.min(...units.map(unit => unit.order));

  // Phase 16 — Complexity routing
  // LOW/MEDIUM → QueryLoop (model decides steps iteratively)
  // HIGH/MAX   → existing decomposeTask + executePlan pipeline
  const complexityClassification: Classification = { intent: 'planned_workflow', codes: [] };
  const complexity = await assessComplexity(goalMessage, complexityClassification, llmHandler);

  if (complexity.level === 'LOW' || complexity.level === 'MEDIUM') {
    const loopResult = await runQueryLoop(goalMessage, llmHandler, workingMemory);
    // Build a minimal stub plan so the return type is satisfied
    const stubPlan: TaskPlan = {
      goal: goalMessage,
      steps: [{ id: 'ql_1', skill: 'query_loop', input: {}, description: goalMessage, dependsOn: [], optional: false, confidence_score: 1.0, risk_level: 'LOW' as const }],
      milestones: [],
      goals: buildGoals(units),
      complexity: complexity.level,
      needsConfirmation: false,
      createdAt: new Date().toISOString(),
    };
    return {
      parts: [{ order: minOrder, route: 'agentic', reply: loopResult.reply }],
      plan: stubPlan,
    };
  }

  // HIGH/MAX — full milestone planner + executor
  const goals = buildGoals(units);
  const memoryContext = [
    buildMemoryContext(units, results),
    buildResolvedContext('PRIOR QUERY CONTEXT', priorContext),
  ].filter(Boolean).join('\n\n');
  // Phase 15 Conflict 5: pass projectCode so decomposeTask can use project brain cache
  const plan = await decomposeTask(goalMessage, {
    skills: getSkillDescriptions(),
    goals,
    memoryContext,
    decompositionSummary: buildDecompositionSummary(units),
    projectCode: workingMemory?.projectCode ?? null,
  }, llmHandler);

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

  const execution = await executePlan(plan, llmHandler, workingMemory);
  // Skip LLM verification call when executor already escalated (e.g. hard abort, too many failures)
  // FIX-H1: Short-circuit verification for escalated plans; use LLM verification for non-escalated
  const verification = execution.escalated
    ? { verified: false, confidence: 0, issues: [execution.escalationMessage ?? 'Execution escalated'], suggestion: undefined }
    : await verifyExecution(plan, execution, llmHandler);
  writeCompletionMemory(plan, execution, verification, llmHandler).catch(() => {});
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
): Promise<RouteExecutionResult> {
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
}
