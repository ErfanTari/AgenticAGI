import { AsyncLocalStorage } from 'node:async_hooks';
import { LLM_CONFIG, LLM_FALLBACK_CONFIG } from '../config/agent.config.js';
import { transparency } from './transparency.js';
const llmRuntimeStore = new AsyncLocalStorage();
function getTimeoutForModel(modelName) {
    const lower = modelName.toLowerCase();
    if (/72b|70b|80b|35b|32b|20b/.test(lower))
        return 90000;
    if (/7b|8b|13b|14b/.test(lower))
        return 20000;
    if (/1b|2b|3b|4b/.test(lower))
        return 10000;
    return 20000;
}
function getDefaultApiKey() {
    return process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY;
}
export function getPrimaryLLMProfile() {
    if (!LLM_CONFIG.endpoint || !LLM_CONFIG.model)
        return null;
    return {
        kind: 'openai-compatible',
        label: 'primary',
        endpoint: LLM_CONFIG.endpoint,
        model: LLM_CONFIG.model,
        apiKey: getDefaultApiKey(),
        temperature: LLM_CONFIG.temperature,
        maxTokens: LLM_CONFIG.maxTokens,
        timeoutMs: LLM_CONFIG.timeoutMs,
    };
}
export function getFallbackLLMProfile() {
    if (!LLM_FALLBACK_CONFIG?.endpoint || !LLM_FALLBACK_CONFIG.model)
        return null;
    if (LLM_FALLBACK_CONFIG.provider === 'gemini') {
        return {
            kind: 'openai-compatible',
            label: 'fallback',
            endpoint: LLM_FALLBACK_CONFIG.endpoint,
            model: LLM_FALLBACK_CONFIG.model,
            apiKey: LLM_FALLBACK_CONFIG.apiKey,
            temperature: LLM_CONFIG.temperature,
            maxTokens: LLM_CONFIG.maxTokens,
            timeoutMs: getTimeoutForModel(LLM_FALLBACK_CONFIG.model),
        };
    }
    if (!LLM_FALLBACK_CONFIG.apiKey)
        return null;
    return {
        kind: 'anthropic',
        label: 'fallback',
        endpoint: LLM_FALLBACK_CONFIG.endpoint,
        model: LLM_FALLBACK_CONFIG.model,
        apiKey: LLM_FALLBACK_CONFIG.apiKey,
        maxTokens: LLM_CONFIG.maxTokens,
        timeoutMs: getTimeoutForModel(LLM_FALLBACK_CONFIG.model),
    };
}
function getRuntimeOverride() {
    return llmRuntimeStore.getStore() ?? {
        primary: getPrimaryLLMProfile(),
        fallback: getFallbackLLMProfile(),
    };
}
export function withLLMRuntime(runtime, fn) {
    return llmRuntimeStore.run(runtime, fn);
}
/**
 * Strip model reasoning/thinking artifacts from LLM responses.
 * Applied to EVERY response before it touches any downstream logic.
 *
 * FIX H: Only strip unambiguous reasoning artifacts:
 * - <think>...</think> blocks
 * - <thought>...</thought> blocks
 * - <|im_start|>...<|im_end|> tokens
 * - Orphaned <think> or <thought> without closing tag
 *
 * Does NOT strip based on content patterns like:
 * - **Constraint Checklist, **Mental Sandbox, **Analyze
 * - "The user..." / "Thinking Process:" line removal
 */
export function stripThinkingTags(raw) {
    let cleaned = raw;
    // 1. Remove complete <think>...</think> blocks
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
    // 2. Remove complete <thought>...</thought> blocks
    cleaned = cleaned.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
    // 3. Remove orphaned think/thought closing tags
    cleaned = cleaned.replace(/<\/think>/gi, '');
    cleaned = cleaned.replace(/<\/thought>/gi, '');
    // 4. Remove orphaned think/thought opening tags (no closing tag = entire rest is reasoning)
    // Only strip if the tag appears at start of response or after whitespace
    cleaned = cleaned.replace(/<think>/gi, '');
    cleaned = cleaned.replace(/<thought>/gi, '');
    // 5. Remove LM Studio special tokens <|im_start|>...<|im_end|>
    cleaned = cleaned.replace(/<\|im_start\|>[\s\S]*?<\|im_end\|>/g, '');
    cleaned = cleaned.replace(/<\|im_start\|>/g, '');
    cleaned = cleaned.replace(/<\|im_end\|>/g, '');
    // Safety rule: if stripping left empty/whitespace and original was non-empty, return original
    const stripped = cleaned.trim();
    if (stripped.length === 0 && raw.trim().length > 0) {
        console.warn('[llm] stripThinkingTags: result was empty after stripping — returning original response');
        return raw.trim();
    }
    return stripped;
}
/**
 * Call the primary LLM (Mac Studio / OpenAI-compatible endpoint).
 * Timeout is tiered by model size (70B+=90s, 7B-14B=20s, 1B-4B=10s, default=20s).
 * On timeout, logs a warning with model name so caller knows what happened.
 */
