import type { Message } from './types.js';
/**
 * Call LLM with Gemini primary and optional fallback.
 */
export declare function callLLM(messages: Message[]): Promise<string>;
