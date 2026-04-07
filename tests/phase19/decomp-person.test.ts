/**
 * Phase 19d — Decomposition Routing + Person Detection Fix Tests
 * 14 tests covering:
 *   - FIX 1: decomposition prompt examples (conversational vs query routing)
 *   - FIX 2a+2b: detectPersonName case normalization + blocklist expansion
 *   - FIX 2c: personSignal threading (confirmed correct, regression test)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { initDatabase, closeDatabase } from '../../core/memory/index.js';
import { PATHS } from '../../config/agent.config.js';
import { decomposeMessage } from '../../core/decomposition.js';
import { searchMemoryForUnits, detectPersonName } from '../../core/memory/unit-search.js';
import { upsertEntry } from '../../core/memory/write.js';
import { promptLoader } from '../../core/prompt-loader.js';
import type { LLMHandler, DecomposedUnit } from '../../core/types.js';

let tmpDir: string;
const origDb = PATHS.db;
const origMemory = PATHS.memory;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase19d-test-'));
  (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
  fs.mkdirSync(path.join(tmpDir, 'memory'), { recursive: true });
  initDatabase(path.join(tmpDir, 'test.sqlite'));
});

afterEach(() => {
  closeDatabase();
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeUnit(content: string, route: DecomposedUnit['route'] = 'query'): DecomposedUnit {
  return { id: 'u1', content, route, taskType: undefined };
}

// ─── FIX 1: Decomposition prompt examples ─────────────────────────────────────

describe('Decomposition routing — prompt content', () => {
  it('test 1: decomposition prompt does NOT contain "capital of France"', () => {
    const prompt = promptLoader.load('decomposition', { current_date: '2026-04-07', context_block: '' });
    expect(prompt).not.toContain('capital of France');
  });

  it('test 2: decomposition prompt contains "photosynthesis" (conversational example)', () => {
    const prompt = promptLoader.load('decomposition', { current_date: '2026-04-07', context_block: '' });
    expect(prompt).toContain('photosynthesis');
  });

  it('test 3: decomposition prompt contains a person-query example (Sara Ahmadi → query)', () => {
    const prompt = promptLoader.load('decomposition', { current_date: '2026-04-07', context_block: '' });
    expect(prompt).toContain('Sara Ahmadi');
    // The example should show route: query for a person question
    const saraIdx = prompt.indexOf('Sara Ahmadi');
    const nearby = prompt.slice(Math.max(0, saraIdx - 100), saraIdx + 150);
    expect(nearby).toContain('query');
  });

  it('test 4: decomposition prompt contains named-entity rule', () => {
    const prompt = promptLoader.load('decomposition', { current_date: '2026-04-07', context_block: '' });
    const hasRule =
      prompt.includes('named person') ||
      prompt.includes('named entity') ||
      prompt.includes('specific named');
    expect(hasRule).toBe(true);
  });

  it('test 5: decomposeMessage routes "who is erfan tari" as query via mock LLM', async () => {
    const llm: LLMHandler = async () =>
      JSON.stringify({ units: [{ route: 'query', content: 'who is erfan tari' }] });
    const result = await decomposeMessage('who is erfan tari', llm);
    expect(result.units[0].route).toBe('query');
  });

  it('test 6: decomposeMessage routes "what is photosynthesis" as conversational via mock LLM', async () => {
    const llm: LLMHandler = async () =>
      JSON.stringify({ units: [{ route: 'conversational', content: 'what is photosynthesis' }] });
    const result = await decomposeMessage('what is photosynthesis', llm);
    expect(result.units[0].route).toBe('conversational');
  });
});

// ─── FIX 2a+2b: detectPersonName case normalization ───────────────────────────

describe('detectPersonName — case normalization', () => {
  it('test 7: detectPersonName("who is erfan tari") returns "Erfan Tari"', () => {
    const result = detectPersonName('who is erfan tari');
    expect(result).toBe('Erfan Tari');
  });

  it('test 8: detectPersonName("who is sara ahmadi") returns "Sara Ahmadi"', () => {
    const result = detectPersonName('who is sara ahmadi');
    expect(result).toBe('Sara Ahmadi');
  });

  it('test 9: detectPersonName("tell me about farzad hamadi") returns "Farzad Hamadi"', () => {
    const result = detectPersonName('tell me about farzad hamadi');
    expect(result).toBe('Farzad Hamadi');
  });

  it('test 10: detectPersonName("what is photosynthesis") returns null', () => {
    const result = detectPersonName('what is photosynthesis');
    expect(result).toBeNull();
  });

  it('test 11: detectPersonName("Who Is Erfan Tari") returns "Erfan Tari" (already title case)', () => {
    const result = detectPersonName('Who Is Erfan Tari');
    expect(result).toBe('Erfan Tari');
  });

  it('test 12: detectPersonName("who is will") returns null (blocklist: "Will")', () => {
    const result = detectPersonName('who is will');
    expect(result).toBeNull();
  });

  it('test 13: detectPersonName("who is create") returns null (blocklist: "Create")', () => {
    const result = detectPersonName('who is create');
    expect(result).toBeNull();
  });
});

// ─── FIX 2c: personSignal threading (regression) ──────────────────────────────

describe('personSignal threading', () => {
  it('test 14: searchUnit for conversational unit with personSignal returns WHO entry', async () => {
    await upsertEntry({ nb: 'WHO', type: 'CT', name: 'Erfan Tari', status: 'active', summary: 'owner' }, undefined, '');

    // Simulate a conversational unit (route = 'conversational') with a personSignal from intake
    const unit = makeUnit('who is erfan tari', 'conversational');
    const results = await searchMemoryForUnits([unit], undefined, { personSignal: 'Erfan Tari' });

    expect(results[0].strategy).toBe('person');
    expect(results[0].entries.length).toBeGreaterThan(0);
    expect(results[0].entries[0].name).toBe('Erfan Tari');
    expect(results[0].confidence).toBeGreaterThan(0);
  });
});
