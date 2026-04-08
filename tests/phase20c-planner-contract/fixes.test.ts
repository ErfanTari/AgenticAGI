import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  buildRepairMessage,
  detectPlanFirstIntent,
  filterPlannerMemoryContext,
  normalizePlanDefaults,
  shouldRequireConfirmation,
  validateImageAcquisition,
} from '../../core/planner.js';
import { TaskPlanSchema } from '../../core/schemas.js';
import { createPromptLoader, loadPlannerPrompt } from '../../core/prompt-loader.js';
import { filterPlannerContextResult } from '../../core/memory/unit-search.js';
import { safeParseJsonWithError } from '../../core/structured.js';
import { transparency } from '../../core/transparency.js';
import type { TaskPlan } from '../../core/schemas.js';
import type { UnitMemoryResult } from '../../core/types.js';

const RepairSchema = z.object({
  createdAt: z.string(),
  steps: z.array(z.object({
    confidence_score: z.number(),
    risk_level: z.enum(['LOW', 'MED', 'HIGH']),
  })).min(1),
});

function makeRawPlan() {
  return {
    goal: 'Build a site',
    goals: [{ id: 'goal_1', sourceUnitIds: ['unit_1'], description: 'Build the site' }],
    milestones: [{
      id: 'milestone_1',
      goalIds: ['goal_1'],
      title: 'Draft',
      description: 'Create initial output',
      completionCriteria: 'Draft saved',
      steps: [{
        id: 'step1',
        description: 'Create site',
        skill: 'generate_and_save_file',
        input: { path: 'workspace/site.html', description: 'Create a site' },
        dependsOn: [],
        storeResultAs: 'site_html',
        optional: false,
      }],
    }],
    steps: [{
      id: 'step1',
      description: 'Create site',
      skill: 'generate_and_save_file',
      input: { path: 'workspace/site.html', description: 'Create a site' },
      dependsOn: [],
      storeResultAs: 'site_html',
      optional: false,
    }],
    complexity: 'LOW',
    needsConfirmation: false,
    estimatedDuration: '30s',
  } as Record<string, unknown>;
}

function makePlanWithSkills(skills: string[]): TaskPlan {
  const steps = skills.map((skill, index) => ({
    id: `step${index + 1}`,
    description: `Run ${skill}`,
    skill,
    input: skill === 'web_search'
      ? { query: 'interior architecture photos' }
      : skill === 'web_fetch'
        ? { url: 'https://example.com/image.jpg' }
        : skill === 'url_extract'
          ? { text: 'https://example.com/image.jpg' }
          : {},
    dependsOn: [],
    storeResultAs: `result_${index + 1}`,
    optional: false,
    confidence_score: 0.8,
    risk_level: 'LOW' as const,
  }));

  return {
    goal: 'Build portfolio',
    goals: [],
    milestones: [{
      id: 'milestone_1',
      goalIds: [],
      title: 'Collect assets',
      description: 'Find assets and build the page',
      completionCriteria: 'Page has images',
      steps,
    }],
    steps,
    complexity: 'LOW',
    needsConfirmation: false,
    estimatedDuration: '1m',
    createdAt: new Date().toISOString(),
  };
}

function makeMemoryResult(confidence: number): UnitMemoryResult {
  return {
    unitId: 'unit_1',
    strategy: 'bm25',
    confidence,
    entries: [{
      code: 'PLAN.PL-000001',
      nb: 'PLAN',
      type: 'PL',
      name: 'Old plan',
      status: 'active',
      summary: 'Legacy plan',
      filePath: '/tmp/plan.md',
      created: '2026-04-08T12:00:00Z',
      updated: '2026-04-08T12:00:00Z',
    }],
    contents: ['Legacy plan content'],
  };
}

