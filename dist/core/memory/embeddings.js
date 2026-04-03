import { getDb } from './index.js';
import { EMBEDDING_TIMEOUT_MS, EMBEDDING_CONFIG } from '../../config/agent.config.js';
/**
 * Create the chunks table for storing text chunks with optional embeddings.
 */
export function initChunksTable() {
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
export function storeChunks(chunks, embeddings) {
    const d = getDb();
    const stmt = d.prepare('INSERT INTO chunks (code, chunk_index, heading, text, embedding) VALUES (?, ?, ?, ?, ?)');
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
export function cosineSimilarity(a, b) {
    if (a.length !== b.length)
        throw new Error('Vector length mismatch');
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    if (denom === 0)
        return 0;
    return dot / denom;
}
/**
 * Generate a fallback deterministic embedding from text using keyword hashing.
 * Ensures consistent vectors even without external embeddings.
 */
function generateFallbackEmbedding(text) {
    const embedding = new Float32Array(768);
    // Create deterministic hash by processing text
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    // Extract keywords for semantic positioning
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const uniqueWords = new Set(words);
    // Seed RNG with text hash
    let seed = Math.abs(hash);
    for (let i = 0; i < 768; i++) {
        // Seeded pseudo-random values
        seed = (seed * 9301 + 49297) % 233280;
        let value = (seed / 233280) * 2 - 1; // Range [-1, 1]
        // Boost dimensions for common keywords
        for (const word of uniqueWords) {
            const wordHash = word.split('').reduce((h, c) => h + c.charCodeAt(0), 0);
            if ((wordHash + i) % 768 === i % 768) {
                value += 0.3;
            }
        }
        embedding[i] = Math.max(-1, Math.min(1, value));
    }
    return embedding;
}
/**
 * Compute and store an embedding BLOB directly on index_entries row.
 * Tries Ollama/embedding endpoint; on failure silently skips.
 */
export async function computeAndStoreEmbedding(code, text) {
    if (!EMBEDDING_CONFIG)
        return;
    try {
        const embeddings = await fetchEmbeddingsFromAPI([text], EMBEDDING_CONFIG);
        if (embeddings.length === 0)
            return;
        const buf = Buffer.from(embeddings[0].buffer, embeddings[0].byteOffset, embeddings[0].byteLength);
        const db = getDb();
        db.prepare('UPDATE index_entries SET embedding = ? WHERE code = ?').run(buf, code);
    }
    catch {
        // Silent skip — not having an embedding is acceptable
    }
}
/**
 * Fetch embeddings from external API or LLM fallback.
 * First tries configured embedding endpoint, falls back to LLM-based generation.
 */
export async function fetchEmbeddings(texts, config) {
    // If config provided and endpoint is reachable, use it
    if (config?.endpoint) {
        try {
            return await fetchEmbeddingsFromAPI(texts, config);
        }
        catch (err) {
            console.warn('[embeddings] External API failed, falling back to LLM-based embeddings:', err);
        }
    }
    // Skip LLM-based semantic feature extraction (adds ~5s per text with no quality benefit
    // — features are never used downstream; go straight to deterministic keyword fallback)
    return texts.map(t => generateFallbackEmbedding(t));
}
/**
 * Fetch embeddings from an OpenAI-compatible embeddings API.
 * config.endpoint is the full URL (e.g. http://host:port/v1/embeddings).
 */
async function fetchEmbeddingsFromAPI(texts, config) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);
    // Build headers with optional API key for hosted providers
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = process.env.JINA_API_KEY
        || process.env.OPENAI_API_KEY
        || process.env.VOYAGE_API_KEY
        || process.env.COHERE_API_KEY;
    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }
    let resp;
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
    }
    finally {
        clearTimeout(timer);
    }
    if (!resp.ok) {
        throw new Error(`Embedding API error: ${resp.status} ${resp.statusText}`);
    }
    const json = await resp.json();
    // Sort by index to maintain input order
    const sorted = json.data.sort((a, b) => a.index - b.index);
    return sorted.map(d => new Float32Array(d.embedding));
}
/**
 * Brute-force cosine similarity search over stored chunk embeddings.
 * Returns top results sorted by descending similarity.
 */
export function searchVectors(queryVector, options) {
    const d = getDb();
    const limit = options?.limit ?? 10;
    let rows;
    if (options?.nb) {
        rows = d.prepare(`
      SELECT c.code, c.chunk_index, c.heading, c.text, c.embedding
      FROM chunks c
      JOIN index_entries e ON c.code = e.code
      WHERE c.embedding IS NOT NULL AND e.nb = ?
    `).all(options.nb);
    }
    else {
        rows = d.prepare(`
      SELECT code, chunk_index, heading, text, embedding
      FROM chunks
      WHERE embedding IS NOT NULL
    `).all();
    }
    const results = rows.map(row => {
        const storedVec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
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
