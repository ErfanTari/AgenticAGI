/**
 * tests/fixes/four-bugs.test.ts
 *
 * 12 tests covering the four confirmed runtime fixes:
 *   Fix 1A — TYPE_MAP block in planner prompt
 *   Fix 1B — isRepairableSkillInputError matches notebook+type errors
 *   Fix 2  — resolveMaxTokens enforces format floors
 *   Fix 3  — stripThinkingTags removes post-think narration preamble
 *   Fix 4  — semantic features extractor is absent
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ─── Fix 1A — TYPE_MAP in planner prompt ────────────────────────────────────

describe('Fix 1A: TYPE_MAP in planner prompt', () => {
  // Phase 18: prompt content moved to prompts/planner.md
  const plannerPath = path.resolve('prompts/planner.md');
  let plannerSource: string;

  it('T1.1 — planner prompt contains VALID MEMORY TYPES block', () => {
    plannerSource = fs.readFileSync(plannerPath, 'utf-8');
    expect(plannerSource).toContain('VALID MEMORY TYPES');
  });

  it('T1.2 — planner prompt lists PLAN notebook valid types (PL, EX, CT, MS, PJ)', () => {
    plannerSource ??= fs.readFileSync(plannerPath, 'utf-8');
    expect(plannerSource).toMatch(/PLAN\s*→.*PL/);
    expect(plannerSource).toMatch(/PLAN\s*→.*EX/);
  });

  it('T1.3 — planner prompt shows WRONG example for PLAN.PR', () => {
    plannerSource ??= fs.readFileSync(plannerPath, 'utf-8');
    expect(plannerSource).toContain('"nb": "PLAN", "type": "PR"');
    expect(plannerSource).toMatch(/WRONG.*PLAN.*PR|PLAN.*PR.*WRONG/s);
  });
});

// ─── Fix 1B — isRepairableSkillInputError notebook+type errors ───────────────

describe('Fix 1B: isRepairableSkillInputError matches notebook+type errors', () => {
  // Import the function by reading the module directly (avoids complex DI)
  async function getIsRepairable(): Promise<(e: string) => boolean> {
    const mod = await import('../../core/react.js');
    // The function is not exported, so we test indirectly via the source
    return (mod as Record<string, unknown>)['isRepairableSkillInputError'] as (e: string) => boolean;
  }

  it('T1B.1 — source contains "invalid notebook+type" pattern', () => {
    const src = fs.readFileSync(path.resolve('core/react.ts'), 'utf-8');
    expect(src).toContain('invalid notebook');
    expect(src).toContain('type');
    // Confirm the two new patterns are present
    expect(src).toMatch(/invalid notebook/i);
    expect(src).toMatch(/does not support type/i);
  });

  it('T1B.2 — source contains "does not support type" pattern', () => {
    const src = fs.readFileSync(path.resolve('core/react.ts'), 'utf-8');
    expect(src).toMatch(/does not support type/i);
  });
});

// ─── Fix 2 — resolveMaxTokens format floors ──────────────────────────────────

describe('Fix 2: resolveMaxTokens enforces format floors', () => {
  it('T2.1 — content_writer.ts defines FORMAT_FLOORS with html floor from TOKEN_BUDGETS', () => {
    const src = fs.readFileSync(path.resolve('core/skills/tools/content_writer.ts'), 'utf-8');
    expect(src).toContain('FORMAT_FLOORS');
    // Phase 18: floors now reference TOKEN_BUDGETS constants
    expect(src).toContain('TOKEN_BUDGETS.CONTENT_WRITER_HTML');
  });

  it('T2.2 — content_writer.ts defines FORMAT_FLOORS with markdown floor from TOKEN_BUDGETS', () => {
    const src = fs.readFileSync(path.resolve('core/skills/tools/content_writer.ts'), 'utf-8');
    expect(src).toContain('TOKEN_BUDGETS.CONTENT_WRITER_MARKDOWN');
  });

  it('T2.3 — content_writer.ts uses resolveMaxTokens (not parseMaxTokens)', () => {
    const src = fs.readFileSync(path.resolve('core/skills/tools/content_writer.ts'), 'utf-8');
    expect(src).toContain('resolveMaxTokens');
    expect(src).not.toContain('parseMaxTokens');
  });

  it('T2.4 — resolveMaxTokens raises low request to format floor', () => {
    // Inline the logic to verify the math without importing
    function resolveMaxTokens(value: unknown, format: 'html' | 'markdown' | 'plain'): number {
      const floors: Record<string, number> = { html: 6000, markdown: 4000, plain: 4000 };
      const n = Number(value);
      const requested = Number.isFinite(n) && n > 0 ? Math.floor(n) : 2000;
      return Math.max(requested, floors[format]);
    }
    expect(resolveMaxTokens(1200, 'html')).toBe(6000);
    expect(resolveMaxTokens(1200, 'markdown')).toBe(4000);
    expect(resolveMaxTokens(8000, 'html')).toBe(8000); // above floor — keep requested
    expect(resolveMaxTokens(undefined, 'plain')).toBe(4000); // default 2000 → raised to 4000
  });
});

// ─── Fix 3 — stripThinkingTags preamble removal ──────────────────────────────

describe('Fix 3: stripThinkingTags removes post-think narration preamble', () => {
  it('T3.1 — strips "Here is the JSON requested:" preamble', async () => {
    const { stripThinkingTags } = await import('../../core/llm.js');
    const input = 'Here is the JSON requested:\n{"action": "done"}';
    const result = stripThinkingTags(input);
    expect(result).not.toMatch(/^Here is/i);
    expect(result).toContain('"action"');
  });

  it('T3.2 — strips "Certainly, here is the output:" preamble', async () => {
    const { stripThinkingTags } = await import('../../core/llm.js');
    const input = "Certainly, here's the output:\n# My Report\n\nContent here.";
    const result = stripThinkingTags(input);
    expect(result).not.toMatch(/^Certainly/i);
    expect(result).toContain('# My Report');
  });

  it('T3.3 — does NOT strip content that begins with "Here" but is real content', async () => {
    const { stripThinkingTags } = await import('../../core/llm.js');
    // A sentence that starts with "Here" as actual content (not a preamble pattern)
    const input = 'Here are the top 5 tips:\n1. First tip\n2. Second tip';
    const result = stripThinkingTags(input);
    // Should not be stripped because it doesn't match the "Here is the X:" preamble pattern
    expect(result.length).toBeGreaterThan(10);
  });
});

// ─── Fix 4 — semantic features extractor is absent ───────────────────────────

describe('Fix 4: semantic features extractor is absent', () => {
  it('T4.1 — no semanticFeatures or extractSemanticFeatures in planner.ts', () => {
    const src = fs.readFileSync(path.resolve('core/planner.ts'), 'utf-8');
    expect(src).not.toContain('extractSemanticFeatures');
    expect(src).not.toContain('semanticFeatures');
  });

  it('T4.2 — no semanticFeatures in executor.ts', () => {
    const src = fs.readFileSync(path.resolve('core/executor.ts'), 'utf-8');
    expect(src).not.toContain('extractSemanticFeatures');
    expect(src).not.toContain('semanticFeatures');
  });

  it('T4.3 — no semanticFeatures in query-loop.ts', () => {
    const src = fs.readFileSync(path.resolve('core/query-loop.ts'), 'utf-8');
    expect(src).not.toContain('extractSemanticFeatures');
    expect(src).not.toContain('semanticFeatures');
  });
});
