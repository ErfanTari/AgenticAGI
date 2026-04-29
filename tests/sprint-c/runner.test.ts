import { describe, it, expect, vi, afterEach } from 'vitest';
import { clearNestingFlag } from '../../core/subagents/nesting-gate.js';
import type { LLMHandler } from '../../core/types.js';

afterEach(() => {
  clearNestingFlag();
});

function makeMockHandler(reply: string): LLMHandler {
  return vi.fn(async () => reply);
}

const EXPLORE_REPLY = `Found the files.

\`\`\`json
{
  "files": [{ "path": "core/foo.ts", "relevance": "main file" }],
  "patterns": ["uses X for Y"],
  "narrative": "Found the main file."
}
\`\`\``;

const PLAN_REPLY = `Here is the plan.

\`\`\`json
{
  "milestones": [
    { "id": "M1", "title": "Step one", "criteria": "Done when X passes", "dependsOn": [] }
  ],
  "narrative": "One-step plan."
}
\`\`\``;

const TASK_REPLY = `Completed the task.

\`\`\`json
{
  "artifactsCreated": ["src/new.ts"],
  "artifactsModified": [],
  "verificationStatus": "passed",
  "narrative": "Created src/new.ts."
}
\`\`\``;

describe('runSubAgent', () => {
  it('explore profile: succeeds and returns structured summary', async () => {
    const { runSubAgent } = await import('../../core/subagents/runner.js');
    const result = await runSubAgent(
      { parentRequestId: 'req-1', profile: 'explore', goal: 'find the auth module' },
      makeMockHandler(EXPLORE_REPLY),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.summary.narrative).toBe('Found the main file.');
      expect(result.summary.files).toHaveLength(1);
    }
  });

  it('plan profile with inherited summary: passes context through', async () => {
    const { runSubAgent } = await import('../../core/subagents/runner.js');
    const result = await runSubAgent(
      {
        parentRequestId: 'req-2',
        profile: 'plan',
        goal: 'plan the migration',
        inheritedSummary: 'Found auth.ts and user.ts.',
      },
      makeMockHandler(PLAN_REPLY),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.summary.milestones).toHaveLength(1);
      expect(result.summary.milestones![0].id).toBe('M1');
    }
  });

  it('task profile: returns artifacts and verification status', async () => {
    const { runSubAgent } = await import('../../core/subagents/runner.js');
    const result = await runSubAgent(
      { parentRequestId: 'req-3', profile: 'task', goal: 'implement M1' },
      makeMockHandler(TASK_REPLY),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.summary.verificationStatus).toBe('passed');
    }
  });

  it('nested sub-agent call throws NestingViolationError', async () => {
    const { runSubAgent } = await import('../../core/subagents/runner.js');
    const { setNestingFlag } = await import('../../core/subagents/nesting-gate.js');
    setNestingFlag(); // simulate being inside a sub-agent
    await expect(
      runSubAgent(
        { parentRequestId: 'req-4', profile: 'explore', goal: 'nested call' },
        makeMockHandler('ok'),
      ),
    ).rejects.toThrow('Sub-agent nesting depth exceeded');
  });
});
