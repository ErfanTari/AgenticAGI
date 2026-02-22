import { GEMINI_CONFIG, LLM_FALLBACK_CONFIG } from '../config/agent.config.js';
function toGeminiPayload(messages) {
    const systemText = messages
        .filter(message => message.role === 'system')
        .map(message => message.content)
        .join('\n\n')
        .trim();
    const contents = messages
        .filter(message => message.role !== 'system')
        .map(message => ({
        role: message.role === 'assistant' ? 'model' : 'user',
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
async function callGemini(messages) {
    if (!GEMINI_CONFIG.apiKey) {
        throw new Error('Gemini not configured (missing GEMINI_API_KEY)');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
        console.warn('[llm] Gemini timeout after %ds (%s).', GEMINI_CONFIG.timeoutMs / 1000, GEMINI_CONFIG.model);
        controller.abort();
    }, GEMINI_CONFIG.timeoutMs);
    try {
        const payload = toGeminiPayload(messages);
        const url = `${GEMINI_CONFIG.endpoint}/models/${encodeURIComponent(GEMINI_CONFIG.model)}:generateContent?key=${encodeURIComponent(GEMINI_CONFIG.apiKey)}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...payload,
                generationConfig: {
                    maxOutputTokens: GEMINI_CONFIG.maxTokens,
                    temperature: GEMINI_CONFIG.temperature,
                },
            }),
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`Gemini: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        const parts = data.candidates?.[0]?.content?.parts ?? [];
        const text = parts
            .map(part => part.text ?? '')
            .join('')
            .trim();
        if (!text) {
            throw new Error('Gemini returned an empty response');
        }
        return text;
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Call the Anthropic Messages API as optional fallback.
 * Extracts system messages into top-level `system`.
 */
async function callAnthropic(messages) {
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
            max_tokens: GEMINI_CONFIG.maxTokens,
        }),
    });
    if (!response.ok) {
        throw new Error(`Anthropic fallback: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    const text = data.content?.[0]?.text?.trim();
    if (!text)
        throw new Error('Anthropic fallback returned empty response');
    return text;
}
/**
 * Call LLM with Gemini primary and optional fallback.
 */
export async function callLLM(messages) {
    const geminiStart = performance.now();
    try {
        const result = await callGemini(messages);
        const elapsed = Math.round(performance.now() - geminiStart);
        console.log('[llm] Provider: gemini (%s) — %dms', GEMINI_CONFIG.model, elapsed);
        return result;
    }
    catch (error) {
        const elapsed = Math.round(performance.now() - geminiStart);
        console.warn('[llm] Gemini failed after %dms: %s — trying fallback', elapsed, String(error));
    }
    if (LLM_FALLBACK_CONFIG) {
        const fallbackStart = performance.now();
        try {
            const result = await callAnthropic(messages);
            const elapsed = Math.round(performance.now() - fallbackStart);
            console.log('[llm] Provider: fallback (%s/%s) — %dms', LLM_FALLBACK_CONFIG.provider, LLM_FALLBACK_CONFIG.model, elapsed);
            return result;
        }
        catch (error) {
            const elapsed = Math.round(performance.now() - fallbackStart);
            console.warn('[llm] Fallback failed after %dms: %s', elapsed, String(error));
        }
    }
    throw new Error('All LLM providers unreachable');
}
