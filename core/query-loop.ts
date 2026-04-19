/**
 * QueryLoop — Phase 16, Section 1
 *
 * Execution engine for LOW/MEDIUM complexity agentic units.
 * Instead of an upfront plan, the model decides each action step
 * in a `while(true)` loop — one tool call per iteration.
 *
 * Loop protocol:
 *  1. Build messages: system + goal block + pointer index + history of tool results
 *  2. Call LLM — extract first JSON with "action" key
 *  3. Execute the skill via runWithRetry
 *  4. Append tool result + goal reminder to messages
 *  5. Repeat until model stops emitting actions or limits are hit
 *
 * Safety limits:
 *  - MAX_ITERATIONS: 20 iterations per run
 *  - Circuit breaker: 3 consecutive identical failures per skillName:inputHash trips the breaker
 */

import { createHash } from 'node:crypto';
import type { LLMHandler, Message } from './types.js';
import type { WorkingMemory } from './memory/working-memory.js';
import { runWithRetry } from './react.js';
import { stripThinkingTags } from './llm.js';
import { transparency } from './transparency.js';
import { loadPointerIndex, loadActiveLoopsSection } from './memory/pointer-index.js';
import { TOKEN_BUDGETS } from '../config/agent.config.js';
import { buildQueryLoopSystemPrompt, emitPromptBudget } from './prompt-budget.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 20;
const HISTORY_KEEP_PAIRS = 3;

export const COMPLEXITY_ITERATION_CAPS = {
  LOW: 20,
  MEDIUM: 40,
  HIGH: 80,
  MAX: 150,
} as const;
const CIRCUIT_MAX_FAILURES = 3;
const FAILURE_RESET_THRESHOLD = 3;

function resolveLoopMaxTokens(goal: string): number {
  if (/\b(html|css|javascript|java\s*script|single-file|single file|complete|full|portfolio|landing page|website|web page)\b/i.test(goal)
    || /\.[a-z0-9]{2,6}\b/i.test(goal)
    || /\b(create|write|save).+\b(file|html|page|script|component)\b/i.test(goal)) {
    return 4096;
  }
  return 1024;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QueryLoopOptions {
  /** Restrict which skills the loop may call. Defaults to all permitted skills. */
  allowedSkillsOverride?: string[];
  /** Override iteration cap. Defaults to MAX_ITERATIONS (20). */
  maxIterationsOverride?: number;
}

export interface QueryLoopResult {
  reply: string;
  iterations: number;
  skillsUsed: string[];
  stoppedBecause: 'goal_complete' | 'circuit_breaker' | 'max_iterations' | 'no_action';
  /** Fix 3: last artifact generated in this session, for follow-up continuation */
  artifactContext?: ArtifactContext;
}

/** Fix 3: Artifact context captured after generate_and_save_file succeeds */
export interface ArtifactContext {
  path: string;
  description: string;
  format: string;
}

interface ToolCall {
  action: string;
  input: Record<string, unknown>;
  /** Optional human-readable reasoning the model produced before the JSON */
  thought?: string;
}

// ─── JSON Extraction ──────────────────────────────────────────────────────────

/**
 * Extracts the first JSON object that looks like a tool call from model output.
 *
 * Supported formats (local models emit any of these):
 *   {"action": "skill_name", "input": {...}}          ← preferred protocol
 *   {"tool": "skill_name", "parameters": {...}}        ← common LM Studio variant
 *   {"skill": "skill_name", "input": {...}}            ← another common variant
 *
 * Returns null if no recognisable tool-call object is found.
 */
function extractToolCall(text: string): ToolCall | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = text.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate) as Record<string, unknown>;

          // Normalise across all supported key variants
          const actionName =
            typeof parsed.action === 'string' ? parsed.action :
            typeof parsed.tool   === 'string' ? parsed.tool :
            typeof parsed.skill  === 'string' ? parsed.skill :
            null;

          if (actionName !== null) {
            const rawInput = parsed.input ?? parsed.parameters;
            const input = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput))
              ? rawInput as Record<string, unknown>
              : {};
            const thought = typeof parsed.thought === 'string' ? parsed.thought : undefined;
            return { action: actionName, input, thought };
          }
        } catch { /* not valid JSON — continue scanning */ }
        start = -1;
      }
    }
  }
  return null;
}

function hasUnbalancedJsonBraces(text: string): boolean {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
  }

  return depth > 0;
}

function looksLikeIncompleteToolCall(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!/"\s*(action|tool|skill)\s*"\s*:/.test(trimmed)) return false;
  if (extractToolCall(trimmed)) return false;
  if (hasUnbalancedJsonBraces(trimmed)) return true;
  if (/^\s*\{/.test(trimmed)) return true;
  return false;
}

