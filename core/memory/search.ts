import { EMBEDDING_CONFIG } from '../../config/agent.config.js';
import { getEntryByCode } from './index.js';
import { searchBM25 } from './fts.js';
import { fetchEmbeddings, searchVectors } from './embeddings.js';
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
export function reciprocalRankFusion(
  bm25: Array<{ code: string; score: number }>,
  vector: Array<{ code: string; score: number }>,
  k = 60,
): Array<{ code: string; score: number }> {
  const scores = new Map<string, number>();

  for (let i = 0; i < bm25.length; i++) {
    const code = bm25[i].code;
    scores.set(code, (scores.get(code) ?? 0) + 1 / (k + i + 1));
  }

  for (let i = 0; i < vector.length; i++) {
    const code = vector[i].code;
    scores.set(code, (scores.get(code) ?? 0) + 1 / (k + i + 1));
  }

  return Array.from(scores.entries())
    .map(([code, score]) => ({ code, score }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Hybrid search — orchestrates BM25 + optional vector search + RRF merge.
 * Falls back to BM25-only when embedding API is unavailable.
 * Returns top results with their source entries.
 */
export async function hybridSearch(
  query: string,
  options?: { nb?: string; limit?: number },
): Promise<SearchResult[]> {
  const limit = options?.limit ?? 3;

  // BM25 always available
  const bm25Results = searchBM25(query, { nb: options?.nb, limit: 10 });

  // Vector search — optional, best-effort
  let vectorResults: Array<{ code: string; score: number }> = [];

  if (EMBEDDING_CONFIG) {
    try {
      const [queryEmbedding] = await fetchEmbeddings([query], EMBEDDING_CONFIG);
      const rawVector = searchVectors(queryEmbedding, { nb: options?.nb, limit: 10 });
      vectorResults = rawVector.map(r => ({ code: r.code, score: r.score }));
    } catch {
      console.log('[search] Embedding server unreachable — using BM25 only');
    }
  }

  // Determine source and merge
  let merged: Array<{ code: string; score: number }>;
  let source: 'bm25' | 'vector' | 'hybrid';

  if (vectorResults.length > 0 && bm25Results.length > 0) {
    merged = reciprocalRankFusion(bm25Results, vectorResults);
    source = 'hybrid';
  } else if (vectorResults.length > 0) {
    merged = vectorResults;
    source = 'vector';
  } else {
    merged = bm25Results;
    source = 'bm25';
  }

  // Deduplicate by code and resolve entries
  const seen = new Set<string>();
  const results: SearchResult[] = [];

  for (const item of merged) {
    if (seen.has(item.code)) continue;
    seen.add(item.code);

    const entry = getEntryByCode(item.code);
    if (!entry) continue;

    results.push({ entry, score: item.score, source });
    if (results.length >= limit) break;
  }

  return results;
}

// Keep backward-compatible export name
export { cosineSimilarity } from './embeddings.js';
