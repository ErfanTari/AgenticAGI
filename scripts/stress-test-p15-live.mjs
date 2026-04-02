#!/usr/bin/env node
// scripts/stress-test-p15-live.mjs
// Phase 15 — Live Memory & Milestone Tests
// Implements TEST 1-7 from the Phase 15 test plan document.
// Usage: node scripts/stress-test-p15-live.mjs [--verbose] [--allow-fallback] [--only T1,T2]

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
const LIVE_DB_PATH = path.join(ROOT, 'index', 'memory.sqlite');
const LIVE_LOG_ROOT = path.join(ROOT, 'workspace', 'logs');

const args = new Set(process.argv.slice(2));
const verbose = args.has('--verbose');
const allowFallback = args.has('--allow-fallback');
const onlyArg = [...args].find(a => a.startsWith('--only='));
const onlyTests = onlyArg ? new Set(onlyArg.replace('--only=', '').split(',')) : null;

const runId = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const runTag = runId.slice(-8);

// Test-specific names (unique per run)
const saraName      = `Sara Ahmadi Live${runTag}`;
const jamesName     = `James Live${runTag}`;
const zarabanPrj    = `Zaraban UI Live${runTag}`;
const blueNbPrj     = `Blue Notebook Live${runTag}`;
const michaelName   = `Michael Live${runTag}`;
const saraDedup     = `Sara Dedup${runTag}`;
const saraEmail     = `sara.dedup.${runTag}@example.com`;
const reminderDir   = path.join('workspace', `reminder-tool-${runTag}`);
const expressDir    = path.join('workspace', `ping-server-${runTag}`);
const blueNbDir     = path.join('workspace', `blue-notebook-${runTag}`);
const financeDir    = path.join('workspace', `finance-tracker-${runTag}`);

const DIST_SENTINELS = [
  ['core/agent.ts', 'dist/core/agent.js'],
  ['core/executor.ts', 'dist/core/executor.js'],
  ['core/router.ts', 'dist/core/router.js'],
];

// ─── Helpers ────────────────────────────────────────────────────────────────

const scriptConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function normalizeText(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
function preview(v, limit = 200) {
  const t = normalizeText(v);
  return t.length <= limit ? t : `${t.slice(0, limit - 1)}…`;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escapeMarkdown(t) { return String(t ?? '').replace(/\|/g, '\\|'); }

function warnIfDistLooksStale() {
  for (const [src, dist] of DIST_SENTINELS) {
    const s = path.join(ROOT, src), d = path.join(ROOT, dist);
    if (!fs.existsSync(d)) { scriptConsole.warn(`[live] dist missing: ${dist}`); continue; }
    if (fs.statSync(s).mtimeMs > fs.statSync(d).mtimeMs)
      scriptConsole.warn(`[live] ${src} newer than ${dist} — run pnpm build`);
  }
}

function alignPathsToRepoRoot() {
  PATHS.root    = ROOT;
  PATHS.memory  = path.join(ROOT, 'memory');
  PATHS.index   = path.join(ROOT, 'index');
  PATHS.db      = LIVE_DB_PATH;
  PATHS.workspace = path.join(ROOT, 'workspace');
  PATHS.logs    = LIVE_LOG_ROOT;
  PATHS.projects = path.join(ROOT, 'workspace', 'projects');
}

function ensureLogDir() { fs.mkdirSync(LIVE_LOG_ROOT, { recursive: true }); }

function createRuntime() {
  const primary = getPrimaryLLMProfile();
  if (!primary) throw new Error('Primary LLM not configured. Set LLM_ENDPOINT and LLM_MODEL.');
  const fallback = allowFallback ? getFallbackLLMProfile() : null;
  return { primary: { ...primary, label: 'live-primary' }, fallback };
}

function startConsoleCapture() {
  const entries = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const record = (level, a) => {
    const text = util.format(...a);
    entries.push({ level, text });
    if (level === 'warn' || level === 'error' || verbose) orig[level](...a);
  };
  console.log = (...a) => record('log', a);
  console.warn = (...a) => record('warn', a);
  console.error = (...a) => record('error', a);
  return () => { Object.assign(console, orig); return entries; };
}

function eventSample(ev) {
  if (ev.type === 'llm_request')
    return `[llm_request] system="${preview(ev.data?.system, 100)}" msgs=${ev.data?.messages?.length ?? 0}`;
  if (ev.type === 'llm_raw')
    return `[llm_raw] ms=${ev.data?.ms} raw="${preview(ev.data?.raw, 100)}"`;
  return `[${ev.type}] ${preview(JSON.stringify(ev.data), 160)}`;
}

async function talk(runtime, history, message, waitMs = 200) {
  const events = [];
  const stopCapture = startConsoleCapture();
  const unsub = transparency.on(ev => {
    events.push({ type: ev.type, sample: eventSample(ev), data: JSON.parse(JSON.stringify(ev.data ?? {})) });
  });
  try {
    const result = await withLLMRuntime(runtime, () => processMessage(message, history));
    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: result.reply });
    await memoryAgent.drain();
    if (waitMs > 0) await sleep(waitMs);
    const logs = stopCapture();
    return { reply: result.reply, intent: result.intent, events, logs };
  } finally {
    unsub();
    try { stopCapture(); } catch { /* already restored */ }
  }
}

