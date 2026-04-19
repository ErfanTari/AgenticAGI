#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { fileURLToPath } from 'node:url';

import { processMessage } from '../dist/core/agent.js';
import { PATHS } from '../dist/config/agent.config.js';
import { initDatabase } from '../dist/core/memory/index.js';
import { getPrimaryLLMProfile, withLLMRuntime } from '../dist/core/llm.js';
import { memoryAgent } from '../dist/core/memory/memory-agent.js';
import { sessionCache } from '../dist/core/memory/session-cache.js';
import { transparency } from '../dist/core/transparency.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LOG_ROOT = path.join(ROOT, 'workspace', 'logs', 'trace-diagnosis');

const DEFAULT_MODELS = [
  'qwen3.5-35b-a3b-claude-4.6-opus-engineer-9e-qx64-hi-mlx',
  'glm-4.7-flash-mlx',
];

const DEFAULT_TASKS = ['html', 'coding'];

const args = new Set(process.argv.slice(2));
const onlyModelsArg = [...args].find(arg => arg.startsWith('--models='));
const onlyTasksArg = [...args].find(arg => arg.startsWith('--tasks='));
const allowFallback = args.has('--allow-fallback');
const verbose = args.has('--verbose');

const models = onlyModelsArg
  ? onlyModelsArg.replace('--models=', '').split(',').map(v => v.trim()).filter(Boolean)
  : DEFAULT_MODELS;

const tasks = onlyTasksArg
  ? onlyTasksArg.replace('--tasks=', '').split(',').map(v => v.trim()).filter(Boolean)
  : DEFAULT_TASKS;

const runId = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const runTag = runId.slice(-6);

function ensureLogDir() {
  fs.mkdirSync(LOG_ROOT, { recursive: true });
}

