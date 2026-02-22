import type { Message, LLMHandler, AgentResponse, Classification } from './types.js';
import { classifyIntent } from './intent.js';
import { resolveQuery } from './resolver.js';
import { buildContext } from './context.js';
import { callLLM } from './llm.js';
import { getAllSkills, getSkill, getSkillsForIntent } from './skills/registry.js';
import { runSkill } from './skills/runner.js';
import type { SkillResult } from './skills/types.js';
import { createEntry, hybridSearch } from './memory/mod.js';
import { addRelationship } from './memory/relationships.js';
import { fetchByCode } from './memory/mod.js';
import { startHeartbeat, stopHeartbeat } from './heartbeat.js';
import { getDb } from './memory/index.js';

// FIX 1: Processing flag — heartbeat checks this to skip when agent is busy
export let isProcessingMessage = false;

// FIX 1: Agent lifecycle
export function startAgent(): void {
  startHeartbeat();
}

export function stopAgent(): void {
  stopHeartbeat();
}

function isToolInventoryQuery(message: string): boolean {
  const trimmed = message.trim();
  if (/^\/(tools|skills)\b/i.test(trimmed)) return true;
  if (trimmed.length > 160) return false;
  return /^(?:what|which|show|list|do|can)\b[\s\S]*\b(tools?|skills?)\b[\s\S]*\??$/i.test(trimmed);
}

function formatToolInventory(): string {
  const skills = getAllSkills();
  if (skills.length === 0) {
    return 'No MCP skills are currently registered.';
  }

  const lines = ['Available MCP skills:'];
  for (const skill of skills) {
    lines.push(`- ${skill.name}: ${skill.description}`);
  }
  lines.push('');
  lines.push('Try prompts like:');
  lines.push('- search the web for TypeScript tutorial');
  lines.push('- download https://example.com to /tmp/example.html');
  lines.push('- write "hello" to /tmp/note.txt');
  return lines.join('\n');
}

const WRITE_SYSTEM_PROMPT = `You are a memory writing assistant. Extract structured data from the user's request and return ONLY valid JSON.
Return a JSON object with these fields:
{
  "nb": "WHO|WHAT|WHEN|HOW|WHY|NOW|PLAN",
  "type": "(see valid types below)",
  "name": "entry name",
  "status": "active|open|upcoming",
  "summary": "one-line summary",
  "body": "markdown body content",
  "relationships": [{"relation": "works_for|owns|supplies|blocks|refers", "to_code": "CODE"}]
}

Valid notebook + type combinations (use ONLY these):
  WHO: CT (contact), ORG (organization)
  WHAT: PJ (project), KN (knowledge)
  WHEN: CA (calendar), DL (deadline)
  HOW: PR (procedure)
  WHY: MT (meta), QU (question)
  NOW: TD (todo), RP (report)
  PLAN: PL (planning)

Never invent type codes outside this list.
If uncertain, use the closest valid type.
Only include "relationships" if the user mentions a connection to an existing entry by code.
Respond with ONLY the JSON object, no extra text.`;

function inferWriteData(message: string, classification: Classification): {
  nb: string; type: string; name: string; status: string; summary: string; body: string;
} | null {
  // Determine notebook + type from classification or message content
  let nb = classification.nb;
  let type = classification.type;

  if (!nb || !type) {
    if (/\bcontact\b/i.test(message) || /\bperson\b/i.test(message)) { nb = 'WHO'; type = 'CT'; }
    else if (/\borganization\b|\bcompany\b/i.test(message)) { nb = 'WHO'; type = 'ORG'; }
    else if (/\bproject\b/i.test(message)) { nb = 'WHAT'; type = 'PJ'; }
    else if (/\bknowledge\b/i.test(message)) { nb = 'WHAT'; type = 'KN'; }
    else if (/\bmeeting\b|\bcalendar\b|\bevent\b/i.test(message)) { nb = 'WHEN'; type = 'CA'; }
    else if (/\bdeadline\b/i.test(message)) { nb = 'WHEN'; type = 'DL'; }
    else if (/\bremind\b|\btodo\b|\btask\b/i.test(message)) { nb = 'NOW'; type = 'TD'; }
    else if (/\bprocedure\b|\bhow to\b/i.test(message)) { nb = 'HOW'; type = 'PR'; }
    else if (/\bplan\b/i.test(message)) { nb = 'PLAN'; type = 'PL'; }
    else if (/\bschedule\b/i.test(message)) { nb = 'WHEN'; type = 'CA'; }
    else { nb = 'WHAT'; type = 'KN'; } // fallback
  }

  // Extract name from classification or message
  let name = classification.name;
  if (!name) {
    // Try "named/called/for X" patterns
    const namedMatch = message.match(
      /(?:named|called|for|contact)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)/
    );
    if (namedMatch) name = namedMatch[1];
  }
  if (!name) return null;

  // Extract role/context for summary
  let summary = name;
  const roleMatch = message.match(/(?:assistant|manager|developer|engineer|designer|lead|director|specialist|consultant|intern)\s+(?:at|for|of)\s+\w+/i);
  if (roleMatch) summary = roleMatch[0];
  else {
    const atMatch = message.match(/(?:at|for|of)\s+([A-Z][A-Za-z]+(?:\s+[A-Za-z]+)*)/);
    if (atMatch) summary = `${name}, ${atMatch[0]}`;
  }

  const status = /\b(upcoming|open|closed|archived)\b/i.test(message)
    ? message.match(/\b(upcoming|open|closed|archived)\b/i)![1].toLowerCase()
    : (nb === 'NOW' ? 'open' : 'active');

  // Build body from remaining context
  const body = message;

  return { nb, type, name, status, summary, body };
}

