import type { LLMHandler, Message } from './types.js';
import type { SkillResult } from './skills/types.js';
import { runSkill } from './skills/runner.js';

/**
 * Repair prompt builder: asks the LLM to fix a failed skill input.
 */
function buildRepairMessages(
  skillName: string,
  input: Record<string, unknown>,
  error: string,
): Message[] {
  return [
    {
      role: 'system',
      content: `You are a JSON repair assistant. A skill call failed. Return ONLY a corrected JSON object for the skill input — no explanation, no markdown fences.`,
    },
    {
      role: 'user',
      content: `Skill: ${skillName}\nOriginal input: ${JSON.stringify(input)}\nError: ${error}\n\nReturn corrected JSON input:`,
    },
  ];
}

/**
 * Ask the LLM to repair a failed skill input.
 * Never throws — returns original input on any failure.
 */
export async function repairSkillInput(
  skillName: string,
  input: Record<string, unknown>,
  error: string,
  handler: LLMHandler,
): Promise<Record<string, unknown>> {
  try {
    const messages = buildRepairMessages(skillName, input, error);
    const response = await handler(messages, { maxTokens: 200 });
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return input;
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    return parsed;
  } catch {
    return input;
  }
}

/**
 * Run a skill with automatic retry + LLM-based input repair.
 * Returns the final SkillResult plus the number of retries attempted.
 */
export async function runWithRetry(
  skillName: string,
  input: Record<string, unknown>,
  handler: LLMHandler,
  maxRetries: number = 3,
): Promise<SkillResult & { retries: number }> {
  let currentInput = input;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await runSkill(skillName, currentInput);

    if (result.success) {
      return { ...result, retries: attempt };
    }

    // Final attempt failed — return as-is
    if (attempt === maxRetries) {
      return { ...result, retries: attempt };
    }

    // Ask LLM to repair input for next attempt
    currentInput = await repairSkillInput(
      skillName,
      currentInput,
      result.error ?? 'Unknown error',
      handler,
    );
  }

  // Unreachable, but TypeScript needs it
  return { success: false, output: '', error: 'Max retries exceeded', retries: maxRetries };
}
