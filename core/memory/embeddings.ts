import { getDb } from './index.js';
import { EMBEDDING_TIMEOUT_MS } from '../../config/agent.config.js';
import type { Chunk } from './chunks.js';

/**
 * Create the chunks table for storing text chunks with optional embeddings.
 */
export function initChunksTable(): void {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      heading TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB,
      FOREIGN KEY (code) REFERENCES index_entries(code)
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_code ON chunks(code);
  `);
}

/**
 * Store chunks into the chunks table with optional embeddings.
 */
export function storeChunks(
  chunks: Chunk[],
  embeddings?: Float32Array[],
): void {
  const d = getDb();
  const stmt = d.prepare(
    'INSERT INTO chunks (code, chunk_index, heading, text, embedding) VALUES (?, ?, ?, ?, ?)'
  );
  const insertAll = d.transaction(() => {
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const emb = embeddings?.[i]
        ? Buffer.from(embeddings[i].buffer, embeddings[i].byteOffset, embeddings[i].byteLength)
        : null;
      stmt.run(c.code, c.chunkIndex, c.heading, c.text, emb);
    }
  });
  insertAll();
}

/**
 * Cosine similarity between two Float32Arrays.
 * Returns value between -1 and 1. Returns 0 if either vector has zero magnitude.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error('Vector length mismatch');

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;

  return dot / denom;
}

/**
 * Fetch embeddings from an OpenAI-compatible embeddings API.
 * config.endpoint is the full URL (e.g. http://host:port/v1/embeddings).
 */
export async function fetchEmbeddings(
  texts: string[],
  config: { endpoint: string; model: string; dimensions: number },
): Promise<Float32Array[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);

  // Build headers with optional API key for hosted providers
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = process.env.JINA_API_KEY
    || process.env.OPENAI_API_KEY
    || process.env.VOYAGE_API_KEY
    || process.env.COHERE_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let resp: Response;
  try {
    resp = await fetch(config.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        input: texts,
        model: config.model,
        encoding_format: 'float',
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    throw new Error(`Embedding API error: ${resp.status} ${resp.statusText}`);
  }

  const json = await resp.json() as {
    data: Array<{ embedding: number[]; index: number }>;
  };

  // Sort by index to maintain input order
  const sorted = json.data.sort((a, b) => a.index - b.index);
  return sorted.map(d => new Float32Array(d.embedding));
}

/**
 * Brute-force cosine similarity search over stored chunk embeddings.
 * Returns top results sorted by descending similarity.
 */
export function searchVectors(
  queryVector: Float32Array,
  options?: { nb?: string; limit?: number },
): Array<{ code: string; chunkIndex: number; heading: string; text: string; score: number }> {
  const d = getDb();
  const limit = options?.limit ?? 10;

  let rows: Array<{ code: string; chunk_index: number; heading: string; text: string; embedding: Buffer }>;

  if (options?.nb) {
    rows = d.prepare(`
      SELECT c.code, c.chunk_index, c.heading, c.text, c.embedding
      FROM chunks c
      JOIN index_entries e ON c.code = e.code
      WHERE c.embedding IS NOT NULL AND e.nb = ?
    `).all(options.nb) as typeof rows;
  } else {
    rows = d.prepare(`
      SELECT code, chunk_index, heading, text, embedding
      FROM chunks
      WHERE embedding IS NOT NULL
    `).all() as typeof rows;
  }

  const results = rows.map(row => {
    const storedVec = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength / 4,
    );
    return {
      code: row.code,
      chunkIndex: row.chunk_index,
      heading: row.heading,
      text: row.text,
      score: cosineSimilarity(queryVector, storedVec),
    };
  });

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