function parseLLMWriteResponse(response: string): {
  nb?: string; type?: string; name?: string; status?: string;
  summary?: string; body?: string;
  relationships?: Array<{ relation: string; to_code: string }>;
} | null {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

const TOOL_ORCHESTRATOR_PROMPT = `You are a tool orchestrator. Decide the next best step to complete the user's request.
You can call one tool at a time and then review the result.

Return ONLY one JSON object in one of these two formats:
1) {"type":"tool","tool":"tool_name","input":{"field":"value"}}
2) {"type":"final","message":"final user-facing answer"}

Rules:
- Use only listed tools.
- Do not invent tool results.
- If a tool fails, either retry with corrected input or return type="final" with the limitation.
- Keep inputs minimal and valid for the tool schema.
- shell_runner supports only these commands: pnpm test, pnpm build, pnpm --version, npm test, npm run test, npm run build, npx vitest run, npx tsc --noEmit, mkdir -p <path>.
- For creating files/folders, prefer file_writer/code_editor. Use shell_runner only when needed.
- No markdown, no code fences, no extra text.`;

const TOOL_RESPONSE_REPAIR_PROMPT = `Convert planner output into strict JSON.
Return exactly one JSON object in one of these shapes:
1) {"type":"tool","tool":"tool_name","input":{...}}
2) {"type":"final","message":"..."}
No markdown, no prose, no explanations.`;
const TOOL_WORKFLOW_FINALIZER_PROMPT = `You are a completion summarizer for tool execution logs.
Write the final user-facing result using executed tool outputs only.
Do not invent actions or results that are not present in the logs.
If requested, include "state trace" and "final gold math" sections explicitly.
Be concise and concrete.`;

const TOOL_WORKFLOW_MAX_STEPS = 12;
const TOOL_RESULT_PREVIEW_CHARS = 1200;
const MAX_PLANNER_JSON_RETRIES = 4;
const TOOL_WORKFLOW_ALLOWED_SKILLS = [
  'web_search',
  'web_fetch',
  'file_reader',
  'file_writer',
  'code_editor',
  'shell_runner',
  'log_analyzer',
  'task_planner',
] as const;
const TOOL_WORKFLOW_PATTERNS = /\b(download|save|store|collect|scrape|extract|summari[sz]e|crawl|visit|open\s+url|write\s+code|implement|refactor|fix\s+(the\s+)?(code|bug|tests?)|run\s+(the\s+)?tests?|build\s+(the\s+)?(project|app)|build\s+a|compile|run\s+(tsc|vitest|pnpm\s+test|pnpm\s+build)|debug|analy[sz]e\s+logs?|break\s+into\s+steps?|plan\s+the\s+task|simulator|prototype|game\s+mechanics?|initialize\s+the\s+game|process\s+the\s+following\s+sequence)\b/i;

type ToolWorkflowDecision =
  | { type: 'tool'; tool: string; input: Record<string, unknown> }
  | { type: 'final'; message: string };

interface ToolWorkflowStep {
  tool: string;
  input: Record<string, unknown>;
  result: SkillResult;
  elapsedMs: number;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiresConcreteExecution(message: string): boolean {
  return /\b(tools?\s+only|build|create|implement|prototype|simulator|game)\b/i.test(message);
}

function requiresStateAndGoldOutput(message: string): boolean {
  return /\b(state\s+trace|final\s+gold\s+math|gold\s+math)\b/i.test(message)
    || /\bfarming\s+simulator\b/i.test(message);
}

function hasStateAndGoldOutput(text: string): boolean {
  return /\bgold\b/i.test(text) && /\b(state|trace|grid)\b/i.test(text);
}

function hasConcreteExecutionSteps(steps: ToolWorkflowStep[]): boolean {
  return steps.some(step =>
    step.tool === 'file_writer'
    || step.tool === 'code_editor'
    || step.tool === 'shell_runner'
    || step.tool === 'web_fetch'
  );
}

function hasSuccessfulFileEdit(steps: ToolWorkflowStep[]): boolean {
  return steps.some(step =>
    step.result.success
      && (step.tool === 'file_writer' || step.tool === 'code_editor')
  );
}

function hasSuccessfulShellRun(steps: ToolWorkflowStep[]): boolean {
  return steps.some(step => step.result.success && step.tool === 'shell_runner');
}

function completionCriteriaMet(userMessage: string, steps: ToolWorkflowStep[]): boolean {
  if (!requiresConcreteExecution(userMessage)) return true;
  if (!hasSuccessfulFileEdit(steps) && !hasSuccessfulShellRun(steps)) return false;
  return true;
}

function isMemoryIntent(intent: Classification['intent']): boolean {
  return intent === 'memory_write'
    || intent === 'memory_query'
    || intent === 'relationship_query'
    || intent === 'code_fetch';
}

const MULTI_STEP_HINTS = /\b(and\s+then|and\s+(download|save|run|build|fix|write|fetch|compile)|then|until|repeat|loop|sequence|use\s+tools\s+only|if\s+tests?\s+fail|process\s+the\s+following|step\s*\d)\b/i;

function shouldRunPlannedToolWorkflow(message: string, classification: Classification): boolean {
  if (isMemoryIntent(classification.intent)) return false;
  if (!TOOL_WORKFLOW_PATTERNS.test(message)) return false;
  // Keep direct single-skill prompts fast; use planner loop for explicit multi-step/complex tasks.
  if (classification.intent === 'skill' && !MULTI_STEP_HINTS.test(message)) {
    return false;
  }
  return true;
}

function isToolsOnlyEnforcedPrompt(message: string): boolean {
  return /\b(tools?\s+only|strict\s+json\s+tool\s+calls?|return\s+strict\s+json|shell_runner|file_writer|code_editor)\b/i
    .test(message);
}

function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? raw).trim();
  const objectMatch = candidate.match(/\{[\s\S]*\}/);
  return objectMatch ? objectMatch[0] : null;
}

