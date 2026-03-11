import type { AgentResponse, LLMHandler, Message } from './types.js';
export declare let isProcessingMessage: boolean;
export declare function startAgent(): void;
export declare function stopAgent(): void;
export declare function processMessage(message: string, history: Message[], options?: {
    llmHandler?: LLMHandler;
}): Promise<AgentResponse>;