async function callOpenAICompatibleProfile(profile, messages, options) {
    const controller = new AbortController();
    const timeoutMs = profile.timeoutMs;
    const timer = setTimeout(() => {
        console.warn('[llm] Still thinking — %s is processing a complex query. Timeout after %ds.', profile.model, timeoutMs / 1000);
        controller.abort();
    }, timeoutMs);
    try {
        return await callOpenAICompatibleEndpoint(profile.endpoint, profile.model, profile.apiKey, messages, options, controller.signal, profile.label, profile.temperature, profile.maxTokens);
    }
    finally {
        clearTimeout(timer);
    }
}
async function callOpenAICompatibleEndpoint(endpoint, model, apiKey, messages, options, signal, label, temperature, defaultMaxTokens) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey)
        headers.Authorization = `Bearer ${apiKey}`;
    const requestBody = {
        model,
        messages,
        max_tokens: options?.maxTokens ?? defaultMaxTokens,
        temperature,
    };
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
    const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal,
    });
    if (!response.ok) {
        throw new Error(`${label}: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error(`${label}: empty response content`);
    }
    return content;
}
/**
 * Call the Anthropic Messages API as fallback.
 * Extracts system messages into the top-level `system` parameter.
 */
async function callAnthropicProfile(profile, messages, options) {
    if (!profile.apiKey) {
        throw new Error('Anthropic fallback not configured (missing API key)');
    }
    const systemParts = messages.filter(m => m.role === 'system').map(m => m.content);
    const nonSystem = messages.filter(m => m.role !== 'system');
    const response = await fetch(profile.endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': profile.apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: profile.model,
            system: systemParts.join('\n'),
            messages: nonSystem,
            max_tokens: options?.maxTokens ?? profile.maxTokens,
        }),
    });
    if (!response.ok) {
        throw new Error(`${profile.label}: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return data.content[0].text;
}
async function callProfile(profile, messages, options) {
    if (profile.kind === 'anthropic') {
        return await callAnthropicProfile(profile, messages, options);
    }
    return await callOpenAICompatibleProfile(profile, messages, options);
}
/**
 * Call LLM with automatic fallback.
 *
 * Flow:
 * 1. Try primary (Mac Studio) with tiered timeout based on model size
 * 2. If unreachable or times out → fall back to the configured cloud provider
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
    const runtime = getRuntimeOverride();
    if (runtime.primary) {
        const start = performance.now();
        try {
            const raw = await callProfile(runtime.primary, messages, options);
            const elapsed = Math.round(performance.now() - start);
            console.log('[llm] Provider: %s (%s) — %dms', runtime.primary.label, runtime.primary.model, elapsed);
            transparency.emit({ type: 'llm_raw', data: { raw, ms: elapsed } });
            const stripped = stripThinkingTags(raw);
            transparency.emit({ type: 'llm_stripped', data: { stripped } });
            return stripped;
        }
        catch (err) {
            const elapsed = Math.round(performance.now() - start);
            console.warn('[llm] %s failed after %dms: %s — trying fallback', runtime.primary.label, elapsed, String(err));
        }
    }
    if (runtime.fallback) {
        const start = performance.now();
        try {
            const raw = await callProfile(runtime.fallback, messages, options);
            const elapsed = Math.round(performance.now() - start);
            console.log('[llm] Provider: %s (%s) — %dms', runtime.fallback.label, runtime.fallback.model, elapsed);
            transparency.emit({ type: 'llm_raw', data: { raw, ms: elapsed } });
            const stripped = stripThinkingTags(raw);
            transparency.emit({ type: 'llm_stripped', data: { stripped } });
            return stripped;
        }
        catch (err) {
            const elapsed = Math.round(performance.now() - start);
            console.warn('[llm] %s failed after %dms: %s', runtime.fallback.label, elapsed, String(err));
        }
    }
    throw new Error('All LLM providers unreachable');
}
