#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { processMessage } from '../dist/core/agent.js';
import { PATHS, LLM_CONFIG } from '../dist/config/agent.config.js';
import { getDb, initDatabase } from '../dist/core/memory/index.js';
import { callLLM, getFallbackLLMProfile, getPrimaryLLMProfile, withLLMRuntime } from '../dist/core/llm.js';
import { memoryAgent } from '../dist/core/memory/memory-agent.js';
import { sessionCache } from '../dist/core/memory/session-cache.js';
import { transparency } from '../dist/core/transparency.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST_SENTINELS = [
  ['core/agent.ts', 'dist/core/agent.js'],
  ['core/router.ts', 'dist/core/router.js'],
  ['core/executor.ts', 'dist/core/executor.js'],
  ['core/llm.ts', 'dist/core/llm.js'],
  ['core/transparency.ts', 'dist/core/transparency.js'],
];

const args = new Set(process.argv.slice(2));
const allowFallback = args.has('--allow-fallback');
const verbose = args.has('--verbose');

const scriptConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

const runId = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const runTag = runId.slice(-6);
const projectName = `CodexStressProject${runTag}`;
const aliceName = `Alice Codex ${runTag}`;
const bobName = `Bob Codex ${runTag}`;
const charlieEmail = `charlie.${runTag}@example.com`;
const fileHello = path.join('workspace', `hello-p15-codex-${runTag}.txt`);
const fileTerminal = path.join('workspace', `terminal-p15-codex-${runTag}.txt`);
const expressDir = path.join('workspace', `express-test-p15-codex-${runTag}`);
const expressServer = path.join(expressDir, 'server.js');
const LIVE_DB_PATH = path.join(ROOT, 'index', 'memory.sqlite');
const LIVE_LOG_ROOT = path.join(ROOT, 'workspace', 'logs');

