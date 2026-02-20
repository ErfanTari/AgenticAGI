import { LLM_CONFIG, LLM_FALLBACK_CONFIG } from '../config/agent.config.js';
import type { Message } from './types.js';

/**
 * Call the primary LLM (Mac Studio / OpenAI-compatible endpoint).
 * Timeout is tiered by model size (70B+=90s, 7B-14B=20s, 1B-4B=10s, default=20s).
 * On timeout, logs a warning with model name so caller knows what happened.
 */
async function callPrimary(messages: Message[]): Promise<string> {
  const controller = new AbortController();
  const timeoutMs = LLM_CONFIG.timeoutMs;
  const timer = setTimeout(() => {
    console.warn(
      '[llm] Still thinking — %s is processing a complex query. Timeout after %ds.',
      LLM_CONFIG.model,
      timeoutMs / 1000,
    );
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(LLM_CONFIG.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_CONFIG.model,
        messages,
        max_tokens: LLM_CONFIG.maxTokens,
        temperature: LLM_CONFIG.temperature,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Primary LLM: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    return data.choices[0].message.content;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call the Anthropic Messages API as fallback.
 * Extracts system messages into the top-level `system` parameter.
 */
async function callAnthropic(messages: Message[]): Promise<string> {
  if (!LLM_FALLBACK_CONFIG || !LLM_FALLBACK_CONFIG.apiKey) {
    throw new Error('Anthropic fallback not configured (missing API key)');
  }

  const systemParts = messages.filter(m => m.role === 'system').map(m => m.content);
  const nonSystem = messages.filter(m => m.role !== 'system');

  const response = await fetch(LLM_FALLBACK_CONFIG.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': LLM_FALLBACK_CONFIG.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: LLM_FALLBACK_CONFIG.model,
      system: systemParts.join('\n'),
      messages: nonSystem,
      max_tokens: LLM_CONFIG.maxTokens,
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic fallback: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as {
    content: Array<{ type: string; text: string }>;
  };

  return data.content[0].text;
}

/**
 * Call LLM with automatic fallback.
 *
 * Flow:
 * 1. Try primary (Mac Studio) with tiered timeout based on model size
 * 2. If unreachable or times out → fall back to Anthropic API
 * 3. Log which provider handled the request + response time
 * 4. Never crash — callers catch the final throw
 */
export async function callLLM(messages: Message[]): Promise<string> {
  // Try primary
  if (LLM_CONFIG.endpoint) {
    const start = performance.now();
    try {
      const result = await callPrimary(messages);
      const elapsed = Math.round(performance.now() - start);
      console.log('[llm] Provider: primary (%s) — %dms', LLM_CONFIG.model, elapsed);
      return result;
    } catch (err) {
      const elapsed = Math.round(performance.now() - start);
      console.warn('[llm] Primary failed after %dms: %s — trying fallback', elapsed, String(err));
    }
  }

  // Try fallback
  if (LLM_FALLBACK_CONFIG) {
    const start = performance.now();
    try {
      const result = await callAnthropic(messages);
      const elapsed = Math.round(performance.now() - start);
      console.log('[llm] Provider: fallback (%s/%s) — %dms', LLM_FALLBACK_CONFIG.provider, LLM_FALLBACK_CONFIG.model, elapsed);
      return result;
    } catch (err) {
      const elapsed = Math.round(performance.now() - start);
      console.warn('[llm] Fallback failed after %dms: %s', elapsed, String(err));
    }
  }

  throw new Error('All LLM providers unreachable');
}
