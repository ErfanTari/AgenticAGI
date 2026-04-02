import type { IndexEntry } from './memory/types.js';
export interface Notification {
    type: 'upcoming_event' | 'overdue_todo' | 'stale_question' | 'stale_plan' | 'stale_project' | 'vision_drift' | 'stale_project_brain';
    entries: IndexEntry[];
    message: string;
}
export interface HeartbeatResult {
    ran_at: string;
    notifications: Notification[];
    created: IndexEntry[];
}
/** Call this whenever the agent processes a message. */
export declare function recordActivity(): void;
export declare function startHeartbeat(): void;
export declare function stopHeartbeat(): void;
export declare function checkDeadlines(): Notification | null;
export declare function checkOverdueTodos(): Notification | null;
export declare function checkStaleQuestions(): Notification | null;
export declare function checkPlanCalibration(): Notification | null;
export declare function checkStaleProjects(): Notification | null;
export declare function checkStalePlanPJ(): Notification | null;
export declare function checkAMemLinker(): {
    processed: number;
    codes: string[];
};
export declare function checkVisionAlignment(): Notification | null;
export declare function checkNowTTL(): Promise<Notification | null>;
/**
 * Phase 16 — AutoDream
 * When the agent has been idle for >10 minutes, reads today's WHEN.EV entries
 * and refreshes the pointer index with any coded references found in their content.
 * This keeps MEMORY.md up-to-date with recently referenced codes without a full scan.
 */
export declare function checkAutoDream(): Promise<Notification | null>;
export declare function runHeartbeat(): Promise<HeartbeatResult>;