function alignPathsToRepoRoot() {
  PATHS.root = ROOT;
  PATHS.memory = path.join(ROOT, 'memory');
  PATHS.index = path.join(ROOT, 'index');
  PATHS.db = path.join(ROOT, 'index', 'memory.sqlite');
  PATHS.workspace = path.join(ROOT, 'workspace');
  PATHS.logs = path.join(ROOT, 'workspace', 'logs');
  PATHS.projects = path.join(ROOT, 'workspace', 'projects');
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function promptSafeAlias(model) {
  const lower = String(model).toLowerCase();
  if (lower.includes('qwen')) return 'qwenprobe';
  if (lower.includes('glm')) return 'glmprobe';
  if (lower.includes('gemma')) return 'gemmaprobe';
  if (lower.includes('nemotron')) return 'nemotronprobe';
  return 'modelprobe';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function preview(value, limit = 180) {
  const text = normalizeText(value);
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function eventPreview(event, payload) {
  if (event === 'llm_request') {
    const count = payload?.messages ? payload.messages.length : 0;
    const provider = [payload?.provider || '', payload?.model || ''].filter(Boolean).join('/');
    const flags = [];
    if (payload?.disableThinking) flags.push('thinking off');
    if (payload?.schemaMode && payload.schemaMode !== 'none') flags.push(`schema:${payload.schemaMode}`);
    return [count ? `${count} msgs` : '', provider, flags.join(' · ')].filter(Boolean).join('  ·  ');
  }
  if (event === 'error') {
    return preview(payload?.error ?? '', 220);
  }
  if (event === 'query_loop_iteration') {
    return preview(payload?.reply ?? '', 220);
  }
  if (event === 'query_loop_skill_call') {
    return `▶ ${payload?.skill ?? '?'} ${preview(JSON.stringify(payload?.input ?? {}), 120)}`;
  }
  if (event === 'query_loop_skill_result') {
    return `${payload?.success === false ? '✗' : '✓'} ${payload?.skill ?? '?'}` + (payload?.error ? ` ${preview(payload.error, 120)}` : '');
  }
  if (event === 'intake') {
    return preview(payload?.summary ?? '', 180);
  }
  if (event === 'plan') {
    return preview(payload?.goal ?? '', 180);
  }
  return preview(JSON.stringify(payload ?? {}), 180);
}

function buildCompactTrace(events) {
  const lines = [];
  for (const entry of events) {
    lines.push(`[${entry.clock}] ${entry.type}`);
    const summary = eventPreview(entry.type, entry.data);
    if (summary) lines.push(summary);
    lines.push('');
  }
  return lines.join('\n').trim();
}

function summarizeRun(result) {
  const events = result.events;
  const typeCounts = {};
  for (const event of events) {
    typeCounts[event.type] = (typeCounts[event.type] ?? 0) + 1;
  }

  const errors = events.filter(event => event.type === 'error');
  const llmRequests = events.filter(event => event.type === 'llm_request');
  const llmTargets = [...new Set(llmRequests.map(event => `${event.data?.provider ?? '?'}:${event.data?.model ?? '?'}`))];
  const queryLoopEvents = events.filter(event => event.type.startsWith('query_loop_'));
  const narrationCount = queryLoopEvents.filter(event => event.type === 'query_loop_narration').length;
  const skillCalls = queryLoopEvents.filter(event => event.type === 'query_loop_skill_call').length;
  const skillResults = queryLoopEvents.filter(event => event.type === 'query_loop_skill_result').length;
  const intakeEvent = events.find(event => event.type === 'intake');
  const intakeSignals = events.find(event => event.type === 'intake_signals');
  const corruptedIntake = JSON.stringify(intakeEvent?.data ?? '').includes('\\u0000');
  const agenticFalse = intakeSignals?.data?.agenticSignal === false;

  return {
    durationMs: result.durationMs,
    intent: result.intent,
    errorCount: errors.length,
    errors: errors.map(event => String(event.data?.error ?? '')),
    llmRequestCount: llmRequests.length,
    llmTargets,
    narrationCount,
    skillCalls,
    skillResults,
    corruptedIntake,
    agenticFalse,
    typeCounts,
  };
}

function makeHtmlPrompt(modelAlias) {
  return [
    'Benchmark task: create a complete single-file bakery website for an artisan neighborhood bakery.',
    `Save it as one self-contained index.html in a fresh output folder under outputs/trace-diag-html-${modelAlias}/.`,
    'If the intended folder already exists, create a new numbered variant instead of overwriting.',
    'Keep all CSS and JavaScript inline, and make the result polished, intentional, and visually distinctive.',
  ].join(' ');
}

function makeCodingPrompt(modelAlias) {
  return [
    'Create a Node.js Express server with a GET /ok endpoint returning JSON {"ok":true}.',
    `Save it in a fresh output folder under outputs/trace-diag-coding-${modelAlias}/.`,
    'Include package.json, server.js, and a test file.',
    'Run the tests if possible.',
    'If the intended folder already exists, create a new numbered variant instead of overwriting.',
  ].join(' ');
}

function buildTaskPrompt(taskName, modelAlias) {
  if (taskName === 'html') return makeHtmlPrompt(modelAlias);
  if (taskName === 'coding') return makeCodingPrompt(modelAlias);
  throw new Error(`Unknown task '${taskName}'`);
}

function makeRuntime(model) {
  const primary = getPrimaryLLMProfile();
  if (!primary) {
    throw new Error('Primary LLM is not configured. Set LLM_ENDPOINT and LLM_MODEL first.');
  }
  return {
    primary: {
      ...primary,
      label: 'diag-local-primary',
      model,
      timeoutMs: 360000,
    },
    fallback: allowFallback ? null : null,
  };
}

function startConsoleCapture() {
  const entries = [];
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };

  const record = (level, args) => {
    const text = util.format(...args);
    entries.push({ level, text, ts: new Date().toISOString() });
    if (verbose || level !== 'log') {
      original[level](...args);
    }
  };

  console.log = (...args) => record('log', args);
  console.warn = (...args) => record('warn', args);
  console.error = (...args) => record('error', args);

  return () => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    return entries;
  };
}

async function runTrial(model, taskName) {
  const modelSlug = slugify(model);
  const modelAlias = promptSafeAlias(model);
  const prompt = buildTaskPrompt(taskName, modelAlias);
  const runtime = makeRuntime(model);
  const history = [];
  const events = [];
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  sessionCache.clear();

  const stopCapture = startConsoleCapture();
  const unsubscribe = transparency.on(event => {
    events.push({
      ts: new Date().toISOString(),
      clock: new Date().toLocaleTimeString('en-GB', { hour12: false }),
      type: event.type,
      data: JSON.parse(JSON.stringify(event.data ?? {})),
    });
  });

  let reply = null;
  let intent = null;
  let error = null;

  try {
    const result = await withLLMRuntime(runtime, () => processMessage(prompt, history));
    reply = result.reply;
    intent = result.intent;
    history.push({ role: 'user', content: prompt });
    history.push({ role: 'assistant', content: result.reply });
    await memoryAgent.drain();
    await sleep(150);
  } catch (err) {
    error = err instanceof Error ? err.stack || err.message : String(err);
  } finally {
    unsubscribe();
  }

  const logs = stopCapture();
  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - startMs;

  const result = {
    runId,
    taskName,
    model,
    modelSlug,
    modelAlias,
    prompt,
    startedAt,
    finishedAt,
    durationMs,
    intent,
    reply,
    error,
    events,
    logs,
    compactTrace: buildCompactTrace(events),
  };

  result.summary = summarizeRun(result);
  return result;
}

function writeRunResult(result) {
  const stem = `${runId}-${result.taskName}-${result.modelSlug}`;
  const jsonPath = path.join(LOG_ROOT, `${stem}.json`);
  const tracePath = path.join(LOG_ROOT, `${stem}.trace.txt`);
  const logPath = path.join(LOG_ROOT, `${stem}.console.log`);

  fs.writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  fs.writeFileSync(tracePath, `${result.compactTrace}\n`, 'utf8');
  fs.writeFileSync(
    logPath,
    `${result.logs.map(entry => `[${entry.ts}] [${entry.level}] ${entry.text}`).join('\n')}\n`,
    'utf8',
  );

  return { jsonPath, tracePath, logPath };
}

function writeIndex(results) {
  const lines = [
    `# Trace Diagnosis Run ${runId}`,
    '',
    '| Task | Model | Duration (s) | Errors | LLM Calls | Skill Calls | Narrations | Intake Corrupt | Agentic False | Reply Preview |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |',
  ];

  for (const result of results) {
    lines.push(
      `| ${result.taskName} | ${result.model} | ${(result.durationMs / 1000).toFixed(1)} | ${result.summary.errorCount} | ${result.summary.llmRequestCount} | ${result.summary.skillCalls} | ${result.summary.narrationCount} | ${result.summary.corruptedIntake ? 'yes' : 'no'} | ${result.summary.agenticFalse ? 'yes' : 'no'} | ${preview(result.reply ?? result.error ?? '', 100).replace(/\|/g, '\\|')} |`,
    );
  }

  const indexPath = path.join(LOG_ROOT, `${runId}-index.md`);
  fs.writeFileSync(indexPath, `${lines.join('\n')}\n`, 'utf8');
  return indexPath;
}

async function main() {
  ensureLogDir();
  alignPathsToRepoRoot();
  initDatabase();
  transparency.enable();

  const results = [];

  for (const model of models) {
    for (const taskName of tasks) {
      const label = `${taskName} :: ${model}`;
      process.stdout.write(`\n[trace-diagnose] running ${label}\n`);
      const result = await runTrial(model, taskName);
      const paths = writeRunResult(result);
      results.push({ ...result, outputPaths: paths });
      process.stdout.write(
        `[trace-diagnose] finished ${label} in ${(result.durationMs / 1000).toFixed(1)}s; ` +
        `errors=${result.summary.errorCount}; llm_calls=${result.summary.llmRequestCount}; ` +
        `artifacts=${Object.values(paths).join(', ')}\n`,
      );
    }
  }

  const indexPath = writeIndex(results);
  process.stdout.write(`\n[trace-diagnose] summary index: ${indexPath}\n`);
}

main().catch(error => {
  console.error('[trace-diagnose] fatal:', error);
  process.exitCode = 1;
});
