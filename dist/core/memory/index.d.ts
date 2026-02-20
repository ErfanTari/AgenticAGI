import Database from 'better-sqlite3';
import type { IndexEntry, QueryFilter } from './types.js';
export declare function initDatabase(dbPath?: string): Database.Database;
export declare function getDb(): Database.Database;
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
