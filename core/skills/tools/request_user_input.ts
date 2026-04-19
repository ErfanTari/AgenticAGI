/**
 * request_user_input skill
 *
 * When the agent needs a clarification or decision from the user before
 * proceeding, this skill pauses execution and queues a question.
 *
 * On the next processMessage call, the pending question is detected and
 * the user's reply is returned as the answer (user_input_received event).
 */

import type { MCPSkill, SkillResult } from '../types.js';
import { savePendingUserInput } from '../../memory/index.js';
import { transparency } from '../../transparency.js';

export const requestUserInputSkill: MCPSkill = {
  name: 'request_user_input',
  description: 'Pause execution and ask the user a clarifying question. The answer will be available at the start of the next message.',
  permissionLevel: 'read-only',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user' },
      context: { type: 'string', description: 'Optional context about why this input is needed' },
    },
    required: ['question'],
  },
  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const question = String(input.question ?? '').trim();
    const context = input.context ? String(input.context).trim() : undefined;

    if (!question) {
      return { success: false, output: '', error: 'question is required' };
    }

    savePendingUserInput(question, context);
    transparency.emit({ type: 'user_input_requested', data: { question, context } });

    const contextNote = context ? `\nContext: ${context}` : '';
    return {
      success: true,
      output: `Paused: awaiting user input — ${question}${contextNote}`,
    };
  },
};
