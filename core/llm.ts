import { GEMINI_CONFIG, LOCAL_LLM_CONFIG, LLM_FALLBACK_CONFIG } from '../config/agent.config.js';
import type { Message } from './types.js';

interface GeminiPart {
  text?: string;
}

interface GeminiContent {
  parts?: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{
    content?: GeminiContent;
  }>;
}

interface OpenAICompatibleResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

export interface LLMCallOptions {
  schema?: Record<string, unknown>;
  timeout?: number;
  maxTokens?: number;
  temperature?: number;
}

function toGeminiPayload(messages: Message[]): {
  systemInstruction?: { parts: Array<{ text: string }> };
  contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>;
} {
  const systemText = messages
    .filter(message => message.role === 'system')
    .map(message => message.content)
    .join('\n\n')
    .trim();

  const contents = messages
    .filter(message => message.role !== 'system')
    .map(message => ({
      role: message.role === 'assistant' ? 'model' as const : 'user' as const,
      parts: [{ text: message.content }],
    }));

  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: '' }] });
  }

  return {
    systemInstruction: systemText
      ? { parts: [{ text: systemText }] }
      : undefined,
    contents,
  };
}

/**
 * Call Google Gemini via the Generative Language API.
 */
async function callGemini(messages: Message[], options?: LLMCallOptions): Promise<string> {
  if (!GEMINI_CONFIG.apiKey) {
    throw new Error('Gemini not configured (missing GEMINI_API_KEY)');
  }

  const controller = new AbortController();
  const timeoutMs = options?.timeout ?? GEMINI_CONFIG.timeoutMs;
  const timer = setTimeout(() => {
    console.warn(
      '[llm] Gemini timeout after %ds (%s).',
      timeoutMs / 1000,
      GEMINI_CONFIG.model,
    );
    controller.abort();
  }, timeoutMs);

  try {
    const payload = toGeminiPayload(messages);
    const url = `${GEMINI_CONFIG.endpoint}/models/${encodeURIComponent(GEMINI_CONFIG.model)}:generateContent?key=${encodeURIComponent(GEMINI_CONFIG.apiKey)}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        generationConfig: {
          maxOutputTokens: options?.maxTokens ?? GEMINI_CONFIG.maxTokens,
          temperature: options?.temperature ?? GEMINI_CONFIG.temperature,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Gemini: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as GeminiResponse;
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .map(part => part.text ?? '')
      .join('')
      .trim();

    if (!text) {
      throw new Error('Gemini returned an empty response');
    }

    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call local/offline OpenAI-compatible endpoint (LM Studio / OpenAI-style).
 */
async function callLocalLLM(messages: Message[], options?: LLMCallOptions): Promise<string> {
  const localConfig = LOCAL_LLM_CONFIG;
  if (!localConfig) {
    throw new Error('Local LLM not configured (missing LLM_ENDPOINT/LLM_MODEL)');
  }

  const controller = new AbortController();
  const timeoutMs = options?.timeout ?? localConfig.timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (localConfig.apiKey) {
      headers.Authorization = `Bearer ${localConfig.apiKey}`;
    }

    const buildBody = (includeSchema: boolean): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        model: localConfig.model,
        messages,
        max_tokens: options?.maxTokens ?? GEMINI_CONFIG.maxTokens,
        temperature: options?.temperature ?? GEMINI_CONFIG.temperature,
      };
      if (includeSchema && options?.schema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: {
            name: 'agent_response',
            strict: true,
            schema: options.schema,
          },
        };
      }
      return body;
    };

    const requestLocal = async (includeSchema: boolean): Promise<Response> => fetch(
      localConfig.endpoint,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(buildBody(includeSchema)),
        signal: controller.signal,
      },
    );

    let response = await requestLocal(Boolean(options?.schema));

    if (!response.ok && options?.schema) {
      const errorBody = await response.text().catch(() => '');
      const schemaUnsupported = response.status === 400
        || response.status === 404
        || /response_format|json_schema|unsupported|unknown field/i.test(errorBody);
      if (schemaUnsupported) {
        console.warn('[llm] Local structured output unsupported; falling back to unstructured output');
        response = await requestLocal(false);
      } else {
        throw new Error(`Local LLM: ${response.status} ${response.statusText}${errorBody ? ` — ${errorBody}` : ''}`);
      }
    }

    if (!response.ok) {
      throw new Error(`Local LLM: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as OpenAICompatibleResponse;
    const content = data.choices?.[0]?.message?.content;

    let text = '';
    if (typeof content === 'string') {
      text = content.trim();
    } else if (Array.isArray(content)) {
      text = content
        .map(part => part.text ?? '')
        .join('')
        .trim();
    }

    if (!text) {
      throw new Error('Local LLM returned an empty response');
    }

    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call the Anthropic Messages API as optional fallback.
 * Extracts system messages into top-level `system`.
 */
async function callAnthropic(messages: Message[], options?: LLMCallOptions): Promise<string> {
  if (!LLM_FALLBACK_CONFIG || !LLM_FALLBACK_CONFIG.apiKey) {
    throw new Error('Anthropic fallback not configured (missing API key)');
  }

  const systemParts = messages
    .filter(message => message.role === 'system')
    .map(message => message.content);
  const nonSystem = messages.filter(message => message.role !== 'system');

  const response = await fetch(LLM_FALLBACK_CONFIG.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': LLM_FALLBACK_CONFIG.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: LLM_FALLBACK_CONFIG.model,
      system: systemParts.join('\n\n'),
      messages: nonSystem,
      max_tokens: options?.maxTokens ?? GEMINI_CONFIG.maxTokens,
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic fallback: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as {
    content: Array<{ type: string; text: string }>;
  };

  const text = data.content?.[0]?.text?.trim();
  if (!text) throw new Error('Anthropic fallback returned empty response');
  return text;
}

/**
 * Call LLM with Gemini primary and optional fallback.
 */
export async function callLLM(messages: Message[], options?: LLMCallOptions): Promise<string> {
  return callLLMWithOptions(messages, options);
}

export async function callLLMWithOptions(
  messages: Message[],
  options?: LLMCallOptions,
): Promise<string> {
  if (LOCAL_LLM_CONFIG) {
    const localStart = performance.now();
    try {
      const result = await callLocalLLM(messages, options);
      const elapsed = Math.round(performance.now() - localStart);
      console.log('[llm] Provider: local (%s) — %dms', LOCAL_LLM_CONFIG.model, elapsed);
      return result;
    } catch (error) {
      const elapsed = Math.round(performance.now() - localStart);
      console.warn('[llm] Local failed after %dms: %s — trying Gemini', elapsed, String(error));
    }
  }

  const geminiStart = performance.now();
  try {
    const result = await callGemini(messages, options);
    const elapsed = Math.round(performance.now() - geminiStart);
    console.log('[llm] Provider: gemini (%s) — %dms', GEMINI_CONFIG.model, elapsed);
    return result;
  } catch (error) {
    const elapsed = Math.round(performance.now() - geminiStart);
    console.warn('[llm] Gemini failed after %dms: %s — trying fallback', elapsed, String(error));
  }

  if (LLM_FALLBACK_CONFIG) {
    const fallbackStart = performance.now();
    try {
      const result = await callAnthropic(messages, options);
      const elapsed = Math.round(performance.now() - fallbackStart);
      console.log('[llm] Provider: fallback (%s/%s) — %dms', LLM_FALLBACK_CONFIG.provider, LLM_FALLBACK_CONFIG.model, elapsed);
      return result;
    } catch (error) {
      const elapsed = Math.round(performance.now() - fallbackStart);
      console.warn('[llm] Fallback failed after %dms: %s', elapsed, String(error));
    }
  }

  throw new Error('All LLM providers unreachable');
}

export async function callLLMWithSchema(
  messages: Message[],
  schema: Record<string, unknown>,
): Promise<string> {
  return callLLMWithOptions(messages, { schema });
}
