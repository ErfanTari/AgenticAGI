import type { Message, LLMHandler, AgentResponse } from './types.js';
export declare function processMessage(message: string, history: Message[], options?: {
    llmHandler?: LLMHandler;
}): Promise<AgentResponse>;
