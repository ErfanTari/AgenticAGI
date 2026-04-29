/**
 * Vision routing: local Qwen 3 VL 8B → cloud Gemini Flash on low confidence.
 * Uses the OpenAI-compatible vision endpoint (image passed as base64 data URL).
 */
import { LLM_CONFIG, LLM_FALLBACK_CONFIG } from '../../config/agent.config.js';

const LOW_CONFIDENCE_PHRASES = [
  "i cannot determine",
  "i can't tell",
  "unclear",
  "unable to identify",
  "not sure what",
  "cannot make out",
  "difficult to discern",
  "i'm not sure",
  "it's hard to tell",
  "cannot see",
];

export type VisionResult = {
  description: string;
  tier: 'local' | 'cloud-fallback';
  confidence: 'high' | 'low';
};

async function callVisionEndpoint(
  endpoint: string,
  model: string,
  apiKey: string | undefined,
  imageBase64: string,
  mimeType: string,
  prompt: string,
): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${imageBase64}` },
          },
          { type: 'text', text: prompt },
        ],
      },
    ],
    max_tokens: 1024,
    temperature: 0.2,
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) throw new Error(`Vision API HTTP ${response.status}`);
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? '';
}

export async function describeImage(
  imageBuffer: Buffer,
  prompt: string,
  mimeType = 'image/png',
): Promise<VisionResult> {
  const base64 = imageBuffer.toString('base64');

  // Derive local vision endpoint — same LM Studio host but chat/completions endpoint
  const localEndpoint = LLM_CONFIG.endpoint || `http://localhost:1234/v1/chat/completions`;
  const localModel = 'qwen/qwen3-vl-8b';

  try {
    const description = await callVisionEndpoint(
      localEndpoint,
      localModel,
      undefined, // LM Studio needs no API key
      base64,
      mimeType,
      prompt,
    );

    const lower = description.toLowerCase();
    const looksUncertain = LOW_CONFIDENCE_PHRASES.some(p => lower.includes(p));

    if (!looksUncertain && description.trim().length > 10) {
      return { description, tier: 'local', confidence: 'high' };
    }
  } catch {
    // Local failure — fall through to cloud
  }

  // Cloud escalation via Gemini fallback
  try {
    const fallback = LLM_FALLBACK_CONFIG;
    if (!fallback) throw new Error('No fallback configured');

    // Gemini uses a different vision endpoint format
    const geminiEndpoint = fallback.endpoint?.replace('/chat/completions', '/chat/completions')
      ?? 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
    const cloudDescription = await callVisionEndpoint(
      geminiEndpoint,
      fallback.model || 'gemini-2.5-flash',
      fallback.apiKey,
      base64,
      mimeType,
      prompt,
    );
    return { description: cloudDescription, tier: 'cloud-fallback', confidence: 'low' };
  } catch (err) {
    return {
      description: `Vision analysis unavailable: ${String(err)}`,
      tier: 'cloud-fallback',
      confidence: 'low',
    };
  }
}
