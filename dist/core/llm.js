import { LLM_CONFIG, LLM_FALLBACK_CONFIG } from '../config/agent.config.js';
import { transparency } from './transparency.js';
/**
 * Strip model reasoning/thinking artifacts from LLM responses.
 * Applied to EVERY response before it touches any downstream logic.
 * Handles: <think> blocks, orphaned closing tags, preamble sentences.
 */
function stripThinkingTags(raw) {
    let cleaned = raw;
    // 1. Remove complete <think>...</think> blocks
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
    // 2. Remove orphaned think tags
    cleaned = cleaned.replace(/<\/think>/gi, '');
    cleaned = cleaned.replace(/<think>/gi, '');
    // 3. Remove LM Studio special tokens
    cleaned = cleaned.replace(/<\|im_start\|>[\s\S]*?<\|im_end\|>/g, '');
    cleaned = cleaned.replace(/<\|im_start\|>/g, '');
    cleaned = cleaned.replace(/<\|im_end\|>/g, '');
    // 4. Remove Thinking Process block — consume ALL numbered items that follow,
    //    not just up to the first blank line
    cleaned = cleaned.replace(/^Thinking Process:[\s\S]*?(?=\n\n(?!\d+\.|\*\*|\s*[-•]))/, '');
    // 5. Remove standalone numbered analysis blocks at the start of the response
    //    "1. **Analyze...**\n2. **Check...**\n..." (2+ items)
    cleaned = cleaned.replace(/^(\s*\d+\.\s+\*\*[\s\S]*?){2,}(?=\n\n[^0-9])/, '');
    // 6. Remove Constraint Checklist blocks
    cleaned = cleaned.replace(/\*\*Constraint Checklist[\s\S]*$/gi, '');
    // 7. Remove Confidence Score lines
    cleaned = cleaned.replace(/Confidence Score:.*$/gim, '');
    // 8. Remove Mental Sandbox blocks
    cleaned = cleaned.replace(/\*\*Mental Sandbox[\s\S]*$/gi, '');
    // 9. Remove numbered analysis blocks starting with **Analyze
    cleaned = cleaned.replace(/\*\*Analyze[\s\S]*?(?=\n\n[A-Z]|$)/gi, '');
    // 10. Preamble sentences at the START of the response only
    //     Anchored to ^ so mid-content "Let me know" is NOT stripped
    const OPENING_PREAMBLES = [
        /^Let me [^\n]+\n+/,
        /^I need to [^\n]+\n+/,
        /^I will [^\n]+\n+/,
        /^I can see [^\n]+\n+/,
        /^I'm going to [^\n]+\n+/,
        /^I should [^\n]+\n+/,
        /^Let['´s][^\n]+\n+/,
        // "The user wants/needs/is asking/asked..."
        /^The user (wants|needs|is asking|asked)[^\n]+\n+/,
        /^The user's [^\n]+\n+/,
    ];
    for (const pattern of OPENING_PREAMBLES) {
        cleaned = cleaned.replace(pattern, '');
    }
    // 11. Artifact detection — if stripping left only a number or punctuation (e.g. "1.")
    //     return empty string so callers treat this as a failed generation
    const stripped = cleaned.trim();
    if (/^\d+\.?\s*$/.test(stripped)) {
        return '';
    }
    return stripped;
}
/**
 * Call the primary LLM (Mac Studio / OpenAI-compatible endpoint).
 * Timeout is tiered by model size (70B+=90s, 7B-14B=20s, 1B-4B=10s, default=20s).
 * On timeout, logs a warning with model name so caller knows what happened.
 */
async function callPrimary(messages, options) {
    const controller = new AbortController();
    const timeoutMs = LLM_CONFIG.timeoutMs;
    const timer = setTimeout(() => {
        console.warn('[llm] Still thinking — %s is processing a complex query. Timeout after %ds.', LLM_CONFIG.model, timeoutMs / 1000);
        controller.abort();
    }, timeoutMs);
    try {
        const apiKey = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY;
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey)
            headers.Authorization = `Bearer ${apiKey}`;
        const requestBody = {
            model: LLM_CONFIG.model,
            messages,
            max_tokens: options?.maxTokens ?? LLM_CONFIG.maxTokens,
            temperature: LLM_CONFIG.temperature,
        };
        // Add structured output schema if provided (LM Studio json_schema format)
        if (options?.responseSchema) {
            requestBody.response_format = {
                type: 'json_schema',
                json_schema: {
                    name: 'response',
                    strict: true,
                    schema: options.responseSchema,
                },
            };
        }
        const response = await fetch(LLM_CONFIG.endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`Primary LLM: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        return data.choices[0].message.content;
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Call the Anthropic Messages API as fallback.
 * Extracts system messages into the top-level `system` parameter.
 */
async function callAnthropic(messages) {
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
    const data = await response.json();
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
export async function callLLM(messages, options) {
    // Emit llm_request event (system message + message count)
    const systemMsg = messages.find(m => m.role === 'system');
    transparency.emit({
        type: 'llm_request',
        data: { system: systemMsg?.content ?? '', messages, schema: options?.responseSchema },
    });
    // Try primary
    if (LLM_CONFIG.endpoint) {
        const start = performance.now();
        try {
            const raw = await callPrimary(messages, options);
            const elapsed = Math.round(performance.now() - start);
            console.log('[llm] Provider: primary (%s) — %dms', LLM_CONFIG.model, elapsed);
            transparency.emit({ type: 'llm_raw', data: { raw, ms: elapsed } });
            const stripped = stripThinkingTags(raw);
            transparency.emit({ type: 'llm_stripped', data: { stripped } });
            return stripped;
        }
        catch (err) {
            const elapsed = Math.round(performance.now() - start);
            console.warn('[llm] Primary failed after %dms: %s — trying fallback', elapsed, String(err));
        }
    }
    // Try fallback
    if (LLM_FALLBACK_CONFIG) {
        const start = performance.now();
        try {
            const raw = await callAnthropic(messages);
            const elapsed = Math.round(performance.now() - start);
            console.log('[llm] Provider: fallback (%s/%s) — %dms', LLM_FALLBACK_CONFIG.provider, LLM_FALLBACK_CONFIG.model, elapsed);
            transparency.emit({ type: 'llm_raw', data: { raw, ms: elapsed } });
            const stripped = stripThinkingTags(raw);
            transparency.emit({ type: 'llm_stripped', data: { stripped } });
            return stripped;
        }
        catch (err) {
            const elapsed = Math.round(performance.now() - start);
            console.warn('[llm] Fallback failed after %dms: %s', elapsed, String(err));
        }
    }
    throw new Error('All LLM providers unreachable');
}
