import { getDb } from './index.js';

/**
 * Initialize the FTS5 virtual table for full-text search.
 * Uses porter stemming for better keyword matching (e.g. "ceramics" matches "ceramic").
 * code and nb are UNINDEXED — stored for retrieval but not searchable.
 */
export function initFTS(): void {
  const d = getDb();
  d.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_content USING fts5(
      code UNINDEXED, nb UNINDEXED, content,
      tokenize = 'porter ascii'
    );
  `);
}

/**
 * Index an entry's content into FTS5.
 * Called inside createEntry transaction (sync).
 */
export function indexContent(code: string, nb: string, content: string): void {
  const d = getDb();
  d.prepare(
    'INSERT INTO fts_content (code, nb, content) VALUES (?, ?, ?)'
  ).run(code, nb, content);
}

/**
 * Strip FTS5 special operators to prevent syntax errors on user input.
 * Removes: " * ( ) { } : ^ ~ + - AND OR NOT NEAR
 */
export function sanitizeFTSQuery(query: string): string {
  // Remove FTS5 special characters and operators
  let sanitized = query
    .replace(/[*"(){}:^~+-]/g, ' ')
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // If empty after sanitization, return empty string
  if (!sanitized) return '';

  // Join tokens with OR for maximum recall on vague queries.
  // BM25 still ranks docs with more matching terms higher.
  const tokens = sanitized.split(/\s+/).filter(t => t.length > 0);
  if (tokens.length === 0) return '';
  if (tokens.length === 1) return tokens[0];
  return tokens.join(' OR ');
}

/**
 * BM25 keyword search over FTS5-indexed content.
 * Returns results ordered by relevance (lower bm25 = more relevant).
 */
export function searchBM25(
  query: string,
  options?: { nb?: string; limit?: number },
): Array<{ code: string; score: number }> {
  const sanitized = sanitizeFTSQuery(query);
  if (!sanitized) return [];

  const d = getDb();
  const limit = options?.limit ?? 10;

  if (options?.nb) {
    const rows = d.prepare(`
      SELECT code, bm25(fts_content) AS score
      FROM fts_content
      WHERE fts_content MATCH ? AND nb = ?
      ORDER BY score
      LIMIT ?
    `).all(sanitized, options.nb, limit) as Array<{ code: string; score: number }>;
    return rows;
  }

  const rows = d.prepare(`
    SELECT code, bm25(fts_content) AS score
    FROM fts_content
    WHERE fts_content MATCH ?
    ORDER BY score
    LIMIT ?
  `).all(sanitized, limit) as Array<{ code: string; score: number }>;
  return rows;
}
