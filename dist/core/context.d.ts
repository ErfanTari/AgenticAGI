import type { Message, ResolvedMemory, Intent, LLMHandler } from './types.js';
import type { IntakeSignals } from './intake.js';
import type { Skill } from './skills/types.js';
import type { IndexEntry } from './memory/types.js';
export declare function _resetCompactionCircuit(): void;
export declare function fetchOwnerPersona(): string | null;
/** Reset persona cache — used in tests */
export declare function _resetPersonaCache(): void;
export interface ContextHistory {
    turns: Message[];
    summary?: string;
}
/**
 * Trim history to fit within a token budget, walking backwards to keep the most recent turns.
 * BUG-6 fix: always returns at least the most recent message, even if it alone exceeds budget.
 * BUG-M1 fix: always preserve the last 2 turns (1 user + 1 assistant) regardless of budget.
 *             Falls back to just the last user message if even 2 turns exceed budget.
 */
export declare function trimHistoryToTokenBudget(history: Message[], budget: number): Message[];
/**
 * BM25F-inspired ranking with recency decay, importance, utility, and page boost.
 * Replaces the old rankByRelevance for richer scoring.
 */
export declare function rankByLightRAG(entries: IndexEntry[], message: string): IndexEntry[];
/**
 * Rank memory entries by relevance to the current message.
 * Alias for rankByLightRAG for backwards compatibility.
 */
export declare function rankByRelevance(entries: IndexEntry[], message: string): IndexEntry[];
export declare function getIndexSummary(): string;
/**
 * Build rolling context with summarization for long histories.
 * When history exceeds SUMMARY_THRESHOLD turns, summarize old turns and keep recent turns verbatim.
 * Falls back gracefully if summarization fails.
 */
export declare function buildRollingContext(history: Message[], llmHandler: LLMHandler): Promise<ContextHistory>;
export type ContextMode = 'default' | 'agentic_coding';
export declare function buildContext(userMessage: string, resolved: ResolvedMemory | null, history: Message[], skills: Skill[], intent?: Intent, skillOutput?: string, llmHandler?: LLMHandler, contextMode?: ContextMode, signals?: IntakeSignals | null): Promise<Message[]>;
/**
 * Count exact tokens using gpt-tokenizer.
 * Can accept either a string or Message array.
 */
export declare function estimateTokens(input: string | Message[]): number;