// SQLite helpers
function countEntriesByTokens(db, nb, tokens) {
  const low = tokens.map(t => t.toLowerCase());
  const rows = db.prepare('SELECT name FROM index_entries WHERE nb = ? ORDER BY rowid DESC LIMIT 300').all(nb);
  return rows.filter(r => low.every(t => String(r.name ?? '').toLowerCase().includes(t))).length;
}

function findEntryByTokens(db, nb, tokens) {
  const low = tokens.map(t => t.toLowerCase());
  const rows = db.prepare('SELECT code, nb, type, name, summary, path, status, project_brain_cache FROM index_entries WHERE nb = ? ORDER BY rowid DESC LIMIT 300').all(nb);
  return rows.find(r => low.every(t => String(r.name ?? '').toLowerCase().includes(t))) ?? null;
}

function findEntriesByContent(db, nb, type, needle, limit = 30) {
  const low = needle.toLowerCase();
  const rows = db.prepare('SELECT code, name, summary, path, status FROM index_entries WHERE nb = ? AND type = ? ORDER BY rowid DESC LIMIT ?').all(nb, type, limit);
  return rows.filter(r => {
    if (String(r.name ?? '').toLowerCase().includes(low)) return true;
    if (String(r.summary ?? '').toLowerCase().includes(low)) return true;
    if (r.path && fs.existsSync(r.path)) {
      try { return fs.readFileSync(r.path, 'utf8').toLowerCase().includes(low); } catch { return false; }
    }
    return false;
  });
}

function makeResult(id, name, checks, run, extras = {}) {
  const issues = checks.filter(c => !c.pass).map(c => `FAIL: ${c.label}`);
  return {
    id, name,
    passed: issues.length === 0,
    issues, checks,
    replyPreview: preview(run?.reply ?? '', 240),
    intent: run?.intent ?? null,
    eventTypes: [...new Set((run?.events ?? []).map(e => e.type))],
    eventSamples: (run?.events ?? []).slice(0, 14).map(e => e.sample),
    logTail: (run?.logs ?? []).slice(-10).map(e => `[${e.level}] ${preview(e.text, 180)}`),
    ...extras,
  };
}

// ─── TEST 1 — Intake + Session Cache ────────────────────────────────────────

