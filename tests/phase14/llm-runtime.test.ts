import { afterEach, describe, expect, it, vi } from 'vitest';
import { callLLM, withLLMRuntime, type LLMProfile } from '../../core/llm.js';
import type { Message } from '../../core/types.js';

const messages: Message[] = [
  { role: 'user', content: 'say ok' },
];

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function openAIProfile(label: string, endpoint: string, model: string): LLMProfile {
  return {
    kind: 'openai-compatible',
    label,
    endpoint,
    model,
    temperature: 0.2,
    maxTokens: 128,
    timeoutMs: 1000,
  };
}

describe('Phase 14: request-scoped LLM runtime overrides', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses the override fallback order when the selected primary fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'http://local.test/v1/chat/completions') {
        return new Response('local down', { status: 503, statusText: 'Service Unavailable' });
      }
      if (url === 'https://cloud.test/v1/chat/completions') {
        return jsonResponse('cloud ok');
      }
      throw new Error(`unexpected url: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const reply = await withLLMRuntime({
      primary: openAIProfile('local-primary', 'http://local.test/v1/chat/completions', 'qwen-local'),
      fallback: openAIProfile('cloud-fallback', 'https://cloud.test/v1/chat/completions', 'gemini-cloud'),
    }, async () => callLLM(messages));

    expect(reply).toBe('cloud ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://local.test/v1/chat/completions');
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://cloud.test/v1/chat/completions');
  });

  it('supports cloud-primary mode without falling back when the cloud call succeeds', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://cloud.test/v1/chat/completions') {
        return jsonResponse('cloud primary ok');
      }
      throw new Error(`unexpected fallback call: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const reply = await withLLMRuntime({
      primary: openAIProfile('cloud-primary', 'https://cloud.test/v1/chat/completions', 'gemini-cloud'),
      fallback: openAIProfile('local-fallback', 'http://local.test/v1/chat/completions', 'qwen-local'),
    }, async () => callLLM(messages));

    expect(reply).toBe('cloud primary ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://cloud.test/v1/chat/completions');
  });
});
