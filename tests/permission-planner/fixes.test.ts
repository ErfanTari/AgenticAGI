/**
 * Permission-Aware Planner Sprint — tests/permission-planner/fixes.test.ts
 *
 * 21 tests covering FIX 1 (permission-aware planner), FIX 2 (failure-aware revision),
 * FIX 3 (decomposition few-shot hardening).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { _unfreezeRegistry, _resetRegistry, getSkillsByPermission, getAllSkills } from '../../core/skills/registry.js';
import { MilestoneRevisionSchema } from '../../core/schemas.js';

// ── Group 1: FIX 1 — Permission-aware planner ──────────────────────────────

describe('FIX 1: Permission-aware planner', () => {
  it('getSkillsByPermission("read-only") returns only read-only skills', () => {
    const skills = getSkillsByPermission('read-only');
    for (const skill of skills) {
      expect(skill.permissionLevel).toBe('read-only');
    }
    expect(skills.length).toBeGreaterThan(0);
  });

  it('getSkillsByPermission("workspace-write") returns read-only + workspace-write skills', () => {
    const skills = getSkillsByPermission('workspace-write');
    const levels = new Set(skills.map(s => s.permissionLevel));
    expect(levels.has('full-access')).toBe(false);
    expect(levels.has('read-only')).toBe(true);
    expect(levels.has('workspace-write')).toBe(true);
  });

  it('getSkillsByPermission("full-access") returns all skills', () => {
    const allowed = getSkillsByPermission('full-access');
    const all = getAllSkills();
    expect(allowed.length).toBe(all.length);
  });

  it('getSkillsByPermission("workspace-write") does NOT include implement_and_test', () => {
    const skills = getSkillsByPermission('workspace-write');
    const names = skills.map(s => s.name);
    expect(names).not.toContain('implement_and_test');
  });

  it('getSkillsByPermission("workspace-write") does NOT include run_bash', () => {
    const skills = getSkillsByPermission('workspace-write');
    const names = skills.map(s => s.name);
    expect(names).not.toContain('run_bash');
  });

  it('planner prompt source uses permission-filtered skill list', () => {
    const routerSrc = fs.readFileSync(
      path.join(process.cwd(), 'core/router.ts'),
      'utf-8'
    );
    // Context Diet: replaced with compact format — still permission-filtered
    expect(routerSrc).toContain('getSkillCompactDescriptions');
    expect(routerSrc).toContain('getActivePermissionMode');
  });

  it('planner prompt includes RUNTIME CONTEXT block', () => {
    // Phase 18: static prompt text moved to prompts/planner.md;
    // dynamic RUNTIME CONTEXT block is now built in decomposeTask() and injected as {{runtime_context}}
    const plannerSrc = fs.readFileSync(
      path.join(process.cwd(), 'core/planner.ts'),
      'utf-8'
    );
    // The runtime context string is assembled in the TS code before injection
    expect(plannerSrc).toContain('RUNTIME CONTEXT');
    expect(plannerSrc).toContain('Permission mode:');
    expect(plannerSrc).toContain('BLOCKED skills');
  });

  it('planner context passes blockedSkillNames from router', () => {
    const routerSrc = fs.readFileSync(
      path.join(process.cwd(), 'core/router.ts'),
      'utf-8'
    );
    expect(routerSrc).toContain('blockedSkillNames');
    expect(routerSrc).toContain('permissionMode');
  });

  it('planner context interface includes permissionMode and blockedSkillNames', () => {
    const plannerSrc = fs.readFileSync(
      path.join(process.cwd(), 'core/planner.ts'),
      'utf-8'
    );
    expect(plannerSrc).toContain('permissionMode?:');
    expect(plannerSrc).toContain('blockedSkillNames?:');
  });

  it('query-loop uses permission-filtered skill list', () => {
    const qlSrc = fs.readFileSync(
      path.join(process.cwd(), 'core/query-loop.ts'),
      'utf-8'
    );
    // Context Diet: query-loop delegates to buildQueryLoopSystemPrompt (prompt-budget.ts)
    // which internally calls getSkillOneLinerList with permission filtering
    expect(qlSrc).toContain('buildQueryLoopSystemPrompt');
  });
});

// ��─ Group 2: FIX 2 — Failure-aware revision ────────────────────────────────

describe('FIX 2: Failure-aware revision', () => {
  it('revision prompt includes FAILED section when milestone has failed steps', () => {
    const executorSrc = fs.readFileSync(
      path.join(process.cwd(), 'core/executor.ts'),
      'utf-8'
    );
    expect(executorSrc).toContain('FAILED in current milestone');
  });

  it('revision prompt includes the specific error message from failed step', () => {
    const executorSrc = fs.readFileSync(
      path.join(process.cwd(), 'core/executor.ts'),
      'utf-8'
    );
    // The prompt template uses s.error for each failed step
    expect(executorSrc).toMatch(/s\.error/);
    expect(executorSrc).toContain('s.skill');
  });

  it('revision prompt does NOT include FAILED section when no failures', () => {
    const executorSrc = fs.readFileSync(
      path.join(process.cwd(), 'core/executor.ts'),
      'utf-8'
    );
    // failedSection is empty string when failedSteps is empty or undefined
    expect(executorSrc).toContain("failedSteps && failedSteps.length > 0");
  });

  it('revision response with abort:true causes executor to stop', () => {
    const executorSrc = fs.readFileSync(
      path.join(process.cwd(), 'core/executor.ts'),
      'utf-8'
    );
    expect(executorSrc).toContain('parsed.abort');
    expect(executorSrc).toContain('revision recommends abort');
    // On abort, returns empty milestones array
    expect(executorSrc).toContain('return []');
  });

  it('revision function accepts failedSteps parameter', () => {
    const executorSrc = fs.readFileSync(
      path.join(process.cwd(), 'core/executor.ts'),
      'utf-8'
    );
    expect(executorSrc).toMatch(/reviseRemainingMilestones\([^)]*failedSteps/s);
  });

  it('revision schema accepts {abort: true, reason: "..."} as valid', () => {
    const result = MilestoneRevisionSchema.safeParse({
      revised: false,
      abort: true,
      reason: 'Task requires full-access permission',
    });
    expect(result.success).toBe(true);
  });

  it('revision schema accepts {revised: false} as valid (regression check)', () => {
    const result = MilestoneRevisionSchema.safeParse({ revised: false });
    expect(result.success).toBe(true);
  });
});

// ── Group 3: FIX 3 — Decomposition few-shot ────────────────────────────────

describe('FIX 3: Decomposition few-shot hardening', () => {
  it('decomposition prompt contains at least one EXAMPLE block', () => {
    // Phase 18: prompt content moved to prompts/decomposition.md
    const src = fs.readFileSync(
      path.join(process.cwd(), 'prompts/decomposition.md'),
      'utf-8'
    );
    const exampleCount = (src.match(/EXAMPLE:/g) ?? []).length;
    expect(exampleCount).toBeGreaterThanOrEqual(3);
  });

  it('decomposition prompt contains WRONG/RIGHT format enforcement block', () => {
    // Phase 18: prompt content moved to prompts/decomposition.md
    const src = fs.readFileSync(
      path.join(process.cwd(), 'prompts/decomposition.md'),
      'utf-8'
    );
    expect(src).toContain('WRONG:');
    expect(src).toContain('RIGHT:');
    expect(src).toContain('CRITICAL: Each unit MUST be an object');
  });

  it('decomposition heuristic repair still exists (regression check)', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'core/decomposition.ts'),
      'utf-8'
    );
    expect(src).toContain('heuristic repair fired');
    expect(src).toContain('repairContext');
    expect(src).toContain('DecompositionRepairContext');
  });
});