describe('Phase 20C — planner contract fixes', () => {
  describe('FIX 1 — specific error feedback', () => {
    it('1. buildRepairMessage includes missing field paths from ZodError', () => {
      const result = RepairSchema.safeParse({ steps: [{}] });
      expect(result.success).toBe(false);
      const message = buildRepairMessage(result.error);
      expect(message).toContain('"createdAt"');
      expect(message).toContain('"steps[0].confidence_score"');
    });

    it('2. buildRepairMessage includes expected types for missing fields', () => {
      const result = RepairSchema.safeParse({ steps: [{}] });
      expect(result.success).toBe(false);
      const message = buildRepairMessage(result.error);
      expect(message).toContain('expected string');
      expect(message).toContain('expected number');
    });

    it('3. buildRepairMessage handles multiple simultaneous issues', () => {
      const result = RepairSchema.safeParse({ steps: [{ confidence_score: 'high', risk_level: 'SEVERE' }] });
      expect(result.success).toBe(false);
      const message = buildRepairMessage(result.error);
      expect(message).toContain('Field "steps[0].confidence_score"');
      expect(message).toContain('Field "steps[0].risk_level"');
    });

    it('4. buildRepairMessage does not include generic step-count guidance', () => {
      const result = RepairSchema.safeParse({ steps: [{}] });
      expect(result.success).toBe(false);
      const message = buildRepairMessage(result.error);
      expect(message).not.toContain('Expected: 5 steps');
    });

    it('5. safeParseJsonWithError returns ZodError when validation fails', () => {
      const parsed = safeParseJsonWithError('{"steps":[{}]}', RepairSchema, 'phase20c-test');
      expect(parsed.data).toBeNull();
      expect(parsed.error).not.toBeNull();
      expect(parsed.error?.issues[0]?.path.length).toBeGreaterThan(0);
    });

    it('6. safeParseJsonWithError returns data when validation succeeds', () => {
      const parsed = safeParseJsonWithError(
        '{"createdAt":"2026-04-08T12:00:00Z","steps":[{"confidence_score":0.8,"risk_level":"LOW"}]}',
        RepairSchema,
        'phase20c-test',
      );
      expect(parsed.error).toBeNull();
      expect(parsed.data).not.toBeNull();
      expect(parsed.data?.steps[0]?.risk_level).toBe('LOW');
    });
  });

  describe('FIX 2 — programmatic default injection', () => {
    it('7. normalizePlanDefaults injects createdAt when missing', () => {
      const normalized = normalizePlanDefaults(makeRawPlan());
      expect(typeof normalized.createdAt).toBe('string');
    });

    it('8. normalizePlanDefaults does not overwrite existing createdAt', () => {
      const raw = makeRawPlan();
      raw.createdAt = '2026-04-08T10:00:00Z';
      const normalized = normalizePlanDefaults(raw);
      expect(normalized.createdAt).toBe('2026-04-08T10:00:00Z');
    });

    it('9. normalizePlanDefaults injects confidence_score=0.8 on root steps', () => {
      const normalized = normalizePlanDefaults(makeRawPlan());
      const step = (normalized.steps as Array<Record<string, unknown>>)[0];
      expect(step.confidence_score).toBe(0.8);
    });

    it('10. normalizePlanDefaults injects risk_level="LOW" on root steps', () => {
      const normalized = normalizePlanDefaults(makeRawPlan());
      const step = (normalized.steps as Array<Record<string, unknown>>)[0];
      expect(step.risk_level).toBe('LOW');
    });

    it('11. normalizePlanDefaults handles both root steps and milestone-nested steps', () => {
      const normalized = normalizePlanDefaults(makeRawPlan());
      const rootStep = (normalized.steps as Array<Record<string, unknown>>)[0];
      const milestoneStep = ((normalized.milestones as Array<Record<string, unknown>>)[0].steps as Array<Record<string, unknown>>)[0];
      expect(rootStep.confidence_score).toBe(0.8);
      expect(milestoneStep.risk_level).toBe('LOW');
    });

    it('12. normalizePlanDefaults is idempotent', () => {
      const once = normalizePlanDefaults(makeRawPlan());
      const twice = normalizePlanDefaults(once);
      expect(twice).toEqual(once);
    });

    it('13. plan with injected defaults passes TaskPlanSchema validation', () => {
      const normalized = normalizePlanDefaults(makeRawPlan());
      const parsed = TaskPlanSchema.safeParse(normalized);
      expect(parsed.success).toBe(true);
    });

    it('14. plan without injected defaults fails TaskPlanSchema validation', () => {
      const parsed = TaskPlanSchema.safeParse(makeRawPlan());
      expect(parsed.success).toBe(false);
      expect(parsed.error.issues.some(issue => issue.path.includes('createdAt'))).toBe(true);
    });
  });

  describe('FIX 3 — zero-confidence memory filtering', () => {
    it('15. zero-confidence memory results are excluded from planner context', () => {
      const filtered = filterPlannerContextResult(makeMemoryResult(0));
      expect(filtered.entries).toEqual([]);
      expect(filtered.contents).toEqual([]);
    });

    it('16. positive-confidence memory results are preserved in planner context', () => {
      const filtered = filterPlannerContextResult(makeMemoryResult(0.6));
      expect(filtered.entries).toHaveLength(1);
      expect(filtered.contents).toHaveLength(1);
    });

    it('17. when all results are zero-confidence, planner context memory section is empty', () => {
      const memoryContext = [
        '## unit_1',
        'Strategy: bm25',
        'Confidence: 0',
        '- [PLAN.PL-000001] Old plan: Legacy plan',
      ].join('\n');
      expect(filterPlannerMemoryContext(memoryContext)).toBe('');
    });

    it('18. filter does not affect memory_read skill results outside planner context', () => {
      const original = makeMemoryResult(0);
      const filtered = filterPlannerContextResult(original);
      expect(original.entries).toHaveLength(1);
      expect(filtered.entries).toHaveLength(0);
    });
  });

  describe('FIX 4 — "plan first" detection', () => {
    it('19. "plan first" in message forces needsConfirmation=true', () => {
      expect(detectPlanFirstIntent('plan first, then build it')).toBe(true);
    });

    it('20. "Plan First" case variation forces needsConfirmation=true', () => {
      expect(detectPlanFirstIntent('PLAN FIRST and show me the steps')).toBe(true);
    });

    it('21. "show me the plan" forces needsConfirmation=true', () => {
      expect(detectPlanFirstIntent('show me the plan before you execute')).toBe(true);
    });

    it('22. "review the plan before building" forces needsConfirmation=true', () => {
      expect(detectPlanFirstIntent('review the plan before building')).toBe(true);
    });

    it('23. normal message without plan-first intent does not force confirmation', () => {
      expect(detectPlanFirstIntent('build a portfolio website')).toBe(false);
    });

    it('24. shouldRequireConfirmation overrides an LLM false with plan-first intent', () => {
      const steps = [{
        id: 'step1',
        description: 'Write a file',
        skill: 'file_writer',
        input: { path: 'workspace/site.html', content: '<html></html>' },
        dependsOn: [],
        storeResultAs: null,
        optional: false,
        confidence_score: 0.8,
        risk_level: 'LOW' as const,
      }];
      expect(shouldRequireConfirmation(steps, 'LOW', 'plan first, then execute')).toBe(true);
    });
  });

  describe('FIX 5 — prompt loader freshness', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase20c-prompts-'));
    });

    afterEach(() => {
      vi.restoreAllMocks();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('25. loadPlannerPrompt helper returns current planner prompt content', () => {
      const content = loadPlannerPrompt();
      expect(content).toContain('You are a task planner');
    });

    it('26. createPromptLoader with reloadOnChange returns updated content after mtime changes', () => {
      const loader = createPromptLoader(tmpDir, { reloadOnChange: true });
      const promptPath = path.join(tmpDir, 'planner.md');
      fs.writeFileSync(promptPath, 'first prompt', 'utf8');
      expect(loader.load('planner')).toBe('first prompt');

      fs.writeFileSync(promptPath, 'second prompt', 'utf8');
      const bumped = new Date(Date.now() + 2_000);
      fs.utimesSync(promptPath, bumped, bumped);

      expect(loader.load('planner')).toBe('second prompt');
    });

    it('27. createPromptLoader returns cached content when mtime is unchanged', () => {
      const readSpy = vi.spyOn(fs, 'readFileSync');
      const loader = createPromptLoader(tmpDir, { reloadOnChange: true });
      fs.writeFileSync(path.join(tmpDir, 'planner.md'), 'cached prompt', 'utf8');

      expect(loader.load('planner')).toBe('cached prompt');
      expect(loader.load('planner')).toBe('cached prompt');
      expect(readSpy.mock.calls.filter(call => String(call[0]).endsWith('planner.md'))).toHaveLength(1);
    });

    it('28. createPromptLoader without reloadOnChange keeps legacy cached behavior', () => {
      const loader = createPromptLoader(tmpDir);
      const promptPath = path.join(tmpDir, 'planner.md');
      fs.writeFileSync(promptPath, 'original prompt', 'utf8');
      expect(loader.load('planner')).toBe('original prompt');
      fs.writeFileSync(promptPath, 'updated prompt', 'utf8');
      expect(loader.load('planner')).toBe('original prompt');
    });
  });

  describe('FIX 6 — image acquisition validation', () => {
    it('29. validateImageAcquisition warns when image-intent plan has no url_extract or web_fetch', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const events: string[] = [];
      transparency.enable();
      const off = transparency.on(event => {
        if (event.type === 'plan_image_warning') {
          events.push(event.data.message);
        }
      });

      const warned = validateImageAcquisition(
        makePlanWithSkills(['web_search', 'generate_and_save_file']),
        'use images on internet for the final portfolio',
      );

      off();
      transparency.disable();
      expect(warned).toBe(true);
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(events).toHaveLength(1);
    });

    it('30. validateImageAcquisition does not warn for normal tasks without image intent', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const warned = validateImageAcquisition(
        makePlanWithSkills(['web_search', 'generate_and_save_file']),
        'build a portfolio website',
      );
      expect(warned).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('31. validateImageAcquisition does not warn when plan includes url_extract', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const warned = validateImageAcquisition(
        makePlanWithSkills(['web_search', 'url_extract', 'generate_and_save_file']),
        'include pictures from the web in the final artifact',
      );
      expect(warned).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('32. validateImageAcquisition does not warn when plan includes web_fetch', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const warned = validateImageAcquisition(
        makePlanWithSkills(['web_search', 'web_fetch', 'generate_and_save_file']),
        'use real photos from the internet',
      );
      expect(warned).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('33. planner prompt contains IMAGE ACQUISITION RULE section', () => {
      const content = fs.readFileSync(path.join(process.cwd(), 'prompts', 'planner.md'), 'utf8');
      expect(content).toContain('IMAGE ACQUISITION RULE');
    });

    it('34. planner prompt IMAGE ACQUISITION RULE references url_extract and web_fetch', () => {
      const content = fs.readFileSync(path.join(process.cwd(), 'prompts', 'planner.md'), 'utf8');
      expect(content).toContain('url_extract');
      expect(content).toContain('web_fetch');
    });
  });
});
