/**
 * Phase 20 — Portfolio Audit Fixes
 * Test suite for six targeted fixes from transparency log analysis
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { isCommandIntent } from '../../core/memory/quick-resolve.js';
import { quickResolve } from '../../core/memory/quick-resolve.js';
import { assessComplexity } from '../../core/planner.js';
import { initDatabase, closeDatabase } from '../../core/memory/index.js';
import { upsertEntry } from '../../core/memory/mod.js';
import { PATHS } from '../../config/agent.config.js';
import type { MCPSkill } from '../../core/skills/types.js';

const origDb = PATHS.db;
const origMemory = PATHS.memory;
let tmpDir: string;

beforeEach(() => {
  // Setup temp directory for each test
  tmpDir = path.join(process.cwd(), 'tmp', `test-phase20-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
  fs.mkdirSync((PATHS as Record<string, string>).memory, { recursive: true });
  initDatabase((PATHS as Record<string, string>).db);
});

afterEach(() => {
  // Cleanup
  closeDatabase();
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('isCommandIntent', () => {
  it('detects bare imperative starting with verb', () => {
    expect(isCommandIntent('create a portfolio website')).toBe(true);
  });

  it('detects polite command (can you)', () => {
    expect(isCommandIntent('Can you build me a dashboard?')).toBe(true);
  });

  it('detects polite command (could you)', () => {
    expect(isCommandIntent('Could you write a script?')).toBe(true);
  });

  it('detects polite command (would you)', () => {
    expect(isCommandIntent('Would you create a file?')).toBe(true);
  });

  it('detects polite command (please)', () => {
    expect(isCommandIntent('please generate a report')).toBe(true);
  });

  it('rejects retrieval question', () => {
    expect(isCommandIntent('tell me about Tennis 3D Game')).toBe(false);
  });

  it('rejects person query', () => {
    expect(isCommandIntent('what does Farzad do?')).toBe(false);
  });

  it('rejects bare code', () => {
    expect(isCommandIntent('WHO.CT-000001')).toBe(false);
  });

  it('rejects status question', () => {
    expect(isCommandIntent('what is the status of AgenticAGI')).toBe(false);
  });

  it('handles mixed case', () => {
    expect(isCommandIntent('BUILD me an app')).toBe(true);
  });

  it('detects generate verb', () => {
    expect(isCommandIntent('generate a website')).toBe(true);
  });
});

describe('quickResolve command gating', () => {
  it('resolves name search for query about portfolio', async () => {
    // Seed a project entry
    upsertEntry({
      nb: 'WHAT',
      type: 'PJ',
      name: 'Portfolio Website',
      status: 'active',
      summary: 'Personal portfolio website',
      body: 'A website for the portfolio project',
    });

    const r = await quickResolve('tell me about Portfolio Website');
    expect(r.resolved).toBe(true);
    expect(r.strategy).toBe('name_search');
  });

  it('does NOT resolve name search for create command about portfolio', async () => {
    // Seed a project entry
    upsertEntry({
      nb: 'WHAT',
      type: 'PJ',
      name: 'Portfolio Website',
      status: 'active',
      summary: 'Personal portfolio website',
      body: 'A website for the portfolio project',
    });

    const r = await quickResolve('create a portfolio website with cards');
    expect(r.resolved).toBe(false);
  });

  it('does NOT resolve name search for direct command', async () => {
    // Seed a project entry
    upsertEntry({
      nb: 'WHAT',
      type: 'PJ',
      name: 'Portfolio Website',
      status: 'active',
      summary: 'Personal portfolio website',
      body: 'A website for the portfolio project',
    });

    // A direct command that would match "Portfolio Website" name but isCommandIntent blocks name search
    const r = await quickResolve('build a portfolio website');
    expect(r.resolved).toBe(false);
  });

  it('still resolves code lookup even for commands', async () => {
    // Seed an entry and get its code
    const entry = upsertEntry({
      nb: 'WHO',
      type: 'CT',
      name: 'Zaraban',
      status: 'active',
      summary: 'The agent',
      body: 'An AI agent',
    });

    const r = await quickResolve(`Show me ${entry.code}`);
    expect(r.resolved).toBe(true);
    expect(r.strategy).toBe('code_lookup');
  });
});

describe('assessComplexity generation heuristic', () => {
  it('promotes "create a website" to at least MEDIUM', async () => {
    const result = await assessComplexity('create a portfolio website with colorful cards');
    expect(['MEDIUM', 'HIGH', 'MAX']).toContain(result.level);
  });

  it('promotes "build a game" to at least MEDIUM', async () => {
    const result = await assessComplexity('build a tetris game');
    expect(['MEDIUM', 'HIGH', 'MAX']).toContain(result.level);
  });

  it('does not promote simple queries', async () => {
    const result = await assessComplexity('what time is it');
    expect(result.level).toBe('LOW');
  });

  it('does not promote memory queries', async () => {
    const result = await assessComplexity('tell me about my contacts');
    expect(result.level).toBe('LOW');
  });
});

describe('generate_and_save_file skill deprecation removal', () => {
  it('skill description does not contain "deprecated"', async () => {
    const { getAllSkills } = await import('../../core/skills/registry.js');
    const skills = getAllSkills();
    const skill = skills.find(s => s.name === 'generate_and_save_file');
    expect(skill).toBeDefined();
    const desc = Array.isArray(skill?.description) ? skill.description.join(' ') : skill?.description ?? '';
    expect(desc.toLowerCase()).not.toContain('deprecated');
  });

  it('execute does not emit deprecation warning', async () => {
    const { getAllSkills } = await import('../../core/skills/registry.js');
    const skills = getAllSkills();
    const skill = skills.find(s => s.name === 'generate_and_save_file') as any;
    expect(skill).toBeDefined();

    // Mock console.warn to check for deprecation message
    let warnCalled = false;
    const originalWarn = console.warn;
    console.warn = (...args: any[]) => {
      if (args.some(arg => String(arg).includes('deprecated'))) {
        warnCalled = true;
      }
    };

    try {
      // Execute with minimal valid input (will fail due to missing path, but we only care about warning)
      await skill.execute({});
    } catch { /* ignore execution errors */ }

    console.warn = originalWarn;
    expect(warnCalled).toBe(false);
  });
});
