import type { IndexEntry, Relationship } from './memory/types.js';
export type Intent = 'greeting' | 'code_fetch' | 'memory_query' | 'synthesis_query' | 'relationship_query' | 'relationship_write' | 'memory_write' | 'web_search' | 'skill' | 'planned_workflow' | 'episodic_query' | 'meeting' | 'general';
export interface Classification {
    intent: Intent;
    codes: string[];
    nb?: string;
    type?: string;
    status?: string;
    name?: string;
    relation?: string;
    skill?: string;
    skillInput?: Record<string, unknown>;
    due_date?: string;
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
export type LLMHandler = (messages: Message[], options?: {
    responseSchema?: Record<string, unknown>;
    maxTokens?: number;
}) => Promise<string>;
export interface AgentResponse {
    reply: string;
    intent: Intent;
    resolved: ResolvedMemory | null;
    created?: IndexEntry;
    error?: string;
    retries?: number;
    notifications?: Array<{
        type: string;
        entries: IndexEntry[];
        message: string;
    }>;
}
