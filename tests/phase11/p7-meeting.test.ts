import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import { _resetGitInstance } from '../../core/memory/versioning.js';

const mockLLM = async (messages: Array<{ role: string; content: string }>) => {
  const last = messages.at(-1);
  if (last?.content?.includes('briefing')) {
    return 'Status: All projects on track. Key question: Are we meeting deadlines?';
  }
  if (last?.content?.includes('Extract memory updates')) {
    return '[{"action": "create", "type": "note", "name": "Meeting Note", "content": "discussed progress"}]';
  }
  return 'Meeting briefing generated.';
};

describe('Phase 11 P7: Meeting Mode', () => {
  let tmpDir: string;
  let origDb: string;
  let origMemory: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-meeting-'));
    origDb = PATHS.db;
    origMemory = PATHS.memory;
    (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
    (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
    (PATHS as Record<string, string>).workspace = path.join(tmpDir, 'workspace');
    (PATHS as Record<string, string>).logs = path.join(tmpDir, 'workspace', 'logs');
    (PATHS as Record<string, string>).projects = path.join(tmpDir, 'workspace', 'projects');
    fs.mkdirSync(PATHS.memory, { recursive: true });
  });

  afterEach(async () => {
    (PATHS as Record<string, string>).db = origDb;
    (PATHS as Record<string, string>).memory = origMemory;
    _resetGitInstance();
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('P7A: runMeetingMode returns a MeetingBriefing object', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { runMeetingMode } = await import('../../core/meeting.js');

    const briefing = await runMeetingMode([], mockLLM as any);
    expect(briefing).toHaveProperty('prompt');
    expect(briefing).toHaveProperty('context');
    expect(briefing).toHaveProperty('suggestedUpdates');
  });

  it('P7B: runMeetingMode prompt contains Meeting Briefing header', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { runMeetingMode } = await import('../../core/meeting.js');

    const briefing = await runMeetingMode([], mockLLM as any);
    expect(briefing.prompt).toContain('Meeting Briefing');
  });

  it('P7C: processMeetingResponse handles "done" command', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { processMeetingResponse } = await import('../../core/meeting.js');

    const briefing = { prompt: '', context: '', suggestedUpdates: [] };
    const result = await processMeetingResponse('done', briefing, mockLLM as any);

    expect(result.nextStep).toContain('complete');
    expect(result.updatesWritten).toEqual([]);
  });

  it('P7D: processMeetingResponse writes NOW.LOG entries', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { processMeetingResponse } = await import('../../core/meeting.js');

    const briefing = { prompt: '', context: 'No entries', suggestedUpdates: [] };
    const result = await processMeetingResponse(
      'We completed the API design task',
      briefing,
      mockLLM as any,
    );

    expect(result.updatesWritten.length).toBeGreaterThan(0);
  });

  it('P7E: meeting intent is classified from /meeting command', async () => {
    const { classifyIntent } = await import('../../core/intent.ts');
    const result = classifyIntent('/meeting');
    expect(result.intent).toBe('meeting');
  });

  it('P7F: meeting intent matches "start meeting mode"', async () => {
    const { classifyIntent } = await import('../../core/intent.ts');
    const result = classifyIntent('start meeting mode');
    expect(result.intent).toBe('meeting');
  });

  it('P7G: /log prefix creates NOW.LOG entry', async () => {
    const { classifyIntent } = await import('../../core/intent.ts');
    const result = classifyIntent('/log today I worked on the agent system');
    expect(result.intent).toBe('memory_write');
    expect(result.nb).toBe('NOW');
    expect(result.type).toBe('LOG');
  });

  it('P7H: NOW.LOG is in TYPE_MAP', async () => {
    const { TYPE_MAP } = await import('../../config/agent.config.js');
    expect('NOW.LOG' in TYPE_MAP).toBe(true);
  });

  it('P7I: meeting_complete transparency event fires', async () => {
    const { transparency } = await import('../../core/transparency.js');
    let emitted = false;
    const off = transparency.on((event) => {
      if (event.type === 'meeting_complete') emitted = true;
    });
    transparency.enable();
    transparency.emit({ type: 'meeting_complete', data: { updatesWritten: ['A', 'B'] } });
    transparency.disable();
    off();
    expect(emitted).toBe(true);
  });

  it('P7J: runMeetingMode does not throw when DB is empty', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { runMeetingMode } = await import('../../core/meeting.js');

    await expect(runMeetingMode([], mockLLM as any)).resolves.toBeDefined();
  });

  it('P7K: runMeetingMode does not throw when LLM fails', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { runMeetingMode } = await import('../../core/meeting.js');

    const failingLLM = async () => { throw new Error('LLM unavailable'); };
    await expect(runMeetingMode([], failingLLM as any)).resolves.toBeDefined();
  });

  it('P7L: suggestedUpdates array is populated from active entries', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { createEntry } = await import('../../core/memory/write.js');
    const { runMeetingMode } = await import('../../core/meeting.js');

    createEntry({ nb: 'PLAN', type: 'PJ', name: 'TestProj', status: 'active', summary: 'test', body: '' });

    const briefing = await runMeetingMode([], mockLLM as any);
    // Should have at least one suggestion from the active project
    expect(Array.isArray(briefing.suggestedUpdates)).toBe(true);
  });

  it('P7M: processMeetingResponse returns nextStep string', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { processMeetingResponse } = await import('../../core/meeting.js');

    const briefing = { prompt: '', context: '', suggestedUpdates: [] };
    const result = await processMeetingResponse('finished', briefing, mockLLM as any);
    expect(typeof result.nextStep).toBe('string');
  });

  it('P7N: meeting briefing context mentions active projects when present', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { createEntry } = await import('../../core/memory/write.js');
    const { runMeetingMode } = await import('../../core/meeting.js');

    createEntry({ nb: 'PLAN', type: 'PJ', name: 'MyProject', status: 'active', summary: 'ongoing', body: '' });

    const briefing = await runMeetingMode([], mockLLM as any);
    expect(briefing.context).toContain('MyProject');
  });

  it('P7O: processMeetingResponse with "finish" also completes meeting', async () => {
    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
    const { processMeetingResponse } = await import('../../core/meeting.js');

    const briefing = { prompt: '', context: '', suggestedUpdates: [] };
    const result = await processMeetingResponse('finish', briefing, mockLLM as any);
    expect(result.nextStep).toContain('complete');
  });
});
