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
  queryEntries,
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

  // BUG 2: Expanded intent classification
  it('classifies "who is" queries as memory_query WHO', () => {
    const c = classifyIntent('who is Reza Ahmadi?');
    expect(c.intent).toBe('memory_query');
    expect(c.nb).toBe('WHO');
    expect(c.name).toBe('Reza Ahmadi');
  });

  it('classifies "when is my next meeting" as memory_query WHEN', () => {
    const c = classifyIntent('when is my next meeting?');
    expect(c.intent).toBe('memory_query');
    expect(c.nb).toBe('WHEN');
  });

  it('classifies web search patterns as skill', () => {
    const c1 = classifyIntent('search the web for SQLite tips');
    expect(c1.intent).toBe('skill');
    expect(c1.skill).toBe('web_search');

    const c2 = classifyIntent('google best practices for TypeScript');
    expect(c2.intent).toBe('skill');
    expect(c2.skill).toBe('web_search');

    const c3 = classifyIntent('look up online how to do X');
    expect(c3.intent).toBe('skill');
    expect(c3.skill).toBe('web_search');
  });

  it('classifies "remind me" as memory_write', () => {
    const c = classifyIntent('remind me tomorrow at 9am to call Sara');
    expect(c.intent).toBe('memory_write');
  });

  it('classifies "remember" as memory_write', () => {
    const c = classifyIntent('remember that Ali is a new supplier');
    expect(c.intent).toBe('memory_write');
  });

  it('classifies "how do I" as memory_query HOW', () => {
    const c = classifyIntent('how do I deploy the app?');
    expect(c.intent).toBe('memory_query');
    expect(c.nb).toBe('HOW');
  });

  it('classifies "find [Name]" as memory_query WHO', () => {
    const c = classifyIntent('find Reza');
    expect(c.intent).toBe('memory_query');
    expect(c.nb).toBe('WHO');
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

  // Resolver fix: code detection works for relationship queries too
  it('resolves relationship query with code regardless of intent label', () => {
    const c = classifyIntent(`what does ${contactCode} own?`);
    // Even though this is relationship_query, resolver still checks code
    const resolved = resolveQuery(c);
    expect(resolved).not.toBeNull();
    expect(resolved!.entries[0].code).toBe(projectCode);
  });
});

// --- Context Building ---

describe('buildContext', () => {
  it('includes system prompt in context', () => {
    const messages = buildContext('hello', null, [], []);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('personal assistant');
  });

  // BUG 4: No extra SQL on every request
  it('does NOT include notebook counts for normal queries', () => {
    const messages = buildContext('hello', null, [], []);
    expect(messages[0].content).not.toContain('Memory index:');
  });

  it('includes notebook counts only for summary/overview queries', () => {
    const messages = buildContext('what do you know about me?', null, [], [], 'general');
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

  // BUG 5: Token ceiling guard
  it('enforces token ceiling on large inputs', () => {
    const hugeMessage = 'word '.repeat(2000); // ~2000 words = ~10000 chars
    const longHistory: Message[] = [];
    for (let i = 0; i < 20; i++) {
      longHistory.push({ role: 'user', content: `msg ${i} ${'padding '.repeat(50)}` });
      longHistory.push({ role: 'assistant', content: `reply ${i} ${'padding '.repeat(50)}` });
    }
    const messages = buildContext(hugeMessage, null, longHistory, []);
    const tokens = estimateTokens(messages);
    expect(tokens).toBeLessThan(2000);
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
    if (system.includes('memory writing assistant')) {
      // Write intent LLM mock — extract name from user message and return structured JSON
      const userMsg = messages[messages.length - 1].content;
      const nameMatch = userMsg.match(/named\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)/);
      const name = nameMatch ? nameMatch[1] : 'Mock Person';
      return JSON.stringify({
        nb: 'WHO', type: 'CT', name,
        status: 'active', summary: `${name}, assistant at Anatolia`, body: userMsg,
      });
    }
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

  // BUG 1: Memory writer is connected
  it('memory_write creates entry in SQLite and on disk', async () => {
    const res = await processMessage(
      'create a contact named Sara Moradi, assistant at Anatolia',
      [],
      { llmHandler: mockLLM },
    );

    expect(res.intent).toBe('memory_write');
    expect(res.created).toBeDefined();
    expect(res.created!.name).toBe('Sara Moradi');
    expect(res.created!.nb).toBe('WHO');
    expect(res.created!.type).toBe('CT');

    // Verify markdown file exists
    expect(fs.existsSync(res.created!.path)).toBe(true);

    // Verify SQLite has the row
    const results = queryEntries({ nb: 'WHO', type: 'CT', name: 'Sara Moradi' });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  // BUG 3: Deterministic not-found guard
  it('returns "Entry not found." for missing code fetch without LLM', async () => {
    let llmCalled = false;
    const trackingLLM = async (msgs: Message[]) => { llmCalled = true; return 'nope'; };

    const res = await processMessage('show me WHO.CT-999999', [], { llmHandler: trackingLLM });
    expect(res.reply).toBe('Entry not found.');
    expect(llmCalled).toBe(false);
  });

  it('returns notebook not-found for empty notebook query', async () => {
    const res = await processMessage('list all HOW procedures', [], { llmHandler: mockLLM });
    expect(res.reply).toContain('No entries found in HOW notebook.');
  });

  it('general query reaches LLM even without resolved memory', async () => {
    const res = await processMessage('what is the meaning of life?', [], { llmHandler: mockLLM });
    expect(res.intent).toBe('general');
    expect(res.reply).toBe('I can help with that.');
  });

  // Phase 6: web_search now routes through skill system
  it('web_search routes through skill and LLM', async () => {
    const res = await processMessage('search the web for SQLite tips', [], { llmHandler: mockLLM });
    expect(res.intent).toBe('skill');
  });

  // BUG 6: LLM errors don't crash
  it('returns clean error when LLM throws', async () => {
    const failingLLM = async () => { throw new Error('Connection refused'); };

    const res = await processMessage('what is the meaning of life?', [], { llmHandler: failingLLM });
    expect(res.reply).toContain('could not reach the language model');
    expect(res.error).toContain('Connection refused');
  });

  it('never throws from processMessage', async () => {
    const failingLLM = async () => { throw new Error('BOOM'); };

    // Should not throw — should return error response
    const res = await processMessage('tell me something', [], { llmHandler: failingLLM });
    expect(res).toBeDefined();
    expect(res.error).toBeDefined();
  });

  // BUG 1: Memory write with LLM failure falls back to rule-based
  it('memory_write falls back to rule-based when LLM fails', async () => {
    const failingLLM = async () => { throw new Error('LLM down'); };

    const res = await processMessage(
      'create a contact named Ali Rezaei',
      [],
      { llmHandler: failingLLM },
    );

    expect(res.intent).toBe('memory_write');
    expect(res.created).toBeDefined();
    expect(res.created!.name).toBe('Ali Rezaei');
    expect(res.created!.nb).toBe('WHO');
  });
});
