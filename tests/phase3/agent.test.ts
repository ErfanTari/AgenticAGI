import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { classifyIntent } from '../../core/intent.js';
import { resolveQuery } from '../../core/resolver.js';
import { buildContext, getIndexSummary, estimateTokens } from '../../core/context.js';
import { getSkillsForIntent } from '../../core/skills/registry.js';
import { processMessage } from '../../core/agent.js';
import {
  initDatabase,
  closeDatabase,
  createEntry,
  addRelationship,
} from '../../core/memory/mod.js';
import { PATHS } from '../../config/agent.config.js';
import type { Message } from '../../core/types.js';

const TEST_DIR = path.join(os.tmpdir(), `agentic-agi-test-p3-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'memory.sqlite');
const TEST_MEMORY = path.join(TEST_DIR, 'memory');

const origDb = PATHS.db;
const origMemory = PATHS.memory;

let contactCode: string;
let projectCode: string;

beforeAll(() => {
  (PATHS as Record<string, string>).db = TEST_DB;
  (PATHS as Record<string, string>).memory = TEST_MEMORY;
  initDatabase(TEST_DB);

  contactCode = createEntry({
    nb: 'WHO', type: 'CT', name: 'Erfan Tari',
    status: 'active', summary: 'Owner, developer', body: 'The owner of this platform.',
  }).code;

  projectCode = createEntry({
    nb: 'WHAT', type: 'PJ', name: 'Activation Xray',
    status: 'active', summary: 'AI interpretability project', body: 'Studying neural activations.',
  }).code;

  createEntry({
    nb: 'NOW', type: 'TD', name: 'Review docs',
    status: 'open', summary: 'Review documentation', body: 'Check all docs.',
  });

  addRelationship({ from_code: contactCode, relation: 'owns', to_code: projectCode });
});

afterAll(() => {
  closeDatabase();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
});

// --- Intent Classification ---

describe('classifyIntent', () => {
  it('classifies greetings', () => {
    expect(classifyIntent('hello').intent).toBe('greeting');
    expect(classifyIntent('Hi there').intent).toBe('greeting');
    expect(classifyIntent('good morning').intent).toBe('greeting');
  });

  it('classifies code fetch', () => {
    const c = classifyIntent(`show me ${contactCode}`);
    expect(c.intent).toBe('code_fetch');
    expect(c.codes).toContain(contactCode);
  });

  it('classifies relationship queries', () => {
    const c = classifyIntent(`what does ${contactCode} own?`);
    expect(c.intent).toBe('relationship_query');
    expect(c.codes).toContain(contactCode);
    expect(c.relation).toBe('owns');
  });

  it('classifies memory queries with type and status', () => {
    const c = classifyIntent('show active projects');
    expect(c.intent).toBe('memory_query');
    expect(c.nb).toBe('WHAT');
    expect(c.type).toBe('PJ');
    expect(c.status).toBe('active');
  });

  it('extracts name from natural query', () => {
    const c = classifyIntent("what's the status of project Xray?");
    expect(c.intent).toBe('memory_query');
    expect(c.name).toBe('Xray');
  });

  it('classifies write intent', () => {
    const c = classifyIntent('create a new contact for John');
    expect(c.intent).toBe('memory_write');
  });

  it('classifies general messages', () => {
    expect(classifyIntent('what is the meaning of life?').intent).toBe('general');
  });
});

// --- Resolver (5-step memory query flow) ---

describe('resolveQuery', () => {
  it('step 1: fetches by code directly', () => {
    const c = classifyIntent(`tell me about ${contactCode}`);
    const resolved = resolveQuery(c);
    expect(resolved).not.toBeNull();
    expect(resolved!.step).toBe(1);
    expect(resolved!.entries[0].code).toBe(contactCode);
    expect(resolved!.contents.length).toBe(1);
    expect(resolved!.contents[0]).toContain('# Erfan Tari');
  });

  it('step 2: filters by type and status', () => {
    const c = classifyIntent('show active projects');
    const resolved = resolveQuery(c);
    expect(resolved).not.toBeNull();
    expect(resolved!.step).toBe(2);
    expect(resolved!.entries.length).toBeGreaterThan(0);
    resolved!.entries.forEach(e => {
      expect(e.nb).toBe('WHAT');
      expect(e.type).toBe('PJ');
    });
  });

  it('step 3: resolves relationship queries', () => {
    const c = classifyIntent(`what does ${contactCode} own?`);
    const resolved = resolveQuery(c);
    expect(resolved).not.toBeNull();
    expect(resolved!.step).toBe(3);
    expect(resolved!.relationships.length).toBe(1);
    expect(resolved!.entries[0].code).toBe(projectCode);
  });

  it('step 2 with name: finds entry by name + type', () => {
    const c = classifyIntent("what's the status of project Xray?");
    const resolved = resolveQuery(c);
    expect(resolved).not.toBeNull();
    expect(resolved!.step).toBe(2);
    expect(resolved!.entries[0].name).toContain('Xray');
  });

  it('returns null when nothing matches', () => {
    const c = classifyIntent('find the ceramic color work');
    const resolved = resolveQuery(c);
    expect(resolved).toBeNull();
  });
});

// --- Context Building ---

describe('buildContext', () => {
  it('includes system prompt and index summary', () => {
    const messages = buildContext('hello', null, [], []);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('personal assistant');
    expect(messages[0].content).toContain('Memory index:');
  });

  it('includes resolved memory entries in context', () => {
    const c = classifyIntent('show active projects');
    const resolved = resolveQuery(c);
    const messages = buildContext('show active projects', resolved, [], []);
    const system = messages[0].content;
    expect(system).toContain('Resolved Memory');
    expect(system).toContain(projectCode);
  });

  it('limits history to last 6 turns', () => {
    const longHistory: Message[] = [];
    for (let i = 0; i < 20; i++) {
      longHistory.push({ role: 'user', content: `msg ${i}` });
      longHistory.push({ role: 'assistant', content: `reply ${i}` });
    }
    const messages = buildContext('new message', null, longHistory, []);
    // system + 12 history messages + 1 user message = 14
    expect(messages.length).toBe(14);
    // First history message should be from turn 14 (index 28), not turn 0
    expect(messages[1].content).toBe('msg 14');
  });

  it('keeps context under 500 tokens for simple queries', () => {
    const c = classifyIntent('show active projects');
    const resolved = resolveQuery(c);
    const skills = getSkillsForIntent(c.intent);
    const messages = buildContext('show active projects', resolved, [], skills);
    const tokens = estimateTokens(messages);
    expect(tokens).toBeLessThan(500);
  });
});

// --- Index Summary ---

describe('getIndexSummary', () => {
  it('returns notebook counts', () => {
    const summary = getIndexSummary();
    expect(summary).toContain('WHO:');
    expect(summary).toContain('WHAT:');
    expect(summary).toContain('NOW:');
  });
});

// --- Skill Loading ---

describe('getSkillsForIntent', () => {
  it('loads memory_read for code_fetch', () => {
    const skills = getSkillsForIntent('code_fetch');
    expect(skills.length).toBe(1);
    expect(skills[0].name).toBe('memory_read');
  });

  it('loads memory_read for memory_query', () => {
    const skills = getSkillsForIntent('memory_query');
    expect(skills.some(s => s.name === 'memory_read')).toBe(true);
  });

  it('loads memory_write for memory_write intent', () => {
    const skills = getSkillsForIntent('memory_write');
    expect(skills.some(s => s.name === 'memory_write')).toBe(true);
  });

  it('loads nothing for greeting', () => {
    const skills = getSkillsForIntent('greeting');
    expect(skills.length).toBe(0);
  });
});

// --- Full Agent Loop ---

describe('processMessage', () => {
  const mockLLM = async (messages: Message[]) => {
    const system = messages[0].content;
    if (system.includes('Resolved Memory')) {
      return 'Based on memory, here is the information you requested.';
    }
    return 'I can help with that.';
  };

  it('greeting returns instantly without LLM', async () => {
    const start = performance.now();
    const res = await processMessage('hello', []);
    const elapsed = performance.now() - start;

    expect(res.intent).toBe('greeting');
    expect(res.reply).toContain('Hello');
    expect(res.resolved).toBeNull();
    expect(elapsed).toBeLessThan(5);
  });

  it('code fetch resolves entry and calls LLM', async () => {
    const res = await processMessage(`tell me about ${contactCode}`, [], { llmHandler: mockLLM });
    expect(res.intent).toBe('code_fetch');
    expect(res.resolved).not.toBeNull();
    expect(res.resolved!.step).toBe(1);
    expect(res.resolved!.entries[0].code).toBe(contactCode);
    expect(res.reply).toContain('Based on memory');
  });

  it('memory query resolves from SQLite', async () => {
    const res = await processMessage('show active projects', [], { llmHandler: mockLLM });
    expect(res.intent).toBe('memory_query');
    expect(res.resolved).not.toBeNull();
    expect(res.resolved!.step).toBe(2);
  });

  it('relationship query resolves from table only', async () => {
    const res = await processMessage(`what does ${contactCode} own?`, [], { llmHandler: mockLLM });
    expect(res.intent).toBe('relationship_query');
    expect(res.resolved).not.toBeNull();
    expect(res.resolved!.step).toBe(3);
    expect(res.resolved!.entries[0].code).toBe(projectCode);
  });

  it('full cycle completes in under 50ms (with mock LLM)', async () => {
    const start = performance.now();
    await processMessage("what's the status of project Xray?", [], { llmHandler: mockLLM });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});
