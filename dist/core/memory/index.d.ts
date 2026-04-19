import Database from 'better-sqlite3';
import type { IndexEntry, QueryFilter } from './types.js';
/**
 * Scan all .md files under memory/ and index any that are missing from SQLite
 * or whose file mtime is newer than their `updated` field in index_entries.
 *
 * Safe to call at every startup regardless of DB state.
 * Catches files added outside the agent's own write path (git pull, manual edits).
 */
export declare function syncMemoryFilesToIndex(): {
    added: number;
    updated: number;
    errors: number;
};
export declare function initDatabase(dbPath?: string): Database.Database;
export declare function getDb(): Database.Database;
export declare function getSettingValue(d: Database.Database, key: string): string | null;
export declare function setSettingValue(d: Database.Database, key: string, value: string): void;
/**
 * H2 — Reconcile operational metadata from frontmatter into SQLite rows.
 * Runs at startup: if a row has all-zero operational scores but the .md file
 * has non-zero values (written by C4), restore them into SQLite.
 */
export declare function reconcileOperationalMetadata(): void;
export declare function insertEntry(entry: IndexEntry): void;
export declare function getEntryByCode(code: string): IndexEntry | undefined;
export declare function queryEntries(filter: QueryFilter): IndexEntry[];
/**
 * Atomically increment and return the next counter value for a given type key.
 * Uses a single SQLite transaction to prevent race conditions and avoids
 * the lexicographic sort bug that getMaxNumber() had.
 */
export declare function nextCounter(typeKey: string): number;
export declare function getNotebookCounts(): Array<{
    nb: string;
    count: number;
}>;
export declare function closeDatabase(): void;
/**
 * savePendingPlan — persist a pending plan to SQLite (singleton row id=1)
 */
export declare function savePendingPlan(plan: unknown): void;
/**
 * loadPendingPlan — retrieve pending plan from SQLite, returns null if none
 */
export declare function loadPendingPlan(): unknown | null;
/**
 * clearPendingPlan — delete pending plan from SQLite
 */
export declare function clearPendingPlan(): void;
export interface PendingUserInput {
    question: string;
    context?: string;
    createdAt: string;
}
export declare function savePendingUserInput(question: string, context?: string): void;
export declare function loadPendingUserInput(): PendingUserInput | null;
export declare function clearPendingUserInput(): void;
