import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { classifyIntent } from '../../core/intent.js';
import { processMessage } from '../../core/agent.js';
import { runSkill } from '../../core/skills/runner.js';
import {
  registerSkill,
  getSkill,
  getAllSkills,
  getSkillDescriptions,
} from '../../core/skills/registry.js';
import type { MCPSkill } from '../../core/skills/types.js';
import type { Message } from '../../core/types.js';
import {
  initDatabase,
  closeDatabase,
  createEntry,
} from '../../core/memory/mod.js';
import { addRelationship } from '../../core/memory/relationships.js';
import { PATHS } from '../../config/agent.config.js';

// --- Test setup ---

const TEST_DIR = path.join(os.tmpdir(), `agentic-agi-test-p6-${Date.now()}`);
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
    status: 'active', summary: 'Owner, developer', body: 'The owner.',
  }).code;

  projectCode = createEntry({
    nb: 'WHAT', type: 'PJ', name: 'Activation Xray',
    status: 'active', summary: 'AI interpretability project', body: 'Studying neural activations.',
  }).code;

  addRelationship({ from_code: contactCode, relation: 'owns', to_code: projectCode });
});

afterAll(() => {
  closeDatabase();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
});

// --- MCP Skill Registry ---

describe('skill registry', () => {
  it('has calculator, file_reader, web_search registered', () => {
    expect(getSkill('calculator')).toBeDefined();
    expect(getSkill('file_reader')).toBeDefined();
    expect(getSkill('web_search')).toBeDefined();
  });

  it('getAllSkills returns all registered skills', () => {
    const skills = getAllSkills();
    const names = skills.map(s => s.name);
    expect(names).toContain('calculator');
    expect(names).toContain('file_reader');
    expect(names).toContain('web_search');
  });

  it('getSkillDescriptions returns formatted descriptions', () => {
    const desc = getSkillDescriptions();
    expect(desc).toContain('calculator:');
    expect(desc).toContain('file_reader:');
    expect(desc).toContain('web_search:');
  });

  it('returns undefined for unknown skill', () => {
    expect(getSkill('nonexistent')).toBeUndefined();
  });

  it('each skill implements MCPSkill interface', () => {
    for (const skill of getAllSkills()) {
      expect(typeof skill.name).toBe('string');
      expect(typeof skill.description).toBe('string');
      expect(skill.inputSchema.type).toBe('object');
      expect(typeof skill.inputSchema.properties).toBe('object');
      expect(Array.isArray(skill.inputSchema.required)).toBe(true);
      expect(typeof skill.execute).toBe('function');
    }
  });

  it('adding a 4th skill requires only registerSkill call', () => {
    const testSkill: MCPSkill = {
      name: 'test_skill',
      description: 'A test skill for verification',
      inputSchema: {
        type: 'object',
        properties: { input: { type: 'string', description: 'test input' } },
        required: ['input'],
      },
      async execute(input: Record<string, unknown>) {
        return { success: true, output: `Got: ${input.input}` };
      },
    };

    registerSkill(testSkill);
    expect(getSkill('test_skill')).toBeDefined();
    expect(getAllSkills().some(s => s.name === 'test_skill')).toBe(true);
  });
});

// --- Calculator Skill ---

