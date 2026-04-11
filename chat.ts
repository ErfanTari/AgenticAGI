import readline from 'node:readline';
import { validateConfig } from './core/config.js';
import { initDatabase } from './core/memory/mod.js';
import { processMessage, startAgent, stopAgent } from './core/agent.js';
import { sanitizeForHistory } from './core/decomposition.js';
import { transparency } from './core/transparency.js';
import { attachConsoleRenderer } from './core/transparency-renderer.js';
import { currentSession } from './core/session/session-log.js';
import { getCostReport, formatCostReport } from './core/operators/cost.js';
import { getTokenStats } from './core/token-counter.js';
import { runHealthCheck, formatHealthCheck } from './core/operators/doctor.js';
import { captureContextSnapshot, formatContextSnapshot } from './core/operators/context.js';
import { runStartupPrefetch, getPointerIndexCache } from './core/startup/prefetch.js';
import { selectResumablePlan, formatResumePrompt } from './core/operators/resume.js';
import type { Message } from './core/types.js';

// Initialize transparency bus based on environment
const TRANSPARENT = process.env.TRANSPARENT === 'true';
const DEBUG_PLANNER = process.env.DEBUG_PLANNER === 'true';
const DEBUG_DEEP = process.env.DEBUG_DEEP === 'true';

if (TRANSPARENT || DEBUG_DEEP) {
  transparency.enable();
  attachConsoleRenderer();
} else if (DEBUG_PLANNER) {
  transparency.enable();
  attachConsoleRenderer(['intent', 'complexity', 'plan', 'step_start', 'step_result', 'memory_write']);
}

// Validate required config on startup
validateConfig();

// Initialize
initDatabase();
startAgent();

// Startup prefetch: load pointer index and first 20 entries in parallel
let promptStarted = false;

const prefetchPromise = runStartupPrefetch().then(async (result) => {
  if (result.pointerIndexLoaded) {
    console.log(`  Loaded pointer index (${result.pointerEntryCount} entries)`);
  }
  if (result.entriesPrefetched > 0) {
    console.log(`  Prefetched ${result.entriesPrefetched} memory entries (${result.prefetchTimeMs}ms)`);
  }

  // Print ready message after prefetch completes
  console.log('Agent ready. Type a message and press Enter. Type "quit" to exit.');
  console.log('Operators: /cost (session usage), /doctor (health check), /context (memory snapshot), /resume (resume plans), /tokens (token usage)\n');

  // Check for active execution plans after prefetch
  await checkActivePlan();

  // Start prompt if not already started (defensive guard)
  if (!promptStarted) {
    promptStarted = true;
    prompt();
  }
}).catch(async (err) => {
  console.warn(`  Startup prefetch failed: ${String(err).slice(0, 50)}`);

  // Print ready message even on prefetch failure
  console.log('Agent ready. Type a message and press Enter. Type "quit" to exit.');
  console.log('Operators: /cost (session usage), /doctor (health check), /context (memory snapshot), /resume (resume plans), /tokens (token usage)\n');

  // Check for active execution plans even on prefetch failure
  await checkActivePlan();

  // Start prompt if not already started (defensive guard)
  if (!promptStarted) {
    promptStarted = true;
    prompt();
  }
});

const history: Message[] = [];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Check for active PLAN.EX on startup — surface resumable execution plans
async function checkActivePlan() {
  try {
    const { loadActivePlanEX } = await import('./core/memory/plan-ex.js');
    const activePlan = loadActivePlanEX();
    if (activePlan) {
      const milestone = activePlan.milestones?.[activePlan.current_milestone];
      const milestoneName = milestone?.name ?? activePlan.next_action ?? 'pending milestone';
      const statusLine = activePlan.status === 'paused'
        ? `Paused: ${activePlan.abort_reason ?? milestoneName}`
        : `In progress: ${milestoneName}`;
      console.log(`📋 Active execution plan found: "${activePlan.task_name}"\n   ${statusLine}\n   Continue? (just say "continue" or proceed with other work)\n`);

      // Load associated working memory if a project code is available
      try {
        const { loadWorkingMemory } = await import('./core/memory/working-memory.js');
        const wm = activePlan.project_code
          ? await loadWorkingMemory(activePlan.project_code)
          : null;
        if (wm) {
          const lastStep = wm.stepLog.at(-1);
          const lastStepSummary = lastStep ? `Last step: ${lastStep.summary}` : '';
          console.log(`   Resuming from: ${wm.goal}${lastStepSummary ? `\n   ${lastStepSummary}` : ''}\n`);
        }
      } catch { /* working memory load is advisory */ }
    }
  } catch { /* startup check is advisory */ }
}

