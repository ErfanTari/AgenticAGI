import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { initDatabase, closeDatabase } from '../../core/memory/index.js';
import { PATHS } from '../../config/agent.config.js';
import { runIntake } from '../../core/intake.js';
import type { LLMHandler } from '../../core/types.js';

let tmpDir: string;
const origDb = PATHS.db;
const origMemory = PATHS.memory;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-test-'));
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

function makeLLM(response: string): LLMHandler {
  return async () => response;
}

function makeFailLLM(): LLMHandler {
  return async () => { throw new Error('LLM unavailable'); };
}

describe('Phase 15: runIntake()', () => {
  it('classifies a person query correctly', async () => {
    const llm = makeLLM(JSON.stringify({
      summary: 'Looking up contact Sara',
      person: { name: 'Sara', confidence: 0.9 },
      project: null,
      time: null,
      agentic: false,
      procedure: false,
      query: true,
    }));

    const { initDatabase: idb } = await import('../../core/memory/index.js');
    const db = idb(PATHS.db);

    const result = await runIntake('Who is Sara?', db, llm);

    expect(result.signals.personSignal).not.toBeNull();
    expect(result.signals.personSignal?.name).toBe('Sara');
    expect(result.signals.querySignal).toBe(true);
    expect(result.signals.agenticSignal).toBe(false);
  });

  it('classifies an agentic task correctly', async () => {
    const llm = makeLLM(JSON.stringify({
      summary: 'Build a web scraper for product prices',
      person: null,
      project: null,
      time: null,
      agentic: true,
      procedure: false,
      query: false,
    }));

    const { initDatabase: idb } = await import('../../core/memory/index.js');
    const db = idb(PATHS.db);

    const result = await runIntake('Build a web scraper for product prices', db, llm);

    expect(result.signals.agenticSignal).toBe(true);
    expect(result.signals.summary).toContain('scraper');
  });

  it('gracefully handles LLM failure with empty signals', async () => {
    const { initDatabase: idb } = await import('../../core/memory/index.js');
    const db = idb(PATHS.db);

    const result = await runIntake('Hello world', db, makeFailLLM());

    expect(result.signals.summary).toBeTruthy();
    expect(result.signals.personSignal).toBeNull();
    expect(result.signals.projectSignal).toBeNull();
    expect(result.resolvedContext).toHaveLength(0);
    expect(result.projectCode).toBeNull();
  });

  it('classifies a procedure signal correctly', async () => {
    const llm = makeLLM(JSON.stringify({
      summary: 'Describes a deployment procedure',
      person: null,
      project: null,
      time: null,
      agentic: false,
      procedure: true,
      query: false,
    }));

    const { initDatabase: idb } = await import('../../core/memory/index.js');
    const db = idb(PATHS.db);

    const result = await runIntake('Here is how to deploy the app...', db, llm);

    expect(result.signals.procedureSignal).toBe(true);
  });

  it('classifies a time signal correctly', async () => {
    const llm = makeLLM(JSON.stringify({
      summary: 'Deadline for project proposal is next Friday',
      person: null,
      project: null,
      time: { description: 'next Friday deadline' },
      agentic: false,
      procedure: false,
      query: false,
    }));

    const { initDatabase: idb } = await import('../../core/memory/index.js');
    const db = idb(PATHS.db);

    const result = await runIntake('Deadline for project proposal is next Friday', db, llm);

    expect(result.signals.timeSignal).not.toBeNull();
    expect(result.signals.timeSignal?.description).toContain('Friday');
  });

  it('returns empty resolvedContext when no signals match memory', async () => {
    const llm = makeLLM(JSON.stringify({
      summary: 'Generic question',
      person: { name: 'Nobody Special', confidence: 0.8 },
      project: null,
      time: null,
      agentic: false,
      procedure: false,
      query: true,
    }));

    const { initDatabase: idb } = await import('../../core/memory/index.js');
    const db = idb(PATHS.db);

    const result = await runIntake('Who is Nobody Special?', db, llm);

    // No entries in DB, so resolvedContext should be empty
    expect(result.resolvedContext).toHaveLength(0);
    expect(result.projectCode).toBeNull();
  });

  it('gracefully handles invalid JSON from LLM', async () => {
    const llm = makeLLM('This is not JSON at all');
    const { initDatabase: idb } = await import('../../core/memory/index.js');
    const db = idb(PATHS.db);

    const result = await runIntake('Some message', db, llm);

    expect(result.signals.personSignal).toBeNull();
    expect(result.signals.projectSignal).toBeNull();
  });
});
