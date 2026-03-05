/**
 * FIX 2 — Context Message Ordering.
 * Verifies that buildContext() always produces a message array whose last entry is role=user.
 * LM Studio's Qwen3.5 jinja template requires this.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildContext } from '../../core/context.js';
import { initDatabase, closeDatabase } from '../../core/memory/index.js';
import { PATHS } from '../../config/agent.config.js';
import type { Message } from '../../core/types.js';

const TEST_DIR = path.join(os.tmpdir(), `agentic-phase12-ctx-${Date.now()}`);
const origDb = PATHS.db;
const origMemory = PATHS.memory;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  (PATHS as Record<string, string>).db = path.join(TEST_DIR, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(TEST_DIR, 'memory');
  initDatabase(path.join(TEST_DIR, 'test.sqlite'));
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

describe('FIX 2 — buildContext message ordering', () => {
  it('last message is always role=user for a simple query', async () => {
    const messages = await buildContext('hello', null, [], []);
    expect(messages[messages.length - 1].role).toBe('user');
  });

  it('last message is role=user with conversation history', async () => {
    const history: Message[] = [
      { role: 'user', content: 'what is 2+2?' },
      { role: 'assistant', content: '4' },
    ];
    const messages = await buildContext('tell me more', null, history, []);
    expect(messages[messages.length - 1].role).toBe('user');
    expect(messages[messages.length - 1].content).toBe('tell me more');
  });

  it('last message is role=user with skill output injected', async () => {
    const messages = await buildContext(
      'what did the calculation return?',
      null,
      [],
      [],
      'skill',
      '42',
    );
    expect(messages[messages.length - 1].role).toBe('user');
  });

  it('last message is role=user with long history (rolling summarization path)', async () => {
    const longHistory: Message[] = [];
    for (let i = 0; i < 20; i++) {
      longHistory.push({ role: 'user', content: `question ${i}` });
      longHistory.push({ role: 'assistant', content: `answer ${i}` });
    }
    const mockLLM = async () => 'Summary of prior conversation.';
    const messages = await buildContext('new question', null, longHistory, [], 'general', undefined, mockLLM);
    expect(messages[messages.length - 1].role).toBe('user');
  });

  it('first message is always role=system', async () => {
    const messages = await buildContext('test', null, [], []);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('personal AI agent');
  });
});
