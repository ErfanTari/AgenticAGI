import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WriteEntrySchema, writeEntryJsonSchema } from '../../core/schemas.js';
import { processMessage } from '../../core/agent.js';
import type { Message, LLMHandler } from '../../core/types.js';
import {
  initDatabase,
  closeDatabase,
} from '../../core/memory/mod.js';
import { getDb } from '../../core/memory/index.js';
import { PATHS } from '../../config/agent.config.js';

// --- Test setup ---

const TEST_DIR = path.join(os.tmpdir(), `stress-schema-${Date.now()}`);
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

// --- Group 2: Structured Outputs ---

describe('Group 2: Structured Outputs', () => {
  // 2A — WriteEntrySchema validates correctly for all 7 notebooks
  it('2A: WriteEntrySchema.safeParse succeeds for all 7 valid notebooks', () => {
    const notebooks = ['WHO', 'WHAT', 'WHEN', 'HOW', 'WHY', 'NOW', 'PLAN'] as const;

    for (const nb of notebooks) {
      const result = WriteEntrySchema.safeParse({
        nb,
        type: 'XX',
        name: `Test ${nb}`,
        status: 'active',
        summary: `Test entry for ${nb}`,
        body: `Body for ${nb}`,
      });
      expect(result.success, `Expected ${nb} to pass validation`).toBe(true);
    }
  });

  // 2B — Schema rejects invalid notebook
  it('2B: WriteEntrySchema rejects invalid nb value, error mentions nb field', () => {
    const result = WriteEntrySchema.safeParse({
      nb: 'INVALID',
      type: 'CT',
      name: 'Test',
      status: 'active',
      summary: 'A test',
      body: 'Details',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const errorStr = JSON.stringify(result.error);
      // Error should reference the nb field
      expect(errorStr).toContain('nb');
    }
  });

  // 2C — LM Studio response_format sent when schema provided
  it('2C: LLM handler receives response_format with json_schema when schema provided', async () => {
    let receivedOptions: { responseSchema?: Record<string, unknown> } | undefined;

    const capturingLLM: LLMHandler = async (messages: Message[], options?) => {
      if (messages[0].content.includes('memory writing assistant')) {
        receivedOptions = options;
        return JSON.stringify({
          nb: 'WHO', type: 'CT', name: 'Schema Format Check',
          status: 'active', summary: 'Checking format pass-through', body: 'Test body',
        });
      }
      return 'ok';
    };

    await processMessage('create a contact named Schema Format Check', [], { llmHandler: capturingLLM });

    expect(receivedOptions).toBeDefined();
    expect(receivedOptions!.responseSchema).toBeDefined();
    // Verify it's a proper JSON schema object
    expect(receivedOptions!.responseSchema!.type).toBe('object');
    expect(receivedOptions!.responseSchema!.properties).toBeDefined();
    // Verify it matches the writeEntryJsonSchema
    expect(receivedOptions!.responseSchema).toEqual(writeEntryJsonSchema);
  });

  // 2D — Fallback when response_format unsupported
  it('2D: falls back to rule-based when LLM returns garbage, entry still created', async () => {
    const garbageLLM: LLMHandler = async (messages: Message[]) => {
      if (messages[0].content.includes('memory writing assistant')) {
        return 'I cannot understand the request, sorry!';
      }
      return 'ok';
    };

    const res = await processMessage('create a contact named Fallback Stress Person', [], { llmHandler: garbageLLM });
    expect(res.intent).toBe('memory_write');
    // Rule-based inference should pick up "contact" + "Fallback Stress Person"
    expect(res.created).toBeDefined();
    expect(res.created!.name).toBe('Fallback Stress Person');
    expect(res.created!.nb).toBe('WHO');
    // No crash
  });

  // 2E — 20 consecutive write operations all parse correctly
  it('2E: 20 consecutive write operations all succeed with zero corrupt entries', async () => {
    let writeCount = 0;
    const batchLLM: LLMHandler = async (messages: Message[]) => {
      if (messages[0].content.includes('memory writing assistant')) {
        writeCount++;
        return JSON.stringify({
          nb: 'WHO', type: 'CT', name: `BatchPerson${writeCount}`,
          status: 'active', summary: `Batch test entry ${writeCount}`, body: `Body ${writeCount}`,
        });
      }
      return 'ok';
    };

    const results = [];
    for (let i = 0; i < 20; i++) {
      const res = await processMessage(`create a contact named BatchPerson${i + 1}`, [], { llmHandler: batchLLM });
      results.push(res);
    }

    // All 20 should succeed
    expect(results.length).toBe(20);
    for (const res of results) {
      expect(res.intent).toBe('memory_write');
      expect(res.created).toBeDefined();
      expect(res.created!.code).toMatch(/^WHO\.CT-\d{6}$/);
      expect(res.created!.name).toBeTruthy();
    }

    // Verify zero corrupt entries in SQLite
    const d = getDb();
    const allEntries = d.prepare(
      "SELECT * FROM index_entries WHERE name LIKE 'BatchPerson%'"
    ).all() as Array<{ name: string; nb: string; type: string }>;
    expect(allEntries.length).toBe(20);
    for (const entry of allEntries) {
      expect(entry.name).toBeTruthy();
      expect(entry.nb).toBe('WHO');
      expect(entry.type).toBe('CT');
    }
  });

  // 2F — Zod validation catches corrupt LLM response
  it('2F: Zod catches empty name, triggers retry, user never sees corrupt entry', async () => {
    let callCount = 0;
    const corruptLLM: LLMHandler = async (messages: Message[]) => {
      if (messages[0].content.includes('memory writing assistant')) {
        callCount++;
        if (callCount === 1) {
          // Corrupt response: valid JSON but Zod-invalid (empty name)
          return JSON.stringify({ nb: 'WHO', type: 'XX', name: '', status: 'active', summary: 'test', body: 'test' });
        }
        // Second attempt: valid
        return JSON.stringify({ nb: 'WHO', type: 'CT', name: 'Fixed Zod Person', status: 'active', summary: 'Fixed', body: 'Fixed body' });
      }
      return 'ok';
    };

    const res = await processMessage('create a contact named Fixed Zod Person', [], { llmHandler: corruptLLM });

    expect(res.created).toBeDefined();
    expect(res.created!.name).toBe('Fixed Zod Person');
    expect(res.reply).toContain('Created');
    // LLM was called at least twice (first corrupt, then fixed)
    expect(callCount).toBeGreaterThanOrEqual(2);

    // Verify no corrupt entry with empty name exists
    const d = getDb();
    const corrupt = d.prepare("SELECT * FROM index_entries WHERE name = ''").all();
    expect(corrupt.length).toBe(0);
  });
});