async function runL1(runtime, db) {
  scriptConsole.log('\n[L1] Intake + Session Cache...');
  sessionCache.clear();
  const history = [];

  const turn1 = await talk(
    runtime, history,
    `${saraName} is leading the new ${zarabanPrj} project. ${jamesName} will handle the backend. ` +
    `Can you save them as contacts and create the project?`,
    600,
  );

  const intakeFired    = turn1.events.some(e => e.type === 'intake');
  const cacheStores    = turn1.events.filter(e => e.type === 'session_cache_store');
  const saraStored     = cacheStores.some(e => {
    const code = String(e.data?.code ?? '').toUpperCase();
    // Check any WHO.CT code was stored — we confirm it's Sara by DB lookup
    return code.startsWith('WHO');
  });

  const turn2 = await talk(
    runtime, history,
    `What role does ${saraName} have on this project?`,
    200,
  );

  const cacheHit    = turn2.events.some(e => e.type === 'session_cache_hit');
  const saraCount   = countEntriesByTokens(db, 'WHO', ['sara', 'live' + runTag.slice(0, 6)]);

  scriptConsole.log(`  intake=${intakeFired} stores=${cacheStores.length} cacheHit=${cacheHit} saraCount=${saraCount}`);

  return makeResult('L1', 'Intake + Session Cache', [
    { label: '[intake] event fired on turn 1', pass: intakeFired },
    { label: 'session_cache_store fired after turn 1', pass: cacheStores.length >= 1 },
    { label: 'session_cache_hit fired on turn 2 (Sara not re-fetched)', pass: cacheHit },
    { label: 'Exactly 1 Sara WHO entry in DB (no duplicates)', pass: saraCount === 1 },
  ], turn2, {
    observations: [`intakeFired=${intakeFired}`, `cacheStores=${cacheStores.length}`, `cacheHit=${cacheHit}`, `saraCount=${saraCount}`],
  });
}

// ─── TEST 2 — Working Memory Lifecycle Across Milestones ────────────────────

async function runL2(runtime, db) {
  scriptConsole.log('\n[L2] Working Memory Lifecycle...');
  sessionCache.clear();
  const history = [];

  const wmFiles_before = fs.existsSync(path.join(ROOT, 'workspace', 'working-memory'))
    ? fs.readdirSync(path.join(ROOT, 'workspace', 'working-memory'))
    : [];

  const run = await talk(
    runtime, history,
    `Build a Node.js CLI tool called "reminder" in ${reminderDir}. It should support:\n` +
    `1. Add a reminder: node reminder.js add "buy milk" tomorrow\n` +
    `2. List all reminders: node reminder.js list\n` +
    `3. Mark done: node reminder.js done 1\n` +
    `Use only Node built-ins (no npm). Write a test file that tests all three commands.`,
    2500,
  );

  const wmCreated    = run.events.some(e => e.type === 'working_memory_created');
  const wmUpdated    = run.events.some(e => e.type === 'working_memory_updated');
  const wmArchived   = run.events.some(e => e.type === 'working_memory_archived');
  const milestoneEvt = run.events.some(e => e.type === 'milestone_memory_cycle');

  const wmFiles_after = fs.existsSync(path.join(ROOT, 'workspace', 'working-memory'))
    ? fs.readdirSync(path.join(ROOT, 'workspace', 'working-memory'))
    : [];
  const newWmFiles  = wmFiles_after.filter(f => !wmFiles_before.includes(f));
  const reminderFile = fs.existsSync(path.join(ROOT, reminderDir, 'reminder.js'));

  const rfEntries = findEntriesByContent(db, 'WHEN', 'RF', 'reminder');

  scriptConsole.log(`  wmCreated=${wmCreated} wmUpdated=${wmUpdated} wmArchived=${wmArchived} milestoneEvt=${milestoneEvt}`);
  scriptConsole.log(`  reminderFile=${reminderFile} rfEntries=${rfEntries.length} newWmFiles=${newWmFiles.length}`);

  return makeResult('L2', 'Working Memory Lifecycle Across Milestones', [
    { label: 'working_memory_created event fired', pass: wmCreated },
    { label: 'working_memory_updated or milestone_memory_cycle event fired', pass: wmUpdated || milestoneEvt },
    { label: 'working_memory_archived event fired (task complete cleanup)', pass: wmArchived },
    { label: 'reminder.js file created in workspace', pass: reminderFile },
    { label: 'WHEN.RF reflection written after completion', pass: rfEntries.length > 0 },
  ], run, {
    observations: [
      `wmCreated=${wmCreated}`, `wmUpdated=${wmUpdated}`, `wmArchived=${wmArchived}`,
      `milestoneEvt=${milestoneEvt}`, `reminderFile=${reminderFile}`,
      `rfEntries=${rfEntries.map(r => r.code).join(', ') || '(none)'}`,
    ],
  });
}

