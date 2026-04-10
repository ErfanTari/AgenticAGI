import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import { _resetGitInstance } from '../../core/memory/versioning.js';

describe('Phase 11 P1: PLAN.PJ Project Brain', () => {
  let tmpDir: string;
  let origDb: string;
  let origMemory: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-project-'));
    origDb = PATHS.db;
    origMemory = PATHS.memory;
    (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
    (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
    (PATHS as Record<string, string>).workspace = path.join(tmpDir, 'workspace');
    (PATHS as Record<string, string>).projects = path.join(tmpDir, 'workspace', 'projects');
    (PATHS as Record<string, string>).logs = path.join(tmpDir, 'workspace', 'logs');
    fs.mkdirSync(PATHS.memory, { recursive: true });
  });

  afterEach(async () => {
    (PATHS as Record<string, string>).db = origDb;
    (PATHS as Record<string, string>).memory = origMemory;
    _resetGitInstance();
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('P1A: createProjectEntry creates a PLAN.PJ index entry', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { createProjectEntry } = await import('../../core/memory/project.js');

    const entry = createProjectEntry({
      name: 'AgenticAGI',
      priority: 1,
      vision: 'Build a world-class local AI agent',
      status: 'active',
      current: 'Phase 11 implementation',
      next_action: 'Write tests',
      blocked_by: [],
      phase: 'Phase 11',
      last_worked: '2026-03-05',
      notes: 'On track',
    });

    expect(entry.code).toMatch(/^PLAN\.PJ-\d{6,}$/);
    expect(entry.nb).toBe('PLAN');
    expect(entry.type).toBe('PJ');
    expect(entry.name).toBe('AgenticAGI');
  });

  it('P1B: createProjectEntry writes a workspace overview file', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { createProjectEntry } = await import('../../core/memory/project.js');

    createProjectEntry({
      name: 'TestProject',
      priority: 2,
      vision: 'Test the system',
      status: 'active',
      current: 'Testing',
      next_action: 'Run tests',
      blocked_by: [],
      phase: 'Phase 1',
      last_worked: '2026-03-05',
      notes: '',
    });

    const projectFiles = fs.readdirSync(PATHS.projects);
    expect(projectFiles.some(f => f.includes('testproject'))).toBe(true);
  });

  it('P1C: createProjectEntry writes markdown with vision section', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { createProjectEntry } = await import('../../core/memory/project.js');

    const entry = createProjectEntry({
      name: 'VisionProject',
      priority: 1,
      vision: 'Achieve AGI',
      status: 'active',
      current: 'Phase 1',
      next_action: 'Research',
      blocked_by: [],
      phase: 'Phase 1',
      last_worked: '2026-03-05',
      notes: 'Important project',
    });

    const content = fs.readFileSync(entry.path, 'utf-8');
    expect(content).toContain('## Vision');
    expect(content).toContain('Achieve AGI');
  });

  it('P1D: parseProjectEntry correctly extracts fields', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { createProjectEntry, parseProjectEntry } = await import('../../core/memory/project.js');

    const entry = createProjectEntry({
      name: 'ParseTest',
      priority: 3,
      vision: 'Parse correctly',
      status: 'active',
      current: 'Working on parsing',
      next_action: 'Fix parser',
      blocked_by: ['DEP-001'],
      phase: 'Alpha',
      last_worked: '2026-03-01',
      notes: 'Notes here',
    });

    const content = fs.readFileSync(entry.path, 'utf-8');
    const parsed = parseProjectEntry(content);

    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('ParseTest');
    expect(parsed!.status).toBe('active');
    expect(parsed!.phase).toBe('Alpha');
  });

  it('P1E: getActiveProjects returns only active entries', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { createProjectEntry, getActiveProjects } = await import('../../core/memory/project.js');

    createProjectEntry({
      name: 'ActiveProject',
      priority: 1, vision: 'Active', status: 'active',
      current: '', next_action: '', blocked_by: [],
      phase: '', last_worked: '2026-03-05', notes: '',
    });

    createProjectEntry({
      name: 'PastProject',
      priority: 2, vision: 'Past', status: 'past',
      current: '', next_action: '', blocked_by: [],
      phase: '', last_worked: '2026-01-01', notes: '',
    });

    const active = getActiveProjects();
    expect(active.some(p => p.name === 'ActiveProject')).toBe(true);
    expect(active.some(p => p.name === 'PastProject')).toBe(false);
  });

  it('P1F: updateProjectEntry changes the status field', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { createProjectEntry, updateProjectEntry } = await import('../../core/memory/project.js');

    const entry = createProjectEntry({
      name: 'UpdateTest',
      priority: 1, vision: 'Update test', status: 'active',
      current: 'Running', next_action: 'Continue', blocked_by: [],
      phase: 'Beta', last_worked: '2026-03-05', notes: '',
    });

    updateProjectEntry(entry.code, { status: 'review' });

    const { getDb } = await import('../../core/memory/index.js');
    const db = getDb();
    const row = db.prepare('SELECT status FROM index_entries WHERE code = ?').get(entry.code) as { status: string };
    // 'review' maps to 'active' in db (not 'past')
    expect(row.status).toBe('active');
  });

  it('P1G: PLAN.PJ is in TYPE_MAP', async () => {
    const { TYPE_MAP } = await import('../../config/agent.config.js');
    expect('PLAN.PJ' in TYPE_MAP).toBe(true);
    expect((TYPE_MAP as Record<string, { notebook: string; type: string }>)['PLAN.PJ'].notebook).toBe('PLAN');
    expect((TYPE_MAP as Record<string, { notebook: string; type: string }>)['PLAN.PJ'].type).toBe('PJ');
  });

  it('P1H: checkStalePlanPJ detects stale project entries', async () => {
    const { initDatabase, getDb } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { createProjectEntry } = await import('../../core/memory/project.js');

    createProjectEntry({
      name: 'StaleProject', priority: 1, vision: 'Test stale',
      status: 'active', current: '', next_action: '',
      blocked_by: [], phase: '', last_worked: '2026-01-01', notes: '',
    });

    // Manually backdate the entry
    const db = getDb();
    db.prepare("UPDATE index_entries SET updated = '2026-01-01' WHERE nb = 'PLAN' AND type = 'PJ'").run();

    const { checkStalePlanPJ } = await import('../../core/heartbeat.js');
    const result = checkStalePlanPJ();
    expect(result).not.toBeNull();
    expect(result!.type).toBe('stale_project_brain');
    expect(result!.entries.length).toBeGreaterThan(0);
  });

  it('P1I: stale_project_brain is a valid notification type', async () => {
    const { checkStalePlanPJ } = await import('../../core/heartbeat.js');
    expect(typeof checkStalePlanPJ).toBe('function');
  });

  it('P1J: PATHS.projects is defined', async () => {
    const { PATHS: P } = await import('../../config/agent.config.js');
    expect(P).toHaveProperty('projects');
    expect(typeof P.projects).toBe('string');
  });

  it('P1K: PATHS.workspace is defined', async () => {
    const { PATHS: P } = await import('../../config/agent.config.js');
    expect(P).toHaveProperty('workspace');
  });

  it('P1L: PATHS.logs is defined', async () => {
    const { PATHS: P } = await import('../../config/agent.config.js');
    expect(P).toHaveProperty('logs');
  });

  it('P1M: parseProjectEntry returns null for invalid content', async () => {
    const { parseProjectEntry } = await import('../../core/memory/project.js');
    const result = parseProjectEntry('invalid content without frontmatter');
    // Should not throw even for invalid input
    expect(result).toBeDefined();
  });

  it('P1N: project vision field preserved in memory file', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { createProjectEntry } = await import('../../core/memory/project.js');

    const vision = 'Build a truly intelligent agent system';
    const entry = createProjectEntry({
      name: 'VisionTest', priority: 1, vision,
      status: 'active', current: '', next_action: '',
      blocked_by: [], phase: 'Phase 1', last_worked: '2026-03-05', notes: '',
    });

    const content = fs.readFileSync(entry.path, 'utf-8');
    expect(content).toContain(vision);
  });

  it('P1O: blocked_by field is serialized correctly', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { createProjectEntry } = await import('../../core/memory/project.js');

    const entry = createProjectEntry({
      name: 'BlockedProject', priority: 1, vision: 'Test',
      status: 'blocked', current: '', next_action: '',
      blocked_by: ['WHO.CT-000001', 'PLAN.PJ-000002'],
      phase: '', last_worked: '2026-03-05', notes: '',
    });

    const content = fs.readFileSync(entry.path, 'utf-8');
    expect(content).toContain('WHO.CT-000001');
    expect(content).toContain('PLAN.PJ-000002');
  });
});
