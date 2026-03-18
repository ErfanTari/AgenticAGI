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
export declare function runHeartbeat(): Promise<HeartbeatResult>;