function scriptLog(...parts) {
  scriptConsole.log(...parts);
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function preview(value, limit = 180) {
  const text = normalizeText(value);
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function hasThinkingLeak(text) {
  const value = String(text ?? '');
  return (
    value.includes('Thinking Process:') ||
    value.includes('1. Analyze the Request') ||
    /\d+\.\s+\**Analyze the Request\**/i.test(value) ||
    /\d+\.\s+\**(Consider|Determine|Break|Think)\b/i.test(value) ||
    value.includes('<think>') ||
    value.includes('</think>') ||
    /\*\*Mental Sandbox/.test(value) ||
    /\*\*Constraint Checklist/.test(value) ||
    value.includes('<|im_start|>') ||
    (value.includes('Let me analyze') && value.length > 800)
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeMarkdown(text) {
  return String(text ?? '').replace(/\|/g, '\\|');
}

function ensureLogDir() {
  fs.mkdirSync(LIVE_LOG_ROOT, { recursive: true });
}

function alignPathsToRepoRoot() {
  PATHS.root = ROOT;
  PATHS.memory = path.join(ROOT, 'memory');
  PATHS.index = path.join(ROOT, 'index');
  PATHS.db = LIVE_DB_PATH;
  PATHS.workspace = path.join(ROOT, 'workspace');
  PATHS.logs = LIVE_LOG_ROOT;
  PATHS.projects = path.join(ROOT, 'workspace', 'projects');
}

function warnIfDistLooksStale() {
  const stalePairs = [];
  for (const [srcRel, distRel] of DIST_SENTINELS) {
    const src = path.join(ROOT, srcRel);
    const dist = path.join(ROOT, distRel);
    if (!fs.existsSync(dist)) {
      stalePairs.push(`${distRel} missing`);
      continue;
    }
    const srcMtime = fs.statSync(src).mtimeMs;
    const distMtime = fs.statSync(dist).mtimeMs;
    if (srcMtime > distMtime) {
      stalePairs.push(`${srcRel} newer than ${distRel}`);
    }
  }
  if (stalePairs.length > 0) {
    scriptConsole.warn('[stress:p15:codex] dist may be stale. Run `pnpm build` before trusting this report.');
    for (const pair of stalePairs) {
      scriptConsole.warn(`  - ${pair}`);
    }
  }
}

function createRuntime() {
  const primary = getPrimaryLLMProfile();
  if (!primary) {
    throw new Error('Primary LLM is not configured. Set LLM_ENDPOINT and LLM_MODEL first.');
  }
  const fallback = allowFallback ? getFallbackLLMProfile() : null;
  return {
    primary: { ...primary, label: 'codex-local-primary' },
    fallback,
  };
}

function copyFileIfExists(source, target) {
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, target);
  }
}

function sanitizeDuplicateNames(dbPath) {
  const db = new Database(dbPath);
  const rows = db.prepare(
    `SELECT rowid, code, nb, type, LOWER(name) AS lname
     FROM index_entries
     WHERE status != 'archived'
     ORDER BY rowid DESC`
  ).all();

  const seen = new Set();
  const archived = [];
  for (const row of rows) {
    const key = `${row.nb}|${row.type}|${row.lname}`;
    if (seen.has(key)) {
      db.prepare('UPDATE index_entries SET status = ? WHERE code = ?').run('archived', row.code);
      archived.push({ code: row.code, nb: row.nb, type: row.type, nameKey: row.lname });
    } else {
      seen.add(key);
    }
  }
  db.close();
  return archived;
}

function switchPathConfigForSandbox(sandboxRoot, sandboxDbPath) {
  PATHS.root = sandboxRoot;
  PATHS.index = path.join(sandboxRoot, 'index');
  PATHS.db = sandboxDbPath;
  PATHS.memory = path.join(sandboxRoot, 'memory');
  PATHS.workspace = path.join(sandboxRoot, 'workspace');
  PATHS.logs = path.join(sandboxRoot, 'workspace', 'logs');
  PATHS.projects = path.join(sandboxRoot, 'workspace', 'projects');
  fs.mkdirSync(PATHS.index, { recursive: true });
  fs.mkdirSync(PATHS.memory, { recursive: true });
  fs.mkdirSync(PATHS.workspace, { recursive: true });
  fs.mkdirSync(PATHS.logs, { recursive: true });
  fs.mkdirSync(PATHS.projects, { recursive: true });
}

function initStressDatabase() {
  try {
    initDatabase();
    return {
      mode: 'live',
      dbPath: PATHS.db,
      sandboxRoot: null,
      archivedDuplicates: [],
    };
  } catch (err) {
    const message = String(err);
    if (!message.includes('idx_unique_entry')) {
      throw err;
    }

    const sandboxRoot = path.join(os.tmpdir(), `agenticagi-stress-p15-codex-${runId}`);
    const sandboxIndex = path.join(sandboxRoot, 'index');
    const sandboxDbPath = path.join(sandboxIndex, 'memory.sqlite');
    fs.mkdirSync(sandboxIndex, { recursive: true });
    copyFileIfExists(LIVE_DB_PATH, sandboxDbPath);
    copyFileIfExists(`${LIVE_DB_PATH}-wal`, `${sandboxDbPath}-wal`);
    copyFileIfExists(`${LIVE_DB_PATH}-shm`, `${sandboxDbPath}-shm`);

    const archivedDuplicates = sanitizeDuplicateNames(sandboxDbPath);
    switchPathConfigForSandbox(sandboxRoot, sandboxDbPath);
    process.chdir(sandboxRoot);
    initDatabase(sandboxDbPath);

    return {
      mode: 'sandbox',
      dbPath: sandboxDbPath,
      sandboxRoot,
      archivedDuplicates,
      liveInitError: message,
    };
  }
}

function countEntriesByNameTokens(db, nb, tokens) {
  const lowered = tokens.map(t => t.toLowerCase());
  const rows = db.prepare(
    'SELECT code, name FROM index_entries WHERE nb = ? ORDER BY rowid DESC LIMIT 200'
  ).all(nb);
  return rows.filter(row => lowered.every(token => String(row.name ?? '').toLowerCase().includes(token))).length;
}

function findLatestEntryByNameTokens(db, nb, tokens) {
  const lowered = tokens.map(t => t.toLowerCase());
  const rows = db.prepare(
    'SELECT code, nb, type, name, summary, path, status FROM index_entries WHERE nb = ? ORDER BY rowid DESC LIMIT 200'
  ).all(nb);
  return rows.find(row => lowered.every(token => String(row.name ?? '').toLowerCase().includes(token))) ?? null;
}

function countWhoEntriesByFingerprint(db, email) {
  const rows = db.prepare(
    'SELECT code, fingerprint, path FROM index_entries WHERE nb = ? AND type = ? ORDER BY rowid DESC LIMIT 300'
  ).all('WHO', 'CT');
  const target = email.toLowerCase();
  return rows.filter(row => {
    try {
      if (row.fingerprint) {
        const fp = JSON.parse(row.fingerprint);
        if (String(fp.email ?? '').toLowerCase() === target) return true;
      }
    } catch {
      // ignore malformed fingerprints
    }
    if (row.path && fs.existsSync(row.path)) {
      const content = fs.readFileSync(row.path, 'utf8').toLowerCase();
      return content.includes(target);
    }
    return false;
  }).length;
}

function findRecentEntriesByContent(db, nb, type, needle, limit = 25) {
  const rows = db.prepare(
    'SELECT code, nb, type, name, summary, path, status, updated FROM index_entries WHERE nb = ? AND type = ? ORDER BY rowid DESC LIMIT ?'
  ).all(nb, type, limit);
  const lowered = needle.toLowerCase();
  return rows.filter(row => {
    const name = String(row.name ?? '').toLowerCase();
    const summary = String(row.summary ?? '').toLowerCase();
    if (name.includes(lowered) || summary.includes(lowered)) return true;
    if (row.path && fs.existsSync(row.path)) {
      const content = fs.readFileSync(row.path, 'utf8').toLowerCase();
      return content.includes(lowered);
    }
    return false;
  });
}

function eventSample(event) {
  if (event.type === 'llm_request') {
    return `[llm_request] system="${preview(event.data.system, 140)}" messages=${event.data.messages.length}`;
  }
  if (event.type === 'llm_raw') {
    return `[llm_raw] ms=${event.data.ms} raw="${preview(event.data.raw, 140)}"`;
  }
  if (event.type === 'llm_stripped') {
    return `[llm_stripped] "${preview(event.data.stripped, 140)}"`;
  }
  return `[${event.type}] ${preview(JSON.stringify(event.data), 180)}`;
}

function startConsoleCapture() {
  const entries = [];
  const originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };

  function record(level, args) {
    const text = util.format(...args);
    entries.push({ level, text, ts: new Date().toISOString() });
    if (level === 'warn' || level === 'error' || verbose) {
      originals[level](...args);
    }
  }

  console.log = (...parts) => record('log', parts);
  console.warn = (...parts) => record('warn', parts);
  console.error = (...parts) => record('error', parts);

  return () => {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
    return entries;
  };
}

async function talk(runtime, history, message, waitMs = 150) {
  const events = [];
  const promptPreviews = [];
  const stopCapture = startConsoleCapture();
  const unsubscribe = transparency.on(event => {
    events.push({
      type: event.type,
      sample: eventSample(event),
      data: event.type === 'llm_request'
        ? { system: preview(event.data.system, 240), messageCount: event.data.messages.length }
        : JSON.parse(JSON.stringify(event.data)),
    });
    if (event.type === 'llm_request' && event.data.system) {
      promptPreviews.push(preview(event.data.system, 240));
    }
  });

  try {
    const result = await withLLMRuntime(runtime, async () => processMessage(message, history));
    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: result.reply });
    await memoryAgent.drain();
    if (waitMs > 0) await sleep(waitMs);
    const logs = stopCapture();
    return {
      reply: result.reply,
      intent: result.intent,
      created: result.created ?? null,
      events,
      promptPreviews,
      logs,
    };
  } finally {
    unsubscribe();
    try {
      stopCapture();
    } catch {
      // console already restored
    }
  }
}

