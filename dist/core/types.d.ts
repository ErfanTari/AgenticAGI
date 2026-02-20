import type { IndexEntry, Relationship } from './memory/types.js';
export type Intent = 'greeting' | 'code_fetch' | 'memory_query' | 'relationship_query' | 'memory_write' | 'web_search' | 'general';
export interface Classification {
    intent: Intent;
    codes: string[];
    nb?: string;
    type?: string;
    status?: string;
    name?: string;
    relation?: string;
}
export interface Message {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
export interface ResolvedMemory {
    step: number;
    entries: IndexEntry[];
    contents: string[];
    relationships: Relationship[];
}
export type LLMHandler = (messages: Message[]) => Promise<string>;
export interface AgentResponse {
    reply: string;
    intent: Intent;
    resolved: ResolvedMemory | null;
    created?: IndexEntry;
    error?: string;
    notifications?: Array<{
        type: string;
        entries: IndexEntry[];
        message: string;
    }>;
}
