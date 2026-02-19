import { LLM_CONFIG } from '../config/agent.config.js';
import type { Message } from './types.js';

export async function callLLM(messages: Message[]): Promise<string> {
  const response = await fetch(`${LLM_CONFIG.endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LLM_CONFIG.model,
      messages,
      max_tokens: LLM_CONFIG.maxTokens,
      temperature: LLM_CONFIG.temperature,
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };

  return data.choices[0].message.content;
}