function makeResult(id, name, checks, run) {
  const issues = checks.filter(check => !check.pass).map(check => check.label);
  return {
    id,
    name,
    passed: issues.length === 0,
    issues,
    checks,
    replyPreview: preview(run.reply, 240),
    intent: run.intent,
    promptPreviews: run.promptPreviews.slice(0, 5),
    eventTypes: [...new Set(run.events.map(event => event.type))],
    eventSamples: run.events.slice(0, 12).map(event => event.sample),
    logTail: run.logs.slice(-12).map(entry => `[${entry.level}] ${preview(entry.text, 220)}`),
  };
}

async function preflight(runtime) {
  const stopCapture = startConsoleCapture();
  const reply = await withLLMRuntime(runtime, async () => callLLM([
    { role: 'system', content: 'Reply with exactly OK.' },
    { role: 'user', content: 'Ping.' },
  ], { maxTokens: 16 }));
  const logs = stopCapture();
  const providerLine = logs.find(entry => entry.text.includes('[llm] Provider:'))?.text ?? null;
  return {
    reply,
    providerLine,
    logs: logs.map(entry => `[${entry.level}] ${entry.text}`),
  };
}

async function runScenarioT1(runtime) {
  const history = [];
  const run = await talk(runtime, history, 'Explain how a hash map works internally. Be thorough.');
  return makeResult('T1', 'Thinking strip', [
    { label: 'No thinking leak in user reply', pass: !hasThinkingLeak(run.reply) },
    { label: 'Response is substantive (> 80 chars)', pass: run.reply.length > 80 },
    { label: 'At least one LLM request prompt observed', pass: run.promptPreviews.length > 0 },
  ], run);
}

