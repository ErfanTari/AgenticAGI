import { AsyncLocalStorage } from 'node:async_hooks';
import { LLM_CONFIG, LLM_FALLBACK_CONFIG, ANTHROPIC_CLOUD_CONFIG } from '../config/agent.config.js';
import { transparency } from './transparency.js';
import { recordTokens } from './token-counter.js';
const llmRuntimeStore = new AsyncLocalStorage();
function getTimeoutForModel(modelName) {
    const lower = modelName.toLowerCase();
    if (/72b|70b|80b|35b|32b|26b|20b/.test(lower))
        return 180000;
    if (/7b|8b|13b|14b/.test(lower))
        return 60000;
    if (/1b|2b|3b|4b/.test(lower))
        return 30000;
    return 180000; // unknown model — assume large, give full budget
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
export function getAnthropicCloudProfile() {
    if (!ANTHROPIC_CLOUD_CONFIG?.apiKey)
        return null;
    return {
        kind: 'anthropic',
        label: 'anthropic-cloud',
        endpoint: ANTHROPIC_CLOUD_CONFIG.endpoint,
        model: ANTHROPIC_CLOUD_CONFIG.model,
        apiKey: ANTHROPIC_CLOUD_CONFIG.apiKey,
        maxTokens: LLM_CONFIG.maxTokens,
        timeoutMs: 60000,
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
 */
export function stripThinkingTags(text) {
    if (!text)
        return text;
    let result = text;
    // 1. Explicit reasoning block tags (all models)
    result = result.replace(/<think>[\s\S]*?<\/think>/gi, '');
    result = result.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
    result = result.replace(/<\|im_start\|>[\s\S]*?<\|im_end\|>/g, '');
    // Orphaned opening tags
    result = result.replace(/<think>[\s\S]*/gi, '');
    result = result.replace(/<thought>[\s\S]*/gi, '');
    // 1b. Gemma 4 thinking format: <|channel>thought\n[reasoning]<channel|>
    result = result.replace(/<\|channel>thought\n[\s\S]*?<channel\|>/g, '');
    result = result.replace(/<\|channel>thought[\s\S]*?<channel\|>/g, '');
    result = result.replace(/<\|channel>thought[\s\S]*/g, ''); // orphaned open tag
    // 1c. Gemma 4 underscore variant: <|channel>_thought\n[reasoning]<channel|>
    result = result.replace(/<\|channel>_thought[\s\S]*?<channel\|>/g, '');
    result = result.replace(/<\|channel>_thought[\s\S]*/g, ''); // orphaned open tag
    // 2. Qwen starred analysis blocks
    result = result.replace(/^\*\*(Analyze|Consider|Think|Break down|Determine|Plan|Understand)\b[^*]*\*\*:?[\s\S]*?(?=\n\n|\n##|\n\*\*(?!Analyze|Consider|Think|Break|Determine|Plan|Understand)|\n[A-Z])/gm, '');
    // 3. Qwen numbered analysis steps
    result = result.replace(/^(\d+\.\s+\*\*(Analyze|Consider|Think|Break|Determine|Plan|Understand)[^*]*\*\*:?[\s\S]*?\n\n)+/gm, '');
    // 4. Gemini "Thinking Process:" block
    result = result.replace(/^Thinking Process:[\s\S]*?(?=\n\n(?!\d)|\n##|\nHere|\nThe (?:answer|solution|result)|\nBased on)/m, '');
    // 5. "Let me analyze/think/break down..." preamble lines
    result = result.replace(/^(Let me (analyze|think about|break down|consider|work through|figure out)[^\n]*\n)+/gim, '');
    // 6. Tool call markup leaking into replies
    result = result.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');
    result = result.replace(/<tool_response>[\s\S]*?<\/tool_response>/g, '');
    result = result.replace(/\{"type"\s*:\s*"tool_call"[\s\S]*?\}\s*/g, '');
    // 7. Known Qwen extended thinking artifacts
    result = result.replace(/^\*\*Constraint Checklist[\s\S]*?(?=\n\n|\n##)/gm, '');
    result = result.replace(/^\*\*Mental Sandbox[\s\S]*?(?=\n\n|\n##)/gm, '');
    result = result.replace(/^Confidence Score:\s*\d[\s\S]*?(?=\n\n|\n##)/gm, '');
    // 8. Safety: if result starts with a numbered list of reasoning steps
    const reasoningStart = /^(\d+\.\s+[A-Z][^\n]*\n)+/;
    if (reasoningStart.test(result.trim()) && result.length > 300) {
        const afterReasoning = result.replace(reasoningStart, '').trim();
        if (afterReasoning.length > 50)
            result = afterReasoning;
    }
    // 9. Post-think narration preambles — models sometimes emit a sentence after the think
    //    block explaining what they're about to do, before the actual JSON/content.
    //    Strip these only when they appear at the start of the result.
    const PREAMBLE_PATTERNS = [
        /^Here(?:'s| is) (?:the )?(?:JSON|output|result|response|answer|corrected|updated|revised)[^\n]*\n+/i,
        /^Certainly[,!]?\s+here(?:'s| is)[^\n]*\n+/i,
        /^Sure[,!]?\s+here(?:'s| is)[^\n]*\n+/i,
        /^Of course[,!]?\s+here(?:'s| is)[^\n]*\n+/i,
        /^I(?:'ll| will) (?:now |)(?:provide|return|give you|output)[^\n]*\n+/i,
        // Memory/search deferred actions
        /^I(?:'ll| will) (?:search|look|check|find|retrieve|fetch|query|examine)[^\n]*\n+/i,
        /^Let me (?:search|look|check|find|retrieve|fetch|query|examine)[^\n]*\n+/i,
        /^I(?:'ll| will) (?:check|search) (?:my )?(?:memory|database|entries|records)[^\n]*\n+/i,
        /^Let me (?:check|search) (?:my )?(?:memory|database|entries|records)[^\n]*\n+/i,
        /^(?:Just|One) (?:a )?(?:moment|second)[,!]?\s+(?:let me|checking|searching)[^\n]*\n+/i,
        /^(?:Checking|Searching|Looking|Retrieving|Fetching|Finding)[^\n]*\n+/i,
    ];
    for (const pattern of PREAMBLE_PATTERNS) {
        const trimmed = result.trimStart();
        const m = trimmed.match(pattern);
        if (m) {
            const afterPreamble = trimmed.slice(m[0].length).trim();
            if (afterPreamble.length > 0) {
                result = afterPreamble;
            }
            break;
        }
    }
    // Safety rule: if stripping left empty/whitespace and original was non-empty, return original
    const stripped = result.trim();
    if (stripped.length === 0 && text.trim().length > 0) {
        console.warn('[llm] stripThinkingTags: result was empty after stripping — returning original response');
        return text.trim();
    }
    return stripped;
}
/**
 * Sanitizes final output before returning to the user.
 * Removes control tokens, thinking tags, and pseudo-tool narratives.
 * Returns cleaned text.
 *
 * FIX D: Prevents leaked tool syntax and thinking text from appearing to the user.
 */
export function sanitizeFinalOutput(text) {
    let cleaned = stripThinkingTags(text);
    // Remove model control tokens that should never appear in output
    cleaned = cleaned.replace(/<\|?(?:tool_call|tool_response|channel|im_start|im_end|endoftext|pad)[^>]*\|?>/gi, '');
    // (closing-token variant covered by pattern above)
    // Remove pseudo-tool-call narrative lines: lines that look like the model is narrating its own tool use
    cleaned = cleaned.replace(/^(?:\*\*)?(?:Calling|Using|Executing|Running)\s+(?:tool|function|memory_read|memory_write)[:\s].+$/gm, '');
    // Remove lines that are clearly internal thought preamble
    cleaned = cleaned.replace(/^(?:Let me|I (?:should|need to|will|'ll)|I (?:search|look|check|find|query|read|retrieve|fetch))[^\n]*$/gm, '');
    cleaned = cleaned.replace(/^(?:Checking|Searching|Looking|Retrieving|Fetching|Finding|One moment|Just a second)[^\n]*$/gm, '');
    // Collapse multiple blank lines into at most two
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    return cleaned.trim();
}
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
    // Clone messages to avoid mutating the original array
    const workingMessages = messages.map(m => ({ ...m }));
    // For OpenAI-compatible endpoints, map tool definitions → responseSchema fallback
    const effectiveOptions = options?.tools?.length
        ? { ...options, responseSchema: options.tools[0].input_schema, tools: undefined, toolChoice: undefined }
        : options;
    const requestBody = {
        model,
        messages: workingMessages,
        max_tokens: effectiveOptions?.maxTokens ?? defaultMaxTokens,
        temperature,
    };
    // LM Studio / llama.cpp thinking suppression.
    // Enabled when the call site passes disableThinking:true OR when DISABLE_THINKING=true
    // in .env (global fallback). Only applied to primary/local calls — never to cloud fallback.
    const shouldDisableThinking = effectiveOptions?.disableThinking === true ||
        (effectiveOptions?.disableThinking === undefined && process.env.DISABLE_THINKING === 'true');
    if (shouldDisableThinking && (label === 'primary' || label === 'local-primary')) {
        requestBody.thinking = { type: 'disabled' };
    }
    // Only send response_format to non-primary (cloud/fallback) providers.
    // For the primary local model, inject schema as a prompt instruction instead.
    const isPrimary = label === 'primary' || label === 'local-primary';
    if (effectiveOptions?.responseSchema && !isPrimary) {
        requestBody.response_format = {
            type: 'json_schema',
            json_schema: {
                name: 'response',
                strict: true,
                schema: effectiveOptions.responseSchema,
            },
        };
    }
    else if (effectiveOptions?.responseSchema && isPrimary) {
        // For local models: inject schema as instruction in system prompt
        const schemaInstruction = `\nRespond ONLY with valid JSON matching this schema:\n${JSON.stringify(effectiveOptions.responseSchema, null, 2)}\nNo other text.`;
        const systemMsg = workingMessages.find(m => m.role === 'system');
        if (systemMsg) {
            systemMsg.content += schemaInstruction;
        }
        else {
            workingMessages.unshift({ role: 'system', content: schemaInstruction });
        }
    }
    const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal,
    });
    // Retry-on-400: if 400 AND we sent response_format, retry without it
    if (response.status === 400 && effectiveOptions?.responseSchema && !isPrimary) {
        const retryBody = {
            model,
            messages: workingMessages,
            max_tokens: effectiveOptions?.maxTokens ?? defaultMaxTokens,
            temperature,
        };
        // Inject schema as prompt instruction instead
        const schemaInstruction = `\nRespond ONLY with valid JSON matching this schema:\n${JSON.stringify(effectiveOptions.responseSchema, null, 2)}\nNo other text.`;
        const systemMsg = workingMessages.find(m => m.role === 'system');
        if (systemMsg) {
            systemMsg.content += schemaInstruction;
        }
        else {
            workingMessages.unshift({ role: 'system', content: schemaInstruction });
        }
        retryBody.messages = workingMessages;
        const retryResponse = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(retryBody),
            signal,
        });
        if (!retryResponse.ok) {
            throw new Error(`${label}: ${retryResponse.status} ${retryResponse.statusText}`);
        }
        const retryData = await retryResponse.json();
        const retryContent = retryData.choices?.[0]?.message?.content;
        if (!retryContent) {
            throw new Error(`${label}: empty response content`);
        }
        return {
            content: retryContent,
            inputTokens: retryData.usage?.prompt_tokens ?? 0,
            outputTokens: retryData.usage?.completion_tokens ?? 0,
        };
    }
    if (!response.ok) {
        throw new Error(`${label}: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error(`${label}: empty response content`);
    }
    return {
        content,
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
    };
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
    const requestBody = {
        model: profile.model,
        system: systemParts.join('\n'),
        messages: nonSystem,
        max_tokens: options?.maxTokens ?? profile.maxTokens,
    };
    // Tool use: forces Anthropic to respond with a tool_use content block (guaranteed valid JSON)
    if (options?.tools && options.tools.length > 0) {
        requestBody.tools = options.tools.map(t => ({
            name: t.name,
            description: t.description ?? '',
            input_schema: t.input_schema,
        }));
        if (options.toolChoice) {
            requestBody.tool_choice = { type: 'tool', name: options.toolChoice };
        }
    }
    const response = await fetch(profile.endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': profile.apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(requestBody),
    });
    if (!response.ok) {
        throw new Error(`${profile.label}: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    // Extract tool_use input as clean JSON string (no sanitization needed)
    if (options?.tools) {
        const toolBlock = data.content.find((b) => b.type === 'tool_use');
        if (toolBlock) {
            return {
                content: JSON.stringify(toolBlock.input),
                inputTokens: data.usage?.input_tokens ?? 0,
                outputTokens: data.usage?.output_tokens ?? 0,
            };
        }
    }
    const textBlock = data.content.find((b) => b.type === 'text');
    if (!textBlock) {
        throw new Error(`${profile.label}: no text or tool_use content block in response`);
    }
    return {
        content: textBlock.text,
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
    };
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
    let lastError = 'no providers configured';
    if (runtime.primary) {
        const start = performance.now();
        try {
            const { content: raw, inputTokens: inT, outputTokens: outT } = await callProfile(runtime.primary, messages, options);
            const elapsed = Math.round(performance.now() - start);
            console.log('[llm] Provider: %s (%s) — %dms', runtime.primary.label, runtime.primary.model, elapsed);
            if (inT > 0 || outT > 0)
                recordTokens(inT, outT);
            transparency.emit({ type: 'llm_raw', data: { raw, ms: elapsed } });
            const stripped = stripThinkingTags(raw);
            transparency.emit({ type: 'llm_stripped', data: { stripped } });
            return stripped;
        }
        catch (err) {
            const elapsed = Math.round(performance.now() - start);
            lastError = String(err);
            console.warn('[llm] %s failed after %dms: %s — trying fallback', runtime.primary.label, elapsed, lastError);
            // Emit to transparency so the error is visible in the UI panel, not just console
            transparency.emit({ type: 'error', data: {
                    source: `llm:${runtime.primary.label}`,
                    error: `${runtime.primary.model} failed after ${elapsed}ms: ${lastError}`,
                } });
        }
    }
    if (runtime.fallback) {
        const start = performance.now();
        try {
            const { content: raw, inputTokens: inT, outputTokens: outT } = await callProfile(runtime.fallback, messages, options);
            const elapsed = Math.round(performance.now() - start);
            console.log('[llm] Provider: %s (%s) — %dms', runtime.fallback.label, runtime.fallback.model, elapsed);
            if (inT > 0 || outT > 0)
                recordTokens(inT, outT);
            transparency.emit({ type: 'llm_raw', data: { raw, ms: elapsed } });
            const stripped = stripThinkingTags(raw);
            transparency.emit({ type: 'llm_stripped', data: { stripped } });
            return stripped;
        }
        catch (err) {
            const elapsed = Math.round(performance.now() - start);
            lastError = String(err);
            console.warn('[llm] %s failed after %dms: %s', runtime.fallback.label, elapsed, lastError);
            transparency.emit({ type: 'error', data: {
                    source: `llm:${runtime.fallback.label}`,
                    error: `${runtime.fallback.model} failed after ${elapsed}ms: ${lastError}`,
                } });
        }
    }
    throw new Error(`All LLM providers unreachable. Last error: ${lastError}`);
}