// ─── TEST 3 — Adaptive Execution (RETRY/REVISE) ─────────────────────────────

async function runL3(runtime, db) {
  scriptConsole.log('\n[L3] Adaptive Execution...');
  sessionCache.clear();
  const history = [];

  const run = await talk(
    runtime, history,
    `Create a REST API server using Express.js with two endpoints:\n` +
    `GET /ping returns { status: "ok" }\n` +
    `POST /echo returns the request body back\n` +
    `Save in ${expressDir} with tests.`,
    2000,
  );

  const serverFile    = fs.existsSync(path.join(ROOT, expressDir, 'server.js'));
  const adaptiveEvt   = run.events.some(e =>
    e.type === 'failure_classified' ||
    e.type === 'milestone_revised' ||
    String(e.sample).includes('RETRY') ||
    String(e.sample).includes('REVISE'),
  );
  const gracefulEsc   = /escalat|could not|unable|failed|sorry/i.test(run.reply) && run.reply.length > 20;
  const planExRows    = findEntriesByContent(db, 'PLAN', 'EX', `ping-server-${runTag}`);
  const planComplete  = planExRows.some(r => ['complete', 'archived', 'closed'].includes(String(r.status ?? '').toLowerCase()));

  scriptConsole.log(`  serverFile=${serverFile} adaptiveEvt=${adaptiveEvt} gracefulEsc=${gracefulEsc} planComplete=${planComplete}`);

  return makeResult('L3', 'Adaptive Execution (RETRY/REVISE)', [
    { label: 'Task produced server.js OR surfaced adaptive events OR escalated gracefully',
      pass: serverFile || adaptiveEvt || gracefulEsc },
    { label: 'PLAN.EX reached terminal state (not stuck active)',
      pass: planExRows.length === 0 || planComplete || gracefulEsc },
  ], run, {
    observations: [
      `serverFile=${serverFile}`, `adaptiveEvt=${adaptiveEvt}`,
      `gracefulEsc=${gracefulEsc}`,
      `planExRows=${planExRows.map(r => `${r.code}:${r.status}`).join(', ') || '(none)'}`,
    ],
  });
}

// ─── TEST 4 — Cross-Session Project Continuity ──────────────────────────────

async function runL4(runtime, db) {
  scriptConsole.log('\n[L4] Cross-Session Project Continuity...');

  // Session 1
  sessionCache.clear();
  const session1 = [];
  const s1run = await talk(
    runtime, session1,
    `I'm starting a new project called ${blueNbPrj}. It's a personal notes app. ` +
    `${saraName} is the designer. Create the project in memory and make a basic folder ` +
    `structure in ${blueNbDir} with a README explaining what we'll build.`,
    1500,
  );

  const projEntry = findEntryByTokens(db, 'WHAT', ['blue', 'notebook', 'live' + runTag.slice(0, 6)])
    ?? findEntryByTokens(db, 'PLAN', ['blue', 'notebook', 'live' + runTag.slice(0, 6)]);
  const s1ReadmeExists = fs.existsSync(path.join(ROOT, blueNbDir, 'README.md'));

  scriptConsole.log(`  Session1: projEntry=${projEntry?.code ?? '(none)'} readme=${s1ReadmeExists}`);

  // Session 2 — fresh history, no session_cache (simulates restart)
  sessionCache.clear();
  const session2 = [];  // Empty history = new session

  const s2run = await talk(
    runtime, session2,
    `Continue the ${blueNbPrj} project. Add a CHANGELOG.md with today's date and note ` +
    `"Phase 1: folder structure complete."`,
    800,
  );

  const s2IntakeFired   = s2run.events.some(e => e.type === 'intake');
  const s2BrainHit      = s2run.events.some(e => e.type === 'project_brain_hit' || e.type === 'project_brain_miss');
  const changelogExists = fs.existsSync(path.join(ROOT, blueNbDir, 'CHANGELOG.md'));
  const mentionsSara    = s2run.reply.toLowerCase().includes('sara');

  scriptConsole.log(`  Session2: intakeFired=${s2IntakeFired} brainEvt=${s2BrainHit} changelog=${changelogExists} mentionsSara=${mentionsSara}`);

  return makeResult('L4', 'Cross-Session Project Continuity', [
    { label: 'Session 1: project entry created in DB', pass: !!projEntry },
    { label: 'Session 1: README.md created in correct folder', pass: s1ReadmeExists },
    { label: 'Session 2: intake fired — agent located Blue Notebook from memory', pass: s2IntakeFired },
    { label: 'Session 2: CHANGELOG.md created in correct folder', pass: changelogExists },
  ], s2run, {
    observations: [
      `projCode=${projEntry?.code ?? '(missing)'}`,
      `s1ReadmeExists=${s1ReadmeExists}`, `s2IntakeFired=${s2IntakeFired}`,
      `changelogExists=${changelogExists}`, `mentionsSara=${mentionsSara}`,
    ],
    // Pass project code forward for L5
    projCode: projEntry?.code ?? null,
  });
}

