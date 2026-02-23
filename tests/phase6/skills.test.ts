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
const WORKSPACE_ROOT = path.resolve(process.cwd(), 'user_workspace');
const WORKSPACE_TEST_DIR = path.join(WORKSPACE_ROOT, `phase6-tests-${Date.now()}`);

const origDb = PATHS.db;
const origMemory = PATHS.memory;

let contactCode: string;
let projectCode: string;

beforeAll(() => {
  (PATHS as Record<string, string>).db = TEST_DB;
  (PATHS as Record<string, string>).memory = TEST_MEMORY;
  fs.mkdirSync(WORKSPACE_TEST_DIR, { recursive: true });
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
  fs.rmSync(WORKSPACE_TEST_DIR, { recursive: true, force: true });
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
});

// --- MCP Skill Registry ---

describe('skill registry', () => {
  it('has calculator, file_reader, web_search core skills registered', () => {
    expect(getSkill('calculator')).toBeDefined();
    expect(getSkill('file_reader')).toBeDefined();
    expect(getSkill('web_search')).toBeDefined();
  });

  it('registry_only_count equals 3 core built-in skills', () => {
    const builtIn = getAllSkills().filter(s =>
      ['calculator', 'file_reader', 'web_search'].includes(s.name)
    );
    expect(builtIn.length).toBe(3);
  });

  it('getAllSkills returns core phase-6 skills by default', () => {
    const skills = getAllSkills();
    const names = skills.map(s => s.name);
    expect(names.length).toBe(3);
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

// --- Shell Runner Skill ---

describe('shell_runner skill', () => {
  it('runs allowed command successfully', async () => {
    const result = await runSkill('shell_runner', { command: 'pnpm --version' });
    expect(result.success).toBe(true);
    expect(result.output.length).toBeGreaterThan(0);
  });

  it('blocks disallowed command', async () => {
    const result = await runSkill('shell_runner', { command: 'rm -rf /tmp/demo' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Command not allowed');
  });

  it('allows mkdir -p for safe workspace setup', async () => {
    const dir = path.join(TEST_DIR, 'mkdir-safe');
    const result = await runSkill('shell_runner', { command: `mkdir -p ${dir}` });
    expect(result.success).toBe(true);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('allows safe chained commands (mkdir + pnpm --version)', async () => {
    const dir = path.join(TEST_DIR, 'node-chain');
    const result = await runSkill('shell_runner', { command: `mkdir -p ${dir} && pnpm --version` });
    expect(result.success).toBe(true);
    expect(fs.existsSync(dir)).toBe(true);
    expect(result.output.length).toBeGreaterThan(0);
  });
});

describe('task_planner skill', () => {
  it('returns ordered execution steps', async () => {
    const result = await runSkill('task_planner', { goal: 'implement farming loop', maxSteps: 5 });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Execution plan:');
    expect(result.output).toContain('1.');
    expect(result.output).toContain('5.');
  });
});

describe('log_analyzer skill', () => {
  it('extracts TypeScript error signatures', async () => {
    const logs = 'core/a.ts(1,1): error TS2322: Type string is not assignable to number';
    const result = await runSkill('log_analyzer', { logs });
    expect(result.success).toBe(true);
    expect(result.output).toContain('TS2322');
    expect(result.output).toContain('Suggested fixes');
  });
});

describe('code_editor skill', () => {
  const file = path.join(TEST_DIR, 'code-editor.ts');
  afterAll(() => {
    fs.rmSync(file, { force: true });
  });

  it('replaces text in file', async () => {
    fs.writeFileSync(file, 'export const n = 1;');
    const result = await runSkill('code_editor', {
      path: file,
      operation: 'replace',
      target: '1',
      content: '2',
    });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toContain('2');
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
  const testFile = path.join(WORKSPACE_ROOT, 'agenticagi_test.txt');
  const testFileRelative = 'user_workspace/agenticagi_test.txt';
  const missingWorkspaceFile = path.join(WORKSPACE_TEST_DIR, 'does_not_exist_xyz.txt');
  const largeFile = path.join(WORKSPACE_TEST_DIR, 'large-file.txt');
  const binaryFile = path.join(WORKSPACE_TEST_DIR, 'test.png');
  const outsideFile = '/tmp/agenticagi_outside_workspace.txt';

  beforeAll(() => {
    fs.mkdirSync(WORKSPACE_TEST_DIR, { recursive: true });
    fs.writeFileSync(testFile, 'hello from phase 6');
    fs.writeFileSync(largeFile, 'x'.repeat(60000));
    fs.writeFileSync(binaryFile, Buffer.from([0x89, 0x50, 0x4E, 0x47])); // PNG header
  });

  it('reads a text file successfully', async () => {
    const result = await runSkill('file_reader', { path: testFileRelative });
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello from phase 6');
  });

  it('returns error for nonexistent file', async () => {
    const result = await runSkill('file_reader', { path: missingWorkspaceFile });
    expect(result.success).toBe(false);
    expect(result.error).toContain('File not found');
  });

  it('denies reading files outside workspace', async () => {
    const result = await runSkill('file_reader', { path: outsideFile });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Access denied: Path outside workspace');
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

  it('recreates user_workspace automatically if deleted', async () => {
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
    const result = await runSkill('file_reader', { path: 'user_workspace/missing-after-delete.txt' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('File not found');
    expect(fs.existsSync(WORKSPACE_ROOT)).toBe(true);

    // Ensure later tests that write under this directory have a valid parent.
    fs.mkdirSync(WORKSPACE_TEST_DIR, { recursive: true });
  });
});

// --- File Writer Skill ---

describe('file_writer skill', () => {
  const outputFile = path.join(TEST_DIR, 'write-target.txt');

  afterAll(() => {
    fs.rmSync(outputFile, { force: true });
  });

  it('writes text to a file successfully', async () => {
    const result = await runSkill('file_writer', {
      path: outputFile,
      content: 'hello writer',
      overwrite: true,
    });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(outputFile, 'utf-8')).toContain('hello writer');
  });

  it('fails when file exists and overwrite=false', async () => {
    fs.writeFileSync(outputFile, 'existing');
    const result = await runSkill('file_writer', {
      path: outputFile,
      content: 'new content',
      overwrite: false,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('File already exists');
  });

  it('appends to a file', async () => {
    fs.writeFileSync(outputFile, 'line1');
    const result = await runSkill('file_writer', {
      path: outputFile,
      content: '\nline2',
      append: true,
    });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(outputFile, 'utf-8')).toContain('line1\nline2');
  });
});

// --- Web Fetch Skill ---

describe('web_fetch skill', () => {
  const originalFetch = globalThis.fetch;
  const downloadTarget = path.join(TEST_DIR, 'catalog.pdf');

  afterAll(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(downloadTarget, { force: true });
  });

  it('returns text content when fetching a text page', async () => {
    globalThis.fetch = async () => (
      new Response('Catalog page content', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    );

    const result = await runSkill('web_fetch', { url: 'https://example.com/catalog' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Catalog page content');
  });

  it('downloads binary content when outputPath is provided', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    globalThis.fetch = async () => (
      new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      })
    );

    const result = await runSkill('web_fetch', {
      url: 'https://example.com/catalog.pdf',
      outputPath: downloadTarget,
    });
    expect(result.success).toBe(true);
    expect(fs.existsSync(downloadTarget)).toBe(true);
    expect(fs.readFileSync(downloadTarget).length).toBe(5);
  });

  it('rejects binary fetch without outputPath', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    globalThis.fetch = async () => (
      new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })
    );

    const result = await runSkill('web_fetch', { url: 'https://example.com/binary.bin' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Provide outputPath');
  });
});

// --- Web Search Skill ---

describe('web_search skill', () => {
  const originalFetch = globalThis.fetch;
  const originalBraveKey = process.env.BRAVE_SEARCH_API_KEY;
  const originalBraveEndpoint = process.env.BRAVE_SEARCH_ENDPOINT;
  const originalBraveNewsEndpoint = process.env.BRAVE_NEWS_ENDPOINT;
  const originalSearchEndpoint = process.env.SEARCH_ENDPOINT;
  const originalDdgEndpoint = process.env.DUCKDUCKGO_ENDPOINT;

  afterAll(() => {
    globalThis.fetch = originalFetch;
    if (originalBraveKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
    else process.env.BRAVE_SEARCH_API_KEY = originalBraveKey;
    if (originalBraveEndpoint === undefined) delete process.env.BRAVE_SEARCH_ENDPOINT;
    else process.env.BRAVE_SEARCH_ENDPOINT = originalBraveEndpoint;
    if (originalBraveNewsEndpoint === undefined) delete process.env.BRAVE_NEWS_ENDPOINT;
    else process.env.BRAVE_NEWS_ENDPOINT = originalBraveNewsEndpoint;
    if (originalSearchEndpoint === undefined) delete process.env.SEARCH_ENDPOINT;
    else process.env.SEARCH_ENDPOINT = originalSearchEndpoint;
    if (originalDdgEndpoint === undefined) delete process.env.DUCKDUCKGO_ENDPOINT;
    else process.env.DUCKDUCKGO_ENDPOINT = originalDdgEndpoint;
  });

  it('returns results for a query', async () => {
    delete process.env.BRAVE_SEARCH_API_KEY;
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return {
          AbstractText: 'TypeScript is a strongly typed programming language.',
          RelatedTopics: [],
        };
      },
    } as Response);

    const result = await runSkill('web_search', { query: 'TypeScript programming language' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('TypeScript');
  });

  it('uses Brave API when key is configured', async () => {
    process.env.BRAVE_SEARCH_API_KEY = 'test-brave-key';
    process.env.BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
    let capturedToken = '';

    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      capturedToken = headers?.['X-Subscription-Token'] ?? '';
      return new Response(
        JSON.stringify({
          web: {
            results: [
              {
                title: 'TypeScript',
                url: 'https://www.typescriptlang.org',
                description: 'TypeScript official website.',
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };

    const result = await runSkill('web_search', { query: 'TypeScript tutorial' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Brave Search');
    expect(result.output).toContain('typescriptlang.org');
    expect(capturedToken).toBe('test-brave-key');
  });

  it('falls back to Google News RSS when Brave returns no results for news query', async () => {
    process.env.BRAVE_SEARCH_API_KEY = 'test-brave-key';
    process.env.BRAVE_NEWS_ENDPOINT = 'https://api.search.brave.com/res/v1/news/search';
    let braveCalls = 0;
    let rssCalls = 0;
    let ddgCalls = 0;

    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Political Headline A</title>
      <link>https://news.example.com/a</link>
      <pubDate>Mon, 23 Feb 2026 12:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/news/search')) {
        braveCalls += 1;
        return new Response(
          JSON.stringify({ news: { results: [] }, web: { results: [] } }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      if (url.includes('news.google.com/rss/search')) {
        rssCalls += 1;
        return new Response(rss, {
          status: 200,
          headers: { 'content-type': 'application/rss+xml' },
        });
      }
      if (url.includes('duckduckgo.com')) {
        ddgCalls += 1;
        return new Response(
          JSON.stringify({ AbstractText: 'Should not be needed', RelatedTopics: [] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      return new Response('Not found', { status: 404 });
    };

    const result = await runSkill('web_search', { query: '3 political news today' });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Top news for '3 political news today'");
    expect(result.output).toContain('Political Headline A');
    expect(braveCalls).toBe(1);
    expect(rssCalls).toBe(1);
    expect(ddgCalls).toBe(0);
  });

  it('returns top news items for news queries', async () => {
    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Story One</title>
      <link>https://news.example.com/one</link>
      <pubDate>Sat, 22 Feb 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Story Two</title>
      <link>https://news.example.com/two</link>
      <pubDate>Sat, 22 Feb 2026 09:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

    globalThis.fetch = async () => (
      new Response(rss, {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
      })
    );

    const result = await runSkill('web_search', { query: '3 news for today' });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Top news for '3 news for today'");
    expect(result.output).toContain('Story One');
  });

  it('handles empty query', async () => {
    const result = await runSkill('web_search', { query: '' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('No search query');
  });

  it('returns graceful message when no results', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return { AbstractText: '', RelatedTopics: [] };
      },
    } as Response);

    const result = await runSkill('web_search', { query: 'xyznonexistentqueryzyx123456' });
    expect(result.success).toBe(true);
    expect(result.output.length).toBeGreaterThan(0);
  });

  it('respects SEARCH_ENDPOINT with {query} placeholder for SearXNG/Tavily-compatible responses', async () => {
    process.env.SEARCH_ENDPOINT = 'http://localhost:8080/search?q={query}&format=json';
    delete process.env.BRAVE_SEARCH_API_KEY;
    let requestedUrl = '';

    globalThis.fetch = async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          results: [
            {
              title: 'SearX Result',
              url: 'https://example.com/searx',
              content: 'SearX compatible result payload',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };

    const result = await runSkill('web_search', { query: 'TypeScript tutorial' });
    expect(result.success).toBe(true);
    expect(requestedUrl).toContain('http://localhost:8080/search?q=TypeScript%20tutorial&format=json');
    expect(result.output).toContain('SearX Result');
    expect(result.output).toContain('https://example.com/searx');
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

  // File writer
  it('detects "write \\"hello\\" to /tmp/note.txt" → file_writer', () => {
    const c = classifyIntent('write "hello" to /tmp/note.txt');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('file_writer');
    expect(String(c.skillInput!.path)).toContain('/tmp/note.txt');
    expect(String(c.skillInput!.content)).toContain('hello');
  });

  // Shell runner
  it('detects "run tests" → shell_runner', () => {
    const c = classifyIntent('run tests');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('shell_runner');
    expect(String(c.skillInput!.command)).toBe('pnpm test');
  });

  it('detects "build project" → shell_runner', () => {
    const c = classifyIntent('build project');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('shell_runner');
    expect(String(c.skillInput!.command)).toBe('pnpm build');
  });

  it('detects planning request → task_planner', () => {
    const c = classifyIntent('break this into steps for implementation');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('task_planner');
  });

  it('detects log analysis request → log_analyzer', () => {
    const c = classifyIntent('analyze this compiler log and explain failure');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('log_analyzer');
  });

  it('detects replace-in-file request → code_editor', () => {
    const c = classifyIntent('replace \"foo\" with \"bar\" in /tmp/a.ts');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('code_editor');
  });

  // Web fetch/download
  it('detects "download https://example.com/catalog.pdf to /tmp/catalog.pdf" → web_fetch', () => {
    const c = classifyIntent('download https://example.com/catalog.pdf to /tmp/catalog.pdf');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('web_fetch');
    expect(String(c.skillInput!.url)).toContain('https://example.com/catalog.pdf');
    expect(String(c.skillInput!.outputPath)).toContain('/tmp/catalog.pdf');
  });

  it('detects bare-domain download prompt → web_fetch with normalized URL', () => {
    const c = classifyIntent('can you go to neolith.com and download their general catalog');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('web_fetch');
    expect(String(c.skillInput!.url)).toBe('https://neolith.com');
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

  it('detects "give me 3 news for today" → web_search', () => {
    const c = classifyIntent('give me 3 news for today');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('web_search');
    expect(String(c.skillInput!.query).length).toBeGreaterThan(0);
  });

  it('detects internet capability news prompt → web_search', () => {
    const c = classifyIntent('check if you can search internet , and tell me latest political news as a test');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('web_search');
    expect(String(c.skillInput!.query)).toContain('political news');
  });

  it('detects "do a web_Search for 3 political news today" with clean query', () => {
    const c = classifyIntent('do a web_Search for 3 political news today');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('web_search');
    expect(String(c.skillInput!.query)).toContain('political news today');
    expect(String(c.skillInput!.query).toLowerCase()).not.toContain('web search');
  });

  it('strips model-name prefix from web search prompt query', () => {
    const c = classifyIntent('qwen do a web_Search for 3 political news today');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('web_search');
    expect(String(c.skillInput!.query)).toContain('political news today');
    expect(String(c.skillInput!.query).toLowerCase()).not.toContain('qwen');
    expect(String(c.skillInput!.query).toLowerCase()).not.toContain('web search');
  });

  it('detects polite internet news prompt with non-empty query', () => {
    const c = classifyIntent('please search internet for news today');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('web_search');
    expect(String(c.skillInput!.query).length).toBeGreaterThan(0);
    expect(String(c.skillInput!.query).toLowerCase()).not.toBe('please');
  });

  it('detects "search internet for ..." → web_search', () => {
    const c = classifyIntent('search internet for EV battery prices');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('web_search');
    expect(String(c.skillInput!.query)).toContain('EV battery prices');
  });

  it('detects "check internet for ..." → web_search', () => {
    const c = classifyIntent('check internet for latest ceramic market trends');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('web_search');
    expect(String(c.skillInput!.query)).toContain('latest ceramic market trends');
  });

  it('detects "find it in internet ..." → web_search', () => {
    const c = classifyIntent('find it in internet for TypeScript router patterns');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('web_search');
    expect(String(c.skillInput!.query)).toContain('TypeScript router patterns');
  });

  it('detects "web_Search for todays date" → web_search', () => {
    const c = classifyIntent('web_Search for todays date');
    expect(c.intent).toBe('skill');
    expect(c.skill).toBe('web_search');
    expect(String(c.skillInput!.query).toLowerCase()).toContain('todays date');
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
    expect(agentSource).not.toContain('./skills/tools/file_writer');
    expect(agentSource).not.toContain('./skills/tools/web_fetch');
    expect(agentSource).not.toContain('./skills/tools/web_search');
  });
});

// --- FIX 4: Skill output reaches LLM context (5B) ---

describe('skill output in LLM context', () => {
  it('buildContext includes "## Skill Output" when skillOutput is provided', () => {
    const messages = buildContext(
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

  it('buildContext does NOT include "## Skill Output" when no skillOutput', () => {
    const messages = buildContext('hello', null, [], []);
    expect(messages[0].content).not.toContain('## Skill Output');
  });

  it('large file skill output appears in LLM context', () => {
    const largeOutput = 'x'.repeat(5000);
    const messages = buildContext(
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
    const testFile = path.join(WORKSPACE_TEST_DIR, 'agent-test-file.txt');
    fs.writeFileSync(testFile, 'Agent test file contents here.');

    const res = await processMessage(`read the file ${testFile}`, [], { llmHandler: mockLLM });
    expect(res.intent).toBe('skill');
    expect(res.reply).toContain('Agent test file contents');
  });

  it('file_reader: "load the contents of" routes correctly', async () => {
    const testFile = path.join(WORKSPACE_TEST_DIR, 'config-test.json');
    fs.writeFileSync(testFile, '{"key": "value"}');

    const res = await processMessage(`load the contents of ${testFile}`, [], { llmHandler: mockLLM });
    expect(res.intent).toBe('skill');
    expect(res.reply).toContain('"key"');
  });

  it('file_writer skill end-to-end', async () => {
    const outFile = path.join(TEST_DIR, 'written-by-agent.txt');
    fs.rmSync(outFile, { force: true });

    const res = await processMessage(`write "hello from file writer" to ${outFile}`, [], { llmHandler: mockLLM });
    expect(res.intent).toBe('skill');
    expect(res.reply).toContain('Wrote');
    expect(fs.existsSync(outFile)).toBe(true);
    expect(fs.readFileSync(outFile, 'utf-8')).toContain('hello from file writer');
  });

  it('web_fetch skill end-to-end (download to local file)', async () => {
    const originalFetch = globalThis.fetch;
    const downloadPath = path.join(TEST_DIR, 'downloaded-catalog.pdf');
    try {
      globalThis.fetch = async () => (
        new Response(new Uint8Array([7, 8, 9]), {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        })
      );

      const res = await processMessage(
        `download https://example.com/catalog.pdf to ${downloadPath}`,
        [],
        { llmHandler: mockLLM },
      );
      expect(res.intent).toBe('skill');
      expect(res.reply.length).toBeGreaterThan(0);
      expect(fs.existsSync(downloadPath)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(downloadPath, { force: true });
    }
  });

  it('bare-domain web prompt uses web_fetch skill output (not capability denial text)', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => (
        new Response('Neolith catalog landing page', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      );

      const denyingLLM = async () => 'I cannot browse live websites.';
      const res = await processMessage(
        'can you go to neolith.com and download their general catalog',
        [],
        { llmHandler: denyingLLM },
      );

      expect(res.intent).toBe('skill');
      expect(res.reply).toContain('Neolith catalog landing page');
      expect(res.reply.toLowerCase()).not.toContain('cannot browse live websites');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('web action workflow chains search then download', async () => {
    const originalFetch = globalThis.fetch;
    const downloadPath = path.join(TEST_DIR, 'workflow-catalog.pdf');
    let plannerCalls = 0;

    const orchestratorLLM = async (messages: Message[]) => {
      const system = messages[0].content;
      if (!system.includes('tool orchestrator')) {
        return 'General response.';
      }

      plannerCalls += 1;
      if (plannerCalls === 1) {
        return JSON.stringify({
          type: 'tool',
          tool: 'web_search',
          input: { query: 'acme catalog pdf' },
        });
      }
      if (plannerCalls === 2) {
        return JSON.stringify({
          type: 'tool',
          tool: 'web_fetch',
          input: { url: 'https://acme.example/catalog.pdf', outputPath: downloadPath },
        });
      }
      return JSON.stringify({
        type: 'final',
        message: `Downloaded catalog to ${downloadPath}`,
      });
    };

    try {
      globalThis.fetch = async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('api.search.brave.com')) {
          return new Response(
            JSON.stringify({
              web: {
                results: [
                  {
                    title: 'ACME catalog',
                    url: 'https://acme.example/catalog.pdf',
                    description: 'ACME catalog PDF available',
                  },
                ],
              },
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          );
        }
        if (url.includes('duckduckgo.com')) {
          return new Response(
            JSON.stringify({
              AbstractText: 'ACME catalog PDF available at https://acme.example/catalog.pdf',
              RelatedTopics: [],
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          );
        }
        if (url.includes('acme.example/catalog.pdf')) {
          return new Response(new Uint8Array([4, 5, 6]), {
            status: 200,
            headers: { 'content-type': 'application/pdf' },
          });
        }
        return new Response('Not found', { status: 404 });
      };

      const res = await processMessage(
        `search the web for acme catalog and download the first pdf to ${downloadPath}`,
        [],
        { llmHandler: orchestratorLLM },
      );

      expect(res.intent).toBe('skill');
      expect(res.reply).toContain('Downloaded catalog');
      expect(plannerCalls).toBe(3);
      expect(fs.existsSync(downloadPath)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(downloadPath, { force: true });
    }
  });

  it('code workflow chains file write then test command', async () => {
    let plannerCalls = 0;
    const workflowFile = path.join(TEST_DIR, 'workflow-code.ts');

    const plannerLLM = async (messages: Message[]) => {
      const system = messages[0].content;
      if (!system.includes('tool orchestrator')) return 'General response.';

      plannerCalls += 1;
      if (plannerCalls === 1) {
        return JSON.stringify({
          type: 'tool',
          tool: 'file_writer',
          input: { path: workflowFile, content: 'export const x = 1;', overwrite: true },
        });
      }
      if (plannerCalls === 2) {
        return JSON.stringify({
          type: 'tool',
          tool: 'shell_runner',
          input: { command: 'pnpm --version' },
        });
      }
      return JSON.stringify({ type: 'final', message: 'Code update applied and tests checked.' });
    };

    const res = await processMessage(
      `write code in ${workflowFile} and run tests`,
      [],
      { llmHandler: plannerLLM },
    );

    expect(res.intent).toBe('skill');
    expect(res.reply).toContain('Code update applied');
    expect(plannerCalls).toBe(3);
    expect(fs.existsSync(workflowFile)).toBe(true);
    expect(fs.readFileSync(workflowFile, 'utf-8')).toContain('export const x = 1');
  });

  it('web_search skill end-to-end', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({
        ok: true,
        async json() {
          return {
            AbstractText: 'Ceramic glaze suppliers list',
            RelatedTopics: [],
          };
        },
      } as Response);

      const res = await processMessage('search the web for ceramic glaze suppliers Turkey', [], { llmHandler: mockLLM });
      expect(res.intent).toBe('skill');
      expect(res.reply.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('news request routes through web_search skill (not general LLM fallback)', async () => {
    const originalFetch = globalThis.fetch;
    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Today Headline</title>
      <link>https://news.example.com/today</link>
      <pubDate>Sat, 22 Feb 2026 11:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

    try {
      globalThis.fetch = async () => (
        new Response(rss, {
          status: 200,
          headers: { 'content-type': 'application/rss+xml' },
        })
      );

      const res = await processMessage('give me 3 news for today', [], { llmHandler: mockLLM });
      expect(res.intent).toBe('skill');
      expect(res.reply).toContain('Today Headline');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('internet capability prompt routes through web_search instead of generic memory fallback', async () => {
    const originalFetch = globalThis.fetch;
    const oldBraveKey = process.env.BRAVE_SEARCH_API_KEY;
    try {
      delete process.env.BRAVE_SEARCH_API_KEY;
      globalThis.fetch = async () => ({
        ok: true,
        async json() {
          return {
            AbstractText: 'Latest political updates and headlines.',
            RelatedTopics: [],
          };
        },
      } as Response);

      const res = await processMessage(
        'check if you can search internet , and tell me latest political news as a test',
        [],
        { llmHandler: mockLLM },
      );
      expect(res.intent).toBe('skill');
      expect(res.reply).toContain('political');
      expect(res.reply.toLowerCase()).not.toContain('cannot search the internet');
    } finally {
      globalThis.fetch = originalFetch;
      if (oldBraveKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
      else process.env.BRAVE_SEARCH_API_KEY = oldBraveKey;
    }
  });

  it('returns deterministic web_search output when LLM claims no internet access', async () => {
    const originalFetch = globalThis.fetch;
    const oldBraveKey = process.env.BRAVE_SEARCH_API_KEY;
    try {
      delete process.env.BRAVE_SEARCH_API_KEY;
      globalThis.fetch = async () => ({
        ok: true,
        async json() {
          return {
            AbstractText: 'Top political headlines fetched from web tool.',
            RelatedTopics: [],
          };
        },
      } as Response);

      const denyingLLM = async () => "I don't have live web access.";
      const res = await processMessage('search todays 3 latest political news', [], { llmHandler: denyingLLM });
      expect(res.intent).toBe('skill');
      expect(res.reply).toContain('Top political headlines');
      expect(res.reply.toLowerCase()).not.toContain("don't have live web access");
    } finally {
      globalThis.fetch = originalFetch;
      if (oldBraveKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
      else process.env.BRAVE_SEARCH_API_KEY = oldBraveKey;
    }
  });

  it('news-style web_Search prompt preserves news intent in tool query and output', async () => {
    const originalFetch = globalThis.fetch;
    const oldBraveKey = process.env.BRAVE_SEARCH_API_KEY;
    try {
      process.env.BRAVE_SEARCH_API_KEY = 'test-brave-key';
      globalThis.fetch = async (_input: RequestInfo | URL) => (
        new Response(
          JSON.stringify({
            news: {
              results: [
                {
                  title: 'Today Political Story',
                  url: 'https://news.example/politics-today',
                  description: 'Current political development.',
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      );

      const denyingLLM = async () => "I don't have live web access.";
      const res = await processMessage('do a web_Search for 3 political news today', [], { llmHandler: denyingLLM });
      expect(res.intent).toBe('skill');
      expect(res.reply).toContain('Today Political Story');
      expect(res.reply.toLowerCase()).not.toContain("don't have live web access");
    } finally {
      globalThis.fetch = originalFetch;
      if (oldBraveKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
      else process.env.BRAVE_SEARCH_API_KEY = oldBraveKey;
    }
  });

  it('skill error with "calculate abc + xyz"', async () => {
    const res = await processMessage('calculate abc + xyz', [], { llmHandler: mockLLM });
    expect(res.intent).toBe('skill');
    expect(res.reply).toContain("couldn't complete");
  });

  it('file_reader error for nonexistent file', async () => {
    const res = await processMessage(`read the file ${path.join(WORKSPACE_TEST_DIR, 'nonexistent-abc-xyz.txt')}`, [], { llmHandler: mockLLM });
    expect(res.intent).toBe('skill');
    expect(res.reply).toContain("couldn't complete");
    expect(res.error).toContain('File not found');
  });

  it('self-corrects skill input even when early repair outputs are malformed', async () => {
    const existingFile = path.join(WORKSPACE_TEST_DIR, 'self-correct-reader.txt');
    fs.writeFileSync(existingFile, 'self-correction works', 'utf-8');
    let repairCalls = 0;

    const correctingLLM = async (messages: Message[]) => {
      const system = messages[0]?.content ?? '';
      if (system.includes('repair tool inputs after a failed tool execution')) {
        repairCalls += 1;
        if (repairCalls < 2) return 'not valid json';
        return JSON.stringify({ path: existingFile });
      }
      return 'Recovered by retry.';
    };

    const res = await processMessage('read the file /tmp/does-not-exist-retry.txt', [], {
      llmHandler: correctingLLM,
    });
    expect(res.intent).toBe('skill');
    expect(res.error).toBeUndefined();
    expect(res.reply).toContain('Recovered by retry');
    expect(repairCalls).toBeGreaterThanOrEqual(2);
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

  it('tool inventory query returns registered skills deterministically', async () => {
    const res = await processMessage('can you see any skills?', [], { llmHandler: mockLLM });
    expect(res.intent).toBe('general');
    expect(res.reply).toContain('Available MCP skills');
    expect(res.reply).toContain('calculator');
    expect(res.reply).toContain('file_reader');
    expect(res.reply).toContain('web_search');
    expect(res.reply).not.toContain('shell_runner');
  });

  it('does not misclassify task prompt containing "available skills" as inventory query', async () => {
    const res = await processMessage(
      'Make a very small version of stardew valley using your new available skills',
      [],
      { llmHandler: mockLLM },
    );
    expect(res.reply).not.toContain('Available MCP skills:');
  });

  it('triggers planned workflow for long simulator build prompt', async () => {
    let plannerCalls = 0;
    const plannerLLM = async (messages: Message[]) => {
      if ((messages[0]?.content ?? '').includes('tool orchestrator')) {
        plannerCalls += 1;
        if (plannerCalls === 1) {
          return JSON.stringify({ type: 'tool', tool: 'task_planner', input: { goal: 'farming simulator prototype', maxSteps: 5 } });
        }
        if (plannerCalls === 2) {
          return JSON.stringify({
            type: 'tool',
            tool: 'file_writer',
            input: { path: path.join(TEST_DIR, 'sim-proto.txt'), content: 'prototype scaffold', overwrite: true },
          });
        }
        return JSON.stringify({ type: 'final', message: 'State trace: scaffold complete. Gold math: final gold = 100.' });
      }
      return 'General response.';
    };

    const prompt = `Build a text-based, turn-based farming simulator prototype.
Initialize the game and process the following sequence of player inputs.`;

    const res = await processMessage(prompt, [], { llmHandler: plannerLLM });
    expect(res.intent).toBe('skill');
    expect(plannerCalls).toBeGreaterThan(0);
    expect(res.reply).toContain('Gold math');
  });

  it('recovers from non-JSON planner output and continues workflow', async () => {
    let plannerCalls = 0;
    const outFile = path.join(TEST_DIR, 'planner-recover.ts');
    const plannerLLM = async (messages: Message[]) => {
      if (!(messages[0]?.content ?? '').includes('tool orchestrator')) return 'General response.';
      plannerCalls += 1;
      if (plannerCalls === 1) {
        return JSON.stringify({ type: 'tool', tool: 'task_planner', input: { goal: 'build simulator' } });
      }
      if (plannerCalls === 2) {
        return 'I think we should now write code and run build.'; // invalid planner format
      }
      if (plannerCalls === 3) {
        return JSON.stringify({
          type: 'tool',
          tool: 'file_writer',
          input: { path: outFile, content: 'export const ok = true;', overwrite: true },
        });
      }
      return JSON.stringify({ type: 'final', message: 'Completed after recovery.' });
    };

    const res = await processMessage(
      'Build a simulator prototype using tools only and execute steps',
      [],
      { llmHandler: plannerLLM },
    );

    expect(res.intent).toBe('skill');
    expect(res.reply).toContain('Completed after recovery');
    expect(plannerCalls).toBeGreaterThanOrEqual(4);
    expect(fs.existsSync(outFile)).toBe(true);
  });

  it('tools-only enforced prompt never falls back to plain generic LLM response', async () => {
    const invalidPlannerLLM = async () => 'This is not JSON tool output.';
    const res = await processMessage(
      'You must return STRICT JSON tool calls every step. tools only with shell_runner and file_writer.',
      [],
      { llmHandler: invalidPlannerLLM },
    );
    expect(res.intent).toBe('skill');
    expect(res.error).toBeTruthy();
    expect(res.reply).toContain('I ran these actions:');
    expect(res.reply).not.toContain('I cannot interact with your local file system');
  });

  it('auto-recovers file_writer overwrite conflicts inside planned workflow', async () => {
    const file = path.join(TEST_DIR, 'overwrite-recover.txt');
    fs.writeFileSync(file, 'existing', 'utf-8');
    let plannerCalls = 0;
    const plannerLLM = async (messages: Message[]) => {
      if (!(messages[0]?.content ?? '').includes('tool orchestrator')) return 'General response.';
      plannerCalls += 1;
      if (plannerCalls === 1) {
        return JSON.stringify({
          type: 'tool',
          tool: 'file_writer',
          input: { path: file, content: 'new-content' },
        });
      }
      return JSON.stringify({ type: 'final', message: 'state trace: done, gold: 100' });
    };

    const res = await processMessage(
      'Build simulator tools only and include state trace and gold math',
      [],
      { llmHandler: plannerLLM },
    );
    expect(res.intent).toBe('skill');
    expect(fs.readFileSync(file, 'utf-8')).toContain('new-content');
  });

  it('LLM failure during skill returns raw skill output', async () => {
    const failingLLM = async () => { throw new Error('LLM down'); };
    const res = await processMessage('what is 100 + 200', [], { llmHandler: failingLLM });
    expect(res.intent).toBe('skill');
    expect(res.reply).toContain('300');
  });
});
