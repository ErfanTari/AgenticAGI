import type { IndexEntry, CreateEntryInput } from './types.js';
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
