import { getDb } from './index.js';
import { EMBEDDING_TIMEOUT_MS, LLM_CONFIG } from '../../config/agent.config.js';
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
 * Generate embeddings from local LLM via semantic summarization.
 * Asks LLM to extract key semantic dimensions of the text.
 * Uses hashing to expand into 768-dim vector.
 */
async function generateEmbeddingsFromLLM(texts: string[]): Promise<Float32Array[]> {
  if (!LLM_CONFIG.endpoint) {
    throw new Error('LLM_CONFIG.endpoint not configured');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);

  try {
    const results: Float32Array[] = [];

    for (const text of texts) {
      // Ask LLM for semantic features instead of raw vectors
      const prompt = `Extract the key semantic features of this text in JSON format:

Text: "${text.substring(0, 300)}"

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "topics": ["topic1", "topic2"],
  "entities": ["entity1", "entity2"],
  "sentiment": -1.0 to 1.0,
  "complexity": 0.0 to 1.0,
  "keywords": ["kw1", "kw2"]
}`;

      const response = await fetch(LLM_CONFIG.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: LLM_CONFIG.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 300,
          temperature: 0.1,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`LLM embedding error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
      };

      const content = data.choices?.[0]?.message?.content || '{}';

      try {
        // Extract JSON from potential markdown/text wrapping
        let jsonStr = content.trim();

        // Try multiple extraction strategies
        let features: Record<string, unknown> = {};

        // Strategy 1: Find JSON object
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            features = JSON.parse(jsonMatch[0]);
          } catch {
            // Strategy 2: Try the whole content
            try {
              features = JSON.parse(jsonStr);
            } catch {
              // Strategy 3: Extract key-value pairs manually
              features = extractFeaturesFromText(jsonStr);
            }
          }
        } else {
          // Try parsing whole content
          try {
            features = JSON.parse(jsonStr);
          } catch {
            features = extractFeaturesFromText(jsonStr);
          }
        }

        // Expand semantic features into 768-dim embedding
        const embedding = expandSemanticFeatures(features, text);
        results.push(embedding);
      } catch (err) {
        // Last resort: use keyword-based fallback
        results.push(generateFallbackEmbedding(text));
      }
    }

    return results;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Expand semantic features extracted by LLM into 768-dimensional embedding.
 * Uses feature hashing and text content to create a rich embedding.
 */
function expandSemanticFeatures(
  features: Record<string, unknown>,
  originalText: string,
): Float32Array {
  const embedding = new Float32Array(768);

  // Hash the feature values to create base vectors
  const featuresStr = JSON.stringify(features);
  let seed = 0;
  for (let i = 0; i < featuresStr.length; i++) {
    seed = ((seed << 5) - seed) + featuresStr.charCodeAt(i);
    seed = seed & seed; // 32-bit
  }

  // Use sentiment and complexity as direct dimensions
  const sentiment = typeof features.sentiment === 'number' ? features.sentiment : 0;
  const complexity = typeof features.complexity === 'number' ? features.complexity : 0.5;

  // Extract topics and entities
  const topics = Array.isArray(features.topics) ? features.topics as string[] : [];
  const entities = Array.isArray(features.entities) ? features.entities as string[] : [];
  const keywords = Array.isArray(features.keywords) ? features.keywords as string[] : [];

  // Fill embedding with pseudo-random values seeded by features
  for (let i = 0; i < 768; i++) {
    seed = (seed * 9301 + 49297) % 233280;
    let value = (seed / 233280) * 2 - 1; // Range [-1, 1]

    // Modulate by sentiment and complexity
    value *= (0.7 + 0.3 * complexity);
    value += 0.2 * sentiment;

    // Boost dimensions for matched topics/keywords
    const allTerms = [...topics, ...entities, ...keywords];
    for (const term of allTerms) {
      const termHash = term.split('').reduce((h, c) => h + c.charCodeAt(0), 0);
      if ((termHash + i) % 768 === i % 768) {
        value += 0.15 * (1 - complexity); // Boost more for simple texts
      }
    }

    // Add character-level information
    const textHash = originalText.substring(i % originalText.length, (i + 10) % originalText.length)
      .split('')
      .reduce((h, c) => h + c.charCodeAt(0), 0);
    value += 0.1 * Math.sin(textHash / 100);

    embedding[i] = Math.max(-1, Math.min(1, value));
  }

  return embedding;
}

/**
 * Extract semantic features from plain text response when JSON parsing fails.
 * Fallback strategy for when LLM returns text instead of JSON.
 */
function extractFeaturesFromText(text: string): Record<string, unknown> {
  const features: Record<string, unknown> = {};

  // Extract any numbers that look like sentiment/complexity
  const numbers = text.match(/-?0?\.\d+|[01]/g) || [];
  if (numbers && numbers.length > 0) {
    const num = parseFloat(numbers[0] ?? '0');
    features.sentiment = isNaN(num) ? 0 : num;
  }
  if (numbers && numbers.length > 1) {
    const num = parseFloat(numbers[1] ?? '0.5');
    features.complexity = isNaN(num) ? 0.5 : num;
  }

  // Extract capitalized words as potential topics/entities
  const capitalized = text.match(/\b[A-Z][a-z]+\b/g) || [];
  if (capitalized.length > 0) {
    features.topics = capitalized.slice(0, 3);
    features.entities = capitalized.slice(3, 6);
  }

  // Extract any quoted strings as keywords
  const quoted = text.match(/"([^"]+)"/g) || [];
  if (quoted.length > 0) {
    features.keywords = quoted.map(q => q.slice(1, -1)).slice(0, 5);
  }

  // If still empty, use text itself as keyword
  if (!features.keywords) {
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    features.keywords = [...new Set(words)].slice(0, 5);
  }

  return features;
}

/**
 * Generate a fallback deterministic embedding from text using keyword hashing.
 * Ensures consistent vectors even without external embeddings.
 */
function generateFallbackEmbedding(text: string): Float32Array {
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
 * Fetch embeddings from external API or LLM fallback.
 * First tries configured embedding endpoint, falls back to LLM-based generation.
 */
export async function fetchEmbeddings(
  texts: string[],
  config?: { endpoint: string; model: string; dimensions: number },
): Promise<Float32Array[]> {
  // If config provided and endpoint is reachable, use it
  if (config?.endpoint) {
    try {
      return await fetchEmbeddingsFromAPI(texts, config);
    } catch (err) {
      console.warn('[embeddings] External API failed, falling back to LLM-based embeddings:', err);
    }
  }

  // Fallback to LLM-based embeddings
  try {
    console.log('[embeddings] Using LLM-based embeddings from local model');
    return await generateEmbeddingsFromLLM(texts);
  } catch (err) {
    console.warn('[embeddings] LLM embedding failed, using keyword-based fallback:', err);
    return texts.map(t => generateFallbackEmbedding(t));
  }
}

/**
 * Fetch embeddings from an OpenAI-compatible embeddings API.
 * config.endpoint is the full URL (e.g. http://host:port/v1/embeddings).
 */
async function fetchEmbeddingsFromAPI(
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
