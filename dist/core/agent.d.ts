import type { AgentResponse, LLMHandler, Message } from './types.js';
import type { TaskPlan } from './schemas.js';
export declare let isProcessingMessage: boolean;
/** Exported for testing only. */
export declare function _getPendingConfirmationPlan(): TaskPlan | null;
/** Exported for testing only. */
export declare function _setPendingConfirmationPlan(plan: TaskPlan | null): void;
export declare function startAgent(): void;
export declare function stopAgent(): void;
export declare function processMessage(message: string, history: Message[], options?: {
    llmHandler?: LLMHandler;
}): Promise<AgentResponse>;
