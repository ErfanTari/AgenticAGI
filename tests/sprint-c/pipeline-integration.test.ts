import { describe, it, expect, vi, afterEach } from 'vitest';
import { clearNestingFlag } from '../../core/subagents/nesting-gate.js';
import type { LLMHandler } from '../../core/types.js';

afterEach(() => {
  clearNestingFlag();
});

const EXPLORE_REPLY = `\`\`\`json
{
  "files": [{ "path": "src/user.ts", "relevance": "user model" }],
  "patterns": ["uses TypeScript interfaces"],
  "narrative": "Found the user model in src/user.ts."
}
\`\`\``;

const PLAN_REPLY = `\`\`\`json
{
  "milestones": [
    { "id": "M1", "title": "Add email field", "criteria": "user.ts has email: string", "dependsOn": [] },
    { "id": "M2", "title": "Update tests", "criteria": "user.test.ts updated", "dependsOn": ["M1"] }
  ],
  "narrative": "Two-milestone plan to add email field."
}
\`\`\``;

const TASK_M1_REPLY = `\`\`\`json
{
  "artifactsModified": ["src/user.ts"],
  "artifactsCreated": [],
  "verificationStatus": "passed",
  "narrative": "Added email field to user model."
}
\`\`\``;

const TASK_M2_REPLY = `\`\`\`json
{
  "artifactsModified": ["src/user.test.ts"],
  "artifactsCreated": [],
  "verificationStatus": "passed",
  "narrative": "Updated tests for email field."
}
\`\`\``;

describe('runSubAgentPipeline integration', () => {
  it('Explore → Plan → 2 Task milestones → assembled result', async () => {
    let callCount = 0;
    const mockHandler: LLMHandler = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return EXPLORE_REPLY;      // explore
      if (callCount === 2) return PLAN_REPLY;          // plan
      if (callCount === 3) return TASK_M1_REPLY;       // task M1
      return TASK_M2_REPLY;                             // task M2
    });

    const { runSubAgentPipeline } = await import('../../core/subagents/runner.js');
    const result = await runSubAgentPipeline(
      'find the user model and implement an email field migration',
      'req-test-pipeline',
      mockHandler,
    );

    expect(result.exploreResult.success).toBe(true);
    expect(result.planResult.success).toBe(true);
    expect(result.taskResults).toHaveLength(2);
    expect(result.taskResults[0].success).toBe(true);
    expect(result.taskResults[1].success).toBe(true);
    expect(result.reply).toContain('Sub-agent pipeline complete');
    expect(result.reply).toContain('Explore');
    expect(result.reply).toContain('Plan');
  });
});
