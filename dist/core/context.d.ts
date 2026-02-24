import type { Message, ResolvedMemory, Intent, LLMHandler } from './types.js';
import type { Skill } from './skills/types.js';
export interface ContextHistory {
    turns: Message[];
    summary?: string;
}
export declare function getIndexSummary(): string;
/**
 * Build rolling context with summarization for long histories.
 * When history exceeds SUMMARY_THRESHOLD turns, summarize old turns and keep recent turns verbatim.
 * Falls back gracefully if summarization fails.
 */
export declare function buildRollingContext(history: Message[], llmHandler: LLMHandler): Promise<ContextHistory>;
export declare function buildContext(userMessage: string, resolved: ResolvedMemory | null, history: Message[], skills: Skill[], intent?: Intent, skillOutput?: string, llmHandler?: LLMHandler): Promise<Message[]>;
/**
 * Count exact tokens using gpt-tokenizer.
 * Can accept either a string or Message array.
 */
export declare function estimateTokens(input: string | Message[]): number;
