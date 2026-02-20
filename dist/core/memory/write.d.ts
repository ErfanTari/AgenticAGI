import type { IndexEntry, CreateEntryInput } from './types.js';
export declare function createEntry(input: CreateEntryInput): IndexEntry;
export declare function updateEntry(code: string, updates: {
    status?: string;
    summary?: string;
}): IndexEntry;