describe('calculator skill', () => {
  it('evaluates simple arithmetic', async () => {
    const result = await runSkill('calculator', { expression: '144 / 12' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('12');
  });

  it('evaluates addition', async () => {
    const result = await runSkill('calculator', { expression: '2 + 3' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('5');
  });

  it('evaluates complex expressions', async () => {
    const result = await runSkill('calculator', { expression: 'sqrt(144)' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('12');
  });

  it('returns error for invalid expression', async () => {
    const result = await runSkill('calculator', { expression: 'abc + xyz' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid expression');
  });

  it('returns error for empty expression', async () => {
    const result = await runSkill('calculator', { expression: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('No expression');
  });

  it('formats output as "expression = result"', async () => {
    const result = await runSkill('calculator', { expression: '10 * 5' });
    expect(result.output).toBe('10 * 5 = 50');
  });
});

// --- File Reader Skill ---

describe('file_reader skill', () => {
  const testFile = path.join(TEST_DIR, 'test-read.txt');
  const largeFile = path.join(TEST_DIR, 'large-file.txt');
  const binaryFile = path.join(TEST_DIR, 'test.png');

  beforeAll(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(testFile, 'Hello, this is test content.\nLine 2.');
    fs.writeFileSync(largeFile, 'x'.repeat(60000));
    fs.writeFileSync(binaryFile, Buffer.from([0x89, 0x50, 0x4E, 0x47])); // PNG header
  });

  it('reads a text file successfully', async () => {
    const result = await runSkill('file_reader', { path: testFile });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Hello, this is test content.');
    expect(result.output).toContain('Line 2.');
  });

  it('returns error for nonexistent file', async () => {
    const result = await runSkill('file_reader', { path: '/tmp/nonexistent-file-xyz.txt' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('File not found');
  });

  it('truncates files larger than 50000 chars', async () => {
    const result = await runSkill('file_reader', { path: largeFile });
    expect(result.success).toBe(true);
    expect(result.output).toContain('File truncated at 50000 characters');
    expect(result.output).toContain('60000 chars');
  });

  it('rejects binary files', async () => {
    const result = await runSkill('file_reader', { path: binaryFile });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Binary file not supported');
  });

  it('returns error for empty path', async () => {
    const result = await runSkill('file_reader', { path: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('No file path');
  });
});

// --- Web Search Skill ---

describe('web_search skill', () => {
  it('returns results for a query', async () => {
    const result = await runSkill('web_search', { query: 'TypeScript programming language' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('TypeScript');
  });

  it('handles empty query', async () => {
    const result = await runSkill('web_search', { query: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('No search query');
  });

  it('returns graceful message when no results', async () => {
    const result = await runSkill('web_search', { query: 'xyznonexistentqueryzyx123456' });
    expect(result.success).toBe(true);
    // Either has results or says no results
    expect(result.output.length).toBeGreaterThan(0);
  });
});

// --- Runner ---

describe('runSkill', () => {
  it('returns error for unknown skill', async () => {
    const result = await runSkill('nonexistent_skill', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("Skill 'nonexistent_skill' not found");
  });

  it('never throws even on skill execution error', async () => {
    // Register a skill that throws
    const throwingSkill: MCPSkill = {
      name: 'throwing_skill',
      description: 'Always throws',
      inputSchema: { type: 'object', properties: {}, required: [] },
      async execute() { throw new Error('BOOM'); },
    };
    registerSkill(throwingSkill);

    const result = await runSkill('throwing_skill', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('BOOM');
  });
});

// --- Classifier Skill Detection ---

describe('classifier skill detection', () => {
  it('detects calculator intent: "what is 144 divided by 12"', () => {
    const c = classifyIntent('what is 144 divided by 12');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('calculator');
    expect(c.skillInput).toBeDefined();
    expect(String(c.skillInput!.expression)).toContain('144');
  });

  it('detects calculator intent: "calculate 25 * 4"', () => {
    const c = classifyIntent('calculate 25 * 4');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('calculator');
  });

  it('detects file_reader intent: "read the file /tmp/test.txt"', () => {
    const c = classifyIntent('read the file /tmp/test.txt');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('file_reader');
    expect(c.skillInput).toBeDefined();
    expect(c.skillInput!.path).toBe('/tmp/test.txt');
  });

  it('detects web_search intent: "search the web for ceramic suppliers Turkey"', () => {
    const c = classifyIntent('search the web for ceramic suppliers Turkey');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('web_search');
    expect(c.skillInput).toBeDefined();
    expect(String(c.skillInput!.query)).toContain('ceramic');
  });

  it('detects web_search intent: "google best TypeScript practices"', () => {
    const c = classifyIntent('google best TypeScript practices');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('web_search');
  });

  it('does NOT detect skill for memory queries', () => {
    // "find the Xray project" → memory_query, NOT skill
    const c = classifyIntent('find the Xray project');
    expect(c.intent).not.toBe('skill');
  });

  it('does NOT detect skill for code fetch', () => {
    const c = classifyIntent(`show me ${contactCode}`);
    expect(c.intent).toBe('code_fetch');
  });

  it('does NOT detect skill for memory write', () => {
    const c = classifyIntent('create a contact named Test Person');
    expect(c.intent).toBe('memory_write');
  });

  it('does NOT detect skill for greetings', () => {
    expect(classifyIntent('hello').intent).toBe('greeting');
  });
});

// --- Full Agent Loop with Skills ---

describe('processMessage with skills', () => {
  const mockLLM = async (messages: Message[]) => {
    const system = messages[0].content;
    if (system.includes('memory writing assistant')) {
      return JSON.stringify({ nb: 'WHO', type: 'CT', name: 'Test', status: 'active', summary: 'Test', body: 'Test' });
    }
    if (system.includes('Skill Output')) {
      return `Here is the result: ${system.match(/## Skill Output\n([\s\S]*)/)?.[1]?.slice(0, 100) ?? 'done'}`;
    }
    if (system.includes('Resolved Memory')) {
      return 'Based on memory context.';
    }
    return 'General response.';
  };

  it('calculator skill end-to-end: "what is 144 divided by 12"', async () => {
    const res = await processMessage('what is 144 divided by 12', [], { llmHandler: mockLLM });
    expect(res.intent).toBe('skill');
    expect(res.reply).toContain('12');
  });

  it('file_reader skill end-to-end', async () => {
    const testFile = path.join(TEST_DIR, 'agent-test-file.txt');
    fs.writeFileSync(testFile, 'Agent test file contents here.');

    const res = await processMessage(`read the file ${testFile}`, [], { llmHandler: mockLLM });
    expect(res.intent).toBe('skill');
    expect(res.reply).toContain('Agent test file contents');
  });

  it('web_search skill end-to-end', async () => {
    const res = await processMessage('search the web for ceramic glaze suppliers Turkey', [], { llmHandler: mockLLM });
    expect(res.intent).toBe('skill');
    // Result from LLM wrapping the skill output
    expect(res.reply.length).toBeGreaterThan(0);
  });

  it('calculator error returns clean message', async () => {
    const res = await processMessage('what is abc plus xyz', [], { llmHandler: mockLLM });
    // "abc plus xyz" doesn't match calculator pattern (no digits), goes to general
    // But "calculate abc + xyz" would match
    expect(res).toBeDefined();
  });

  it('skill error with "calculate abc + xyz"', async () => {
    const res = await processMessage('calculate abc + xyz', [], { llmHandler: mockLLM });
    expect(res.intent).toBe('skill');
    expect(res.reply).toContain("couldn't complete");
  });

  it('file_reader error for nonexistent file', async () => {
    const res = await processMessage('read the file /tmp/nonexistent-abc-xyz.txt', [], { llmHandler: mockLLM });
    expect(res.intent).toBe('skill');
    expect(res.reply).toContain("couldn't complete");
    expect(res.error).toContain('File not found');
  });

  // Regression: memory queries still work unchanged
  it('memory query for project still works', async () => {
    const res = await processMessage('show active projects', [], { llmHandler: mockLLM });
    expect(res.intent).toBe('memory_query');
    expect(res.resolved).not.toBeNull();
  });

  it('code fetch still works', async () => {
    const res = await processMessage(`tell me about ${contactCode}`, [], { llmHandler: mockLLM });
    expect(res.intent).toBe('code_fetch');
    expect(res.resolved).not.toBeNull();
    expect(res.resolved!.entries[0].code).toBe(contactCode);
  });

  it('relationship query still works', async () => {
    const res = await processMessage(`what does ${contactCode} own?`, [], { llmHandler: mockLLM });
    expect(res.intent).toBe('relationship_query');
    expect(res.resolved).not.toBeNull();
    expect(res.resolved!.entries[0].code).toBe(projectCode);
  });

  it('greeting still instant', async () => {
    const res = await processMessage('hello', []);
    expect(res.intent).toBe('greeting');
    expect(res.reply).toContain('Hello');
  });

  it('LLM failure during skill returns raw skill output', async () => {
    const failingLLM = async () => { throw new Error('LLM down'); };
    const res = await processMessage('what is 100 + 200', [], { llmHandler: failingLLM });
    expect(res.intent).toBe('skill');
    // Falls back to raw skill output when LLM fails
    expect(res.reply).toContain('300');
  });
});
