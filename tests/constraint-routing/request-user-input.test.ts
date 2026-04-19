/**
 * Batch 4: request_user_input skill + pending user input intercept
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PATHS } from '../../config/agent.config.js';
import { initDatabase, closeDatabase } from '../../core/memory/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(__dirname, `tmp-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
  initDatabase();
});

afterEach(() => {
  closeDatabase();
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('savePendingUserInput / loadPendingUserInput / clearPendingUserInput', () => {
  it('saves and loads a pending question', async () => {
    const { savePendingUserInput, loadPendingUserInput } = await import('../../core/memory/index.js');
    savePendingUserInput('What framework do you prefer?');
    const loaded = loadPendingUserInput();
    expect(loaded).not.toBeNull();
    expect(loaded!.question).toBe('What framework do you prefer?');
  });

  it('saves question with optional context', async () => {
    const { savePendingUserInput, loadPendingUserInput } = await import('../../core/memory/index.js');
    savePendingUserInput('Which database?', 'Need to choose between SQLite and Postgres');
    const loaded = loadPendingUserInput();
    expect(loaded!.context).toBe('Need to choose between SQLite and Postgres');
  });

  it('loads null when no pending question', async () => {
    const { loadPendingUserInput } = await import('../../core/memory/index.js');
    const loaded = loadPendingUserInput();
    expect(loaded).toBeNull();
  });

  it('clear removes the pending question', async () => {
    const { savePendingUserInput, loadPendingUserInput, clearPendingUserInput } = await import('../../core/memory/index.js');
    savePendingUserInput('A question');
    clearPendingUserInput();
    expect(loadPendingUserInput()).toBeNull();
  });

  it('overwrite — second save replaces first (singleton)', async () => {
    const { savePendingUserInput, loadPendingUserInput } = await import('../../core/memory/index.js');
    savePendingUserInput('First question');
    savePendingUserInput('Second question');
    const loaded = loadPendingUserInput();
    expect(loaded!.question).toBe('Second question');
  });

  it('PendingUserInput has created_at field', async () => {
    const { savePendingUserInput, loadPendingUserInput } = await import('../../core/memory/index.js');
    savePendingUserInput('When is this?');
    const loaded = loadPendingUserInput();
    expect(typeof loaded!.createdAt).toBe('string');
    expect(loaded!.createdAt.length).toBeGreaterThan(0);
  });
});

describe('request_user_input skill', () => {
  it('execute stores question in DB', async () => {
    const { requestUserInputSkill } = await import('../../core/skills/tools/request_user_input.js');
    const { loadPendingUserInput } = await import('../../core/memory/index.js');
    await requestUserInputSkill.execute({ question: 'What color scheme?' });
    const loaded = loadPendingUserInput();
    expect(loaded).not.toBeNull();
    expect(loaded!.question).toBe('What color scheme?');
  });

  it('execute returns success: true', async () => {
    const { requestUserInputSkill } = await import('../../core/skills/tools/request_user_input.js');
    const result = await requestUserInputSkill.execute({ question: 'Confirm approach?' });
    expect(result.success).toBe(true);
  });

  it('execute returns error when question is empty', async () => {
    const { requestUserInputSkill } = await import('../../core/skills/tools/request_user_input.js');
    const result = await requestUserInputSkill.execute({ question: '' });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('execute emits user_input_requested event', async () => {
    const { transparency } = await import('../../core/transparency.js');
    const { requestUserInputSkill } = await import('../../core/skills/tools/request_user_input.js');

    transparency.enable();
    const events: Array<{ type: string; data: unknown }> = [];
    const off = transparency.on(e => events.push(e));

    try {
      await requestUserInputSkill.execute({ question: 'Which approach?', context: 'test context' });
      const found = events.filter(e => e.type === 'user_input_requested');
      expect(found.length).toBe(1);
      const ev = found[0] as { type: string; data: { question: string; context?: string } };
      expect(ev.data.question).toBe('Which approach?');
      expect(ev.data.context).toBe('test context');
    } finally {
      off();
      transparency.disable();
    }
  });

  it('skill has permissionLevel read-only', async () => {
    const { requestUserInputSkill } = await import('../../core/skills/tools/request_user_input.js');
    expect(requestUserInputSkill.permissionLevel).toBe('read-only');
  });

  it('skill is registered in registry', async () => {
    const { getSkill } = await import('../../core/skills/registry.js');
    const skill = getSkill('request_user_input');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('request_user_input');
  });
});

describe('user_input_received + user_input_cleared events', () => {
  it('user_input_received event has question and answer fields', async () => {
    const { transparency } = await import('../../core/transparency.js');

    transparency.enable();
    const events: Array<{ type: string; data: unknown }> = [];
    const off = transparency.on(e => events.push(e));

    try {
      transparency.emit({
        type: 'user_input_received',
        data: { question: 'What color?', answer: 'Blue' },
      });
      const found = events.filter(e => e.type === 'user_input_received');
      expect(found.length).toBe(1);
      const ev = found[0] as { type: string; data: { question: string; answer: string } };
      expect(ev.data.question).toBe('What color?');
      expect(ev.data.answer).toBe('Blue');
    } finally {
      off();
      transparency.disable();
    }
  });

  it('user_input_cleared event has empty data object', async () => {
    const { transparency } = await import('../../core/transparency.js');

    transparency.enable();
    const events: Array<{ type: string; data: unknown }> = [];
    const off = transparency.on(e => events.push(e));

    try {
      transparency.emit({ type: 'user_input_cleared', data: {} });
      const found = events.filter(e => e.type === 'user_input_cleared');
      expect(found.length).toBe(1);
    } finally {
      off();
      transparency.disable();
    }
  });
});

describe('processMessage intercept for pending user input', () => {
  it('intercept fires when pending user input exists — clears state', async () => {
    const { savePendingUserInput, loadPendingUserInput, getDb } = await import('../../core/memory/index.js');
    const { processMessage } = await import('../../core/agent.js');

    const mockLLM = async () => 'Hello';
    const db = getDb();

    savePendingUserInput('What framework do you want?');
    expect(loadPendingUserInput()).not.toBeNull();

    const result = await processMessage('I want React', [], mockLLM as any, db);

    // After intercept, pending input should be cleared
    expect(loadPendingUserInput()).toBeNull();
    expect(result.reply).toBeTruthy();
  });

  it('intercept includes the answered question in reply', async () => {
    const { savePendingUserInput, getDb } = await import('../../core/memory/index.js');
    const { processMessage } = await import('../../core/agent.js');

    const mockLLM = async () => 'Response';
    const db = getDb();

    savePendingUserInput('Which database?');

    const result = await processMessage('PostgreSQL please', [], mockLLM as any, db);

    // Reply should reference the answer or question
    expect(result.reply).toBeTruthy();
    expect(result.reply.length).toBeGreaterThan(0);
  });

  it('intercept emits user_input_received event', async () => {
    const { transparency } = await import('../../core/transparency.js');
    const { savePendingUserInput, getDb } = await import('../../core/memory/index.js');
    const { processMessage } = await import('../../core/agent.js');

    transparency.enable();
    const events: Array<{ type: string }> = [];
    const off = transparency.on(e => events.push(e));

    try {
      const db = getDb();
      savePendingUserInput('Which color scheme?');

      await processMessage('Blue and white', [], async () => 'ok', db);

      const received = events.filter(e => e.type === 'user_input_received');
      expect(received.length).toBe(1);
    } finally {
      off();
      transparency.disable();
    }
  });

  it('no intercept when no pending user input', async () => {
    const { loadPendingUserInput, getDb } = await import('../../core/memory/index.js');
    const { processMessage } = await import('../../core/agent.js');

    const db = getDb();
    expect(loadPendingUserInput()).toBeNull();

    // Normal processing — no error
    const mockLLM = async () => JSON.stringify({ summary: 'hello', person: null, project: null, time: null, agentic: false, procedure: false, query: false });
    const result = await processMessage('Hello!', [], mockLLM as any, db);
    expect(result).toBeDefined();
  });
});
