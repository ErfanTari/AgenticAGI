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
import { PATHS } from '../../config/agent.config.js';

// --- Test setup ---

const TEST_DIR = path.join(os.tmpdir(), `agentic-agi-test-p7-schema-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'memory.sqlite');
const TEST_MEMORY = path.join(TEST_DIR, 'memory');

const origDb = PATHS.db;
const origMemory = PATHS.memory;

beforeAll(() => {
  (PATHS as Record<string, string>).db = TEST_DB;
  (PATHS as Record<string, string>).memory = TEST_MEMORY;
  initDatabase(TEST_DB);
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

// --- P2A: WriteEntrySchema.safeParse accepts valid JSON ---

describe('Structured Outputs via Zod Schema', () => {
  it('P2A: WriteEntrySchema.safeParse accepts valid JSON', () => {
    const valid = {
      nb: 'WHO',
      type: 'CT',
      name: 'Test Person',
      status: 'active',
      summary: 'A test contact',
      body: 'Contact details here',
    };

    const result = WriteEntrySchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.nb).toBe('WHO');
      expect(result.data.type).toBe('CT');
      expect(result.data.name).toBe('Test Person');
      expect(result.data.status).toBe('active');
    }
  });

  it('P2A: WriteEntrySchema accepts valid JSON with relationships', () => {
    const valid = {
      nb: 'WHAT',
      type: 'PJ',
      name: 'Project Alpha',
      status: 'active',
      summary: 'A test project',
      body: 'Project details',
      relationships: [
        { relation: 'owns', to_code: 'WHO.CT-000001' },
      ],
    };

    const result = WriteEntrySchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.relationships).toBeDefined();
      expect(result.data.relationships!.length).toBe(1);
      expect(result.data.relationships![0].relation).toBe('owns');
    }
  });

  // --- P2B: WriteEntrySchema.safeParse rejects invalid JSON ---

  it('P2B: WriteEntrySchema rejects missing nb field', () => {
    const invalid = {
      type: 'CT',
      name: 'Test',
      summary: 'A test',
      body: 'Details',
    };

    const result = WriteEntrySchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('P2B: WriteEntrySchema rejects invalid nb value', () => {
    const invalid = {
      nb: 'INVALID',
      type: 'CT',
      name: 'Test',
      status: 'active',
      summary: 'A test',
      body: 'Details',
    };

    const result = WriteEntrySchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('P2B: agent falls back to rule-based when LLM returns unparseable response', async () => {
    // LLM returns garbage — both Zod and regex fail, rule-based inference handles it
    const garbageLLM: LLMHandler = async (messages: Message[]) => {
      if (messages[0].content.includes('memory writing assistant')) {
        return 'I cannot understand the request, sorry!';
      }
      return 'ok';
    };

    const res = await processMessage('create a contact named Fallback Person', [], { llmHandler: garbageLLM });
    expect(res.intent).toBe('memory_write');
    // Rule-based should pick up "contact" + "Fallback Person"
    expect(res.created).toBeDefined();
    expect(res.created!.name).toBe('Fallback Person');
    expect(res.created!.nb).toBe('WHO');
  });

  // --- P2C: Mock LLM handler receives responseSchema in options ---

  it('P2C: LLM handler receives responseSchema in options during write', async () => {
    let receivedOptions: { responseSchema?: Record<string, unknown> } | undefined;

    const capturingLLM: LLMHandler = async (messages: Message[], options?: { responseSchema?: Record<string, unknown> }) => {
      if (messages[0].content.includes('memory writing assistant')) {
        receivedOptions = options;
        return JSON.stringify({
          nb: 'WHO', type: 'CT', name: 'Schema Check',
          status: 'active', summary: 'Checking schema pass-through', body: 'Test body',
        });
      }
      return 'ok';
    };

    await processMessage('create a contact named Schema Check', [], { llmHandler: capturingLLM });

    expect(receivedOptions).toBeDefined();
    expect(receivedOptions!.responseSchema).toBeDefined();
    // Verify it's a proper JSON schema object
    expect(receivedOptions!.responseSchema!.type).toBe('object');
    expect(receivedOptions!.responseSchema!.properties).toBeDefined();
  });

  // --- writeEntryJsonSchema structure check ---

  it('writeEntryJsonSchema is a valid JSON schema object', () => {
    expect(writeEntryJsonSchema).toBeDefined();
    expect(writeEntryJsonSchema.type).toBe('object');
    expect(writeEntryJsonSchema.properties).toBeDefined();
    const props = writeEntryJsonSchema.properties as Record<string, unknown>;
    expect(props.nb).toBeDefined();
    expect(props.type).toBeDefined();
    expect(props.name).toBeDefined();
    expect(props.summary).toBeDefined();
    expect(props.body).toBeDefined();
  });

  // --- Default status ---

  it('WriteEntrySchema provides default status when omitted', () => {
    const minimal = {
      nb: 'NOW',
      type: 'TD',
      name: 'Test Todo',
      summary: 'A todo',
      body: 'Details',
    };

    const result = WriteEntrySchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('active');
    }
  });
});
