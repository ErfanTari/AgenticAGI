import type { Message, LLMHandler, AgentResponse } from './types.js';
import { classifyIntent } from './intent.js';
import { resolveQuery } from './resolver.js';
import { buildContext } from './context.js';
import { callLLM } from './llm.js';
import { getSkillsForIntent } from './skills/registry.js';

export async function processMessage(
  message: string,
  history: Message[],
  options?: { llmHandler?: LLMHandler },
): Promise<AgentResponse> {
  // 1. Classify intent
  const classification = classifyIntent(message);

  // 2. Greeting — no memory, no LLM
  if (classification.intent === 'greeting') {
    return { reply: 'Hello! How can I help you today?', intent: 'greeting', resolved: null };
  }

  // 3. Resolve memory (5-step query flow)
  const resolved = resolveQuery(classification);

  // 4. Load relevant skills
  const skills = getSkillsForIntent(classification.intent);

  // 5. Build lean context
  const messages = buildContext(message, resolved, history, skills);

  // 6. Call LLM
  const handler = options?.llmHandler ?? callLLM;
  const reply = await handler(messages);

  return { reply, intent: classification.intent, resolved };
}