// ─── TEST 5 — Project Brain Cache Invalidation ──────────────────────────────

async function runL5(runtime, db, blueNbProjCode) {
  scriptConsole.log('\n[L5] Project Brain Cache Invalidation...');

  if (!blueNbProjCode) {
    // Try to find it anyway
    const entry = findEntryByTokens(db, 'WHAT', ['blue', 'notebook', 'live' + runTag.slice(0, 6)])
      ?? findEntryByTokens(db, 'PLAN', ['blue', 'notebook', 'live' + runTag.slice(0, 6)]);
    blueNbProjCode = entry?.code ?? null;
  }

  sessionCache.clear();
  const history = [];

  // Turn 1: Add Michael
  const addRun = await talk(
    runtime, history,
    `Add ${michaelName} as the backend developer on the ${blueNbPrj} project.`,
    400,
  );
  const brainInvalidated = addRun.events.some(e => e.type === 'project_brain_invalidated');

  // Turn 2: Briefing
  const briefRun = await talk(
    runtime, history,
    `Give me a full briefing on the ${blueNbPrj} project and team.`,
    400,
  );
  const brainMiss      = briefRun.events.some(e => e.type === 'project_brain_miss');
  const brainRebuilt   = briefRun.events.some(e => e.type === 'project_brain_rebuilt');
  const mentionsMichael = briefRun.reply.toLowerCase().includes('michael');

  // SQLite check: project_brain_cache populated
  let cachePopulated = false;
  let cacheHasMichael = false;
  if (blueNbProjCode) {
    const row = db.prepare('SELECT project_brain_cache FROM index_entries WHERE code = ?').get(blueNbProjCode);
    cachePopulated = !!row?.project_brain_cache;
    cacheHasMichael = String(row?.project_brain_cache ?? '').toLowerCase().includes('michael');
  }

  scriptConsole.log(`  brainInvalidated=${brainInvalidated} brainMiss=${brainMiss} brainRebuilt=${brainRebuilt}`);
  scriptConsole.log(`  mentionsMichael=${mentionsMichael} cachePopulated=${cachePopulated} cacheHasMichael=${cacheHasMichael}`);

  return makeResult('L5', 'Project Brain Cache Invalidation', [
    { label: 'project_brain_invalidated fired after adding Michael', pass: brainInvalidated },
    { label: 'project_brain_miss fired on briefing (cache was cleared)', pass: brainMiss },
    { label: 'project_brain_rebuilt fired on briefing', pass: brainRebuilt },
    { label: 'Briefing response mentions Michael', pass: mentionsMichael },
    { label: 'project_brain_cache repopulated in SQLite after rebuild',
      pass: blueNbProjCode ? cachePopulated : true /* skip if no code */ },
  ], briefRun, {
    observations: [
      `projCode=${blueNbProjCode ?? '(unknown)'}`,
      `brainInvalidated=${brainInvalidated}`, `brainMiss=${brainMiss}`,
      `brainRebuilt=${brainRebuilt}`, `cachePopulated=${cachePopulated}`,
      `cacheHasMichael=${cacheHasMichael}`, `mentionsMichael=${mentionsMichael}`,
    ],
  });
}

