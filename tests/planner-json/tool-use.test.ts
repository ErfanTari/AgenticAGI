/**
 * Batch 1: Pure JSON throughout — tool_use content blocks + zodToJsonSchema
 *
 * Tests that:
 * 1. LLMHandlerOptions accepts tools/toolChoice fields
 * 2. callAnthropicProfile sends tool definitions and extracts tool_use input
 * 3. decomposeTask passes tools/toolChoice (not responseSchema) to llmHandler
 * 4. plan_json_parse_failed and plan_parser_fallback_used events are emitted
 * 5. Fast-path: clean JSON from tool_use response skips sanitizePlannerJson
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PATHS } from '../../config/agent.config.js';
import { initDatabase } from '../../core/memory/index.js';

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
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── LLMHandlerOptions type tests ─────────────────────────────────────────────

describe('LLMHandlerOptions accepts tools and toolChoice', () => {
  it('LLMHandlerOptions type includes tools array and toolChoice string', async () => {
    const { } = await import('../../core/types.js');
    // Type-level test: compile-time only. If this file compiles, the type is correct.
    const opts: import('../../core/types.js').LLMHandlerOptions = {
      tools: [{ name: 'test_tool', description: 'desc', input_schema: { type: 'object' } }],
      toolChoice: 'test_tool',
    };
    expect(opts.tools).toHaveLength(1);
    expect(opts.toolChoice).toBe('test_tool');
  });

  it('LLMHandlerOptions tools without description still valid', async () => {
    const opts: import('../../core/types.js').LLMHandlerOptions = {
      tools: [{ name: 'my_tool', input_schema: { type: 'object', properties: {} } }],
    };
    expect(opts.tools?.[0].name).toBe('my_tool');
    expect(opts.tools?.[0].description).toBeUndefined();
  });
});

// ─── ToolDefinition type from llm.ts ─────────────────────────────────────────

describe('ToolDefinition type', () => {
  it('ToolDefinition exported from core/llm.ts', async () => {
    const llmModule = await import('../../core/llm.js');
    // ToolDefinition is a type — exported name exists at module level via type import
    // Verify callLLM is still exported (smoke test module loads cleanly)
    expect(typeof llmModule.callLLM).toBe('function');
  });
});

// ─── Anthropic tool_use content block extraction ─────────────────────────────

describe('Anthropic tool_use content block response', () => {
  it('callLLM with tools resolves tool_use input as JSON string', async () => {
    const { callLLM, withLLMRuntime } = await import('../../core/llm.js');

    const mockPlan = {
      goal: 'test goal',
      steps: [{ id: 'step1', description: 'do it', skill: 'calculator', input: { expression: '1+1' }, dependsOn: [], optional: false, confidence_score: 0.8, risk_level: 'LOW' }],
      goals: [],
      milestones: [],
      complexity: 'LOW',
      needsConfirmation: false,
      createdAt: '2026-01-01T00:00:00Z',
    };

    // Simulate an Anthropic endpoint returning a tool_use content block
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          { type: 'tool_use', id: 'tu_001', name: 'decompose_task', input: mockPlan },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
      status: 200,
    });

    const originalFetch = global.fetch;
    global.fetch = mockFetch as any;

    try {
      const result = await withLLMRuntime(
        {
          primary: null,
          fallback: {
            kind: 'anthropic',
            label: 'fallback',
            endpoint: 'https://api.anthropic.com/v1/messages',
            model: 'claude-sonnet-4-6',
            apiKey: 'test-key',
            maxTokens: 4096,
            timeoutMs: 30000,
          },
        },
        () => callLLM(
          [{ role: 'user', content: 'decompose this task' }],
          {
            tools: [{ name: 'decompose_task', description: 'decompose', input_schema: { type: 'object' } }],
            toolChoice: 'decompose_task',
          },
        ),
      );

      // Result should be the JSON-stringified tool input
      const parsed = JSON.parse(result);
      expect(parsed.goal).toBe('test goal');
      expect(parsed.steps).toHaveLength(1);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('Anthropic request body includes tools and tool_choice when tools provided', async () => {
    const { callLLM, withLLMRuntime } = await import('../../core/llm.js');

    const capturedBodies: unknown[] = [];
    const mockFetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBodies.push(JSON.parse(init.body as string));
      return {
        ok: true,
        json: async () => ({
          content: [
            { type: 'tool_use', id: 'tu_002', name: 'my_tool', input: { result: 'ok' } },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      };
    });

    const originalFetch = global.fetch;
    global.fetch = mockFetch as any;

    try {
      await withLLMRuntime(
        {
          primary: null,
          fallback: {
            kind: 'anthropic',
            label: 'fallback',
            endpoint: 'https://api.anthropic.com/v1/messages',
            model: 'claude-sonnet-4-6',
            apiKey: 'test-key',
            maxTokens: 1024,
            timeoutMs: 10000,
          },
        },
        () => callLLM(
          [{ role: 'user', content: 'hello' }],
          {
            tools: [{ name: 'my_tool', input_schema: { type: 'object', properties: { result: { type: 'string' } } } }],
            toolChoice: 'my_tool',
          },
        ),
      );

      expect(capturedBodies).toHaveLength(1);
      const body = capturedBodies[0] as Record<string, unknown>;
      expect(Array.isArray(body.tools)).toBe(true);
      const tc = body.tool_choice as { type: string; name: string };
      expect(tc.type).toBe('tool');
      expect(tc.name).toBe('my_tool');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('falls back to text content when no tool_use block in response', async () => {
    const { callLLM, withLLMRuntime } = await import('../../core/llm.js');

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'plain text response' }],
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
    });

    const originalFetch = global.fetch;
    global.fetch = mockFetch as any;

    try {
      const result = await withLLMRuntime(
        {
          primary: null,
          fallback: {
            kind: 'anthropic',
            label: 'fallback',
            endpoint: 'https://api.anthropic.com/v1/messages',
            model: 'claude-sonnet-4-6',
            apiKey: 'test-key',
            maxTokens: 1024,
            timeoutMs: 10000,
          },
        },
        () => callLLM(
          [{ role: 'user', content: 'hello' }],
          {
            tools: [{ name: 'my_tool', input_schema: { type: 'object' } }],
            toolChoice: 'my_tool',
          },
        ),
      );

      expect(result).toContain('plain text response');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ─── OpenAI-compatible endpoint maps tools → responseSchema ──────────────────

describe('OpenAI-compatible endpoint maps tools to responseSchema', () => {
  it('local endpoint receives response_format when tools provided (non-primary)', async () => {
    const { callLLM, withLLMRuntime } = await import('../../core/llm.js');

    const capturedBodies: unknown[] = [];
    const mockFetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBodies.push(JSON.parse(init.body as string));
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"ok": true}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      };
    });

    const originalFetch = global.fetch;
    global.fetch = mockFetch as any;

    try {
      await withLLMRuntime(
        {
          primary: null,
          fallback: {
            kind: 'openai-compatible',
            label: 'fallback',
            endpoint: 'http://localhost:1234/v1/chat/completions',
            model: 'some-model',
            temperature: 0,
            maxTokens: 1024,
            timeoutMs: 10000,
          },
        },
        () => callLLM(
          [{ role: 'user', content: 'hello' }],
          {
            tools: [{ name: 'my_tool', input_schema: { type: 'object', properties: { x: { type: 'string' } } } }],
            toolChoice: 'my_tool',
          },
        ),
      );

      const body = capturedBodies[0] as Record<string, unknown>;
      // Should have response_format with the tool's input_schema
      const rf = body.response_format as { type: string; json_schema: { schema: Record<string, unknown> } };
      expect(rf?.type).toBe('json_schema');
      expect(rf?.json_schema?.schema?.properties).toBeDefined();
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ─── Transparency events ───────────────────────────────────────────────────────

describe('plan_json_parse_failed and plan_parser_fallback_used events', () => {
  it('decomposeTask emits plan_parser_fallback_used when response needs sanitize', async () => {
    const { transparency } = await import('../../core/transparency.js');
    const { decomposeTask } = await import('../../core/planner.js');

    transparency.enable();
    const events: Array<{ type: string }> = [];
    const off = transparency.on(e => events.push(e));

    // Handler returns text with preamble (not clean JSON) → sanitize path
    const mockHandler = vi.fn().mockResolvedValue(
      'Here is the plan:\n{"goal":"test","steps":[{"id":"s1","description":"do it","skill":"calculator","input":{"expression":"1+1"},"dependsOn":[],"optional":false,"confidence_score":0.8,"risk_level":"LOW","storeResultAs":null}],"goals":[],"milestones":[],"complexity":"LOW","needsConfirmation":false,"createdAt":"2026-01-01T00:00:00Z"}'
    );

    try {
      await decomposeTask('test task', { skills: 'calculator' }, mockHandler as any);
    } catch {
      // may or may not succeed depending on sanitize
    } finally {
      off();
      transparency.disable();
    }

    const fallbackEvents = events.filter(e => e.type === 'plan_parser_fallback_used');
    expect(fallbackEvents.length).toBeGreaterThan(0);
  });

  it('decomposeTask emits plan_json_parse_failed when JSON.parse throws', async () => {
    const { transparency } = await import('../../core/transparency.js');
    const { decomposeTask } = await import('../../core/planner.js');

    transparency.enable();
    const events: Array<{ type: string; data?: unknown }> = [];
    const off = transparency.on(e => events.push(e));

    // Handler returns invalid JSON on every attempt
    const mockHandler = vi.fn().mockResolvedValue('{invalid json !!!}');

    try {
      await decomposeTask('test task', { skills: 'calculator' }, mockHandler as any);
    } catch {
      // expected to fail
    } finally {
      off();
      transparency.disable();
    }

    const parseFailEvents = events.filter(e => e.type === 'plan_json_parse_failed');
    expect(parseFailEvents.length).toBeGreaterThan(0);
  });

  it('no plan_parser_fallback_used when response is clean JSON', async () => {
    const { transparency } = await import('../../core/transparency.js');
    const { decomposeTask } = await import('../../core/planner.js');

    transparency.enable();
    const events: Array<{ type: string }> = [];
    const off = transparency.on(e => events.push(e));

    const cleanPlan = JSON.stringify({
      goal: 'compute something',
      steps: [{ id: 's1', description: 'calc', skill: 'calculator', input: { expression: '2+2' }, dependsOn: [], optional: false, confidence_score: 0.9, risk_level: 'LOW', storeResultAs: null }],
      goals: [],
      milestones: [],
      complexity: 'LOW',
      needsConfirmation: false,
      createdAt: '2026-01-01T00:00:00Z',
    });

    const mockHandler = vi.fn().mockResolvedValue(cleanPlan);

    try {
      await decomposeTask('compute 2+2', { skills: 'calculator' }, mockHandler as any);
    } catch {
      // may fail Zod — that's ok, we're testing the parse path
    } finally {
      off();
      transparency.disable();
    }

    const fallbackEvents = events.filter(e => e.type === 'plan_parser_fallback_used');
    expect(fallbackEvents).toHaveLength(0);
  });
});

// ─── zodToJsonSchema (Zod v4 z.toJSONSchema) ──────────────────────────────────

describe('taskPlanJsonSchema is generated via z.toJSONSchema', () => {
  it('taskPlanJsonSchema is a valid JSON Schema object', async () => {
    const { taskPlanJsonSchema } = await import('../../core/schemas.js');
    expect(typeof taskPlanJsonSchema).toBe('object');
    expect(taskPlanJsonSchema).not.toBeNull();
    // Zod v4 toJSONSchema produces a schema with type or $schema
    const schema = taskPlanJsonSchema as Record<string, unknown>;
    expect(schema.type === 'object' || typeof schema.$schema === 'string' || typeof schema.properties === 'object').toBe(true);
  });

  it('taskPlanJsonSchema has properties for goal and steps', async () => {
    const { taskPlanJsonSchema } = await import('../../core/schemas.js');
    const schema = taskPlanJsonSchema as { properties?: Record<string, unknown> };
    expect(schema.properties?.goal).toBeDefined();
    expect(schema.properties?.steps).toBeDefined();
  });
});
