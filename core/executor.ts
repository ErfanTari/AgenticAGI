import type { LLMHandler, Message } from './types.js';
import type { TaskPlan, VerificationResult } from './schemas.js';
import { VerificationResultSchema, verificationJsonSchema } from './schemas.js';
import { runWithRetry } from './react.js';
import { resolveTemplates } from './planner.js';

// Flatten nested objects to primitives (fixes [object Object] issue)
function flattenInput(input: Record<string, unknown>): Record<string, unknown> {
  const flattened: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(input)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      // Nested object — single key: extract key as the value; multiple keys: stringify to preserve all data
      const nested = val as Record<string, unknown>;
      const nestedKeys = Object.keys(nested);
      flattened[key] = nestedKeys.length === 1 ? nestedKeys[0] : JSON.stringify(val);
    } else {
      flattened[key] = val;
    }
  }

  return flattened;
}

// --- Executor interfaces (Priority 4) ---

export interface CompletedStep {
  stepId: string;
  skill: string;
  output: string;
  display?: string;
  retries: number;
}

export interface FailedStep {
  stepId: string;
  skill: string;
  error: string;
  optional: boolean;
}

export interface ExecutionResult {
  success: boolean;
  completed: CompletedStep[];
  failed: FailedStep[];
  abortReason?: string;
}

// --- Executor Loop (Priority 4) ---

const TOTAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const STEP_DELAY_MS = 100;

export async function executePlan(
  plan: TaskPlan,
  llmHandler: LLMHandler,
): Promise<ExecutionResult> {
  const results = new Map<string, string>();
  const completed: CompletedStep[] = [];
  const failed: FailedStep[] = [];
  const startTime = Date.now();

  for (const step of plan.steps) {
    // Timeout check
    if (Date.now() - startTime > TOTAL_TIMEOUT_MS) {
      return {
        success: false,
        completed,
        failed,
        abortReason: 'Total execution timeout (5 minutes)',
      };
    }

    // Dependency check
    const unmetDeps = step.dependsOn.filter(dep => !results.has(dep + '_result') && !results.has(dep));
    if (unmetDeps.length > 0) {
      // Check if any unmet dep is in failed (non-optional)
      const depFailed = unmetDeps.some(dep =>
        failed.some(f => f.stepId === dep && !f.optional),
      );
      if (depFailed) {
        return {
          success: false,
          completed,
          failed,
          abortReason: `Dependency '${unmetDeps[0]}' failed`,
        };
      }
    }

    // Resolve templates in input
    let resolvedInput = resolveTemplates(step.input, results);

    // Flatten nested objects (fixes [object Object] serialization)
    resolvedInput = flattenInput(resolvedInput);

    // Guardrail: unresolved templates should fail fast instead of silently writing placeholders.
    const unresolvedTokens: string[] = [];
    for (const value of Object.values(resolvedInput)) {
      if (typeof value !== 'string') continue;
      const matches = value.match(/\{\{\w+\}\}/g);
      if (matches) unresolvedTokens.push(...matches);
    }
    if (unresolvedTokens.length > 0) {
      const unique = [...new Set(unresolvedTokens)];

      // Check if the unresolved tokens correspond to optional failed dependencies.
      // Match by storeResultAs key OR by stepId (with or without _result suffix).
      const optionalStoreResultAsKeys = new Set(
        failed.filter(f => f.optional).map(f => f.stepId),
      );
      // Also collect storeResultAs values from optional failed steps by scanning plan steps
      const optionalResultKeys = new Set<string>();
      for (const ps of plan.steps) {
        if (ps.optional && failed.some(f => f.stepId === ps.id) && ps.storeResultAs) {
          optionalResultKeys.add(ps.storeResultAs);
          optionalResultKeys.add(`${ps.storeResultAs}_result`);
        }
      }

      const unmetOptionalDeps = unique.every(token => {
        const key = token.replace(/^\{\{/, '').replace(/\}\}$/, '');
        const depId = key.replace(/_result$/, '');
        return (
          optionalStoreResultAsKeys.has(depId) ||
          optionalResultKeys.has(key) ||
          optionalResultKeys.has(depId) ||
          failed.some(f => f.stepId === depId && f.optional)
        );
      });

      if (unmetOptionalDeps) {
        // All unresolved templates come from optional failed steps.
        // Replace them with empty string so downstream content doesn't contain placeholder text.
        for (const key of Object.keys(resolvedInput)) {
          if (typeof resolvedInput[key] === 'string') {
            resolvedInput[key] = (resolvedInput[key] as string).replace(/\{\{\w+\}\}/g, '');
          }
        }
        // Fall through — step runs with empty string for missing optional results
      } else {

      failed.push({
        stepId: step.id,
        skill: step.skill,
        error: `Unresolved template values: ${unique.join(', ')}`,
        optional: step.optional ?? false,
      });

      if (!step.optional) {
        return {
          success: false,
          completed,
          failed,
          abortReason: `Required step '${step.id}' has unresolved templates`,
        };
      }
      continue;
      } // end else (unmetOptionalDeps)
    }

    // DEBUG_DEEP: log each step's resolved input before execution
    if (process.env.DEBUG_DEEP === 'true') {
      const inputPreview = JSON.stringify(resolvedInput).slice(0, 400);
      console.log(`[executor:DEEP] step=${step.id} skill=${step.skill} input=${inputPreview}`);
    }

    // Execute via runWithRetry
    const skillResult = await runWithRetry(step.skill, resolvedInput, llmHandler);

    if (skillResult.success) {
      completed.push({
        stepId: step.id,
        skill: step.skill,
        output: skillResult.output,
        display: skillResult.display,
        retries: skillResult.retries ?? 0,
      });
      // Store result for dependent steps
      if (step.storeResultAs) {
        results.set(step.storeResultAs, skillResult.output);
        if (step.storeResultAs.endsWith('_result')) {
          results.set(step.storeResultAs.replace(/_result$/, ''), skillResult.output);
        } else {
          results.set(`${step.storeResultAs}_result`, skillResult.output);
        }
      }
      // Also store by step ID for dependency resolution
      results.set(step.id + '_result', skillResult.output);
      results.set(step.id, skillResult.output);
    } else {
      failed.push({
        stepId: step.id,
        skill: step.skill,
        error: skillResult.error ?? 'Unknown error',
        optional: step.optional ?? false,
      });

      // Optional step failure → continue; required → stop
      if (!step.optional) {
        return {
          success: false,
          completed,
          failed,
          abortReason: `Required step '${step.id}' failed: ${skillResult.error}`,
        };
      }
    }

    // Brief delay between steps
    if (STEP_DELAY_MS > 0) {
      await new Promise(resolve => setTimeout(resolve, STEP_DELAY_MS));
    }
  }

  return {
    success: failed.length === 0,
    completed,
    failed,
  };
}