// ─── TEST 6 — WHO Deduplication ─────────────────────────────────────────────

async function runL6(runtime, db) {
  scriptConsole.log('\n[L6] WHO Deduplication...');
  sessionCache.clear();

  // Three separate sessions about the same person
  const h1 = [];
  await talk(runtime, h1, `${saraDedup} reviewed the code today and said it looks good.`, 300);

  const h2 = [];
  await talk(runtime, h2,
    `${saraDedup} confirmed she'll join the Monday standup. Her email is ${saraEmail}`, 300);

  const h3 = [];
  const run3 = await talk(runtime, h3,
    `I spoke with ${saraDedup} — she wants to add dark mode to the UI.`, 300);

  // SQLite: count WHO entries for Sara
  const rows = db.prepare(
    `SELECT code, name, summary, fingerprint, path FROM index_entries WHERE nb = 'WHO' ORDER BY rowid DESC LIMIT 300`
  ).all();
  const saraRows = rows.filter(r => String(r.name ?? '').toLowerCase().includes('sara') &&
    (String(r.name ?? '').toLowerCase().includes('dedup') ||
      (r.path && fs.existsSync(r.path) && fs.readFileSync(r.path, 'utf8').toLowerCase().includes(saraEmail))));

  // Check if any entry has the email
  let emailFound = false;
  for (const row of saraRows) {
    if (String(row.fingerprint ?? '').includes(saraEmail)) { emailFound = true; break; }
    if (row.path && fs.existsSync(row.path)) {
      if (fs.readFileSync(row.path, 'utf8').toLowerCase().includes(saraEmail)) { emailFound = true; break; }
    }
  }

  const mergeHint = run3.events.some(e =>
    e.type === 'memory' || String(e.sample).toLowerCase().includes('merg'));

  scriptConsole.log(`  saraRows=${saraRows.length} emailFound=${emailFound}`);

  return makeResult('L6', 'WHO Deduplication', [
    { label: 'Exactly 1 WHO entry for Sara Dedup (no duplicates created across 3 prompts)',
      pass: saraRows.length === 1 },
    { label: 'Email address stored in Sara entry', pass: emailFound },
  ], run3, {
    observations: [
      `saraRows=${saraRows.length}`,
      `saraNames=${saraRows.map(r => r.name).join(', ') || '(none)'}`,
      `emailFound=${emailFound}`,
    ],
  });
}

// ─── TEST 7 — Real Stress Test (all systems together) ───────────────────────

