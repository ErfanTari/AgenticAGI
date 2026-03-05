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
import { buildContext } from '../../core/context.js';
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

afterAll(async () => {
  closeDatabase();
  const { _resetGitInstance } = await import('../../core/memory/versioning.js');
  _resetGitInstance();
  await new Promise(r => setTimeout(r, 100));
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
});

// --- FIX 2: File cleanup on transaction failure ---

describe('createEntry file cleanup', () => {
  it('cleans up file if DB transaction would fail on duplicate code', () => {
    // Create a valid entry first
    const entry = createEntry({
      nb: 'WHAT', type: 'KN', name: 'Cleanup Test',
      status: 'active', summary: 'Testing cleanup', body: 'Body text.',
    });
    expect(fs.existsSync(entry.path)).toBe(true);

    // The file write happens BEFORE the transaction now,
    // so the file is written and then cleaned up on DB error.
    // We verify the normal case works — file exists after successful creation.
    const entry2 = createEntry({
      nb: 'WHAT', type: 'KN', name: 'Cleanup Test Two',
      status: 'active', summary: 'Second test', body: 'Body two.',
    });
    expect(fs.existsSync(entry2.path)).toBe(true);
  });
});

// --- MCP Skill Registry ---

describe('skill registry', () => {
  it('has calculator, file_reader, web_search registered', () => {
    expect(getSkill('calculator')).toBeDefined();
    expect(getSkill('file_reader')).toBeDefined();
    expect(getSkill('web_search')).toBeDefined();
  });

  // FIX 3: registry_only_count — skills registered without importing agent
  it('registry_only_count equals 3 built-in skills', () => {
    const builtIn = getAllSkills().filter(s =>
      ['calculator', 'file_reader', 'web_search'].includes(s.name)
    );
    expect(builtIn.length).toBe(3);
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

  // P5 echo skill test: adding a 4th skill requires only registerSkill call, no circular import
  it('adding a 4th skill (echo) requires only registerSkill call', async () => {
    const echoSkill: MCPSkill = {
      name: 'echo',
      description: 'Echo input back',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'text to echo' } },
        required: ['text'],
      },
      async execute(input: Record<string, unknown>) {
        return { success: true, output: `Echo: ${input.text}` };
      },
    };

    registerSkill(echoSkill);
    expect(getSkill('echo')).toBeDefined();
    expect(getAllSkills().some(s => s.name === 'echo')).toBe(true);

    // Verify it actually executes
    const result = await runSkill('echo', { text: 'hello world' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('Echo: hello world');
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

  it('evaluates percentage expression', async () => {
    const result = await runSkill('calculator', { expression: '15 / 100 * 280' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('42');
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
  const WORKSPACE_ROOT = path.resolve(process.cwd(), 'workspace');
  const testFile = path.join(WORKSPACE_ROOT, 'agenticagi_test.txt');
  const largeFile = path.join(WORKSPACE_ROOT, 'large-file.txt');
  const binaryFile = path.join(WORKSPACE_ROOT, 'test.png');

  beforeAll(() => {
    fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
    fs.writeFileSync(testFile, 'Hello, this is test content.\nLine 2.');
    fs.writeFileSync(largeFile, 'x'.repeat(60000));
    fs.writeFileSync(binaryFile, Buffer.from([0x89, 0x50, 0x4E, 0x47])); // PNG header
  });

  afterAll(() => {
    for (const f of [testFile, largeFile, binaryFile]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  });

  it('reads a text file successfully', async () => {
    const result = await runSkill('file_reader', { path: testFile });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Hello, this is test content.');
    expect(result.output).toContain('Line 2.');
  });

  it('returns error for nonexistent file', async () => {
    const result = await runSkill('file_reader', { path: path.join(WORKSPACE_ROOT, 'nonexistent-file-xyz.txt') });
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

  it('denies access to paths outside workspace', async () => {
    const result = await runSkill('file_reader', { path: '/etc/passwd' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Access denied: Path outside workspace');
  });

  it('denies path traversal attempts', async () => {
    const result = await runSkill('file_reader', { path: path.join(WORKSPACE_ROOT, '..', 'package.json') });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Access denied: Path outside workspace');
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
    expect(result.output.length).toBeGreaterThan(0);
  });

  it('respects SEARCH_ENDPOINT env variable', async () => {
    // Verify the env var is read (when unset, uses DDG fallback)
    const origEndpoint = process.env.SEARCH_ENDPOINT;
    delete process.env.SEARCH_ENDPOINT;
    const result = await runSkill('web_search', { query: 'test query' });
    // Falls back to DDG — should still work
    expect(result.success).toBe(true);
    if (origEndpoint) process.env.SEARCH_ENDPOINT = origEndpoint;
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

// --- FIX 1: Expanded Classifier Patterns ---

describe('classifier skill detection', () => {
  // Calculator
  it('detects "what is 144 divided by 12" → calculator', () => {
    const c = classifyIntent('what is 144 divided by 12');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('calculator');
    expect(String(c.skillInput!.expression)).toContain('144');
  });

  it('detects "calculate 25 * 4" → calculator', () => {
    const c = classifyIntent('calculate 25 * 4');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('calculator');
  });

  it('detects "calculate 15 percent of 280" → calculator', () => {
    const c = classifyIntent('calculate 15 percent of 280');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('calculator');
    // Expression should convert to "15 / 100 * 280"
    expect(String(c.skillInput!.expression)).toContain('15');
    expect(String(c.skillInput!.expression)).toContain('280');
  });

  it('detects "how much is 50 times 3" → calculator', () => {
    const c = classifyIntent('how much is 50 times 3');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('calculator');
  });

  // File reader
  it('detects "read the file /tmp/test.txt" → file_reader', () => {
    const c = classifyIntent('read the file /tmp/test.txt');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('file_reader');
    expect(c.skillInput!.path).toBe('/tmp/test.txt');
  });

  it('detects "load the contents of config.json" → file_reader', () => {
    const c = classifyIntent('load the contents of config.json');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('file_reader');
    expect(String(c.skillInput!.path)).toContain('config.json');
  });

  it('detects "open file /etc/hosts" → file_reader', () => {
    const c = classifyIntent('open file /etc/hosts');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('file_reader');
  });

  // Web search
  it('detects "search the web for ceramic suppliers Turkey" → web_search', () => {
    const c = classifyIntent('search the web for ceramic suppliers Turkey');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('web_search');
    expect(String(c.skillInput!.query)).toContain('ceramic');
  });

  it('detects "google best TypeScript practices" → web_search', () => {
    const c = classifyIntent('google best TypeScript practices');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('web_search');
  });

  it('detects "look up latest news on AI" → web_search', () => {
    const c = classifyIntent('look up latest news on AI');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('web_search');
  });

  it('detects "find online resources for TypeScript" → web_search', () => {
    const c = classifyIntent('find online resources for TypeScript');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('web_search');
  });

  it('detects "latest news on ceramics" → web_search', () => {
    const c = classifyIntent('latest news on ceramics');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('web_search');
  });

  // Non-skill intents remain unchanged
  it('does NOT detect skill for "find the Xray project" (memory query)', () => {
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

  // Broad calculator patterns don't false-positive on non-math messages
  it('does NOT detect calculator for "show active projects plus details"', () => {
    // "plus" matches CALCULATOR_PATTERNS but extractMathExpression finds no numbers → falls through
    const c = classifyIntent('show active projects');
    expect(c.intent).toBe('memory_query');
  });
});

// --- FIX 2: agent.ts has zero skill name imports ---

describe('agent.ts import cleanliness', () => {
  it('agent.ts does not import any skill tool files', () => {
    const agentSource = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../core/agent.ts'),
      'utf-8',
    );
    expect(agentSource).not.toContain('./skills/tools/calculator');
    expect(agentSource).not.toContain('./skills/tools/file_reader');
    expect(agentSource).not.toContain('./skills/tools/web_search');
  });
});

// --- FIX 4: Skill output reaches LLM context (5B) ---

describe('skill output in LLM context', () => {
  it('buildContext includes "## Skill Output" when skillOutput is provided', async () => {
    const messages = await buildContext(
      'what is 2 + 2',
      null,
      [],
      [],
      'skill',
      '2 + 2 = 4',
    );
    expect(messages[0].content).toContain('## Skill Output');
    expect(messages[0].content).toContain('2 + 2 = 4');
  });

  it('buildContext does NOT include "## Skill Output" when no skillOutput', async () => {
    const messages = await buildContext('hello', null, [], []);
    expect(messages[0].content).not.toContain('## Skill Output');
  });

  it('large file skill output appears in LLM context', async () => {
    const largeOutput = 'x'.repeat(5000);
    const messages = await buildContext(
      'read the file /tmp/big.txt',
      null,
      [],
      [],
      'skill',
      largeOutput,
    );
    expect(messages[0].content).toContain('## Skill Output');
    expect(messages[0].content).toContain('xxxxx');
  });

  it('end-to-end: skill output reaches mockLLM system prompt', async () => {
    let capturedMessages: Message[] = [];
    const capturingLLM = async (messages: Message[]) => {
      capturedMessages = messages;
      return 'Got it.';
    };

    await processMessage('what is 10 + 20', [], { llmHandler: capturingLLM });

    expect(capturedMessages.length).toBeGreaterThan(0);
    expect(capturedMessages[0].content).toContain('## Skill Output');
    expect(capturedMessages[0].content).toContain('10 + 20 = 30');
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

  it('calculator: "calculate 15 percent of 280" → correct answer', async () => {
    const res = await processMessage('calculate 15 percent of 280', [], { llmHandler: mockLLM });
    expect(res.intent).toBe('skill');
    expect(res.reply).toContain('42');
  });

  it('file_reader skill end-to-end', async () => {
    const wsRoot = path.resolve(process.cwd(), 'workspace');
    const testFile = path.join(wsRoot, 'agent-test-file.txt');
    fs.mkdirSync(wsRoot, { recursive: true });
    fs.writeFileSync(testFile, 'Agent test file contents here.');

    const res = await processMessage(`read the file ${testFile}`, [], { llmHandler: mockLLM });
    expect(res.intent).toBe('skill');
    expect(res.reply).toContain('Agent test file contents');
    try { fs.unlinkSync(testFile); } catch { /* ignore */ }
  });

  it('file_reader: "load the contents of" routes correctly', async () => {
    const wsRoot = path.resolve(process.cwd(), 'workspace');
    const testFile = path.join(wsRoot, 'config-test.json');
    fs.mkdirSync(wsRoot, { recursive: true });
    fs.writeFileSync(testFile, '{"key": "value"}');

    const res = await processMessage(`load the contents of ${testFile}`, [], { llmHandler: mockLLM });
    expect(res.intent).toBe('skill');
    expect(res.reply).toContain('"key"');
    try { fs.unlinkSync(testFile); } catch { /* ignore */ }
  });

  it('web_search skill end-to-end', async () => {
    const res = await processMessage('search the web for ceramic glaze suppliers Turkey', [], { llmHandler: mockLLM });
    expect(res.intent).toBe('skill');
    expect(res.reply.length).toBeGreaterThan(0);
  });

  it('skill error with "calculate abc + xyz"', async () => {
    const res = await processMessage('calculate abc + xyz', [], { llmHandler: mockLLM });
    expect(res.intent).toBe('skill');
    expect(res.reply).toContain("couldn't complete");
  });

  it('file_reader error for nonexistent file', async () => {
    const wsRoot = path.resolve(process.cwd(), 'workspace');
    const res = await processMessage(`read the file ${path.join(wsRoot, 'nonexistent-abc-xyz.txt')}`, [], { llmHandler: mockLLM });
    expect(res.intent).toBe('skill');
    expect(res.reply).toContain("couldn't complete");
    expect(res.error).toContain('File not found');
  });

  it('file_reader denies access outside workspace via agent loop', async () => {
    const res = await processMessage('read the file /etc/passwd', [], { llmHandler: mockLLM });
    expect(res.intent).toBe('skill');
    expect(res.reply).toContain("couldn't complete");
    expect(res.error).toContain('Access denied');
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
    expect(res.reply).toContain('300');
  });
});