function prompt() {
  rl.question('you > ', async (input) => {
    const trimmed = input.trim();
    if (!trimmed) return prompt();
    if (trimmed === 'quit' || trimmed === 'exit') {
      stopAgent();
      rl.close();
      process.exit(0);
    }

    // Handle operator commands
    if (trimmed === '/cost') {
      try {
        const report = getCostReport();
        console.log(`\nagent > ${formatCostReport(report)}`);
      } catch (err) {
        console.log(`\nagent > Error generating cost report: ${String(err).slice(0, 100)}`);
      }
      return prompt();
    }

    if (trimmed === '/doctor') {
      try {
        const health = runHealthCheck();
        console.log(`\nagent > ${formatHealthCheck(health)}`);
      } catch (err) {
        console.log(`\nagent > Error running health check: ${String(err).slice(0, 100)}`);
      }
      return prompt();
    }

    if (trimmed === '/context') {
      try {
        const snapshot = captureContextSnapshot();
        console.log(`\nagent > ${formatContextSnapshot(snapshot)}`);
      } catch (err) {
        console.log(`\nagent > Error capturing context: ${String(err).slice(0, 100)}`);
      }
      return prompt();
    }

    if (trimmed === '/tokens') {
      const stats = getTokenStats();
      const fmt = (n: number) => n.toLocaleString();
      console.log(`\nagent > Session tokens — Input: ${fmt(stats.inputTokens)} | Output: ${fmt(stats.outputTokens)} | Calls: ${stats.callCount} | ~$${stats.estimatedCostUSD.toFixed(4)}`);
      return prompt();
    }

    if (trimmed === '/resume') {
      try {
        const result = selectResumablePlan();
        console.log(`\nagent > ${formatResumePrompt(result)}`);
      } catch (err) {
        console.log(`\nagent > Error finding resumable plans: ${String(err).slice(0, 100)}`);
      }
      return prompt();
    }

    // Handle /resume plan-code or /resume plan-name for specific plan
    if (trimmed.startsWith('/resume ')) {
      try {
        const planRef = trimmed.slice(8).trim();
        const result = selectResumablePlan(planRef);
        console.log(`\nagent > ${formatResumePrompt(result)}`);
      } catch (err) {
        console.log(`\nagent > Error finding plan: ${String(err).slice(0, 100)}`);
      }
      return prompt();
    }

    try {
      // Log user input to session JSONL
      currentSession().append({ role: 'user', content: trimmed, ts: new Date().toISOString() });

      const res = await processMessage(trimmed, history);

      // Log assistant response to session JSONL
      currentSession().append({ role: 'assistant', content: res.reply, ts: new Date().toISOString() });

      // Keep conversation history (last 6 turns)
      history.push({ role: 'user', content: trimmed });
      // Sanitize before storing — Gemma 4 thinking tags MUST NOT enter history
      history.push({ role: 'assistant', content: sanitizeForHistory(res.reply) });
      if (history.length > 12) history.splice(0, 2);

      console.log(`\nagent > ${res.reply}`);
      if (res.intent !== 'greeting') {
        const meta = [`intent=${res.intent}`];
        if (res.created) meta.push(`created=${res.created.code}`);
        if (res.retries) meta.push(`retries=${res.retries}`);
        if (res.resolved) meta.push(`step=${res.resolved.step}, entries=${res.resolved.entries.length}`);
        console.log(`       [${meta.join(', ')}]`);
      }
      console.log();
    } catch (err) {
      console.error(`\nerror > ${err}\n`);
    }

    prompt();
  });
}

// Print token stats on clean exit
process.on('SIGINT', () => {
  const stats = getTokenStats();
  if (stats.callCount > 0) {
    const fmt = (n: number) => n.toLocaleString();
    console.log(`\nSession tokens — Input: ${fmt(stats.inputTokens)} | Output: ${fmt(stats.outputTokens)} | Calls: ${stats.callCount} | ~$${stats.estimatedCostUSD.toFixed(4)}`);
  }
  stopAgent();
  process.exit(0);
});
