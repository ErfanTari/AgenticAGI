/**
 * QueryLoop Efficiency Fix Sprint — tests/queryloop-efficiency/efficiency.test.ts
 *
 * 24 tests covering FIX 1-3 (system prompt rules), FIX 4 (post-gen hint),
 * FIX 5 (permission-filtered skills), FIX 6 (MEMORY.md filtering),
 * FIX 7 (GitHub URL rewrite).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { filterPointerIndex } from '../../core/query-loop.js';
import { rewriteGitHubBlobUrl } from '../../core/skills/tools/web_fetch.js';
import { getSkillsByPermission } from '../../core/skills/registry.js';

// ── Group 1: System prompt content (FIXes 1-3) ─────────────────────────────

describe('FIXes 1-3: QueryLoop system prompt rules', () => {
  // Phase 18: prompt content moved to prompts/query-loop.md
  const src = fs.readFileSync(
    path.join(process.cwd(), 'prompts/query-loop.md'),
    'utf-8'
  );

  it('contains SINGLE-FILE HTML RULE', () => {
    expect(src).toContain('SINGLE-FILE HTML RULE');
  });

  it('contains GENERATE-FIRST RULE', () => {
    expect(src).toContain('GENERATE-FIRST RULE');
  });

  it('contains DESCRIPTION QUALITY RULE', () => {
    expect(src).toContain('DESCRIPTION QUALITY RULE');
  });

  it('mentions CDN and inline <style>/<script>', () => {
    expect(src).toContain('CDN');
    expect(src).toContain('inline <style>');
    expect(src).toContain('<script>');
  });

  it('warns against fetching GitHub blob pages', () => {
    expect(src).toContain('GitHub blob pages');
    expect(src).toContain('raw.githubusercontent.com');
  });
});

// ── Group 2: Post-generation hint (FIX 4) ──────────────────────────────────

describe('FIX 4: Post-generation self-read suppression', () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), 'core/query-loop.ts'),
    'utf-8'
  );

  it('generate_and_save_file success includes "Do not re-read" hint', () => {
    expect(src).toContain("generate_and_save_file");
    expect(src).toContain('Do not re-read files you just generated');
  });

  it('hint is conditional on success and generate_and_save_file action', () => {
    // The hint only fires after generate_and_save_file succeeds (inside result.success branch)
    expect(src).toContain("toolCall.action === 'generate_and_save_file'");
    expect(src).toContain('Do not re-read files you just generated');
  });

  it('post-gen hint block exists inside success branch', () => {
    // Verify hint logic is inside the result.success block
    const successIdx = src.indexOf('if (result.success)');
    const hintIdx = src.indexOf('Do not re-read files you just generated');
    expect(successIdx).toBeGreaterThan(-1);
    expect(hintIdx).toBeGreaterThan(successIdx);
  });
});

// ── Group 3: Permission-filtered skill list (FIX 5) ────────────────────────

describe('FIX 5: Permission-filtered skill list in queryLoop', () => {
  it('in workspace-write mode, run_bash is NOT listed', () => {
    const skills = getSkillsByPermission('workspace-write');
    const names = skills.map(s => s.name);
    expect(names).not.toContain('run_bash');
  });

  it('in workspace-write mode, implement_and_test is NOT listed', () => {
    const skills = getSkillsByPermission('workspace-write');
    const names = skills.map(s => s.name);
    expect(names).not.toContain('implement_and_test');
  });

  it('in full-access mode, all skills ARE listed', () => {
    const fullSkills = getSkillsByPermission('full-access');
    const names = fullSkills.map(s => s.name);
    expect(names).toContain('run_bash');
    expect(names).toContain('implement_and_test');
  });

  it('in read-only mode, file_writer is NOT listed', () => {
    const skills = getSkillsByPermission('read-only');
    const names = skills.map(s => s.name);
    expect(names).not.toContain('file_writer');
  });

  it('calculator and web_search are listed in all modes', () => {
    for (const mode of ['read-only', 'workspace-write', 'full-access'] as const) {
      const skills = getSkillsByPermission(mode);
      const names = skills.map(s => s.name);
      expect(names).toContain('calculator');
      expect(names).toContain('web_search');
    }
  });
});

// ── Group 4: MEMORY.md filtering (FIX 6) ───────────────────────────────────

describe('FIX 6: MEMORY.md relevance filtering', () => {
  const sampleIndex = [
    '# Memory Index',
    'WHO.CT-000001: Sara Ahmadi — lead designer',
    'WHO.CT-000002: John Doe — backend developer',
    'PLAN.PJ-000001: Street of Rage Game — HTML game project',
    'PLAN.PJ-000002: Street of Rage v2 — second attempt',
    'PLAN.PJ-000003: Street of Rage v3 — third attempt',
    'PLAN.PJ-000004: Milky Way Sim — 3D galaxy simulation',
    'WHAT.KN-000001: Three.js Tips — rendering knowledge',
    'NOW.TD-000001: Fix bug in router — active todo',
    'NOW.TD-000002: Write tests — active todo',
    'HOW.PR-000001: Deploy process — deployment procedure',
    'WHEN.CA-000001: Meeting tomorrow — calendar event',
    'PLAN.PL-000001: Q2 roadmap — planning entry',
    'PLAN.PL-000002: Security audit — planning entry',
    'WHY.MT-000001: Architecture decision — meta reflection',
    'WHY.MT-000002: Performance review — meta reflection',
    'PLAN.PJ-000005: Calculator App — math utility',
    'PLAN.PJ-000006: Portfolio Website — web portfolio',
    'PLAN.PJ-000007: Chat Bot — AI assistant',
    'PLAN.PJ-000008: Blog Engine — CMS system',
  ].join('\n');

  it('preserves owner persona and drops irrelevant entries when goal has no matches', () => {
    const result = filterPointerIndex(sampleIndex, 'anything', 50);
    expect(result).toContain('WHO.CT-000001');
    expect(result).toContain('WHO.CT-000002');
    expect(result).not.toContain('Street of Rage Game');
  });

  it('keeps entries matching goal keywords', () => {
    const result = filterPointerIndex(sampleIndex, 'milky way galaxy simulation', 5);
    expect(result).toContain('Milky Way Sim');
    expect(result).toContain('galaxy simulation');
  });

  it('removes entries with zero keyword overlap when over limit', () => {
    const result = filterPointerIndex(sampleIndex, 'milky way galaxy simulation', 5);
    const lines = result.split('\n');
    // Should NOT contain all Street of Rage entries
    const streetOfRageCount = lines.filter(l => l.includes('Street of Rage')).length;
    expect(streetOfRageCount).toBeLessThan(3);
  });

  it('fills remaining slots with most recent entries', () => {
    const result = filterPointerIndex(sampleIndex, 'milky way galaxy simulation', 5);
    const lines = result.split('\n').filter(l => l.trim().length > 0 && !l.startsWith('#'));
    // Should have at most maxEntries non-header lines
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('preserves header lines (starting with #)', () => {
    const result = filterPointerIndex(sampleIndex, 'milky way galaxy simulation', 5);
    expect(result).toContain('# Memory Index');
  });

  it('with empty goal returns most recent maxEntries', () => {
    const result = filterPointerIndex(sampleIndex, '', 5);
    const lines = result.split('\n').filter(l => l.trim().length > 0 && !l.startsWith('#'));
    expect(lines.length).toBe(5);
  });
});

// ── Group 5: GitHub URL rewrite (FIX 7) ────────────────────────────────────

describe('FIX 7: GitHub blob URL rewrite', () => {
  it('converts blob URL to raw.githubusercontent.com', () => {
    const url = 'https://github.com/mrdoob/three.js/blob/master/examples/webgl_points_sprites.html';
    const result = rewriteGitHubBlobUrl(url);
    expect(result).toBe('https://raw.githubusercontent.com/mrdoob/three.js/master/examples/webgl_points_sprites.html');
  });

  it('leaves non-GitHub URLs unchanged', () => {
    const url = 'https://example.com/some/page.html';
    expect(rewriteGitHubBlobUrl(url)).toBe(url);
  });

  it('leaves raw.githubusercontent.com URLs unchanged', () => {
    const url = 'https://raw.githubusercontent.com/user/repo/main/file.js';
    expect(rewriteGitHubBlobUrl(url)).toBe(url);
  });

  it('handles URLs with nested paths', () => {
    const url = 'https://github.com/owner/repo/blob/main/src/lib/index.ts';
    const result = rewriteGitHubBlobUrl(url);
    expect(result).toBe('https://raw.githubusercontent.com/owner/repo/main/src/lib/index.ts');
  });

  it('handles branch names with slashes', () => {
    const url = 'https://github.com/owner/repo/blob/feature/branch/src/file.js';
    const result = rewriteGitHubBlobUrl(url);
    expect(result).toBe('https://raw.githubusercontent.com/owner/repo/feature/branch/src/file.js');
  });
});
