import type { Chunk } from './chunks.js';
/**
 * Create the chunks table for storing text chunks with optional embeddings.
 */
export declare function initChunksTable(): void;
/**
 * Store chunks into the chunks table with optional embeddings.
 */
export declare function storeChunks(chunks: Chunk[], embeddings?: Float32Array[]): void;
/**
 * Cosine similarity between two Float32Arrays.
 * Returns value between -1 and 1. Returns 0 if either vector has zero magnitude.
 */
export declare function cosineSimilarity(a: Float32Array, b: Float32Array): number;
/**
 * Fetch embeddings from external API or LLM fallback.
 * First tries configured embedding endpoint, falls back to LLM-based generation.
 */
export declare function fetchEmbeddings(texts: string[], config?: {
    endpoint: string;
    model: string;
    dimensions: number;
}): Promise<Float32Array[]>;
/**
 * Brute-force cosine similarity search over stored chunk embeddings.
 * Returns top results sorted by descending similarity.
 */
export declare function searchVectors(queryVector: Float32Array, options?: {
    nb?: string;
    limit?: number;
}): Array<{
    code: string;
    chunkIndex: number;
    heading: string;
    text: string;
    score: number;
}>;
