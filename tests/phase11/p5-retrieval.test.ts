import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import { _resetGitInstance } from '../../core/memory/versioning.js';

describe('Phase 11 P5: LightRAG Relevance + RRF', () => {
  let tmpDir: string;
  let origDb: string;
  let origMemory: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-retrieval-'));
    origDb = PATHS.db;
    origMemory = PATHS.memory;
    (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
    (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
    (PATHS as Record<string, string>).workspace = path.join(tmpDir, 'workspace');
    (PATHS as Record<string, string>).logs = path.join(tmpDir, 'workspace', 'logs');
    (PATHS as Record<string, string>).projects = path.join(tmpDir, 'workspace', 'projects');
    fs.mkdirSync(PATHS.memory, { recursive: true });
  });

  afterEach(async () => {
    (PATHS as Record<string, string>).db = origDb;
    (PATHS as Record<string, string>).memory = origMemory;
    _resetGitInstance();
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('P5A: rankByLightRAG is exported from context.ts', async () => {
    const contextMod = await import('../../core/context.js');
    expect(typeof (contextMod as any).rankByLightRAG).toBe('function');
  });

  it('P5B: rankByLightRAG returns sorted array', async () => {
    const { rankByLightRAG } = await import('../../core/context.js') as any;
    const now = new Date().toISOString().slice(0, 10);
    const entries = [
      { code: 'A', nb: 'WHAT', type: 'KN', name: 'AgenticAGI Project', status: 'active', updated: now, summary: 'AI agent platform' },
      { code: 'B', nb: 'WHO', type: 'CT', name: 'John Smith', status: 'active', updated: now, summary: 'contact' },
      { code: 'C', nb: 'PLAN', type: 'PJ', name: 'AgenticAGI roadmap planning', status: 'active', updated: now, summary: 'roadmap' },
    ];

    const ranked = rankByLightRAG(entries, 'AgenticAGI project planning');
    expect(ranked.length).toBe(3);
    // AgenticAGI entries should rank higher
    expect(['A', 'C']).toContain(ranked[0].code);
  });

  it('P5C: rankByRelevance is an alias for rankByLightRAG', async () => {
    const { rankByRelevance, rankByLightRAG } = await import('../../core/context.js') as any;
    const now = new Date().toISOString().slice(0, 10);
    const entries = [
      { code: 'A', nb: 'PLAN', type: 'PJ', name: 'Alpha Project', status: 'active', updated: now, summary: 'alpha' },
      { code: 'B', nb: 'PLAN', type: 'PJ', name: 'Beta Project', status: 'active', updated: now, summary: 'beta' },
    ];

    const result1 = rankByRelevance(entries, 'alpha project');
    const result2 = rankByLightRAG(entries, 'alpha project');
    expect(result1.map((e: any) => e.code)).toEqual(result2.map((e: any) => e.code));
  });

  it('P5D: pinned entries rank highest', async () => {
    const { rankByLightRAG } = await import('../../core/context.js') as any;
    const now = new Date().toISOString().slice(0, 10);
    const entries = [
      { code: 'A', nb: 'PLAN', type: 'PJ', name: 'Pinned Project', status: 'active', updated: now, summary: 'pinned entry', pinned: 1, active_page: 1 },
      { code: 'B', nb: 'PLAN', type: 'PJ', name: 'Pinned Project Match', status: 'active', updated: now, summary: 'another entry', pinned: 0, active_page: 1 },
    ];

    const ranked = rankByLightRAG(entries, 'pinned project');
    expect(ranked[0].code).toBe('A');
  });

  it('P5E: inactive_page entries rank lower', async () => {
    const { rankByLightRAG } = await import('../../core/context.js') as any;
    const now = new Date().toISOString().slice(0, 10);
    const entries = [
      { code: 'A', nb: 'PLAN', type: 'PJ', name: 'Active Page Entry', status: 'active', updated: now, summary: 'test', active_page: 1, pinned: 0 },
      { code: 'B', nb: 'PLAN', type: 'PJ', name: 'Inactive Page Entry', status: 'active', updated: now, summary: 'test', active_page: 0, pinned: 0 },
    ];

    const ranked = rankByLightRAG(entries, 'test entry');
    expect(ranked[0].code).toBe('A');
  });

  it('P5F: reciprocalRankFusion merges two ranked lists', async () => {
    const { reciprocalRankFusion } = await import('../../core/memory/search.js');
    const bm25 = [
      { code: 'A', score: 1.0, rank: 1 },
      { code: 'B', score: 0.8, rank: 2 },
      { code: 'C', score: 0.6, rank: 3 },
    ] as any[];
    const vector = [
      { code: 'B', score: 1.0, rank: 1 },
      { code: 'A', score: 0.9, rank: 2 },
      { code: 'D', score: 0.7, rank: 3 },
    ] as any[];

    const merged = reciprocalRankFusion(bm25, vector);
    expect(merged.length).toBe(4); // A, B, C, D
    // B appears in both lists, should have highest RRF score
    expect(merged[0].code).toBe('B');
  });

  it('P5G: RRF handles empty lists', async () => {
    const { reciprocalRankFusion } = await import('../../core/memory/search.js');
    const result = reciprocalRankFusion([], []);
    expect(result).toEqual([]);
  });

  it('P5H: RRF handles single list', async () => {
    const { reciprocalRankFusion } = await import('../../core/memory/search.js');
    const bm25 = [{ code: 'X', score: 1.0 }] as any[];
    const result = reciprocalRankFusion(bm25, []);
    expect(result.length).toBe(1);
    expect(result[0].code).toBe('X');
  });

  it('P5I: context_compacted event type is valid', async () => {
    const { transparency } = await import('../../core/transparency.js');
    let emitted = false;
    const off = transparency.on((event) => {
      if (event.type === 'context_compacted') {
        emitted = true;
      }
    });
    transparency.enable();
    transparency.emit({ type: 'context_compacted', data: { before: 1000, after: 500 } });
    transparency.disable();
    off();
    expect(emitted).toBe(true);
  });

  it('P5J: computeAndStoreEmbedding is exported from embeddings.ts', async () => {
    const embMod = await import('../../core/memory/embeddings.js');
    expect(typeof (embMod as any).computeAndStoreEmbedding).toBe('function');
  });

  it('P5K: computeAndStoreEmbedding no-ops when EMBEDDING_CONFIG is null', async () => {
    const { computeAndStoreEmbedding } = await import('../../core/memory/embeddings.js') as any;
    // Should silently do nothing
    await expect(computeAndStoreEmbedding('WHAT.KN-000001', 'test text')).resolves.toBeUndefined();
  });

  it('P5L: rankByLightRAG returns same count as input', async () => {
    const { rankByLightRAG } = await import('../../core/context.js') as any;
    const now = new Date().toISOString().slice(0, 10);
    const entries = Array.from({ length: 10 }, (_, i) => ({
      code: `X-${i}`, nb: 'WHAT', type: 'KN',
      name: `Entry ${i}`, status: 'active', updated: now, summary: `summary ${i}`,
    }));

    const ranked = rankByLightRAG(entries, 'test query');
    expect(ranked.length).toBe(10);
  });

  it('P5M: rankByLightRAG handles empty entries list', async () => {
    const { rankByLightRAG } = await import('../../core/context.js') as any;
    const ranked = rankByLightRAG([], 'test');
    expect(ranked).toEqual([]);
  });

  it('P5N: RRF k parameter affects score magnitude', async () => {
    const { reciprocalRankFusion } = await import('../../core/memory/search.js');
    const bm25 = [{ code: 'A', score: 1.0 }] as any[];
    const r1 = reciprocalRankFusion(bm25, [], 60);
    const r2 = reciprocalRankFusion(bm25, [], 10);
    // With smaller k, score is higher (1/(10+1) > 1/(60+1))
    expect(r2[0].score).toBeGreaterThan(r1[0].score);
  });

  it('P5O: new Phase 11 columns have defaults', async () => {
    const { initDatabase, getDb } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { createEntry } = await import('../../core/memory/write.js');

    const entry = createEntry({
      nb: 'WHAT', type: 'KN', name: 'Default Test',
      status: 'active', summary: 'test', body: 'body',
    });

    const db = getDb();
    const row = db.prepare('SELECT importance_score, utility_score, usage_count, active_page, pinned FROM index_entries WHERE code = ?').get(entry.code) as Record<string, number>;
    expect(row.importance_score).toBe(0.5);
    expect(row.utility_score).toBe(1.0);
    expect(row.usage_count).toBe(0);
    expect(row.active_page).toBe(1);
    expect(row.pinned).toBe(0);
  });
});
