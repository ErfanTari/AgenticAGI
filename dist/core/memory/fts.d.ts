/**
 * Initialize the FTS5 virtual table for full-text search.
 * Uses porter stemming for better keyword matching (e.g. "ceramics" matches "ceramic").
 * code and nb are UNINDEXED — stored for retrieval but not searchable.
 */
export declare function initFTS(): void;
/**
 * Index an entry's content into FTS5.
 * Called inside createEntry transaction (sync).
 */
export declare function indexContent(code: string, nb: string, content: string): void;
/**
 * Strip FTS5 special operators to prevent syntax errors on user input.
 * Removes: " * ( ) { } : ^ ~ + - AND OR NOT NEAR
 */
export declare function sanitizeFTSQuery(query: string): string;
/**
 * BM25 keyword search over FTS5-indexed content.
 * Returns results ordered by relevance (lower bm25 = more relevant).
 */
export declare function searchBM25(query: string, options?: {
    nb?: string;
    limit?: number;
}): Array<{
    code: string;
    score: number;
}>;