async function runL7(runtime, db) {
  scriptConsole.log('\n[L7] Real Stress Test (all systems)...');
  sessionCache.clear();
  const history = [];

  const run = await talk(
    runtime, history,
    `I want to build a complete personal finance tracker CLI.\n` +
    `Features:\n` +
    `- Add income/expense: node finance.js add income 500 "freelance"\n` +
    `- List all entries: node finance.js list\n` +
    `- Monthly summary: node finance.js summary march\n` +
    `- Warning when spending category exceeds 80% of last month\n\n` +
    `Save in ${financeDir}.\n` +
    `Node built-ins only.\n` +
    `Tests for all four features.\n` +
    `Remember this as a project — ${saraName} will review it when done.\n` +
    `When finished, tell me what other projects I have that this could connect to.`,
    4000,
  );

  const financeFile   = fs.existsSync(path.join(ROOT, financeDir, 'finance.js'));
  const testFile      = fs.existsSync(path.join(ROOT, financeDir)) &&
    fs.readdirSync(path.join(ROOT, financeDir)).some(f => /test/i.test(f));
  const wmCreated     = run.events.some(e => e.type === 'working_memory_created');
  const wmArchived    = run.events.some(e => e.type === 'working_memory_archived');
  const milestoneCycles = run.events.filter(e => e.type === 'milestone_memory_cycle').length;

  const projEntry     = findEntryByTokens(db, 'WHAT', ['finance', 'live' + runTag.slice(0, 6)])
    ?? findEntryByTokens(db, 'PLAN', ['finance', 'live' + runTag.slice(0, 6)]);

  // Check relationship: Sara → project
  let saraRelationship = false;
  const saraEntry = findEntryByTokens(db, 'WHO', ['sara', 'live' + runTag.slice(0, 6)]);
  if (saraEntry && projEntry) {
    const relRows = db.prepare(
      `SELECT * FROM relationships WHERE (from_code = ? AND to_code = ?) OR (from_code = ? AND to_code = ?)`
    ).all(saraEntry.code, projEntry.code, projEntry.code, saraEntry.code);
    saraRelationship = relRows.length > 0;
  }

  const mentionsCrossProject = /project|zaraban|blue|notebook|reminder|finance/i.test(run.reply.slice(-800));

  scriptConsole.log(`  financeFile=${financeFile} testFile=${testFile} wmCreated=${wmCreated} wmArchived=${wmArchived}`);
  scriptConsole.log(`  projEntry=${projEntry?.code ?? '(none)'} saraRel=${saraRelationship} milestoneCycles=${milestoneCycles}`);

  return makeResult('L7', 'Real Stress Test — all systems together', [
    { label: 'finance.js file created in workspace', pass: financeFile },
    { label: 'Test file created alongside finance.js', pass: !!testFile },
    { label: 'working_memory_created event fired (multi-milestone tracking)', pass: wmCreated },
    { label: 'At least 2 milestone_memory_cycle events (multi-step execution)', pass: milestoneCycles >= 2 },
    { label: 'working_memory_archived (task cleanup complete)', pass: wmArchived },
    { label: 'Finance project entry created in DB', pass: !!projEntry },
    { label: 'Sara linked to finance project via relationship', pass: saraRelationship },
    { label: 'Response addresses cross-project connection', pass: mentionsCrossProject },
  ], run, {
    observations: [
      `financeFile=${financeFile}`, `testFile=${testFile}`,
      `wmCreated=${wmCreated}`, `wmArchived=${wmArchived}`,
      `milestoneCycles=${milestoneCycles}`,
      `projEntry=${projEntry?.code ?? '(none)'}`,
      `saraEntry=${saraEntry?.code ?? '(none)'}`,
      `saraRelationship=${saraRelationship}`,
      `mentionsCrossProject=${mentionsCrossProject}`,
    ],
  });
}

// ─── Preflight ───────────────────────────────────────────────────────────────

async function preflight(runtime) {
  const stopCapture = startConsoleCapture();
  const reply = await withLLMRuntime(runtime, () => callLLM([
    { role: 'system', content: 'Reply with exactly OK.' },
    { role: 'user', content: 'Ping.' },
  ], { maxTokens: 16 }));
  const logs = stopCapture();
  const providerLine = logs.find(l => l.text.includes('[llm] Provider:'))?.text ?? null;
  return { reply, providerLine };
}

// ─── Report ──────────────────────────────────────────────────────────────────

