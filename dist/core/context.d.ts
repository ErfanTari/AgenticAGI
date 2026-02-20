import type { Message, ResolvedMemory, Intent } from './types.js';
import type { Skill } from './skills/types.js';
export declare function getIndexSummary(): string;
export declare function buildContext(userMessage: string, resolved: ResolvedMemory | null, history: Message[], skills: Skill[], intent?: Intent): Message[];
export declare function estimateTokens(messages: Message[]): number;
