/**
 * FIX 1 — Skill dispatch: think-block stripping happens BEFORE JSON extraction.
 * Verifies that a <think> block containing curly braces does NOT confuse the JSON extractor.
 */
import { describe, it, expect } from 'vitest';
import { decomposeTask } from '../../core/planner.js';
import type { LLMHandler } from '../../core/types.js';

describe('FIX 1 — think-block stripping before JSON extraction', () => {
  it('strips <think> block that contains braces before parsing task plan JSON', async () => {
    // LLM output: think block with braces FIRST, then real JSON
    const mockLLM: LLMHandler = async () => {
      return `<think>
Let me reason about this task. I need to {"fake": "json inside think"} carefully.
The user wants to calculate something. Let me plan it out.
</think>
{"goal":"calculate 2+2","steps":[{"id":"step1","description":"run calculator","skill":"calculator","input":{"expression":"2+2"},"dependsOn":[],"storeResultAs":"result","optional":false}],"estimatedDuration":"1s"}`;
    };

    const plan = await decomposeTask(
      'calculate 2+2',
      { skills: 'calculator: evaluate math expressions' },
      mockLLM,
    );

    expect(plan.goal).toBe('calculate 2+2');
    expect(plan.steps.length).toBe(1);
    expect(plan.steps[0].skill).toBe('calculator');
  });

  it('handles <thought> block variant too', async () => {
    const mockLLM: LLMHandler = async () => {
      return `<thought>
Thinking: I could do {this} or {that} but let me plan properly.
</thought>
{"goal":"web search","steps":[{"id":"step1","description":"search web","skill":"web_search","input":{"query":"TypeScript tips"},"dependsOn":[],"storeResultAs":"results","optional":false}],"estimatedDuration":"5s"}`;
    };

    const plan = await decomposeTask(
      'search the web for TypeScript tips',
      { skills: 'web_search: search the web' },
      mockLLM,
    );

    expect(plan.goal).toBe('web search');
    expect(plan.steps[0].skill).toBe('web_search');
  });

  it('handles response with no think block (normal path still works)', async () => {
    const mockLLM: LLMHandler = async () => {
      return `{"goal":"run bash","steps":[{"id":"step1","description":"list files","skill":"run_bash","input":{"command":"ls -la"},"dependsOn":[],"storeResultAs":"listing","optional":false}],"estimatedDuration":"1s"}`;
    };

    const plan = await decomposeTask(
      'list files in the directory',
      { skills: 'run_bash: execute shell commands' },
      mockLLM,
    );

    expect(plan.steps[0].skill).toBe('run_bash');
  });
});