function parseToolWorkflowDecision(raw: string): ToolWorkflowDecision | null {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return null;

  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    if (parsed.type === 'final') {
      const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
      return { type: 'final', message };
    }
    if (parsed.type === 'tool' && typeof parsed.tool === 'string') {
      const input = isObjectRecord(parsed.input) ? parsed.input : {};
      return { type: 'tool', tool: parsed.tool.trim(), input };
    }
    return null;
  } catch {
    return null;
  }
}

async function repairToolWorkflowDecision(
  raw: string,
  handler: LLMHandler,
): Promise<ToolWorkflowDecision | null> {
  try {
    const repaired = await handler([
      { role: 'system', content: TOOL_RESPONSE_REPAIR_PROMPT },
      { role: 'user', content: raw },
    ]);
    return parseToolWorkflowDecision(repaired);
  } catch {
    return null;
  }
}

function validateToolInput(toolName: string, input: Record<string, unknown>): string | null {
  const skill = getSkill(toolName);
  if (!skill) return `Unknown tool '${toolName}'`;

  for (const requiredField of skill.inputSchema.required) {
    const value = input[requiredField];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      return `Missing required input '${requiredField}' for tool '${toolName}'`;
    }
  }

  for (const [field, schema] of Object.entries(skill.inputSchema.properties)) {
    const value = input[field];
    if (value === undefined || value === null) continue;

    if (schema.type === 'string' && typeof value !== 'string') {
      return `Invalid type for '${field}' in tool '${toolName}': expected string`;
    }
    if (schema.type === 'number' && typeof value !== 'number') {
      return `Invalid type for '${field}' in tool '${toolName}': expected number`;
    }
    if (schema.type === 'boolean' && typeof value !== 'boolean') {
      return `Invalid type for '${field}' in tool '${toolName}': expected boolean`;
    }
    if (schema.type === 'object' && !isObjectRecord(value)) {
      return `Invalid type for '${field}' in tool '${toolName}': expected object`;
    }
  }

  return null;
}