async function runScenarioT2(runtime, db) {
  const history = [];
  const message = `Save ${aliceName} as a contact and ${bobName} as a contact and create a project called ${projectName}.`;
  const run = await talk(runtime, history, message, 300);
  const aliceCount = countEntriesByNameTokens(db, 'WHO', ['alice', 'codex', runTag]);
  const bobCount = countEntriesByNameTokens(db, 'WHO', ['bob', 'codex', runTag]);
  const projectCount = countEntriesByNameTokens(db, 'WHAT', ['codexstressproject', runTag])
    + countEntriesByNameTokens(db, 'PLAN', ['codexstressproject', runTag]);
  const result = makeResult('T2', 'Compound message: all writes execute', [
    { label: `Created WHO entry for ${aliceName}`, pass: aliceCount > 0 },
    { label: `Created WHO entry for ${bobName}`, pass: bobCount > 0 },
    { label: `Created project entry for ${projectName}`, pass: projectCount > 0 },
    { label: 'No thinking leak in user reply', pass: !hasThinkingLeak(run.reply) },
  ], run);
  result.observations = [
    `aliceCount=${aliceCount}`,
    `bobCount=${bobCount}`,
    `projectCount=${projectCount}`,
  ];
  result.history = history;
  return result;
}

async function runScenarioT3(runtime) {
  const history = [];
  sessionCache.clear();
  const first = await talk(runtime, history, `Who is ${aliceName}?`, 150);
  const second = await talk(runtime, history, `What can you tell me about ${aliceName}?`, 150);
  const firstCacheEvents = first.events.filter(event => event.type.startsWith('session_cache_'));
  const secondHit = second.events.some(event => event.type === 'session_cache_hit');
  const secondStore = second.events.some(event => event.type === 'session_cache_store');
  return {
    id: 'T3',
    name: 'Session cache on second mention',
    passed: firstCacheEvents.length > 0 && secondHit,
    issues: [
      ...(firstCacheEvents.length > 0 ? [] : ['No session cache events fired on first mention']),
      ...(secondHit ? [] : ['No session_cache_hit observed on second mention']),
    ],
    checks: [
      { label: 'Cache events fired on first mention', pass: firstCacheEvents.length > 0 },
      { label: 'Cache HIT observed on second mention', pass: secondHit },
      { label: 'Second mention did not rely only on cache store', pass: !secondStore || secondHit },
    ],
    replyPreview: preview(second.reply, 240),
    intent: second.intent,
    promptPreviews: second.promptPreviews.slice(0, 5),
    eventTypes: [...new Set(second.events.map(event => event.type))],
    eventSamples: second.events.slice(0, 12).map(event => event.sample),
    logTail: second.logs.slice(-12).map(entry => `[${entry.level}] ${preview(entry.text, 220)}`),
  };
}

