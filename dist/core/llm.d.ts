import type { Message } from './types.js';
type LLMCallOptions = {
    responseSchema?: Record<string, unknown>;
    maxTokens?: number;
};
export type OpenAICompatibleLLMProfile = {
    kind: 'openai-compatible';
    label: string;
    endpoint: string;
    model: string;
    apiKey?: string;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
};
export type AnthropicLLMProfile = {
    kind: 'anthropic';
    label: string;
    endpoint: string;
    model: string;
    apiKey: string;
    maxTokens: number;
    timeoutMs: number;
};
export type LLMProfile = OpenAICompatibleLLMProfile | AnthropicLLMProfile;
type LLMRuntimeOverride = {
    primary: LLMProfile | null;
    fallback: LLMProfile | null;
};
export declare function getPrimaryLLMProfile(): LLMProfile | null;
export declare function getFallbackLLMProfile(): LLMProfile | null;
export declare function withLLMRuntime<T>(runtime: LLMRuntimeOverride, fn: () => Promise<T>): Promise<T>;
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
export declare function stripThinkingTags(raw: string): string;
/**
 * Call LLM with automatic fallback.
 *
 * Flow:
 * 1. Try primary (Mac Studio) with tiered timeout based on model size
 * 2. If unreachable or times out → fall back to the configured cloud provider
 * 3. Log which provider handled the request + response time
 * 4. Never crash — callers catch the final throw
 */
export declare function callLLM(messages: Message[], options?: LLMCallOptions): Promise<string>;
export {};