function buildMarkdown(report) {
  const lines = [];
  lines.push('# Phase 15 Live Memory & Milestone Test Report');
  lines.push('');
  lines.push(`- Run ID: \`${report.runId}\``);
  lines.push(`- Started: \`${report.startedAt}\``);
  lines.push(`- Primary model: \`${report.runtime.primaryModel}\``);
  lines.push(`- Preflight: \`${escapeMarkdown(report.preflight.reply)}\``);
  if (report.preflight.providerLine) lines.push(`- Provider: \`${escapeMarkdown(report.preflight.providerLine)}\``);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| ID | Result | Name | Issues |');
  lines.push('| -- | ------ | ---- | ------ |');
  for (const r of report.results) {
    lines.push(`| ${r.id} | ${r.passed ? 'PASS' : 'FAIL'} | ${escapeMarkdown(r.name)} | ${escapeMarkdown(r.issues.join('; ') || 'none')} |`);
  }
  lines.push('');
  for (const r of report.results) {
    lines.push(`## ${r.id} — ${r.name}`);
    lines.push('');
    lines.push(`**Status:** ${r.passed ? 'PASS' : 'FAIL'}`);
    lines.push('');
    lines.push('**Checks:**');
    for (const c of r.checks) lines.push(`- ${c.pass ? 'PASS' : 'FAIL'}: ${escapeMarkdown(c.label)}`);
    if (r.observations?.length) {
      lines.push('');
      lines.push(`**Observations:** ${escapeMarkdown(r.observations.join(' | '))}`);
    }
    if (r.issues.length) {
      lines.push('');
      lines.push(`**Issues:** ${escapeMarkdown(r.issues.join(' | '))}`);
    }
    lines.push('');
    lines.push(`**Reply preview:** ${escapeMarkdown(r.replyPreview)}`);
    if (r.eventSamples?.length) {
      lines.push('');
      lines.push('**Event samples:**');
      for (const s of r.eventSamples.slice(0, 8)) lines.push(`- ${escapeMarkdown(s)}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  alignPathsToRepoRoot();
  ensureLogDir();
  warnIfDistLooksStale();

  const runtime = createRuntime();
  transparency.enable();
  initDatabase();
  const db = getDb();

  const reportStem = path.join(LIVE_LOG_ROOT, `stress-test-p15-live-${runId}`);
  const jsonPath = `${reportStem}.json`;
  const mdPath   = `${reportStem}.md`;

  scriptConsole.log('=== Phase 15 Live Memory & Milestone Tests ===');
  scriptConsole.log(`Run ID:   ${runId}`);
  scriptConsole.log(`Run Tag:  ${runTag}`);
  scriptConsole.log(`Model:    ${LLM_CONFIG.model ?? '(unconfigured)'}`);
  scriptConsole.log(`DB:       ${PATHS.db}`);
  scriptConsole.log(`Sara:     ${saraName}`);
  scriptConsole.log(`BlueNb:   ${blueNbPrj}`);
  scriptConsole.log('');

  const preflightResult = await preflight(runtime);
  scriptConsole.log(`Preflight: ${preflightResult.reply}`);
  if (preflightResult.providerLine) scriptConsole.log(preflightResult.providerLine);

  const allTests = {
    L1: () => runL1(runtime, db),
    L2: () => runL2(runtime, db),
    L3: () => runL3(runtime, db),
    L4: () => runL4(runtime, db),
    L5: (ctx) => runL5(runtime, db, ctx?.L4?.projCode ?? null),
    L6: () => runL6(runtime, db),
    L7: () => runL7(runtime, db),
  };

  const results = [];
  const ctx = {};

  for (const [id, fn] of Object.entries(allTests)) {
    if (onlyTests && !onlyTests.has(id)) continue;
    try {
      const result = await fn(ctx);
      ctx[id] = result;
      results.push(result);
      scriptConsole.log(`  ${result.passed ? 'PASS' : 'FAIL'} ${result.id} — ${result.name}`);
      if (!result.passed) {
        for (const issue of result.issues) scriptConsole.log(`    - ${issue}`);
      }
    } catch (err) {
      scriptConsole.error(`  ERROR in ${id}:`, err.message);
      results.push({
        id, name: id, passed: false,
        issues: [`Threw: ${err.message}`],
        checks: [], replyPreview: '', intent: null,
        eventTypes: [], eventSamples: [], logTail: [],
        observations: [`error: ${err.message}`],
      });
    }
  }

  await memoryAgent.drain();

  const passed  = results.filter(r => r.passed).length;
  const total   = results.length;
  const failed  = total - passed;

  scriptConsole.log('');
  scriptConsole.log(`=== ${passed}/${total} tests passed ===`);

  const report = {
    runId,
    startedAt: new Date().toISOString(),
    runtime: {
      primaryModel: runtime.primary.model,
      primaryEndpoint: runtime.primary.endpoint,
    },
    preflight: preflightResult,
    names: { saraName, jamesName, zarabanPrj, blueNbPrj, michaelName, saraDedup, saraEmail },
    results,
  };

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, buildMarkdown(report));
  scriptConsole.log(`Report JSON: ${jsonPath}`);
  scriptConsole.log(`Report MD:   ${mdPath}`);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  scriptConsole.error('[stress:p15:live] fatal:', err);
  process.exit(1);
});
