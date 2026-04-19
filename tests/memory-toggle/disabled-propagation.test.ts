/**
 * Batch 1: Memory Toggle — Disabled Propagation Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PATHS } from '../../config/agent.config.js';
import { initDatabase } from '../../core/memory/index.js';
import { setMemoryMode, getMemoryMode, _resetMemoryMode } from '../../core/memory-mode.js';
import { setMemoryDisabled, isMemoryDisabled } from '../../core/memory-flag.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(__dirname, `tmp-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
  initDatabase();
});

afterEach(() => {
  _resetMemoryMode();
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('memory-mode module', () => {
  it('defaults to enabled', () => {
    expect(getMemoryMode()).toBe('enabled');
  });

  it('setMemoryMode disabled → getMemoryMode returns disabled', () => {
    setMemoryMode('disabled');
    expect(getMemoryMode()).toBe('disabled');
  });

  it('_resetMemoryMode restores enabled', () => {
    setMemoryMode('disabled');
    _resetMemoryMode();
    expect(getMemoryMode()).toBe('enabled');
  });
});

describe('memory-flag delegates to memory-mode', () => {
  it('setMemoryDisabled(true) → isMemoryDisabled() true', () => {
    setMemoryDisabled(true);
    expect(isMemoryDisabled()).toBe(true);
  });

  it('setMemoryDisabled(true) → getMemoryMode() === disabled', () => {
    setMemoryDisabled(true);
    expect(getMemoryMode()).toBe('disabled');
  });

  it('setMemoryDisabled(false) → isMemoryDisabled() false', () => {
    setMemoryDisabled(true);
    setMemoryDisabled(false);
    expect(isMemoryDisabled()).toBe(false);
  });
});

describe('getSkillDescriptionsForPermission with memoryEnabled: false', () => {
  it('excludes memory_read when memoryEnabled: false', async () => {
    const { getSkillsByPermission } = await import('../../core/skills/registry.js');
    const skills = getSkillsByPermission('full-access', { memoryEnabled: false });
    expect(skills.map(s => s.name)).not.toContain('memory_read');
  });

  it('excludes memory_write when memoryEnabled: false', async () => {
    const { getSkillsByPermission } = await import('../../core/skills/registry.js');
    const skills = getSkillsByPermission('full-access', { memoryEnabled: false });
    expect(skills.map(s => s.name)).not.toContain('memory_write');
  });

  it('excludes relationship_write when memoryEnabled: false', async () => {
    const { getSkillsByPermission } = await import('../../core/skills/registry.js');
    const skills = getSkillsByPermission('full-access', { memoryEnabled: false });
    expect(skills.map(s => s.name)).not.toContain('relationship_write');
  });

  it('excludes memory_history when memoryEnabled: false', async () => {
    const { getSkillsByPermission } = await import('../../core/skills/registry.js');
    const skills = getSkillsByPermission('full-access', { memoryEnabled: false });
    expect(skills.map(s => s.name)).not.toContain('memory_history');
  });

  it('includes non-memory skills when memoryEnabled: false', async () => {
    const { getSkillsByPermission } = await import('../../core/skills/registry.js');
    const skills = getSkillsByPermission('full-access', { memoryEnabled: false });
    expect(skills.map(s => s.name)).toContain('calculator');
  });

  it('includes all memory skills when memoryEnabled: true (default)', async () => {
    const { getSkillsByPermission } = await import('../../core/skills/registry.js');
    const skills = getSkillsByPermission('full-access', { memoryEnabled: true });
    const names = skills.map(s => s.name);
    expect(names).toContain('memory_read');
    expect(names).toContain('memory_write');
  });

  it('includes all memory skills when opts is omitted (backward compat)', async () => {
    const { getSkillsByPermission } = await import('../../core/skills/registry.js');
    const skills = getSkillsByPermission('full-access');
    expect(skills.map(s => s.name)).toContain('memory_read');
  });
});

describe('QueryLoop system prompt when memory disabled', () => {
  it('does not contain ## Active loops when memory disabled', async () => {
    setMemoryMode('disabled');
    const { runQueryLoop } = await import('../../core/query-loop.js');
    const captured: string[] = [];
    const mockHandler = vi.fn(async (msgs: Array<{ role: string; content: string }>) => {
      const sys = msgs.find(m => m.role === 'system');
      if (sys) captured.push(sys.content);
      return 'Task complete.'; // no XML action → loop exits with no_action
    });
    await runQueryLoop('test goal', mockHandler as any);
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]).not.toContain('## Active loops');
  });

  it('does not contain ## Known Entries when memory disabled', async () => {
    setMemoryMode('disabled');
    const { runQueryLoop } = await import('../../core/query-loop.js');
    const captured: string[] = [];
    const mockHandler = vi.fn(async (msgs: Array<{ role: string; content: string }>) => {
      const sys = msgs.find(m => m.role === 'system');
      if (sys) captured.push(sys.content);
      return 'Task complete.';
    });
    await runQueryLoop('test goal', mockHandler as any);
    expect(captured[0]).not.toContain('## Known Entries');
  });
});

describe('memory_mode transparency event', () => {
  it('emits memory_mode event once per processMessage call', async () => {
    const { transparency } = await import('../../core/transparency.js');
    transparency.enable();

    const events: Array<{ type: string }> = [];
    const off = transparency.on(e => events.push(e));

    try {
      const { processMessage } = await import('../../core/agent.js');
      const mockHandler = vi.fn(async () => 'Hello there!');
      await processMessage('hello', [], { llmHandler: mockHandler as any });

      const modeEvents = events.filter(e => e.type === 'memory_mode');
      expect(modeEvents.length).toBe(1);
    } finally {
      off();
      transparency.disable();
    }
  });

  it('memory_mode event carries correct mode value', async () => {
    setMemoryMode('disabled');
    const { transparency } = await import('../../core/transparency.js');
    transparency.enable();

    const events: Array<any> = [];
    const off = transparency.on(e => events.push(e));

    try {
      const { processMessage } = await import('../../core/agent.js');
      const mockHandler = vi.fn(async () => 'Hello!');
      await processMessage('hello', [], { llmHandler: mockHandler as any });

      const modeEvent = events.find(e => e.type === 'memory_mode');
      expect(modeEvent).toBeDefined();
      expect(modeEvent.data.mode).toBe('disabled');
    } finally {
      off();
      transparency.disable();
    }
  });
});
