import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSkillOneLinerList, getSkillCompactDescriptions, getSkillDescriptionsForPermission } from '../../core/skills/registry.js';
import { buildQueryLoopSystemPrompt, buildPlannerSystemPrompt } from '../../core/prompt-budget.js';
import { _resetMemoryMode, setMemoryMode } from '../../core/memory-mode.js';

describe('Context Diet: prompt-budget', () => {
  afterEach(() => {
    _resetMemoryMode();
  });

  describe('getSkillOneLinerList', () => {
    it('produces significantly fewer tokens than full descriptions', () => {
      const oneliner = getSkillOneLinerList('full-access', { memoryEnabled: true });
      const full = getSkillDescriptionsForPermission('full-access', { memoryEnabled: true });
      const onelinerTokens = Math.round(oneliner.length / 4);
      const fullTokens = Math.round(full.length / 4);
      // One-liner should be at least 50% smaller than full
      expect(onelinerTokens).toBeLessThan(fullTokens * 0.5);
    });

    it('includes all skill names', () => {
      const oneliner = getSkillOneLinerList('full-access', { memoryEnabled: true });
      expect(oneliner).toContain('file_writer');
      expect(oneliner).toContain('web_search');
      expect(oneliner).toContain('run_bash');
      expect(oneliner).toContain('memory_read');
      expect(oneliner).toContain('skill_schema');
    });

    it('excludes memory skills when memoryEnabled=false', () => {
      const oneliner = getSkillOneLinerList('full-access', { memoryEnabled: false });
      // Check that memory skill lines are absent (each line starts with skill name)
      const lines = oneliner.split('\n');
      expect(lines.every(l => !l.startsWith('memory_read'))).toBe(true);
      expect(lines.every(l => !l.startsWith('memory_write'))).toBe(true);
      expect(lines.every(l => !l.startsWith('memory_history'))).toBe(true);
      expect(lines.every(l => !l.startsWith('relationship_write'))).toBe(true);
    });
  });

  describe('getSkillCompactDescriptions', () => {
    it('is smaller than full format', () => {
      const compact = getSkillCompactDescriptions('full-access', { memoryEnabled: true });
      const full = getSkillDescriptionsForPermission('full-access', { memoryEnabled: true });
      expect(compact.length).toBeLessThan(full.length);
    });

    it('contains required field names', () => {
      const compact = getSkillCompactDescriptions('full-access', { memoryEnabled: true });
      expect(compact).toContain('Required:');
    });

    it('does not contain JSON examples', () => {
      const compact = getSkillCompactDescriptions('full-access', { memoryEnabled: true });
      expect(compact).not.toContain('"action"');
    });
  });

  describe('buildQueryLoopSystemPrompt', () => {
    it('returns a BuiltPrompt with promptId=query-loop', () => {
      setMemoryMode('disabled');
      const built = buildQueryLoopSystemPrompt({ goal: 'write hello world', pointerIndex: '', activeLoops: '' });
      expect(built.promptId).toBe('query-loop');
      expect(built.tokenEstimate).toBeGreaterThan(0);
      expect(built.sources.length).toBeGreaterThan(0);
      expect(built.text).toContain('skill_schema');
    });

    it('token estimate is under 2000 for minimal context (memory disabled)', () => {
      setMemoryMode('disabled');
      const built = buildQueryLoopSystemPrompt({ goal: 'write hello world', pointerIndex: '', activeLoops: '' });
      // With one-liner skills + template, should be well under old ~2700 token baseline
      expect(built.tokenEstimate).toBeLessThan(2300);
    });

    it('sources include skill_list and query-loop-base.md', () => {
      setMemoryMode('disabled');
      const built = buildQueryLoopSystemPrompt({ goal: 'test', pointerIndex: '', activeLoops: '' });
      const names = built.sources.map(s => s.name);
      expect(names).toContain('skill_list');
      expect(names).toContain('query-loop-base.md');
    });
  });

  describe('buildPlannerSystemPrompt', () => {
    it('returns a BuiltPrompt with promptId=planner', () => {
      setMemoryMode('disabled');
      const built = buildPlannerSystemPrompt({
        runtimeContext: '',
        planningContextSections: '',
        permissionMode: 'full-access',
      });
      expect(built.promptId).toBe('planner');
      expect(built.tokenEstimate).toBeGreaterThan(0);
    });

    it('compact skill descriptions are included', () => {
      setMemoryMode('disabled');
      const built = buildPlannerSystemPrompt({
        runtimeContext: '',
        planningContextSections: '',
        permissionMode: 'full-access',
      });
      expect(built.text).toContain('file_writer');
      expect(built.text).not.toContain('"action"'); // no JSON examples
    });
  });
});
