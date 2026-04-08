import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  initDatabase,
  closeDatabase,
  createEntry,
  searchBM25,
  sanitizeFTSQuery,
  chunkMarkdown,
  cosineSimilarity,
  storeChunks,
  searchVectors,
  hybridSearch,
  reciprocalRankFusion,
} from '../../core/memory/mod.js';
import { processMessage } from '../../core/agent.js';
import { PATHS } from '../../config/agent.config.js';
import { sessionCache } from '../../core/memory/session-cache.js';
import type { Message } from '../../core/types.js';
import type { Chunk } from '../../core/memory/chunks.js';

const TEST_DIR = path.join(os.tmpdir(), `agentic-agi-test-p4-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'memory.sqlite');
const TEST_MEMORY = path.join(TEST_DIR, 'memory');

const origDb = PATHS.db;
const origMemory = PATHS.memory;

let ceramicCode: string;
let projectCode: string;
let todoCode: string;

beforeAll(() => {
  // Clear session cache to prevent stale entries from previous tests/sessions
  sessionCache.clear();

  (PATHS as Record<string, string>).db = TEST_DB;
  (PATHS as Record<string, string>).memory = TEST_MEMORY;
  initDatabase(TEST_DB);

  // Create test entries — these get auto-indexed in FTS via createEntry
  const ceramicEntry = createEntry({
    nb: 'WHAT', type: 'KN', name: 'Ceramic Color Techniques',
    status: 'active',
    summary: 'Traditional ceramic glaze color formulation methods',
    body: 'This knowledge entry covers traditional ceramic glaze color work including oxide combinations, temperature profiles for color development, and historical Anatolian ceramic techniques. Key topics: cobalt blue glazes, iron red reduction firing, copper green oxidation.',
  });
  ceramicCode = ceramicEntry.code;

  const projectEntry = createEntry({
    nb: 'WHAT', type: 'PJ', name: 'Activation Xray',
    status: 'active',
    summary: 'AI interpretability project',
    body: 'Studying neural network activation patterns for interpretability research.',
  });
  projectCode = projectEntry.code;

  const todoEntry = createEntry({
    nb: 'NOW', type: 'TD', name: 'Review documentation',
    status: 'open',
    summary: 'Review all project docs',
    body: 'Go through all documentation and update outdated sections.',
  });
  todoCode = todoEntry.code;

  createEntry({
    nb: 'HOW', type: 'PR', name: 'Deploy Application',
    status: 'active',
    summary: 'Steps to deploy the application',
    body: 'Step 1: Build the project. Step 2: Run tests. Step 3: Push to production.',
  });

  createEntry({
    nb: 'WHO', type: 'CT', name: 'Erfan Tari',
    status: 'active',
    summary: 'Owner, developer, ceramic specialist',
    body: 'The owner of this platform. Deep interest in AI and ceramics.',
  });
});

afterAll(async () => {
  closeDatabase();
  const { _resetGitInstance } = await import('../../core/memory/versioning.js');
  _resetGitInstance();
  await new Promise(r => setTimeout(r, 100));
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
});

// --- BM25 Search ---

describe('searchBM25', () => {
  it('finds entry by keyword match', () => {
    const results = searchBM25('ceramic');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.code === ceramicCode)).toBe(true);
  });

  it('finds entry via stemming (ceramics → ceramic)', () => {
    const results = searchBM25('ceramics');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.code === ceramicCode)).toBe(true);
  });

  it('matches multi-word queries', () => {
    const results = searchBM25('ceramic color');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].code).toBe(ceramicCode);
  });

  it('scopes by notebook', () => {
    const whatResults = searchBM25('ceramic', { nb: 'WHAT' });
    expect(whatResults.length).toBeGreaterThan(0);

    const howResults = searchBM25('ceramic', { nb: 'HOW' });
    expect(howResults.length).toBe(0);
  });

  it('returns empty for no matches', () => {
    const results = searchBM25('zyxwvutsrqp');
    expect(results.length).toBe(0);
  });

  it('respects limit parameter', () => {
    const results = searchBM25('project', { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('returns results ordered by relevance', () => {
    const results = searchBM25('ceramic glaze color');
    expect(results.length).toBeGreaterThan(0);
    // First result should be the ceramic entry (most relevant)
    expect(results[0].code).toBe(ceramicCode);
  });
});

// --- FTS Query Sanitization ---

describe('sanitizeFTSQuery', () => {
  it('strips special characters and joins with OR', () => {
    expect(sanitizeFTSQuery('hello "world"')).toBe('hello OR world');
    expect(sanitizeFTSQuery('test*')).toBe('test');
    expect(sanitizeFTSQuery('(a OR b)')).toBe('a OR b');
  });

  it('strips FTS5 operators and joins with OR', () => {
    expect(sanitizeFTSQuery('hello AND world')).toBe('hello OR world');
    expect(sanitizeFTSQuery('NOT bad')).toBe('bad');
    expect(sanitizeFTSQuery('word NEAR other')).toBe('word OR other');
  });

  it('returns empty string for all-special input', () => {
    expect(sanitizeFTSQuery('***')).toBe('');
    expect(sanitizeFTSQuery('""')).toBe('');
  });

  it('joins multi-word queries with OR for recall', () => {
    expect(sanitizeFTSQuery('find ceramic color work')).toBe('find OR ceramic OR color OR work');
  });

  it('returns single token as-is', () => {
    expect(sanitizeFTSQuery('ceramic')).toBe('ceramic');
  });
});

// --- Markdown Chunking ---

describe('chunkMarkdown', () => {
  it('strips frontmatter', () => {
    const content = '---\ncode: TEST\nnb: WHO\n---\n\n# Hello\n\nBody text here.';
    const chunks = chunkMarkdown('TEST', content);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].text).not.toContain('---');
    expect(chunks[0].text).not.toContain('code: TEST');
  });

  it('detects headings', () => {
    const content = '# Title\n\nIntro text.\n\n## Section One\n\nFirst section content.\n\n## Section Two\n\nSecond section content.';
    const chunks = chunkMarkdown('TEST', content);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Check heading detection
    const headings = chunks.map(c => c.heading);
    expect(headings).toContain('Section One');
    expect(headings).toContain('Section Two');
  });

  it('assigns sequential chunk indices', () => {
    const content = '# Title\n\nIntro.\n\n## A\n\nSection A.\n\n## B\n\nSection B.';
    const chunks = chunkMarkdown('TEST', content);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunkIndex).toBe(i);
    }
  });

  it('preserves code in chunks', () => {
    const chunks = chunkMarkdown('WHAT.KN-000001', '# Test\n\nBody content.');
    expect(chunks.every(c => c.code === 'WHAT.KN-000001')).toBe(true);
  });

  it('returns empty for empty content', () => {
    expect(chunkMarkdown('TEST', '').length).toBe(0);
    expect(chunkMarkdown('TEST', '---\ncode: X\n---').length).toBe(0);
  });

  it('handles content without headings', () => {
    const chunks = chunkMarkdown('TEST', 'Just a plain paragraph with no headings.');
    expect(chunks.length).toBe(1);
    expect(chunks[0].heading).toBe('');
    expect(chunks[0].text).toContain('plain paragraph');
  });
});

// --- Cosine Similarity ---

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it('returns -1 for opposite vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it('returns 0 for zero vector', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([0, 0, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('throws on length mismatch', () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    expect(() => cosineSimilarity(a, b)).toThrow('Vector length mismatch');
  });
});

// --- Vector Storage ---

describe('storeChunks + searchVectors', () => {
  it('stores and retrieves chunks with embeddings', () => {
    // Create a test entry for vector storage
    const entry = createEntry({
      nb: 'WHAT', type: 'KN', name: 'Vector Test Entry',
      status: 'active', summary: 'Test for vector search',
      body: 'Testing vector storage and retrieval.',
    });

    // Manually store chunks with embeddings
    const chunks: Chunk[] = [
      { code: entry.code, chunkIndex: 0, heading: 'Test', text: 'Vector test content' },
    ];
    const embeddings = [new Float32Array([0.1, 0.2, 0.3, 0.4])];
    storeChunks(chunks, embeddings);

    // Search with a similar vector
    const queryVec = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const results = searchVectors(queryVec);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].code).toBe(entry.code);
    expect(results[0].score).toBeCloseTo(1, 3); // identical vector
  });

  it('scopes vector search by notebook', () => {
    const entry = createEntry({
      nb: 'HOW', type: 'PR', name: 'Vector Scope Test',
      status: 'active', summary: 'Test scoping',
      body: 'Scoping test for vector search.',
    });

    const chunks: Chunk[] = [
      { code: entry.code, chunkIndex: 0, heading: '', text: 'Scope test' },
    ];
    const embeddings = [new Float32Array([0.5, 0.5, 0.5, 0.5])];
    storeChunks(chunks, embeddings);

    const queryVec = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    const howResults = searchVectors(queryVec, { nb: 'HOW' });
    expect(howResults.some(r => r.code === entry.code)).toBe(true);

    const whenResults = searchVectors(queryVec, { nb: 'WHEN' });
    expect(whenResults.some(r => r.code === entry.code)).toBe(false);
  });
});

// --- Reciprocal Rank Fusion ---

describe('reciprocalRankFusion', () => {
  it('merges two ranked lists', () => {
    const bm25 = [
      { code: 'A', score: -1.5 },
      { code: 'B', score: -1.2 },
    ];
    const vector = [
      { code: 'B', score: 0.95 },
      { code: 'C', score: 0.80 },
    ];
    const merged = reciprocalRankFusion(bm25, vector);
    // B appears in both lists, should rank highest
    expect(merged[0].code).toBe('B');
    expect(merged.length).toBe(3);
  });

  it('handles empty vector list (BM25-only)', () => {
    const bm25 = [{ code: 'A', score: -1.5 }];
    const merged = reciprocalRankFusion(bm25, []);
    expect(merged.length).toBe(1);
    expect(merged[0].code).toBe('A');
  });

  it('handles empty BM25 list (vector-only)', () => {
    const vector = [{ code: 'A', score: 0.9 }];
    const merged = reciprocalRankFusion([], vector);
    expect(merged.length).toBe(1);
    expect(merged[0].code).toBe('A');
  });
});

// --- Hybrid Search ---

describe('hybridSearch', () => {
  it('returns results for keyword matches (BM25-only mode)', async () => {
    const results = await hybridSearch('ceramic color');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.code).toBe(ceramicCode);
    expect(results[0].source).toBe('bm25');
  });

  it('scopes search by notebook', async () => {
    const whatResults = await hybridSearch('ceramic', { nb: 'WHAT' });
    expect(whatResults.length).toBeGreaterThan(0);

    const nowResults = await hybridSearch('ceramic', { nb: 'NOW' });
    expect(nowResults.length).toBe(0);
  });

  it('respects limit parameter', async () => {
    const results = await hybridSearch('active', { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('returns empty for no matches', async () => {
    const results = await hybridSearch('zyxwvutsrqp');
    expect(results.length).toBe(0);
  });

  // Acceptance test: vague query returns correct result
  it('ACCEPTANCE: "find the ceramic color work" returns the ceramic entry', async () => {
    const results = await hybridSearch('find the ceramic color work');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entry.code).toBe(ceramicCode);
    expect(results[0].entry.name).toBe('Ceramic Color Techniques');
  });
});

// --- Agent Integration ---

describe('processMessage with hybrid search', () => {
  const mockLLM = async (messages: Message[]) => {
    const system = messages[0].content;
    if (system.includes('memory writing assistant')) {
      return JSON.stringify({
        nb: 'WHAT', type: 'KN', name: 'Mock',
        status: 'active', summary: 'mock', body: 'mock',
      });
    }
    if (system.includes('Resolved Memory')) {
      return 'Found it via hybrid search.';
    }
    return 'I can help with that.';
  };

  it('agent falls back to hybrid search for vague queries', async () => {
    const res = await processMessage('find the ceramic color work', [], { llmHandler: mockLLM });
    // "find the ceramic color work" decomposes to route:query via QUERY_PATTERNS.
    // FIX E: decomposed units always go through routeDecomposedUnits → handleQueryUnits.
    // handleQueryUnits returns the entry via BM25/vector search without LLM call.
    expect(res.resolved).not.toBeNull();
    expect(res.resolved!.entries[0].code).toBe(ceramicCode);
    // reply is the formatted query result, not the LLM response
    expect(res.reply).toBeTruthy();
  });

  it('agent still calls LLM when search has no results', async () => {
    const res = await processMessage('explain quantum entanglement theory', [], { llmHandler: mockLLM });
    // No matching entries in memory — falls through to LLM
    expect(res.reply).toBe('I can help with that.');
  });
});