async function runScenarioT4(runtime, db) {
  const history = [];
  const before = countWhoEntriesByFingerprint(db, charlieEmail);
  await talk(runtime, history, `Save Charlie Codex ${runTag} as a contact with email ${charlieEmail}.`, 150);
  await talk(runtime, history, `Save Charlie as a contact with email ${charlieEmail}.`, 150);
  const third = await talk(runtime, history, `Save Charlie C. as a contact with email ${charlieEmail}.`, 300);
  const after = countWhoEntriesByFingerprint(db, charlieEmail);
  return makeResult('T4', 'WHO dedup by fingerprint across formats', [
    { label: 'At most one WHO entry exists for the Charlie fingerprint', pass: after - before <= 1 },
    { label: 'No thinking leak in user reply', pass: !hasThinkingLeak(third.reply) },
  ], third);
}

async function runScenarioT5(runtime, db) {
  const history = [];
  const evBefore = db.prepare(`SELECT COUNT(*) AS count FROM index_entries WHERE nb = 'WHEN' AND type = 'EV'`).get().count;
  const rfBefore = db.prepare(`SELECT COUNT(*) AS count FROM index_entries WHERE nb = 'WHEN' AND type = 'RF'`).get().count;
  const run = await talk(runtime, history, `Create a file called ${fileHello} with content "Phase 15 codex ${runTag}"`, 300);
  const evAfter = db.prepare(`SELECT COUNT(*) AS count FROM index_entries WHERE nb = 'WHEN' AND type = 'EV'`).get().count;
  const rfAfter = db.prepare(`SELECT COUNT(*) AS count FROM index_entries WHERE nb = 'WHEN' AND type = 'RF'`).get().count;
  const matchingEV = findRecentEntriesByContent(db, 'WHEN', 'EV', `hello-p15-codex-${runTag}.txt`);
  const matchingRF = findRecentEntriesByContent(db, 'WHEN', 'RF', `hello-p15-codex-${runTag}.txt`);
  const result = makeResult('T5', 'Memory write completeness after task', [
    { label: 'WHEN.EV count increased', pass: evAfter > evBefore },
    { label: 'WHEN.RF count increased', pass: rfAfter > rfBefore },
    { label: 'Recent WHEN.EV mentions the task artifact', pass: matchingEV.length > 0 },
    { label: 'Recent WHEN.RF mentions the task artifact', pass: matchingRF.length > 0 },
  ], run);
  result.observations = [
    `evBefore=${evBefore} evAfter=${evAfter}`,
    `rfBefore=${rfBefore} rfAfter=${rfAfter}`,
    `matchingEV=${matchingEV.map(row => row.code).join(', ') || '(none)'}`,
    `matchingRF=${matchingRF.map(row => row.code).join(', ') || '(none)'}`,
  ];
  return result;
}

async function runScenarioT6(runtime, db) {
  const history = [];
  const activeBefore = db.prepare(
    `SELECT COUNT(*) AS count
     FROM index_entries
     WHERE nb = 'PLAN' AND type = 'EX' AND status IN ('active', 'in_progress')`
  ).get().count;
  const run = await talk(runtime, history, `Create a file ${fileTerminal} with content "done ${runTag}"`, 300);
  const activeAfter = db.prepare(
    `SELECT COUNT(*) AS count
     FROM index_entries
     WHERE nb = 'PLAN' AND type = 'EX' AND status IN ('active', 'in_progress')`
  ).get().count;
  const matchingPlanEx = findRecentEntriesByContent(db, 'PLAN', 'EX', `terminal-p15-codex-${runTag}.txt`);
  const completeMatch = matchingPlanEx.some(row => ['complete', 'archived', 'closed'].includes(String(row.status ?? '').toLowerCase()));
  const lingeringActiveMatch = matchingPlanEx.some(row => ['active', 'in_progress'].includes(String(row.status ?? '').toLowerCase()));
  const result = makeResult('T6', 'PLAN.EX terminal state does not accumulate', [
    { label: 'Global active PLAN.EX count did not grow', pass: activeAfter <= activeBefore },
    { label: 'Matching PLAN.EX row reached a terminal state', pass: matchingPlanEx.length > 0 && completeMatch },
    { label: 'No matching PLAN.EX row remained active', pass: !lingeringActiveMatch },
  ], run);
  result.observations = [
    `activeBefore=${activeBefore} activeAfter=${activeAfter}`,
    `matchingPlanEx=${matchingPlanEx.map(row => `${row.code}:${row.status}`).join(', ') || '(none)'}`,
  ];
  return result;
}

