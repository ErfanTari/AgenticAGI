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
import { loadPointerIndex } from './memory/pointer-index.js';
import { getSkillDescriptions } from './skills/registry.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 20;
const CIRCUIT_MAX_FAILURES = 3;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QueryLoopResult {
  reply: string;
  iterations: number;
  skillsUsed: string[];
  stoppedBecause: 'goal_complete' | 'circuit_breaker' | 'max_iterations' | 'no_action';
}

interface ToolCall {
  action: string;
  input: Record<string, unknown>;
  /** Optional human-readable reasoning the model produced before the JSON */
  thought?: string;
}

// ─── JSON Extraction ──────────────────────────────────────────────────────────

/**
 * Extracts the first JSON object that has an "action" key from model output.
 * Returns null if no such object is found.
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
          if (typeof parsed.action === 'string') {
            const input = (parsed.input && typeof parsed.input === 'object' && !Array.isArray(parsed.input))
              ? parsed.input as Record<string, unknown>
              : {};
            const thought = typeof parsed.thought === 'string' ? parsed.thought : undefined;
            return { action: parsed.action, input, thought };
          }
        } catch { /* not valid JSON — continue scanning */ }
        start = -1;
      }
    }
  }
  return null;
}

// ─── Input Fingerprinting ─────────────────────────────────────────────────────

function inputHash(input: Record<string, unknown>): string {
  return createHash('sha1').update(JSON.stringify(input)).digest('hex').slice(0, 8);
}

function circuitKey(skillName: string, input: Record<string, unknown>): string {
  return `${skillName}:${inputHash(input)}`;
}

// ─── Goal Block ───────────────────────────────────────────────────────────────

function buildGoalBlock(goal: string, iteration: number): string {
  return [
    `GOAL: ${goal}`,
    `COMPLETION CONDITION: When the goal is fully addressed, respond with a plain-text summary and NO JSON action block.`,
    `ITERATION: ${iteration} / ${MAX_ITERATIONS}`,
  ].join('\n');
}

// ─── System Prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(goal: string, pointerIndex: string): string {
  const skillList = getSkillDescriptions(); // already a formatted string

  const indexSection = pointerIndex.trim()
    ? `\n\n## Known Entries (MEMORY.md)\n${pointerIndex.trim()}`
    : '';

  return [
    'You are an autonomous AI agent with memory and skills.',
    '',
    '## How to act',
    'Each turn, decide whether to use a skill or complete the task.',
    'To use a skill, respond with ONLY a JSON object (no other text):',
    '  {"action": "<skill_name>", "input": {<parameters>}}',
    'To complete the task, respond with a plain-text answer and NO JSON.',
    '',
    '## Available skills',
    skillList,
    '',
    '## Current goal',
    goal,
    indexSection,
  ].join('\n');
}

// ─── Main Loop ─────────────────────────────────────────────────────────────────

/**
 * Run the QueryLoop for a LOW/MEDIUM complexity goal.
 * Each iteration the model chooses the next skill to call or declares completion.
 */
export async function runQueryLoop(
  goal: string,
  llmHandler: LLMHandler,
  _workingMemory?: WorkingMemory,
): Promise<QueryLoopResult> {
  const pointerIndex = loadPointerIndex();
  const systemPrompt = buildSystemPrompt(goal, pointerIndex);

  // Messages accumulate tool results across iterations
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: buildGoalBlock(goal, 1) },
  ];

  // Circuit breaker state: skillName:inputHash → consecutive failures
  const circuitFailures = new Map<string, number>();

  const skillsUsed: string[] = [];
  let lastReply = '';

  transparency.emit({ type: 'query_loop_start', data: { goal } });

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    // Call the model
    const raw = await llmHandler(messages, { maxTokens: 512 });
    const reply = stripThinkingTags(raw).trim();
    lastReply = reply;

    transparency.emit({ type: 'query_loop_iteration', data: { iteration, reply: reply.slice(0, 200) } });

    // Try to extract a tool call
    const toolCall = extractToolCall(reply);

    if (!toolCall) {
      // No JSON action — model declared completion
      transparency.emit({ type: 'query_loop_end', data: { reason: 'no_action', iterations: iteration } });
      return {
        reply: reply || 'Task complete.',
        iterations: iteration,
        skillsUsed,
        stoppedBecause: 'no_action',
      };
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
      };
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

      transparency.emit({ type: 'query_loop_skill_result', data: { skill: toolCall.action, success: true } });

      // Append: model's action turn + tool result + next goal reminder
      messages.push({ role: 'assistant', content: reply });
      messages.push({
        role: 'user',
        content: [
          `SKILL RESULT [${toolCall.action}]:`,
          String(result.output ?? '(no output)'),
          '',
          buildGoalBlock(goal, iteration + 1),
        ].join('\n'),
      });
    } else {
      // Increment circuit failures on error
      circuitFailures.set(ck, ckFailures + 1);

      transparency.emit({ type: 'query_loop_skill_result', data: { skill: toolCall.action, success: false, error: result.error } });

      messages.push({ role: 'assistant', content: reply });
      messages.push({
        role: 'user',
        content: [
          `SKILL ERROR [${toolCall.action}]: ${result.error ?? 'Unknown error'}`,
          '',
          buildGoalBlock(goal, iteration + 1),
        ].join('\n'),
      });
    }
  }

  // Exhausted max iterations
  transparency.emit({ type: 'query_loop_end', data: { reason: 'max_iterations', iterations: MAX_ITERATIONS } });
  return {
    reply: lastReply || `Stopped after ${MAX_ITERATIONS} iterations without completing the goal.`,
    iterations: MAX_ITERATIONS,
    skillsUsed,
    stoppedBecause: 'max_iterations',
  };
}
