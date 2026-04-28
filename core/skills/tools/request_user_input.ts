/**
 * request_user_input skill
 *
 * When the agent needs a clarification or decision from the user before
 * proceeding, this skill pauses execution and queues a question.
 *
 * On the next processMessage call, the pending question is detected and
 * the user's reply is returned as the answer (user_input_received event).
 *
 * Supports an optional `options` array for multiple-choice decisions,
 * which the UI can render as buttons instead of free text.
 */

import type { MCPSkill, SkillResult } from '../types.js';
import { savePendingUserInput } from '../../memory/index.js';
import { transparency } from '../../transparency.js';

export const requestUserInputSkill: MCPSkill = {
  name: 'request_user_input',
  description: 'Pause execution and ask the user a clarifying question. Pass options[] for multiple-choice decisions. The answer will be available at the start of the next message.',
  permissionLevel: 'read-only',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user' },
      context: { type: 'string', description: 'Optional context about why this input is needed' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of choices (e.g. ["Yes", "No", "Skip"]). Renders as buttons in the UI; user can still type a free-form answer.',
      },
    },
    required: ['question'],
  },
  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const question = String(input.question ?? '').trim();
    const context = input.context ? String(input.context).trim() : undefined;
    const options = Array.isArray(input.options)
      ? (input.options as unknown[]).map(o => String(o)).filter(o => o.trim())
      : [];

    if (!question) {
      return { success: false, output: '', error: 'question is required' };
    }

    // Encode options into context so savePendingUserInput doesn't need a schema change
    const contextWithOptions = options.length > 0
      ? `${context ? context + '\n' : ''}Options: ${options.map((o, i) => `[${i + 1}] ${o}`).join(' | ')}`
      : context;

    savePendingUserInput(question, contextWithOptions);
    transparency.emit({ type: 'user_input_requested', data: { question, context, options } });

    const optionsNote = options.length > 0 ? `\nChoices: ${options.join(' / ')}` : '';
    const contextNote = context ? `\nContext: ${context}` : '';
    return {
      success: true,
      output: `Paused: awaiting user input — ${question}${contextNote}${optionsNote}`,
    };
  },
};