async function runScenarioT7(runtime) {
  const history = [];
  const run = await talk(
    runtime,
    history,
    `Create a Node.js server using Express at ${expressServer} with GET /ok returning {ok:true}. Include a test and run the test if possible.`,
    800,
  );
  const fileExists = fs.existsSync(path.join(ROOT, expressServer));
  const adaptiveEvent = run.events.some(event =>
    event.type === 'failure_classified'
    || event.type === 'milestone_revised'
    || String(event.sample).includes('RETRY')
    || String(event.sample).includes('REVISE')
  );
  const escalatedGracefully = /escalat|could not|unable|failed/i.test(run.reply) && run.reply.length > 20;
  return makeResult('T7', 'Adaptive execution handles failure without raw collapse', [
    { label: 'No thinking leak in user reply', pass: !hasThinkingLeak(run.reply) },
    { label: 'Task produced an artifact or surfaced graceful adaptive handling', pass: fileExists || adaptiveEvent || escalatedGracefully },
    { label: 'Observed adaptive evidence if artifact was not created', pass: fileExists || adaptiveEvent || escalatedGracefully },
  ], run);
}

async function runScenarioT8(db) {
  const rfRows = db.prepare(
    `SELECT code, name, summary, path
     FROM index_entries
     WHERE nb = 'WHEN' AND type IN ('RF', 'EV')
     ORDER BY rowid DESC
     LIMIT 20`
  ).all();
  const relevant = rfRows.filter(row => {
    const name = String(row.name ?? '');
    const summary = String(row.summary ?? '');
    if (name.includes(runTag) || summary.includes(runTag)) return true;
    if (row.path && fs.existsSync(row.path)) {
      const content = fs.readFileSync(row.path, 'utf8');
      return content.includes(runTag);
    }
    return false;
  });
  const issues = [];
  for (const row of relevant) {
    const content = row.path && fs.existsSync(row.path) ? fs.readFileSync(row.path, 'utf8') : '';
    if (hasThinkingLeak(`${row.name ?? ''} ${row.summary ?? ''}`)) {
      issues.push(`${row.code} summary/name contains reasoning leak`);
    }
    if (hasThinkingLeak(content)) {
      issues.push(`${row.code} file contains reasoning leak`);
    }
  }
  return {
    id: 'T8',
    name: 'Recent WHEN.EV / WHEN.RF entries have no thinking leak',
    passed: relevant.length > 0 && issues.length === 0,
    issues: [
      ...(relevant.length > 0 ? [] : ['No recent WHEN.EV/WHEN.RF entries tied to this run were found']),
      ...issues,
    ],
    checks: [
      { label: 'Found relevant recent episodic/reflection entries for this run', pass: relevant.length > 0 },
      { label: 'No thinking leak in matching entries', pass: issues.length === 0 },
    ],
    replyPreview: `Checked ${relevant.length} matching WHEN rows`,
    intent: 'audit',
    promptPreviews: [],
    eventTypes: [],
    eventSamples: relevant.map(row => `${row.code} ${preview(row.summary || row.name, 120)}`),
    logTail: [],
  };
}

