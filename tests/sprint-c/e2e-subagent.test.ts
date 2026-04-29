import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clearNestingFlag } from '../../core/subagents/nesting-gate.js';
import { transparency } from '../../core/transparency.js';
import type { LLMHandler } from '../../core/types.js';

beforeEach(() => { transparency.enable(); });
afterEach(() => { transparency.disable(); });

afterEach(() => {
  clearNestingFlag();
});

const EXPLORE_REPLY = `\`\`\`json
{
  "files": [
    { "path": "src/user.ts", "relevance": "user model definition" },
    { "path": "src/user.test.ts", "relevance": "user model tests" },
    { "path": "src/db.ts", "relevance": "database schema" }
  ],
  "symbols": [{ "name": "User", "file": "src/user.ts", "signature": "interface User { id: string; name: string }" }],
  "patterns": ["TypeScript interface-first model design"],
  "narrative": "Found user model and related test/db files."
}
\`\`\``;

const PLAN_REPLY = `\`\`\`json
{
  "milestones": [
    { "id": "M1", "title": "Add email field to User interface", "criteria": "src/user.ts exports User with email: string", "dependsOn": [] },
    { "id": "M2", "title": "Update user tests for email field", "criteria": "src/user.test.ts passes with email assertions", "dependsOn": ["M1"] }
  ],
  "narrative": "Two-milestone plan: add email field, then update tests."
}
\`\`\``;

const TASK_M1_REPLY = `\`\`\`json
{
  "artifactsModified": ["src/user.ts"],
  "artifactsCreated": [],
  "verificationStatus": "passed",
  "narrative": "Added email: string to User interface and verified build passes."
}
\`\`\``;

const TASK_M2_REPLY = `\`\`\`json
{
  "artifactsModified": ["src/user.test.ts"],
  "artifactsCreated": [],
  "verificationStatus": "passed",
  "narrative": "Updated tests to assert email field existence."
}
\`\`\``;

describe('E2E: HIGH-complexity sub-agent pipeline', () => {
  it('Explore→Plan(Qwen)→2 Task milestones, events emitted, nesting gate holds', async () => {
    const events: string[] = [];
    const unsub = transparency.on(e => {
      if (e.type.startsWith('subagent_')) events.push(e.type);
    });

    let callCount = 0;
    const mockHandler: LLMHandler = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return EXPLORE_REPLY;
      if (callCount === 2) return PLAN_REPLY;
      if (callCount === 3) return TASK_M1_REPLY;
      return TASK_M2_REPLY;
    });

    const { runSubAgentPipeline } = await import('../../core/subagents/runner.js');
    const result = await runSubAgentPipeline(
      'Find the user model in the codebase, plan a migration to add an email field, and implement it.',
      'e2e-req-001',
      mockHandler,
    );

    unsub();

    // 4 sub-agent invocations: 1 explore + 1 plan + 2 task
    const startEvents = events.filter(e => e === 'subagent_start');
    const completeEvents = events.filter(e => e === 'subagent_complete');
    expect(startEvents).toHaveLength(4);
    expect(completeEvents).toHaveLength(4);

    // No failures
    const failEvents = events.filter(e => e === 'subagent_failed');
    expect(failEvents).toHaveLength(0);

    // Final reply has all narrative sections
    expect(result.reply).toContain('pipeline complete');
    expect(result.reply).toContain('Explore');
    expect(result.reply).toContain('Plan');
    expect(result.reply).toContain('Task');

    // Nesting gate not left set (clearNestingFlag runs in finally)
    const { isNested } = await import('../../core/subagents/nesting-gate.js');
    expect(isNested()).toBe(false);

    // Task results both passed
    expect(result.taskResults[0].success).toBe(true);
    expect(result.taskResults[1].success).toBe(true);
  });
});
