import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Message } from '../../core/types.js';
import { processMessage } from '../../core/agent.js';
import { PATHS } from '../../config/agent.config.js';
import { initDatabase, closeDatabase, getDb } from '../../core/memory/mod.js';

const TEST_DIR = path.join(os.tmpdir(), `agentic-agi-p7-p2-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'memory.sqlite');
const TEST_MEMORY = path.join(TEST_DIR, 'memory');

const origDb = PATHS.db;
const origMemory = PATHS.memory;

beforeAll(() => {
  (PATHS as Record<string, string>).db = TEST_DB;
  (PATHS as Record<string, string>).memory = TEST_MEMORY;
  initDatabase(TEST_DB);
});

afterAll(() => {
  closeDatabase();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
});

describe('Phase 7 Priority 2 — Structured outputs', () => {
  it('P2A: 20/20 memory writes parse successfully with schema path (no repair fallback)', async () => {
    let writeCalls = 0;
    let repairCalls = 0;

    const llm = async (messages: Message[]) => {
      const system = messages[0]?.content ?? '';
      const user = messages[1]?.content ?? '';

      if (system.includes('memory writing assistant')) {
        writeCalls += 1;
        const index = Number(user.match(/Schema User (\d+)/)?.[1] ?? '0');
        return JSON.stringify({
          nb: 'WHO',
          type: 'CT',
          name: `Schema User ${index}`,
          status: 'active',
          summary: `Schema summary ${index}`,
          body: `Schema body ${index}`,
        });
      }
      if (system.includes('repair malformed memory-write JSON')) {
        repairCalls += 1;
        return JSON.stringify({
          nb: 'WHO',
          type: 'CT',
          name: 'Unexpected Repair',
          status: 'active',
          summary: 'unexpected',
          body: 'unexpected',
        });
      }
      return 'ok';
    };

    for (let i = 1; i <= 20; i += 1) {
      const res = await processMessage(`create a contact named Schema User ${i}`, [], { llmHandler: llm });
      expect(res.intent).toBe('memory_write');
      expect(res.error).toBeUndefined();
      expect(res.reply).toContain('Created');
    }

    const d = getDb();
    const count = (d.prepare("SELECT COUNT(*) AS c FROM index_entries WHERE name LIKE 'Schema User %'").get() as { c: number }).c;
    expect(count).toBe(20);
    expect(writeCalls).toBe(20);
    expect(repairCalls).toBe(0);
  });

  it('P2B: invalid nb is rejected by schema and repaired on retry', async () => {
    let writeCalls = 0;
    let repairCalls = 0;

    const llm = async (messages: Message[]) => {
      const system = messages[0]?.content ?? '';
      if (system.includes('memory writing assistant')) {
        writeCalls += 1;
        return JSON.stringify({
          nb: 'UNKNOWN',
          type: 'CT',
          name: 'Schema Reject User',
          status: 'active',
          summary: 'bad nb first pass',
          body: 'bad nb first pass',
        });
      }
      if (system.includes('repair malformed memory-write JSON')) {
        repairCalls += 1;
        return JSON.stringify({
          nb: 'WHO',
          type: 'CT',
          name: 'Schema Reject User',
          status: 'active',
          summary: 'repaired nb',
          body: 'repaired nb body',
        });
      }
      return 'ok';
    };

    const res = await processMessage('create a contact named Schema Reject User', [], { llmHandler: llm });
    expect(res.intent).toBe('memory_write');
    expect(res.error).toBeUndefined();
    expect(res.reply).toContain('Created');
    expect(writeCalls).toBe(1);
    expect(repairCalls).toBe(1);
  });

  it('P2C: callLLM falls back to unstructured call when response_format unsupported', async () => {
    const oldEndpoint = process.env.LLM_ENDPOINT;
    const oldModel = process.env.LLM_MODEL;
    const oldApiKey = process.env.LLM_API_KEY;
    const oldGeminiKey = process.env.GEMINI_API_KEY;
    const oldFallback = process.env.LLM_FALLBACK_PROVIDER;
    const originalFetch = globalThis.fetch;

    try {
      process.env.LLM_ENDPOINT = 'http://local.test';
      process.env.LLM_MODEL = 'mock-local-model';
      process.env.LLM_API_KEY = '';
      process.env.GEMINI_API_KEY = '';
      delete process.env.LLM_FALLBACK_PROVIDER;

      const requestBodies: Array<Record<string, unknown>> = [];
      globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        requestBodies.push(body);
        if (body.response_format) {
          return new Response('response_format unsupported', { status: 400, statusText: 'Bad Request' });
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"nb":"WHO","type":"CT","name":"Fallback User","status":"active","summary":"ok","body":"ok"}',
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch;

      vi.resetModules();
      const llmMod = await import('../../core/llm.js');
      const result = await llmMod.callLLM(
        [
          { role: 'system', content: 'Return JSON only.' },
          { role: 'user', content: 'Create a valid write payload.' },
        ],
        {
          schema: {
            type: 'object',
            properties: {
              nb: { type: 'string' },
            },
            required: ['nb'],
          },
        },
      );

      expect(result).toContain('"nb":"WHO"');
      expect(requestBodies.length).toBe(2);
      expect(requestBodies[0].response_format).toBeDefined();
      expect(requestBodies[1].response_format).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      if (oldEndpoint === undefined) delete process.env.LLM_ENDPOINT;
      else process.env.LLM_ENDPOINT = oldEndpoint;
      if (oldModel === undefined) delete process.env.LLM_MODEL;
      else process.env.LLM_MODEL = oldModel;
      if (oldApiKey === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = oldApiKey;
      if (oldGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = oldGeminiKey;
      if (oldFallback === undefined) delete process.env.LLM_FALLBACK_PROVIDER;
      else process.env.LLM_FALLBACK_PROVIDER = oldFallback;
    }
  });
});
