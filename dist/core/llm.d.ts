import type { Message } from './types.js';
export type ToolDefinition = {
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
};
type LLMCallOptions = {
    responseSchema?: Record<string, unknown>;
    maxTokens?: number;
    temperature?: number;
    disableThinking?: boolean;
    /** Force Anthropic tool_use content blocks for structured JSON output */
    tools?: ToolDefinition[];
    /** Name of the tool to force (used with tool_choice: {type:'tool', name}) */
    toolChoice?: string;
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
export declare function getAnthropicCloudProfile(): LLMProfile | null;
export declare function withLLMRuntime<T>(runtime: LLMRuntimeOverride, fn: () => Promise<T>): Promise<T>;
/**
 * Strip model reasoning/thinking artifacts from LLM responses.
 * Applied to EVERY response before it touches any downstream logic.
 */
export declare function stripThinkingTags(text: string): string;
/**
 * Sanitizes final output before returning to the user.
 * Removes control tokens, thinking tags, and pseudo-tool narratives.
 * Returns cleaned text.
 *
 * FIX D: Prevents leaked tool syntax and thinking text from appearing to the user.
 */
export declare function sanitizeFinalOutput(text: string): string;
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