async function runRelationshipProbe(runtime, db) {
  const history = [];
  const run = await talk(
    runtime,
    history,
    `What role does ${aliceName} have on project ${projectName}?`,
    200,
  );
  const alice = findLatestEntryByNameTokens(db, 'WHO', ['alice', 'codex', runTag]);
  const project = findLatestEntryByNameTokens(db, 'WHAT', ['codexstressproject', runTag])
    ?? findLatestEntryByNameTokens(db, 'PLAN', ['codexstressproject', runTag]);
  let relationshipRows = [];
  if (alice && project) {
    relationshipRows = db.prepare(
      `SELECT from_code, relation, to_code, note
       FROM relationships
       WHERE (from_code = ? AND to_code = ?) OR (from_code = ? AND to_code = ?)
       ORDER BY rowid DESC`
    ).all(alice.code, project.code, project.code, alice.code);
  }
  return {
    name: 'Follow-up probe: person/project relationship',
    passed: relationshipRows.length > 0,
    issues: relationshipRows.length > 0 ? [] : ['No SQLite relationship exists between the created person and project'],
    replyPreview: preview(run.reply, 240),
    observations: [
      `alice=${alice ? `${alice.code}:${alice.name}` : '(missing)'}`,
      `project=${project ? `${project.code}:${project.name}` : '(missing)'}`,
      `relationships=${relationshipRows.map(row => `${row.from_code}-${row.relation}->${row.to_code}`).join(', ') || '(none)'}`,
    ],
    eventSamples: run.events.slice(0, 10).map(event => event.sample),
    logTail: run.logs.slice(-10).map(entry => `[${entry.level}] ${preview(entry.text, 220)}`),
  };
}

