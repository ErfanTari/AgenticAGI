import type { IndexEntry } from './types.js';
export interface SearchResult {
    entry: IndexEntry;
    score: number;
    source: 'bm25' | 'vector' | 'hybrid';
}
/**
 * Reciprocal Rank Fusion — merges two ranked lists into one.
 * Standard RRF with k=60. Higher score = more relevant.
 */
export declare function reciprocalRankFusion(bm25: Array<{
    code: string;
    score: number;
}>, vector: Array<{
    code: string;
    score: number;
}>, k?: number): Array<{
    code: string;
    score: number;
}>;
/**
 * Hybrid search — orchestrates BM25 + optional vector search + RRF merge.
 * Falls back to BM25-only when embedding API is unavailable.
 * Returns top results with their source entries.
 */
export declare function hybridSearch(query: string, options?: {
    nb?: string;
    limit?: number;
}): Promise<SearchResult[]>;
export { cosineSimilarity } from './embeddings.js';
export declare function reIndexAllEntries(): Promise<void>;
export declare function checkEmbeddingMigration(): Promise<void>;