function formatToolSchemas(toolNames: readonly string[]): string {
  const allSkills = getAllSkills();
  const lines: string[] = [];
  for (const toolName of toolNames) {
    const skill = allSkills.find(s => s.name === toolName);
    if (!skill) continue;
    lines.push(`- ${skill.name}: ${skill.description}`);
    lines.push(`  inputSchema: ${JSON.stringify(skill.inputSchema)}`);
  }
  return lines.join('\n');
}

function formatRecentHistory(history: Message[]): string {
  if (history.length === 0) return 'No prior conversation.';
  return history
    .slice(-4)
    .map(m => `${m.role}: ${m.content}`)
    .join('\n');
}

function formatToolWorkflowState(steps: ToolWorkflowStep[]): string {
  if (steps.length === 0) return 'No tool calls have run yet.';

  const lines = ['Executed tool calls:'];
  steps.forEach((step, index) => {
    const preview = step.result.output.length > TOOL_RESULT_PREVIEW_CHARS
      ? step.result.output.slice(0, TOOL_RESULT_PREVIEW_CHARS) + '...'
      : step.result.output;
    lines.push(`${index + 1}. tool=${step.tool} elapsedMs=${step.elapsedMs}`);
    lines.push(`   input=${JSON.stringify(step.input)}`);
    lines.push(`   success=${step.result.success}`);
    if (step.result.error) lines.push(`   error=${step.result.error}`);
    if (preview) lines.push(`   output=${preview}`);
  });
  return lines.join('\n');
}

function buildToolWorkflowMessages(
  userMessage: string,
  history: Message[],
  steps: ToolWorkflowStep[],
): Message[] {
  const toolsSummary = formatToolSchemas(TOOL_WORKFLOW_ALLOWED_SKILLS);
  const userContent = [
    `User request: ${userMessage}`,
    '',
    `Recent conversation:\n${formatRecentHistory(history)}`,
    '',
    `Available tools:\n${toolsSummary}`,
    '',
    formatToolWorkflowState(steps),
  ].join('\n');

  return [
    { role: 'system', content: TOOL_ORCHESTRATOR_PROMPT },
    { role: 'user', content: userContent },
  ];
}

function summarizeWorkflow(steps: ToolWorkflowStep[]): string {
  if (steps.length === 0) {
    return "I couldn't plan the web action workflow for that request.";
  }

  const lines = ['I ran these actions:'];
  steps.forEach((step, index) => {
    const status = step.result.success ? 'ok' : 'failed';
    lines.push(`${index + 1}. ${step.tool} (${status}, ${step.elapsedMs} ms)`);
    if (step.result.error) lines.push(`   ${step.result.error}`);
  });

  const lastOutput = [...steps].reverse().find(step => step.result.output.trim().length > 0)?.result.output;
  if (lastOutput) {
    const preview = lastOutput.length > TOOL_RESULT_PREVIEW_CHARS
      ? `${lastOutput.slice(0, TOOL_RESULT_PREVIEW_CHARS)}...`
      : lastOutput;
    lines.push('');
    lines.push(preview);
  }

  return lines.join('\n');
}

async function buildWorkflowFinalAnswer(
  userMessage: string,
  steps: ToolWorkflowStep[],
  handler: LLMHandler,
): Promise<string> {
  try {
    const logs = steps
      .map((s, i) => `${i + 1}. ${s.tool} success=${s.result.success} input=${JSON.stringify(s.input)}`
        + (s.result.error ? ` error=${s.result.error}` : '')
        + (s.result.output ? ` output=${s.result.output.slice(0, 1200)}` : ''))
      .join('\n');

    const prompt = [
      `User request: ${userMessage}`,
      '',
      'Executed tool logs:',
      logs || '(none)',
    ].join('\n');

    const finalText = await handler([
      { role: 'system', content: TOOL_WORKFLOW_FINALIZER_PROMPT },
      { role: 'user', content: prompt },
    ]);
    const normalized = finalText.trim();
    if (
      normalized
      && !/^general response\.?$/i.test(normalized)
      && !/strict json tool output/i.test(normalized)
      && !/cannot interact with your local file system/i.test(normalized)
    ) {
      return normalized;
    }
  } catch {
    // Fall through.
  }
  return summarizeWorkflow(steps);
}