function buildMarkdown(report) {
  const lines = [];
  lines.push('# Phase 15 Stress Test Codex');
  lines.push('');
  lines.push(`- Run ID: \`${report.runId}\``);
  lines.push(`- Started: \`${report.startedAt}\``);
  lines.push(`- Local primary model: \`${report.runtime.primaryModel}\``);
  lines.push(`- Local-only: \`${report.runtime.localOnly}\``);
  lines.push(`- Preflight reply: \`${escapeMarkdown(report.preflight.reply)}\``);
  if (report.preflight.providerLine) {
    lines.push(`- Preflight provider log: \`${escapeMarkdown(report.preflight.providerLine)}\``);
  }
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push('| ID | Result | Name | Key Issues |');
  lines.push('| --- | --- | --- | --- |');
  for (const result of report.results) {
    lines.push(`| ${result.id} | ${result.passed ? 'PASS' : 'FAIL'} | ${escapeMarkdown(result.name)} | ${escapeMarkdown(result.issues.join('; ') || 'none')} |`);
  }
  lines.push('');
  for (const result of report.results) {
    lines.push(`## ${result.id} — ${result.name}`);
    lines.push('');
    lines.push(`- Status: ${result.passed ? 'PASS' : 'FAIL'}`);
    lines.push(`- Reply preview: ${escapeMarkdown(result.replyPreview)}`);
    if (result.observations?.length) {
      lines.push(`- Observations: ${escapeMarkdown(result.observations.join(' | '))}`);
    }
    if (result.issues.length) {
      lines.push(`- Issues: ${escapeMarkdown(result.issues.join(' | '))}`);
    }
    if (result.promptPreviews.length) {
      lines.push('- Prompt previews:');
      for (const prompt of result.promptPreviews) {
        lines.push(`  - ${escapeMarkdown(prompt)}`);
      }
    }
    if (result.eventSamples.length) {
      lines.push('- Event samples:');
      for (const sample of result.eventSamples.slice(0, 6)) {
        lines.push(`  - ${escapeMarkdown(sample)}`);
      }
    }
    if (result.logTail.length) {
      lines.push('- Log tail:');
      for (const sample of result.logTail.slice(-6)) {
        lines.push(`  - ${escapeMarkdown(sample)}`);
      }
    }
    lines.push('');
  }
  lines.push('## Follow-up Probe');
  lines.push('');
  lines.push(`- Status: ${report.followUp.passed ? 'PASS' : 'FAIL'}`);
  lines.push(`- Reply preview: ${escapeMarkdown(report.followUp.replyPreview)}`);
  lines.push(`- Observations: ${escapeMarkdown(report.followUp.observations.join(' | '))}`);
  if (report.followUp.issues.length) {
    lines.push(`- Issues: ${escapeMarkdown(report.followUp.issues.join(' | '))}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  alignPathsToRepoRoot();
  ensureLogDir();
  warnIfDistLooksStale();
  const runtime = createRuntime();
  transparency.enable();
  const dbMode = initStressDatabase();
  const db = getDb();
  const reportStem = path.join(LIVE_LOG_ROOT, `stress-test-p15-codex-${runId}`);
  const jsonReportPath = `${reportStem}.json`;
  const mdReportPath = `${reportStem}.md`;

  scriptLog('Running Stress-test-p15-codex');
  scriptLog(`Run ID: ${runId}`);
  scriptLog(`Primary model: ${LLM_CONFIG.model || '(unconfigured)'}`);
  scriptLog(`Primary endpoint: ${LLM_CONFIG.endpoint || '(unconfigured)'}`);
  scriptLog(`Fallback enabled: ${allowFallback ? 'yes' : 'no'}`);
  scriptLog(`Database mode: ${dbMode.mode}`);
  scriptLog(`Database path: ${dbMode.dbPath}`);
  if (dbMode.mode === 'sandbox') {
    scriptConsole.warn('[stress:p15:codex] live database could not initialize because of duplicate active names; running in temp sandbox instead.');
    scriptConsole.warn(`  live db: ${LIVE_DB_PATH}`);
    scriptConsole.warn(`  sandbox: ${dbMode.sandboxRoot}`);
    scriptConsole.warn(`  archived duplicate rows in sandbox: ${dbMode.archivedDuplicates.length}`);
  }

  const preflightResult = await preflight(runtime);
  scriptLog(`Preflight reply: ${preflightResult.reply}`);
  if (preflightResult.providerLine) {
    scriptLog(preflightResult.providerLine);
  }

  const results = [];
  results.push(await runScenarioT1(runtime));
  results.push(await runScenarioT2(runtime, db));
  results.push(await runScenarioT3(runtime));
  results.push(await runScenarioT4(runtime, db));
  results.push(await runScenarioT5(runtime, db));
  results.push(await runScenarioT6(runtime, db));
  results.push(await runScenarioT7(runtime));
  results.push(await runScenarioT8(db));

  const followUp = await runRelationshipProbe(runtime, db);
  await memoryAgent.drain();

  const report = {
    runId,
    startedAt: new Date().toISOString(),
    runtime: {
      primaryModel: runtime.primary.model,
      primaryEndpoint: runtime.primary.endpoint,
      localOnly: !runtime.fallback,
      fallbackModel: runtime.fallback?.model ?? null,
    },
    database: dbMode,
    preflight: preflightResult,
    results,
    followUp,
  };

  fs.writeFileSync(jsonReportPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdReportPath, buildMarkdown(report));

  scriptLog('');
  scriptLog('=== Stress-test-p15-codex Report ===');
  let passed = 0;
  let failed = 0;
  for (const result of results) {
    scriptLog(`${result.passed ? 'PASS' : 'FAIL'} ${result.id} ${result.name}`);
    if (result.passed) {
      passed++;
    } else {
      failed++;
      for (const issue of result.issues) {
        scriptLog(`  - ${issue}`);
      }
    }
  }
  scriptLog(`${followUp.passed ? 'PASS' : 'FAIL'} Follow-up: ${followUp.name}`);
  if (!followUp.passed) {
    for (const issue of followUp.issues) {
      scriptLog(`  - ${issue}`);
    }
  }
  scriptLog('');
  scriptLog(`Artifacts: ${jsonReportPath}`);
  scriptLog(`Artifacts: ${mdReportPath}`);
  scriptLog(`Summary: ${passed}/${results.length} tests passed`);

  process.exit((failed === 0 && followUp.passed) ? 0 : 1);
}

main().catch(err => {
  scriptConsole.error('[stress:p15:codex] fatal:', err);
  process.exit(1);
});
