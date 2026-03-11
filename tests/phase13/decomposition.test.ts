import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import { decomposeMessage } from '../../core/decomposition.js';
import { processMessage } from '../../core/agent.js';
import { _resetGitInstance } from '../../core/memory/versioning.js';

describe('Phase 13: decomposition', () => {
  let tmpDir: string;
  let origDb: string;
  let origMemory: string;
  let origWorkspace: string;
  let origLogs: string;
  let origProjects: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase13-decomp-'));
    origDb = PATHS.db;
    origMemory = PATHS.memory;
    origWorkspace = PATHS.workspace;
    origLogs = PATHS.logs;
    origProjects = PATHS.projects;
    (PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
    (PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');
    (PATHS as Record<string, string>).workspace = path.join(tmpDir, 'workspace');
    (PATHS as Record<string, string>).logs = path.join(tmpDir, 'workspace', 'logs');
    (PATHS as Record<string, string>).projects = path.join(tmpDir, 'workspace', 'projects');
    fs.mkdirSync(PATHS.memory, { recursive: true });

    const { initDatabase } = await import('../../core/memory/index.js');
    initDatabase(PATHS.db);
  });

  afterEach(async () => {
    (PATHS as Record<string, string>).db = origDb;
    (PATHS as Record<string, string>).memory = origMemory;
    (PATHS as Record<string, string>).workspace = origWorkspace;
    (PATHS as Record<string, string>).logs = origLogs;
    (PATHS as Record<string, string>).projects = origProjects;
    _resetGitInstance();
    await new Promise(resolve => setTimeout(resolve, 50));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('decomposes a multi-intent message into ordered semantic units', async () => {
    const llm = vi.fn(async () => JSON.stringify({
      units: [
        { route: 'agentic', content: 'create a calculator app' },
        { route: 'conversational', content: 'remember Sara will review it' },
        { route: 'query', content: 'show me similar projects I have done' },
      ],
    }));

    const result = await decomposeMessage(
      'create a calculator app, remember Sara will review it, and show me similar projects I have done',
      llm,
    );

    expect(result.units.map(unit => ({ route: unit.route, content: unit.content }))).toEqual([
      { route: 'agentic', content: 'create a calculator app' },
      { route: 'conversational', content: 'remember Sara will review it' },
      { route: 'query', content: 'show me similar projects I have done' },
    ]);
  });

  it('falls back to a single safe unit when the decomposition output is invalid', async () => {
    const result = await decomposeMessage('tell me something interesting', async () => 'not-json');

    expect(result.units).toHaveLength(1);
    expect(result.units[0].content).toBe('tell me something interesting');
    expect(result.units[0].route).toBe('conversational');
  });

  it('retries compound decomposition before falling back when the first pass collapses multiple routes', async () => {
    const llm = vi.fn(async (messages: Array<{ role: string; content: string }>) => {
      const system = messages[0]?.content ?? '';
      if (system.includes('This message is compound.')) {
        return JSON.stringify({
          units: [
            { route: 'conversational', content: 'I started working on a new project today called TestProject.' },
            { route: 'conversational', content: 'Sara is reviewing it.' },
            { route: 'agentic', content: 'Create a file called hello.txt in workspace/TestProject with content "Hello World".' },
            { route: 'query', content: 'Show me what active projects I have.' },
          ],
        });
      }

      return JSON.stringify({
        units: [
          {
            route: 'conversational',
            content: 'I started working on a new project today called TestProject. Sara is reviewing it. Create a file called hello.txt in workspace/TestProject with content "Hello World". Show me what active projects I have.',
          },
        ],
      });
    });

    const result = await decomposeMessage(
      'I started working on a new project today called TestProject. Sara is reviewing it. Create a file called hello.txt in workspace/TestProject with content "Hello World". Show me what active projects I have.',
      llm,
    );

    expect(result.units.map(unit => unit.route)).toEqual([
      'conversational',
      'conversational',
      'agentic',
      'query',
    ]);
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it('uses heuristic compound recovery when both decomposition passes under-split a multi-sentence message', async () => {
    const llm = vi.fn(async () => JSON.stringify({
      units: [
        {
          route: 'conversational',
          content: 'Remember last time we built the snake game? Take that and add a high score display. Show me active projects too.',
        },
      ],
    }));

    const result = await decomposeMessage(
      'Remember last time we built the snake game? Take that and add a high score display. Show me active projects too.',
      llm,
    );

    expect(result.units.map(unit => ({ route: unit.route, content: unit.content }))).toEqual([
      { route: 'query', content: 'Remember last time we built the snake game?' },
      { route: 'agentic', content: 'Take that and add a high score display.' },
      { route: 'query', content: 'Show me active projects too.' },
    ]);
  });

  it('/log bypasses decomposition and writes immediately', async () => {
    const llm = vi.fn(async () => {
      throw new Error('LLM should not be called for /log');
    });

    const result = await processMessage('/log phase13 bypass test', [], { llmHandler: llm });
    expect(result.intent).toBe('memory_write');
    expect(result.reply).toBe('Logged.');
    expect(llm).not.toHaveBeenCalled();
  });

  it('/meeting bypasses decomposition and starts meeting mode directly', async () => {
    const llm = vi.fn(async (messages: Array<{ role: string; content: string }>) => {
      const system = messages[0]?.content ?? '';
      if (system.includes('decompose one user message')) {
        throw new Error('decomposition should have been skipped');
      }
      return 'Meeting briefing generated.';
    });

    const result = await processMessage('/meeting', [], { llmHandler: llm });
    expect(result.intent).toBe('meeting');
    expect(result.reply).toContain('Meeting Briefing');
  });

  it('direct code fetch bypasses decomposition entirely', async () => {
    const llm = vi.fn(async (messages: Array<{ role: string; content: string }>) => {
      const system = messages[0]?.content ?? '';
      if (system.includes('decompose one user message')) {
        throw new Error('decomposition should have been skipped');
      }
      return 'unused';
    });

    const result = await processMessage('show me WHO.CT-999999', [], { llmHandler: llm });
    expect(result.intent).toBe('code_fetch');
    expect(result.reply).toBe('Entry not found.');
  });

  it('does not let legacy memory_write compatibility override a decomposed agentic build request', async () => {
    const llm = vi.fn(async (messages: Array<{ role: string; content: string }>) => {
      const system = messages[0]?.content ?? '';
      if (system.includes('decompose one user message')) {
        return JSON.stringify({
          units: [
            {
              route: 'agentic',
              content: 'create a snake game in HTML inside a snake_game folder in the workspace',
            },
          ],
        });
      }

      if (system.includes('You are a task planner.')) {
        return JSON.stringify({
          goal: 'create a snake game in HTML inside a snake_game folder in the workspace',
          goals: [
            {
              id: 'goal_1',
              sourceUnitIds: ['unit_1'],
              description: 'create a snake game in HTML inside a snake_game folder in the workspace',
            },
          ],
          milestones: [
            {
              id: 'milestone_1',
              goalIds: ['goal_1'],
              title: 'Prepare workspace structure',
              description: 'The snake_game folder exists and is ready for implementation.',
              completionCriteria: 'Folder and files are ready to be created.',
              steps: [
                {
                  id: 'step_1',
                  description: 'Create the snake_game implementation folder and files.',
                  skill: 'file_writer',
                  input: { path: 'snake_game/index.html', content: '<!doctype html>', mode: 'write' },
                  dependsOn: [],
                  optional: false,
                  confidence_score: 0.9,
                  risk_level: 'LOW',
                },
              ],
            },
          ],
          steps: [
            {
              id: 'step_1',
              description: 'Create the snake_game implementation folder and files.',
              skill: 'file_writer',
              input: { path: 'snake_game/index.html', content: '<!doctype html>', mode: 'write' },
              dependsOn: [],
              optional: false,
              confidence_score: 0.9,
              risk_level: 'LOW',
            },
          ],
          complexity: 'LOW',
          needsConfirmation: true,
          estimatedDuration: '5 minutes',
        });
      }

      throw new Error(`Unexpected LLM prompt: ${system}`);
    });

    const result = await processMessage(
      'lets do a semi complex task, create a snake_game folder in the workspace and build a snake game in HTML inside it',
      [],
      { llmHandler: llm },
    );

    expect(result.intent).toBe('planned_workflow');
    expect(result.reply).toContain('Confirmation required before executing this plan.');
  });

  it('does not let a compound message collapse back into legacy memory_write execution', async () => {
    const llm = vi.fn(async (messages: Array<{ role: string; content: string }>) => {
      const system = messages[0]?.content ?? '';
      if (system.includes('This message is compound.')) {
        return JSON.stringify({
          units: [
            { route: 'conversational', content: 'I started working on a new project today called TestProject.' },
            { route: 'conversational', content: 'Sara is reviewing it.' },
            { route: 'agentic', content: 'Create a file called hello.txt in workspace/TestProject with content "Hello World".' },
            { route: 'query', content: 'Show me what active projects I have.' },
          ],
        });
      }

      if (system.includes('decompose one user message')) {
        return JSON.stringify({
          units: [
            {
              route: 'conversational',
              content: 'I started working on a new project today called TestProject. Sara is reviewing it. Create a file called hello.txt in workspace/TestProject with content "Hello World". Show me what active projects I have.',
            },
          ],
        });
      }

      if (system.includes('You are a task planner.')) {
        return JSON.stringify({
          goal: 'Create a file called hello.txt in workspace/TestProject with content "Hello World".',
          goals: [
            {
              id: 'goal_1',
              sourceUnitIds: ['unit_3'],
              description: 'Create a file called hello.txt in workspace/TestProject with content "Hello World".',
            },
          ],
          milestones: [
            {
              id: 'milestone_1',
              goalIds: ['goal_1'],
              title: 'Write hello.txt',
              description: 'The requested file exists in the project folder.',
              completionCriteria: 'hello.txt has the expected content.',
              steps: [
                {
                  id: 'step_1',
                  description: 'Create the requested file.',
                  skill: 'file_writer',
                  input: { path: 'TestProject/hello.txt', content: 'Hello World', mode: 'write' },
                  dependsOn: [],
                  optional: false,
                  confidence_score: 0.9,
                  risk_level: 'LOW',
                },
              ],
            },
          ],
          steps: [
            {
              id: 'step_1',
              description: 'Create the requested file.',
              skill: 'file_writer',
              input: { path: 'TestProject/hello.txt', content: 'Hello World', mode: 'write' },
              dependsOn: [],
              optional: false,
              confidence_score: 0.9,
              risk_level: 'LOW',
            },
          ],
          complexity: 'LOW',
          needsConfirmation: true,
          estimatedDuration: '2 minutes',
        });
      }

      return 'Acknowledged.';
    });

    const { createEntry } = await import('../../core/memory/write.js');
    createEntry({
      nb: 'WHAT',
      type: 'PJ',
      name: 'Existing Project',
      status: 'active',
      summary: 'Already active',
      body: 'Project notes',
    });

    const result = await processMessage(
      'I started working on a new project today called TestProject. Sara is reviewing it. Create a file called hello.txt in workspace/TestProject with content "Hello World". Show me what active projects I have.',
      [],
      { llmHandler: llm },
    );

    expect(result.intent).toBe('planned_workflow');
    expect(result.reply).toContain('Confirmation required before executing this plan.');
    expect(result.reply).toContain('Existing Project');
    expect(result.reply).not.toContain('Created WHAT.PJ');
  });
});