/**
 * Fix 1: Detect malformed tagged/wrapped tool calls.
 * Matches LM Studio token formats like <|tool_call>, <tool_call>, call:skill:{...}, etc.
 */
function looksLikeMalformedTaggedToolCall(text: string): boolean {
  const trimmed = text.trim();
  return (
    /^<\|?tool_call\b/i.test(trimmed) ||
    /^<tool_call>/i.test(trimmed) ||
    /^\[tool:/i.test(trimmed) ||
    /^call:[a-z_]+\s*:\s*\{/i.test(trimmed) ||
    // function-call syntax: skill_name({...}) or skill_name(...)
    /^[a-z_]+\s*\(/.test(trimmed)
  );
}

/**
 * Fix 6: Detect when the model clearly intended to call a tool but the output
 * failed to parse — via known action-intent keywords in the text.
 * Used to trigger repair instead of returning no_action.
 */
function looksLikeToolIntent(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    // Model mentioned a skill name or action-like word suggesting tool use
    /\b(generate_and_save_file|file_writer|file_reader|web_search|run_bash|memory_write|calculator|content_writer)\b/.test(lower) ||
    // Common "I will use..." preamble patterns without completing the JSON
    /\bi\s+(will|am going to|should|need to)\s+(use|call|invoke|run)\b/.test(lower) ||
    // Partial action key present but no valid JSON
    /"action"\s*:/.test(text)
  );
}

/** Fix 5/7: Keywords that signal a follow-up modification request */
const MODIFICATION_KEYWORDS = /\b(fix|adjust|improve|change|scale|update|modify|edit|correct|redo|redo|tweak|refine|revise|enhance|rework)\b/i;

function getLargeInlineFileWriteError(toolCall: ToolCall): string | null {
  if (toolCall.action !== 'file_writer') return null;

  const path = typeof toolCall.input.path === 'string' ? toolCall.input.path : '';
  const content = typeof toolCall.input.content === 'string' ? toolCall.input.content : '';
  if (content.length < 1200) return null;

  const looksLikeGeneratedArtifact =
    /\.(html?|css|js|jsx|ts|tsx|md|markdown|txt|json|csv)$/i.test(path) ||
    /<!DOCTYPE html>|<html[\s>]|<style[\s>]|<script[\s>]/i.test(content);

  if (!looksLikeGeneratedArtifact) return null;

  return [
    'Large generated file contents must not be embedded directly in file_writer JSON.',
    'Use generate_and_save_file instead so the backend generates the content and writes the file.',
  ].join(' ');
}

function getRepeatedGeneratedFileError(toolCall: ToolCall, filesWritten: string[]): string | null {
  if (toolCall.action !== 'generate_and_save_file') return null;
  const pathValue = typeof toolCall.input.path === 'string' ? toolCall.input.path.trim() : '';
  if (!pathValue || !filesWritten.includes(pathValue)) return null;

  return [
    `File "${pathValue}" was already generated earlier in this task.`,
    'Do not call generate_and_save_file again for the same path.',
    'If the file already satisfies the goal, respond with a plain-text completion summary and NO JSON action block.',
    'If you need to modify the existing file, use patch_file instead.',
  ].join(' ');
}

function getTerminalSpecCodeError(toolCall: ToolCall, entryStatus: string): string | null {
  if (toolCall.action !== 'generate_and_save_file') return null;
  return [
    `spec_code points to a terminal PLAN.EX entry with status "${entryStatus}".`,
    'Do not generate from completed or failed execution specs.',
    'Write a fresh spec with memory_write or use a new inline description instead.',
  ].join(' ');
}

// ─── Input Fingerprinting (Fix 3: semantic normalization) ────────────────────

function normalizeInput(input: Record<string, unknown>): string {
  // Normalize: stringify, strip excess whitespace, truncate long text
  const raw = JSON.stringify(input);
  return raw
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

function errorType(error: string): string {
  if (/permission|denied|forbidden|not allowed/i.test(error)) return 'PERMISSION';
  if (/not found|no such file|enoent/i.test(error)) return 'NOT_FOUND';
  if (/timeout|timed out/i.test(error)) return 'TIMEOUT';
  if (/boundary|traversal/i.test(error)) return 'BOUNDARY';
  if (/invalid|missing|required/i.test(error)) return 'INVALID_INPUT';
  return 'UNKNOWN';
}

/**
 * Fix 3: Semantic failure signature = hash(skill_name + normalized_input + error_type)
 * Detects repeated failures even when input objects differ in whitespace/ordering.
 */
function failureSignature(skillName: string, input: Record<string, unknown>, error: string): string {
  const payload = `${skillName}|${normalizeInput(input)}|${errorType(error)}`;
  return createHash('sha1').update(payload).digest('hex').slice(0, 12);
}

function inputHash(input: Record<string, unknown>): string {
  return createHash('sha1').update(JSON.stringify(input)).digest('hex').slice(0, 8);
}

function replySignature(text: string): string {
  return createHash('sha1')
    .update(text.replace(/\s+/g, ' ').trim().slice(0, 500))
    .digest('hex')
    .slice(0, 12);
}

function circuitKey(skillName: string, input: Record<string, unknown>): string {
  return `${skillName}:${inputHash(input)}`;
}

// ─── Goal Block ───────────────────────────────────────────────────────────────

function buildGoalBlock(goal: string, iteration: number, filesWritten: string[] = [], maxIter: number = MAX_ITERATIONS): string {
  const lines = [
    `GOAL: ${goal}`,
    `COMPLETION CONDITION: When ALL aspects of the goal are fully addressed, respond with a plain-text summary and NO JSON action block.`,
    `ITERATION: ${iteration} / ${maxIter}`,
  ];
  if (filesWritten.length > 0) {
    lines.push(`FILES WRITTEN SO FAR: ${filesWritten.join(', ')}`);
  }
  return lines.join('\n');
}

function buildResetNote(goal: string, iteration: number, recentFailures: string[], filesWritten: string[] = [], maxIter: number = MAX_ITERATIONS): string {
  const latest = recentFailures.length > 0
    ? `Latest failure: ${recentFailures[recentFailures.length - 1]}`
    : 'Recent attempts encountered repeated tool failures.';

  return [
    'Previous attempts ran into repeated tool failures.',
    'Take a step back and try a different approach.',
    'Avoid repeating the same failed tool call or embedding large generated files directly in JSON.',
    'If a permission or bash error occurred, use file_reader to verify existing files instead of re-running bash.',
    latest,
    '',
    buildGoalBlock(goal, iteration, filesWritten, maxIter),
  ].join('\n');
}

// ─── History Collapse ─────────────────────────────────────────────────────────

function collapseOldHistory(messages: Message[], baseCount: number): void {
  // Keep system + priorTurns (baseCount) + last HISTORY_KEEP_PAIRS*2 tool turns
  const keepTail = HISTORY_KEEP_PAIRS * 2;
  const toolMessages = messages.slice(baseCount);
  if (toolMessages.length <= keepTail) return;
  const collapsed = toolMessages.slice(0, toolMessages.length - keepTail);
  const summary = `[${collapsed.length} earlier turns collapsed to save context]`;
  messages.splice(baseCount, collapsed.length, { role: 'user', content: summary });
}

// ─── MEMORY.md Relevance Filtering ──────────────────────────────────────────

const POINTER_STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'create', 'make', 'build', 'write', 'save', 'add', 'use', 'get', 'set']);

export function filterPointerIndex(fullIndex: string, goal: string, maxEntries: number = 15): string {
  const lines = fullIndex.split('\n').filter(l => l.trim().length > 0);
  const header = lines.filter(l => l.startsWith('#'));
  const entries = lines.filter(l => !l.startsWith('#') && l.includes(':'));

  if (entries.length <= maxEntries) {
    return fullIndex;
  }

  const goalWords = goal.toLowerCase()
    .split(/\s+/)
    .filter(w => w.length >= 3 && !POINTER_STOPWORDS.has(w));

  const scored = entries.map(entry => {
    const entryLower = entry.toLowerCase();
    const score = goalWords.filter(w => entryLower.includes(w)).length;
    return { entry, score };
  });

  const relevant = scored.filter(s => s.score > 0).map(s => s.entry);
  const irrelevant = scored.filter(s => s.score === 0).map(s => s.entry);
  const remaining = maxEntries - relevant.length;
  const recent = remaining > 0 ? irrelevant.slice(-remaining) : [];

  const filtered = [...relevant, ...recent];
  return [...header, ...filtered].join('\n');
}

// ─── Main Loop ─────────────────────────────────────────────────────────────────

/**
 * Run the QueryLoop for a LOW/MEDIUM complexity goal.
 * Each iteration the model chooses the next skill to call or declares completion.
 *
 * @param lastArtifactContext — Fix 3/5: context about the most recently generated file,
 *   injected so follow-up modification requests can regenerate without reading first.
 */
export async function runQueryLoop(
  goal: string,
  llmHandler: LLMHandler,
  _workingMemory?: WorkingMemory,
  history?: Message[],
  lastArtifactContext?: ArtifactContext,
  opts?: QueryLoopOptions,
): Promise<QueryLoopResult> {
  const effectiveMaxIterations = opts?.maxIterationsOverride ?? MAX_ITERATIONS;

  // Load MEMORY.md zones:
  //   activeLoops  — always-fresh task state, injected as task state anchor (~100 tokens)
  //   knownEntries — goal-filtered subset for reference (~200 tokens max)
  const rawPointerIndex = loadPointerIndex();
  const activeLoops = loadActiveLoopsSection();
  const pointerIndex = filterPointerIndex(rawPointerIndex, goal);
  const builtPrompt = buildQueryLoopSystemPrompt({ goal, pointerIndex, activeLoops });
  const systemPrompt = builtPrompt.text;
  emitPromptBudget(transparency, builtPrompt, 'query-loop');
  const loopMaxTokens = resolveLoopMaxTokens(goal);

  // Convenience closure so every call uses effectiveMaxIterations consistently
  const goalBlock = (iteration: number, files?: string[]) =>
    buildGoalBlock(goal, iteration, files, effectiveMaxIterations);

  // Fix 5/7: Detect continuation/modification request
  const isContinuationGoal = MODIFICATION_KEYWORDS.test(goal);
  const taskMode: 'edit' | 'create' = (isContinuationGoal && !!lastArtifactContext) ? 'edit' : 'create';

  // Inject conversation history — cap at 2 turns inside a running loop to save tokens.
  // The task state anchor (## Your current task state) replaces the need for deep history.
  const priorTurns = (history ?? [])
    .filter(m => m.role !== 'system')
    .map(message => (
      message.role === 'assistant'
        ? { ...message, content: stripThinkingTags(message.content).trim() }
        : message
    ))
    .slice(-2);

  // Fix 3/5: Build initial user message — in edit mode inject artifact context + skip-read instruction
  function buildInitialUserContent(): string {
    const initialGoalBlock = goalBlock(1, []);
    if (taskMode === 'edit' && lastArtifactContext) {
      return [
        '## LAST ARTIFACT CONTEXT',
        `FILES_WRITTEN: ${lastArtifactContext.path}`,
        `ARTIFACT_TYPE: ${lastArtifactContext.format}`,
        `ORIGINAL_DESCRIPTION: ${lastArtifactContext.description.slice(0, 400)}`,
        '',
        '## EDIT MODE INSTRUCTIONS',
        `The user wants to modify the file above. Do NOT call file_reader.`,
        `Use generate_and_save_file with path="${lastArtifactContext.path}" and an improved description`,
        `that incorporates the requested change: "${goal}"`,
        '',
        initialGoalBlock,
      ].join('\n');
    }
    return initialGoalBlock;
  }

  // Messages accumulate tool results across iterations
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    ...priorTurns,
    { role: 'user', content: buildInitialUserContent() },
  ];
  const baseMessageCount = messages.length;

  // Circuit breaker state: skillName:inputHash → consecutive failures
  const circuitFailures = new Map<string, number>();
  let consecutiveFailures = 0;
  const recentFailures: string[] = [];

  // Fix 3: Semantic failure signature tracking (last N=3 signatures)
  const recentSignatures: string[] = [];

  // Fix 7: Tool locking — if generate_and_save_file chosen first, lock it
  let lockedTool: string | null = null;
  const skillFailureCounts = new Map<string, number>(); // per-skill failure count

  // Fix 1: Per-iteration format repair counter (max 2 repairs before giving up)
  const formatRepairCounts = new Map<string, number>();

  const skillsUsed: string[] = [];
  const filesWritten: string[] = [];  // track files generated this session
  // Fix 3: Track last artifact generated this session
  let sessionArtifact: ArtifactContext | null = lastArtifactContext ?? null;
  let lastReply = '';

  transparency.emit({ type: 'query_loop_start', data: { goal } });

  for (let iteration = 1; iteration <= effectiveMaxIterations; iteration++) {
    // Collapse old history to keep context lean
    if (iteration > HISTORY_KEEP_PAIRS + 1) {
      collapseOldHistory(messages, baseMessageCount);
    }
    // Call the model — strip thinking BEFORE any parsing attempt.
    // Gemma 4 sometimes wraps tool calls inside <|channel>thought blocks;
    // parsing raw output would mistake those for completed tool executions.
    const raw = await llmHandler(messages, { maxTokens: loopMaxTokens ?? TOKEN_BUDGETS.QUERY_LOOP_ITER, disableThinking: true });
    const reply = stripThinkingTags(raw).trim();
    lastReply = reply;

    // Pure-thinking turn: model only thought, no actual output.
    // Treat as no_action rather than entering the repair/tool-call paths.
    if (!reply) {
      transparency.emit({ type: 'query_loop_end', data: { reason: 'no_action', iterations: iteration } });
      return {
        reply: 'Task complete.',
        iterations: iteration,
        skillsUsed,
        stoppedBecause: 'no_action',
        artifactContext: sessionArtifact ?? undefined,
      };
    }

    transparency.emit({ type: 'query_loop_iteration', data: { iteration, reply: reply.slice(0, 200) } });

    // Try to extract a tool call
    const toolCall = extractToolCall(reply);

    // Emit narration if model prefixed the JSON with prose
    if (toolCall) {
      const firstBrace = reply.indexOf('{');
      if (firstBrace > 0) {
        const narration = reply.slice(0, firstBrace).trim();
        if (narration) {
          transparency.emit({ type: 'query_loop_narration', data: { narration, iteration } });
        }
      }
    }

    if (!toolCall) {
      // Fix 1: Detect malformed tagged tool calls (e.g. <|tool_call>call:skill:{...})
      if (looksLikeMalformedTaggedToolCall(reply)) {
        const sig = replySignature(reply);
        const repairCount = (formatRepairCounts.get(sig) ?? 0) + 1;
        formatRepairCounts.set(sig, repairCount);
        if (repairCount <= 2) {
          transparency.emit({ type: 'query_loop_narration', data: { narration: `[format-repair ${repairCount}/2] malformed tagged tool call detected`, iteration } });
          messages.push({ role: 'assistant', content: reply });
          messages.push({
            role: 'user',
            content: [
              'INVALID TOOL CALL FORMAT. Your response used a tagged or wrapped format which is NOT supported.',
              'You MUST respond with ONLY a plain JSON object. No tags, no wrappers, no prefixes.',
              'Required format:',
              '  {"action":"<skill_name>","input":{<parameters>}}',
              '',
              'Example: {"action":"generate_and_save_file","input":{"path":"index.html","description":"..."}}',
              '',
              goalBlock(iteration + 1, filesWritten),
            ].join('\n'),
          });
          continue;
        }
        // Exceeded repair attempts — fall through to completion check
      }

      if (looksLikeIncompleteToolCall(reply)) {
        const sig = replySignature(reply);
        const repairCount = (formatRepairCounts.get(sig) ?? 0) + 1;
        formatRepairCounts.set(sig, repairCount);
        transparency.emit({ type: 'query_loop_narration', data: { narration: `[json-repair ${repairCount}/2] incomplete tool call detected`, iteration } });
        const escalation = repairCount >= 2
          ? 'You have repeated an incomplete JSON tool call. Do NOT truncate. Emit exactly one complete JSON object with all closing braces.'
          : 'Your previous response looked like an incomplete or truncated JSON tool call.';
        messages.push({ role: 'assistant', content: reply });
        messages.push({
          role: 'user',
          content: [
            escalation,
            'Resend exactly one complete JSON object only.',
            'Required format: {"action":"<skill_name>","input":{...}}',
            '',
            goalBlock(iteration + 1, filesWritten),
          ].join('\n'),
        });
        continue;
      }

      // Fix 6: Detect tool intent without valid JSON — repair instead of exiting
      if (looksLikeToolIntent(reply)) {
        const sig = replySignature(reply);
        const repairCount = (formatRepairCounts.get(sig) ?? 0) + 1;
        formatRepairCounts.set(sig, repairCount);
        if (repairCount <= 2) {
          transparency.emit({ type: 'query_loop_narration', data: { narration: `[intent-repair ${repairCount}/2] tool intent without valid JSON`, iteration } });
          messages.push({ role: 'assistant', content: reply });
          messages.push({
            role: 'user',
            content: [
              'It looks like you intended to use a tool but did not emit a valid JSON tool call.',
              'Respond with ONLY a valid JSON object to use a tool:',
              '  {"action":"<skill_name>","input":{<parameters>}}',
              'Do NOT include any text before or after the JSON.',
              '',
              goalBlock(iteration + 1, filesWritten),
            ].join('\n'),
          });
          continue;
        }
      }

      // No JSON action — model declared completion
      transparency.emit({ type: 'query_loop_end', data: { reason: 'no_action', iterations: iteration } });
      return {
        reply: reply || 'Task complete.',
        iterations: iteration,
        skillsUsed,
        stoppedBecause: 'no_action',
        artifactContext: sessionArtifact ?? undefined,
      };
    }

    // Fix 7: Enforce tool lock — if locked to generate_and_save_file, block content_writer for same goal
    if (lockedTool === 'generate_and_save_file' && toolCall.action === 'content_writer') {
      const lockMsg = 'Tool switch blocked: generate_and_save_file is locked for this task. Use generate_and_save_file instead of content_writer.';
      messages.push({ role: 'assistant', content: stripThinkingTags(reply).trim() });
      messages.push({
        role: 'user',
        content: [
          `TOOL LOCK [content_writer]: ${lockMsg}`,
          '',
          goalBlock(iteration + 1, filesWritten),
        ].join('\n'),
      });
      transparency.emit({ type: 'query_loop_skill_result', data: { skill: toolCall.action, success: false, error: lockMsg } });
      continue;
    }

    // Set tool lock on first use of generate_and_save_file
    if (!lockedTool && toolCall.action === 'generate_and_save_file') {
      lockedTool = 'generate_and_save_file';
    }

    // Check circuit breaker
    const ck = circuitKey(toolCall.action, toolCall.input);
    const ckFailures = circuitFailures.get(ck) ?? 0;
    if (ckFailures >= CIRCUIT_MAX_FAILURES) {
      const msg = `Circuit breaker tripped for ${toolCall.action} after ${ckFailures} consecutive identical failures.`;
      console.warn(`[query-loop] ${msg}`);
      transparency.emit({ type: 'query_loop_end', data: { reason: 'circuit_breaker', iterations: iteration } });
      return {
        reply: msg,
        iterations: iteration,
        skillsUsed,
        stoppedBecause: 'circuit_breaker',
        artifactContext: sessionArtifact ?? undefined,
      };
    }

    // FIX 3: Pre-dispatch validator for generate_and_save_file
    if (toolCall.action === 'generate_and_save_file') {
      const input = toolCall.input || {};
      const hasDescription = typeof input.description === 'string' && input.description.trim().length > 0;
      const hasSpecCode = typeof input.spec_code === 'string' && input.spec_code.trim().length > 0;

      // Check for contradictory payload
      if (hasDescription && hasSpecCode) {
        const errorMsg = 'generate_and_save_file received both "description" and "spec_code". ' +
          'Use one or the other. If you have a spec_code, do not include description. ' +
          'If you are writing inline, do not include spec_code.';
        messages.push({ role: 'assistant', content: stripThinkingTags(reply).trim() });
        messages.push({ role: 'user', content: `[TOOL ERROR] ${errorMsg}\n\n${goalBlock(iteration + 1, filesWritten)}` });
        continue;
      }

      // If spec_code present, verify it exists
      if (hasSpecCode) {
        const { getEntryByCode } = await import('./memory/index.js');
        const entry = getEntryByCode(input.spec_code as string);
        if (!entry) {
          const errorMsg = `spec_code "${input.spec_code}" does not exist in memory. ` +
            'You must first write the spec using memory_write, then pass the returned code as spec_code. ' +
            'Alternatively, use "description" with a detailed inline spec instead of spec_code.';
          messages.push({ role: 'assistant', content: stripThinkingTags(reply).trim() });
          messages.push({ role: 'user', content: `[TOOL ERROR] ${errorMsg}\n\n${goalBlock(iteration + 1, filesWritten)}` });
          continue;
        }
        if (entry.nb === 'PLAN' && entry.type === 'EX' && (entry.status === 'complete' || entry.status === 'failed')) {
          const errorMsg = getTerminalSpecCodeError(toolCall, entry.status)!;
          messages.push({ role: 'assistant', content: stripThinkingTags(reply).trim() });
          messages.push({ role: 'user', content: `[TOOL ERROR] ${errorMsg}\n\n${goalBlock(iteration + 1, filesWritten)}` });
          transparency.emit({ type: 'query_loop_skill_result', data: { skill: toolCall.action, success: false, error: errorMsg } });
          continue;
        }
      }
    }

    const inlineFileWriteError = getLargeInlineFileWriteError(toolCall);
    if (inlineFileWriteError) {
      circuitFailures.set(ck, ckFailures + 1);
      consecutiveFailures++;
      recentFailures.push(`${toolCall.action}: ${inlineFileWriteError}`);
      while (recentFailures.length > FAILURE_RESET_THRESHOLD) {
        recentFailures.shift();
      }
      if (consecutiveFailures >= FAILURE_RESET_THRESHOLD) {
        messages.splice(baseMessageCount);
        messages.push({ role: 'user', content: buildResetNote(goal, iteration + 1, recentFailures, filesWritten, effectiveMaxIterations) });
        consecutiveFailures = 0;
        recentFailures.length = 0;
        transparency.emit({ type: 'query_loop_skill_result', data: { skill: toolCall.action, success: false, error: inlineFileWriteError } });
        continue;
      }
      const prevInlineFailures = skillFailureCounts.get(toolCall.action) ?? 0;
      skillFailureCounts.set(toolCall.action, prevInlineFailures + 1);
      const inlineForceChange = (prevInlineFailures + 1) >= 2
        ? `\nSTRATEGY CHANGE REQUIRED: Use generate_and_save_file — do NOT embed large file contents in file_writer JSON.`
        : '';

      messages.push({ role: 'assistant', content: stripThinkingTags(reply).trim() });
      messages.push({
        role: 'user',
        content: [
          `SKILL ERROR [${toolCall.action}]: ${inlineFileWriteError}`,
          `Your previous execution failed: ${inlineFileWriteError}. Please try again.`,
          inlineForceChange,
          '',
          goalBlock(iteration + 1, filesWritten),
        ].join('\n'),
      });
      transparency.emit({ type: 'query_loop_skill_result', data: { skill: toolCall.action, success: false, error: inlineFileWriteError } });
      continue;
    }

    const repeatedGeneratedFileError = getRepeatedGeneratedFileError(toolCall, filesWritten);
    if (repeatedGeneratedFileError) {
      circuitFailures.set(ck, ckFailures + 1);
      consecutiveFailures++;
      recentFailures.push(`${toolCall.action}: ${repeatedGeneratedFileError}`);
      while (recentFailures.length > FAILURE_RESET_THRESHOLD) {
        recentFailures.shift();
      }

      const prevFailures = skillFailureCounts.get(toolCall.action) ?? 0;
      skillFailureCounts.set(toolCall.action, prevFailures + 1);

      messages.push({ role: 'assistant', content: stripThinkingTags(reply).trim() });
      messages.push({
        role: 'user',
        content: [
          `SKILL ERROR [${toolCall.action}]: ${repeatedGeneratedFileError}`,
          'STRATEGY CHANGE REQUIRED: either finish with a plain-text summary or use patch_file for modifications.',
          '',
          goalBlock(iteration + 1, filesWritten),
        ].join('\n'),
      });
      transparency.emit({ type: 'query_loop_skill_result', data: { skill: toolCall.action, success: false, error: repeatedGeneratedFileError } });
      continue;
    }

    // Execute the skill
    transparency.emit({ type: 'query_loop_skill_call', data: { skill: toolCall.action, input: toolCall.input } });

    const result = await runWithRetry(toolCall.action, toolCall.input, llmHandler);

    if (!skillsUsed.includes(toolCall.action)) {
      skillsUsed.push(toolCall.action);
    }

    if (result.success) {
      // Reset circuit failures for this key on success
      circuitFailures.delete(ck);
      consecutiveFailures = 0;
      recentFailures.length = 0;

      // Track files written so they appear in the goal block
      if (toolCall.action === 'file_writer' || toolCall.action === 'generate_and_save_file') {
        const path = typeof toolCall.input.path === 'string' ? toolCall.input.path
          : typeof toolCall.input.filename === 'string' ? toolCall.input.filename
          : null;
        if (path && !filesWritten.includes(path)) {
          filesWritten.push(path);
        }
      }

      transparency.emit({ type: 'query_loop_skill_result', data: { skill: toolCall.action, success: true } });

      // FIX 4: Post-write verification for file generation
      if (toolCall.action === 'generate_and_save_file') {
        const filePath = typeof toolCall.input.path === 'string' ? toolCall.input.path : '';
        if (filePath) {
          try {
            const { runSkill } = await import('./skills/runner.js');
            const verifyResult = await runSkill('verify_state', {
              operation: 'file_write',
              target: filePath,
            });

            if (!verifyResult.success) {
              const warnMsg = `[VERIFICATION WARNING] generate_and_save_file reported success ` +
                `but verify_state could not confirm file at "${filePath}". ` +
                `The file may not have been written correctly. Try again.`;
              messages.push({ role: 'user', content: warnMsg });
              continue;
            }
          } catch (e) {
            // verify_state failure should not break the loop — log and continue
            console.warn('[QueryLoop] verify_state call failed:', (e as Error).message);
          }
        }
      }

      // Fix 3: Capture artifact context after generate_and_save_file succeeds
      if (toolCall.action === 'generate_and_save_file') {
        const artifactPath = typeof toolCall.input.path === 'string' ? toolCall.input.path : '';
        const artifactDesc = typeof toolCall.input.description === 'string' ? toolCall.input.description : '';
        const artifactFormat = typeof toolCall.input.format === 'string' ? toolCall.input.format : 'html';
        if (artifactPath) {
          sessionArtifact = { path: artifactPath, description: artifactDesc, format: artifactFormat };
        }
      }

      // Append: model's action turn + tool result + next goal reminder
      messages.push({ role: 'assistant', content: stripThinkingTags(reply).trim() });

      // Fix 3: Inject artifact context + suppress self-read after generation
      let postGenHint = '';
      if (toolCall.action === 'generate_and_save_file' && sessionArtifact) {
        postGenHint = [
          '',
          'LAST_ARTIFACT_CONTEXT:',
          `  FILES_WRITTEN: ${sessionArtifact.path}`,
          `  ARTIFACT_TYPE: ${sessionArtifact.format}`,
          `  DESCRIPTION_SUMMARY: ${sessionArtifact.description.slice(0, 200)}`,
          'Hint: Do not re-read files you just generated. Proceed to the next step or complete the task.',
        ].join('\n');
      }

      messages.push({
        role: 'user',
        content: [
          `SKILL RESULT [${toolCall.action}]:`,
          String(result.output ?? '(no output)'),
          postGenHint,
          '',
          goalBlock(iteration + 1, filesWritten),
        ].join('\n'),
      });
    } else {
      const errMsg = result.error ?? 'Unknown error';

      // Fix 3: Track semantic failure signature
      const sig = failureSignature(toolCall.action, toolCall.input, errMsg);
      recentSignatures.push(sig);
      while (recentSignatures.length > CIRCUIT_MAX_FAILURES) {
        recentSignatures.shift();
      }
      const semanticTripCount = recentSignatures.filter(s => s === sig).length;

      // Fix 4: Per-skill failure count
      const prevSkillFailures = skillFailureCounts.get(toolCall.action) ?? 0;
      skillFailureCounts.set(toolCall.action, prevSkillFailures + 1);

      // Increment circuit failures on error
      circuitFailures.set(ck, ckFailures + 1);
      consecutiveFailures++;
      recentFailures.push(`${toolCall.action}: ${errMsg}`);
      while (recentFailures.length > FAILURE_RESET_THRESHOLD) {
        recentFailures.shift();
      }

      transparency.emit({ type: 'query_loop_skill_result', data: { skill: toolCall.action, success: false, error: `${errMsg} [sig:${sig}]` } });

      // Fix 3: Semantic circuit breaker — 3 repeated signatures
      if (semanticTripCount >= CIRCUIT_MAX_FAILURES) {
        const msg = `Semantic circuit breaker tripped for ${toolCall.action}: ${CIRCUIT_MAX_FAILURES} failures with same error pattern (${errorType(errMsg)}).`;
        console.warn(`[query-loop] ${msg}`);
        transparency.emit({ type: 'query_loop_end', data: { reason: 'circuit_breaker', iterations: iteration } });
        return {
          reply: msg,
          iterations: iteration,
          skillsUsed,
          stoppedBecause: 'circuit_breaker',
          artifactContext: sessionArtifact ?? undefined,
        };
      }

      if (consecutiveFailures >= FAILURE_RESET_THRESHOLD) {
        messages.splice(baseMessageCount);
        messages.push({ role: 'user', content: buildResetNote(goal, iteration + 1, recentFailures, filesWritten, effectiveMaxIterations) });
        consecutiveFailures = 0;
        recentFailures.length = 0;
        continue;
      }

      // Fix 4: Structured failure feedback — force strategy change if same skill failed 2+ times
      const currentSkillFailures = skillFailureCounts.get(toolCall.action) ?? 0;
      const structuredFeedback = JSON.stringify({
        previous_error: errMsg,
        failed_skill: toolCall.action,
        reason: errorType(errMsg),
        skill_failure_count: currentSkillFailures,
      });
      const forceChange = currentSkillFailures >= 2
        ? `\nSTRATEGY CHANGE REQUIRED: ${toolCall.action} has failed ${currentSkillFailures} times. You MUST try a different skill or a different approach.`
        : '';

      const altHint = /permission|denied|not allowed|forbidden/i.test(errMsg)
        ? 'Hint: If you need to verify a file exists, use file_reader instead of run_bash.'
        : /not found|no such file/i.test(errMsg)
        ? 'Hint: The file may not exist yet. Check FILES WRITTEN SO FAR before reading.'
        : 'Hint: Try a different skill or a different approach to achieve the same outcome.';

      messages.push({ role: 'assistant', content: stripThinkingTags(reply).trim() });
      messages.push({
        role: 'user',
        content: [
          `SKILL ERROR [${toolCall.action}]: ${errMsg}`,
          `Failure context: ${structuredFeedback}`,
          altHint,
          forceChange,
          '',
          goalBlock(iteration + 1, filesWritten),
        ].join('\n'),
      });
    }
  }

  // Exhausted max iterations
  transparency.emit({ type: 'query_loop_end', data: { reason: 'max_iterations', iterations: effectiveMaxIterations } });
  return {
    reply: lastReply || `Stopped after ${effectiveMaxIterations} iterations without completing the goal.`,
    iterations: effectiveMaxIterations,
    skillsUsed,
    stoppedBecause: 'max_iterations',
    artifactContext: sessionArtifact ?? undefined,
  };
}
