import type { IndexEntry, CreateEntryInput } from './types.js';
/**
 * FIX 3 — Atomic file write using a .tmp intermediate file.
 * Writes to filePath.tmp first, then atomically renames to filePath.
 * On the same filesystem, rename() is atomic — no partial file is ever visible.
 * If rename fails, the .tmp file is cleaned up before throwing.
 */
export declare function atomicWriteFile(filePath: string, content: string): void;
export declare function createEntry(input: CreateEntryInput): IndexEntry;
/**
 * upsertEntry — create or update based on exact nb+type+name match.
 *
 * If an active entry with the same (nb, type, name) already exists,
 * updates its summary and body content instead of creating a duplicate.
 *
 * Returns: { code, created: true } on new creation, { code, created: false } on update.
 */
export declare function upsertEntry(input: CreateEntryInput): {
    code: string;
    created: boolean;
};
export declare function updateEntry(code: string, updates: {
    status?: string;
    summary?: string;
}): IndexEntry;