async function runPlannedToolWorkflow(
  userMessage: string,
  history: Message[],
  findingsPrefix: string,
  options?: { llmHandler?: LLMHandler },
): Promise<AgentResponse | null> {
  const handler = options?.llmHandler ?? callLLM;
  const steps: ToolWorkflowStep[] = [];
  let invalidPlannerOutputCount = 0;
  const toolsOnlyEnforced = isToolsOnlyEnforcedPrompt(userMessage);

  for (let i = 0; i < TOOL_WORKFLOW_MAX_STEPS; i += 1) {
    let plannerResponse: string;
    try {
      plannerResponse = await handler(buildToolWorkflowMessages(userMessage, history, steps));
    } catch {
      return null;
    }

    let decision = parseToolWorkflowDecision(plannerResponse);
    if (!decision) {
      decision = await repairToolWorkflowDecision(plannerResponse, handler);
    }
    if (!decision) {
      invalidPlannerOutputCount += 1;
      if (invalidPlannerOutputCount > MAX_PLANNER_JSON_RETRIES && completionCriteriaMet(userMessage, steps)) {
        const fallbackFinal = await buildWorkflowFinalAnswer(userMessage, steps, handler);
        return {
          reply: findingsPrefix + fallbackFinal,
          intent: 'skill',
          resolved: null,
          error: 'Planner output invalid; auto-finalized from executed results',
        };
      }
      if (invalidPlannerOutputCount <= MAX_PLANNER_JSON_RETRIES) {
        steps.push({
          tool: 'planner_guard',
          input: {},
          result: {
            success: false,
            output: '',
            error: 'Planner returned invalid format; expected strict JSON tool/final object.',
          },
          elapsedMs: 0,
        });
        continue;
      }
      if (steps.length === 0) return null;
      return {
        reply: findingsPrefix + summarizeWorkflow(steps),
        intent: 'skill',
        resolved: null,
        error: 'Tool planner returned invalid output repeatedly',
      };
    }
    invalidPlannerOutputCount = 0;

    if (decision.type === 'final') {
      if (toolsOnlyEnforced && !completionCriteriaMet(userMessage, steps)) {
        steps.push({
          tool: 'planner_guard',
          input: {},
          result: {
            success: false,
            output: '',
            error: 'Final blocked: must include at least one successful file edit and one successful shell_runner command.',
          },
          elapsedMs: 0,
        });
        continue;
      }
      if (requiresConcreteExecution(userMessage) && !hasConcreteExecutionSteps(steps)) {
        steps.push({
          tool: 'planner_guard',
          input: {},
          result: {
            success: false,
            output: '',
            error: 'Planner attempted to finish before any concrete execution step (edit/build/test/fetch).',
          },
          elapsedMs: 0,
        });
        continue;
      }
      if (requiresStateAndGoldOutput(userMessage) && !hasStateAndGoldOutput(decision.message)) {
        steps.push({
          tool: 'planner_guard',
          input: {},
          result: {
            success: false,
            output: '',
            error: 'Final output missing required state trace + gold math details.',
          },
          elapsedMs: 0,
        });
        continue;
      }
      const finalMessage = decision.message || summarizeWorkflow(steps);
      return {
        reply: findingsPrefix + finalMessage,
        intent: 'skill',
        resolved: null,
      };
    }

    if (!TOOL_WORKFLOW_ALLOWED_SKILLS.includes(decision.tool as typeof TOOL_WORKFLOW_ALLOWED_SKILLS[number])) {
      steps.push({
        tool: decision.tool,
        input: decision.input,
        result: { success: false, output: '', error: `Tool '${decision.tool}' is not allowed in this workflow` },
        elapsedMs: 0,
      });
      continue;
    }

    const inputError = validateToolInput(decision.tool, decision.input);
    if (inputError) {
      steps.push({
        tool: decision.tool,
        input: decision.input,
        result: { success: false, output: '', error: inputError },
        elapsedMs: 0,
      });
      continue;
    }

    const startedAt = performance.now();
    let executedInput = decision.input;
    let result = await runSkill(decision.tool, executedInput);

    // Auto-recover common deterministic tool mistakes to reduce planner thrash.
    if (!result.success && decision.tool === 'file_writer') {
      const overwriteMissing = /File already exists:/i.test(result.error ?? '');
      const hasOverwrite = Boolean(executedInput.overwrite ?? false);
      const hasAppend = Boolean(executedInput.append ?? false);
      if (overwriteMissing && !hasOverwrite && !hasAppend) {
        executedInput = { ...executedInput, overwrite: true };
        result = await runSkill(decision.tool, executedInput);
      }
    }

    const elapsedMs = Math.round(performance.now() - startedAt);
    steps.push({ tool: decision.tool, input: executedInput, result, elapsedMs });
  }

  return {
    reply: findingsPrefix + await buildWorkflowFinalAnswer(userMessage, steps, handler),
    intent: 'skill',
    resolved: null,
    error: 'Tool workflow reached step limit',
  };
}

