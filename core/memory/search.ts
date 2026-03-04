import fs from 'node:fs';
import { EMBEDDING_CONFIG } from '../../config/agent.config.js';
import { getDb, getEntryByCode, queryEntries } from './index.js';
import { searchBM25 } from './fts.js';
import { fetchEmbeddings, searchVectors } from './embeddings.js';
import { indexContent } from './fts.js';
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
  // Always attempt embeddings (tries external API first, falls back to LLM)
  let vectorResults: Array<{ code: string; score: number }> = [];

  try {
    const [queryEmbedding] = await fetchEmbeddings([query], EMBEDDING_CONFIG ?? undefined);
    const rawVector = searchVectors(queryEmbedding, { nb: options?.nb, limit: 10 });
    vectorResults = rawVector.map(r => ({ code: r.code, score: r.score }));
  } catch {
    console.log('[search] Vector embedding failed — using BM25 only');
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

// --- Embedding migration detection ---

// BUG-7 fix: store full model name string in settings table instead of a char-code sum hash.
// Char-code sums can collide (e.g. "abc" == "bca"), causing silent false negatives.
export async function reIndexAllEntries(): Promise<void> {
  try {
    const d = getDb();
    const entries = queryEntries({}).filter(e => e.status !== 'archived');
    console.log(`[embed-migration] Re-indexing ${entries.length} entries...`);

    // BUG-H5 fix: clear all FTS rows before full rebuild to prevent duplicates
    d.prepare('DELETE FROM fts_content').run();

    // BUG-H6 fix: clear stale chunk vectors so hybrid search doesn't use wrong-model embeddings
    d.prepare('DELETE FROM chunks').run();

    for (const entry of entries) {
      try {
        if (!fs.existsSync(entry.path)) continue;
        const content = fs.readFileSync(entry.path, 'utf-8');
        indexContent(entry.code, entry.nb, content);
      } catch {
        // per-entry errors are silently ignored
      }
    }

    console.log('[embed-migration] Re-indexing complete. Chunk vectors cleared — will regenerate on next write.');
  } catch (err) {
    console.warn('[embed-migration] reIndexAllEntries failed:', err);
  }
}

export async function checkEmbeddingMigration(): Promise<void> {
  try {
    const d = getDb();
    const currentModel = process.env.EMBEDDING_MODEL ?? '';

    const row = d.prepare("SELECT value FROM settings WHERE key = 'embedding_model'")
      .get() as { value: string } | undefined;
    const storedModel = row?.value ?? '';

    if (storedModel !== '' && storedModel !== currentModel) {
      console.warn(
        `[embed-migration] Embedding model changed ("${storedModel}" → "${currentModel}"). Re-indexing all entries...`,
      );
      await reIndexAllEntries();
    }

    // Update stored model name (upsert)
    d.prepare(
      "INSERT INTO settings (key, value) VALUES ('embedding_model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(currentModel);
  } catch {
    // Never block any caller
  }
}
