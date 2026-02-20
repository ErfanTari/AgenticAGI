import type { IndexEntry } from './memory/types.js';
export interface Notification {
    type: 'upcoming_event' | 'overdue_todo' | 'stale_question' | 'stale_plan' | 'stale_project';
    entries: IndexEntry[];
    message: string;
}
export interface HeartbeatResult {
    ran_at: string;
    notifications: Notification[];
    created: IndexEntry | null;
}
export declare function checkUpcomingEvents(): Notification | null;
export declare function checkOverdueTodos(): Notification | null;
export declare function checkStaleQuestions(): Notification | null;
export declare function checkStalePlans(): Notification | null;
export declare function checkStaleProjects(): Notification | null;
export declare function runHeartbeat(): HeartbeatResult;