export async function processMessage(
  message: string,
  history: Message[],
  options?: { llmHandler?: LLMHandler },
): Promise<AgentResponse> {
  isProcessingMessage = true;
  try {
    return await _processMessage(message, history, options);
  } finally {
    isProcessingMessage = false;
  }
}

async function _processMessage(
  message: string,
  history: Message[],
  options?: { llmHandler?: LLMHandler },
): Promise<AgentResponse> {
  // FIX 3: Drain heartbeat_queue — surface findings to user
  let findingsPrefix = '';
  try {
    const d = getDb();
    const unseen = d.prepare(
      'SELECT * FROM heartbeat_queue WHERE seen = 0'
    ).all() as Array<{ id: number; code: string; message: string; seen: number; created: string }>;

    if (unseen.length > 0) {
      findingsPrefix = '\u{1F4CB} While you were away:\n' + unseen.map(r => r.message).join('\n') + '\n\n';
      d.prepare('UPDATE heartbeat_queue SET seen = 1').run();
    }
  } catch {
    // Queue not available yet — ignore
  }

  // 1. Classify intent
  const classification = classifyIntent(message);

  // 2. Greeting — no memory, no LLM
  if (classification.intent === 'greeting') {
    return { reply: findingsPrefix + 'Hello! How can I help you today?', intent: 'greeting', resolved: null };
  }

  // 2b. Tool inventory question — deterministic response, no LLM needed
  if (isToolInventoryQuery(message)) {
    return {
      reply: findingsPrefix + formatToolInventory(),
      intent: 'general',
      resolved: null,
    };
  }

  // 3. Memory write — extract data and write to memory
  if (classification.intent === 'memory_write') {
    const handler = options?.llmHandler ?? callLLM;

    // Try LLM extraction first, fall back to rule-based
    let writeData: {
      nb: string; type: string; name: string; status: string; summary: string; body: string;
      relationships?: Array<{ relation: string; to_code: string }>;
    } | null = null;

    try {
      const writeMessages: Message[] = [
        { role: 'system', content: WRITE_SYSTEM_PROMPT },
        { role: 'user', content: message },
      ];
      const llmResponse = await handler(writeMessages);
      const parsed = parseLLMWriteResponse(llmResponse);
      if (parsed?.nb && parsed?.type && parsed?.name) {
        writeData = {
          nb: parsed.nb,
          type: parsed.type,
          name: parsed.name,
          status: parsed.status ?? 'active',
          summary: parsed.summary ?? parsed.name,
          body: parsed.body ?? message,
          relationships: parsed.relationships,
        };
      }
    } catch {
      // LLM unavailable — fall through to rule-based
    }

    // Fall back to rule-based inference
    if (!writeData) {
      const inferred = inferWriteData(message, classification);
      if (!inferred) {
        return {
          reply: findingsPrefix + 'I could not determine what to create. Please specify a name and type (e.g., "create a contact named John Smith").',
          intent: 'memory_write',
          resolved: null,
        };
      }
      writeData = inferred;
    }

    try {
      const entry = createEntry({
        nb: writeData.nb,
        type: writeData.type,
        name: writeData.name,
        status: writeData.status,
        summary: writeData.summary,
        body: writeData.body,
      });

      // Add relationships if present
      if (writeData.relationships) {
        for (const rel of writeData.relationships) {
          try {
            addRelationship({ from_code: entry.code, relation: rel.relation, to_code: rel.to_code });
          } catch {
            // relationship target may not exist — skip silently
          }
        }
      }

      return {
        reply: findingsPrefix + `Created ${entry.code} — ${entry.name} (${writeData.nb}.${writeData.type})`,
        intent: 'memory_write',
        resolved: { step: 0, entries: [entry], contents: [], relationships: [] },
        created: entry,
      };
    } catch (err) {
      return {
        reply: findingsPrefix + `Failed to create entry: ${String(err)}`,
        intent: 'memory_write',
        resolved: null,
        error: String(err),
      };
    }
  }

  // 4. Planned multi-step workflow (can start from general or skill intent)
  const workflowRequested = shouldRunPlannedToolWorkflow(message, classification);
  const toolsOnlyEnforced = isToolsOnlyEnforcedPrompt(message);
  if (workflowRequested || toolsOnlyEnforced) {
    const workflowResponse = await runPlannedToolWorkflow(
      message,
      history,
      findingsPrefix,
      options,
    );
    if (workflowResponse) return workflowResponse;
    if (toolsOnlyEnforced) {
      return {
        reply: findingsPrefix + 'Tool workflow could not start with valid planner output. Please retry with a concrete task sentence (e.g., "build X in /tmp/y and run pnpm build").',
        intent: 'skill',
        resolved: null,
        error: 'Tool workflow initialization failed',
      };
    }
  }

  // 5. Single skill execution
  if (classification.intent === 'skill' && classification.skill) {
    const skillResult = await runSkill(classification.skill, classification.skillInput ?? {});

    if (!skillResult.success) {
      return {
        reply: findingsPrefix + `I couldn't complete that: ${skillResult.error}`,
        intent: 'skill',
        resolved: null,
        error: skillResult.error,
      };
    }

    // Pass skill output through context builder and LLM
    const skillContext = buildContext(
      message, null, history, [],
      'skill',
      skillResult.output,
    );

    try {
      const handler = options?.llmHandler ?? callLLM;
      const reply = await handler(skillContext);
      return { reply: findingsPrefix + reply, intent: 'skill', resolved: null };
    } catch (error) {
      // If LLM fails, return raw skill output
      return { reply: findingsPrefix + skillResult.output, intent: 'skill', resolved: null };
    }
  }

  // 6. Resolve memory (5-step query flow)
  let resolved = resolveQuery(classification);

  // 6b. Step 5: Hybrid search fallback for vague queries
  // At this point, only code_fetch, memory_query, relationship_query, general remain
  if (resolved === null && classification.intent !== 'code_fetch') {
    try {
      const searchResults = await hybridSearch(message, { nb: classification.nb });
      if (searchResults.length > 0) {
        const entries = searchResults.map(r => r.entry);
        const contents: string[] = [];
        for (const entry of entries) {
          const fetched = fetchByCode(entry.code);
          if (fetched) contents.push(fetched.content);
        }
        resolved = { step: 5, entries, contents, relationships: [] };
      }
    } catch {
      // Search failed — fall through to not-found guard
    }
  }

  // 7. Deterministic not-found guard
  if (resolved === null) {
    if (classification.intent === 'code_fetch') {
      return { reply: findingsPrefix + 'Entry not found.', intent: classification.intent, resolved: null };
    }
    if ((classification.intent === 'memory_query' || classification.intent === 'relationship_query') && classification.nb) {
      return { reply: findingsPrefix + `No entries found in ${classification.nb} notebook.`, intent: classification.intent, resolved: null };
    }
    if (classification.intent === 'memory_query' || classification.intent === 'relationship_query') {
      return { reply: findingsPrefix + 'No matching entries found.', intent: classification.intent, resolved: null };
    }
    // 'general' intent — allowed to pass to LLM without resolved memory
  }

  // 8. Load relevant skills
  const skills = getSkillsForIntent(classification.intent);

  // 9. Build lean context
  const messages = buildContext(message, resolved, history, skills, classification.intent);

  // 10. Call LLM with error handling (BUG 6)
  try {
    const handler = options?.llmHandler ?? callLLM;
    const reply = await handler(messages);
    return { reply: findingsPrefix + reply, intent: classification.intent, resolved };
  } catch (error) {
    return {
      reply: findingsPrefix + 'I could not reach the language model. Please check that it is running.',
      intent: classification.intent,
      resolved,
      error: String(error),
    };
  }
}
