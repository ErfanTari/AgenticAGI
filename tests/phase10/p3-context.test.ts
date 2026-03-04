import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { buildContext, estimateTokens } from '../../core/context.js';
import { initDatabase, closeDatabase } from '../../core/memory/index.js';
import { transparency } from '../../core/transparency.js';
import { PATHS } from '../../config/agent.config.js';
import type { Message } from '../../core/types.js';

const MAX_CONTEXT_TOKENS = 2000;

describe('Priority 3: Context orchestrator', () => {
  let tmpDir: string;
  const origDb = PATHS.db;
  const origMemory = PATHS.memory;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p10-ctx-'));
    (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
    (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
    fs.mkdirSync(path.join(tmpDir, 'memory'), { recursive: true });
    initDatabase(path.join(tmpDir, 'test.sqlite'));
    transparency.disable();
  });

  afterEach(() => {
    closeDatabase();
    (PATHS as Record<string, string>).db = origDb;
    (PATHS as Record<string, string>).memory = origMemory;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('P3A: 10 history turns → token count under MAX_CONTEXT_TOKENS', async () => {
    const history: Message[] = [];
    for (let i = 0; i < 10; i++) {
      history.push({ role: 'user', content: `Message ${i}: hello world` });
      history.push({ role: 'assistant', content: `Reply ${i}: hi there` });
    }
    const messages = await buildContext('final question', null, history, []);
    const tokens = estimateTokens(messages);
    expect(tokens).toBeLessThan(MAX_CONTEXT_TOKENS);
  });

  it('P3B: context_built event emitted with tokens and sections', async () => {
    const events: Array<{ tokens: number; sections: string[] }> = [];
    transparency.enable();
    const unsubscribe = transparency.on(event => {
      if (event.type === 'context_built') events.push(event.data);
    });

    await buildContext('test message', null, [], []);
    unsubscribe();
    transparency.disable();

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].tokens).toBeGreaterThan(0);
    expect(Array.isArray(events[0].sections)).toBe(true);
    expect(events[0].sections).toContain('system');
    expect(events[0].sections).toContain('user_message');
  });

  it('P3C: sections array contains memory when resolved entries present', async () => {
    const events: Array<{ tokens: number; sections: string[] }> = [];
    transparency.enable();
    const unsubscribe = transparency.on(event => {
      if (event.type === 'context_built') events.push(event.data);
    });

    const resolved = {
      step: 0,
      entries: [{ code: 'WHO.CT-000001', nb: 'WHO', type: 'CT', name: 'Test', status: 'active', updated: '2026-01-01', summary: 'test', path: '/tmp/t.md' }],
      contents: [],
      relationships: [],
    };
    await buildContext('test', resolved, [], []);
    unsubscribe();
    transparency.disable();

    expect(events[0].sections).toContain('memory');
  });

  it('P3D: token count is always a positive integer', async () => {
    const messages = await buildContext('hello', null, [], []);
    const tokens = estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
    expect(Number.isInteger(tokens)).toBe(true);
  });

  it('P3E: 50+ history messages → token budget respected', async () => {
    const history: Message[] = [];
    for (let i = 0; i < 60; i++) {
      history.push({ role: 'user', content: `Long message ${i} about various topics that adds tokens to the context` });
      history.push({ role: 'assistant', content: `Response ${i} with some information` });
    }
    const messages = await buildContext('final', null, history, []);
    const tokens = estimateTokens(messages);
    expect(tokens).toBeLessThanOrEqual(MAX_CONTEXT_TOKENS);
  });
});