// --- Execution Verification (Priority 5) ---

export async function verifyExecution(
  plan: TaskPlan,
  result: ExecutionResult,
  llmHandler: LLMHandler,
): Promise<VerificationResult> {
  try {
    const completedSummary = result.completed
      .map(s => `- [DONE] ${s.stepId} (${s.skill}): ${s.output.slice(0, 200)}`)
      .join('\n');

    const failedSummary = result.failed
      .map(s => `- [FAILED] ${s.stepId} (${s.skill}): ${s.error}`)
      .join('\n');

    const prompt: Message[] = [
      {
        role: 'system',
        content: `You are a task verification assistant. Given a plan and its execution results, assess whether the goal was achieved.
Return ONLY a JSON object: {"verified": true/false, "confidence": 0.0-1.0, "issues": ["issue1"], "suggestion": "optional fix"}`,
      },
      {
        role: 'user',
        content: `Goal: ${plan.goal}
Plan had ${plan.steps.length} steps.

Completed steps:
${completedSummary || '(none)'}

Failed steps:
${failedSummary || '(none)'}

Was the goal achieved?`,
      },
    ];

    const response = await llmHandler(prompt, {
      responseSchema: verificationJsonSchema,
      maxTokens: 300,
    });

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { verified: result.success, confidence: result.success ? 0.7 : 0.3, issues: [], suggestion: undefined };
    }

    const raw = JSON.parse(jsonMatch[0]);
    const parsed = VerificationResultSchema.safeParse(raw);
    if (parsed.success) return parsed.data;

    return { verified: result.success, confidence: result.success ? 0.7 : 0.3, issues: [], suggestion: undefined };
  } catch {
    // Verification is advisory — never block
    return { verified: result.success, confidence: 0.5, issues: ['Verification failed'], suggestion: undefined };
  }
}

// --- User Report (Priority 6) ---

export function buildUserReport(
  plan: TaskPlan,
  result: ExecutionResult,
  verification: VerificationResult,
): string {
  const lines: string[] = [];

  // Header
  lines.push(`## ${verification.verified ? 'Done' : 'Warning'}: ${plan.goal}`);
  lines.push('');

  // Completed steps
  if (result.completed.length > 0) {
    lines.push('**Completed:**');
    for (const step of result.completed) {
      const label = step.display ?? step.output;
      const output = label.length > 150 ? label.slice(0, 150) + '...' : label;
      lines.push(`- [Done] ${step.skill}: ${output}`);
    }
    lines.push('');
  }

  // Failed steps
  if (result.failed.length > 0) {
    lines.push('**Issues:**');
    for (const step of result.failed) {
      const prefix = step.optional ? '[Skipped]' : '[Failed]';
      lines.push(`- ${prefix} ${step.skill}: ${step.error}`);
    }
    lines.push('');
  }

  // Abort reason
  if (result.abortReason) {
    lines.push(`**Stopped:** ${result.abortReason}`);
    lines.push('');
  }

  // Verification
  if (verification.suggestion) {
    lines.push(`**Suggestion:** ${verification.suggestion}`);
    lines.push('');
  }

  // Memory codes created
  const memoryCodes = result.completed
    .filter(s => s.skill === 'memory_write' || s.output.match(/[A-Z]+\.[A-Z]+-\d{6,}/))
    .map(s => {
      const codeMatch = s.output.match(/([A-Z]+\.[A-Z]+-\d{6,})/);
      return codeMatch ? codeMatch[1] : null;
    })
    .filter(Boolean);

  if (memoryCodes.length > 0) {
    lines.push(`**Memory:** ${memoryCodes.join(', ')}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}
