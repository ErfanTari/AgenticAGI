import type { IndexEntry } from './memory/types.js';
import { getDb } from './memory/index.js';
import { createEntry, updateEntry } from './memory/write.js';
import { isProcessingMessage } from './agent.js';

export interface Notification {
  type: 'upcoming_event' | 'overdue_todo' | 'overdue_plan' | 'stale_question' | 'stale_plan' | 'stale_project' | 'vision_alignment';
  entries: IndexEntry[];
  message: string;
}

export interface HeartbeatResult {
  ran_at: string;
  notifications: Notification[];
  created: IndexEntry[];
}

// --- FIX 1: Timer ---

let timer: NodeJS.Timeout | null = null;

export function startHeartbeat(): void {
  if (timer) return; // prevent duplicate timers
  timer = setInterval(runHeartbeatSafe, 1800000);
}

export function stopHeartbeat(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

async function runHeartbeatSafe(): Promise<void> {
  if (isProcessingMessage) return; // idle check
  try { await runHeartbeat(); }
  catch (e) { console.error('[heartbeat] cycle failed:', e); }
}

// --- Helpers ---

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function queryStale(nb: string, type: string, status: string, cutoff: string): IndexEntry[] {
  const d = getDb();
  return d.prepare(
    'SELECT * FROM index_entries WHERE nb = ? AND type = ? AND status = ? AND updated < ?'
  ).all(nb, type, status, cutoff) as IndexEntry[];
}

// --- Individual checks ---

export function checkDeadlines(): Notification | null {
  // FIX 4: Only flag deadlines within the 24h window [today, tomorrow]
  const todayStr = new Date().toISOString().split('T')[0];
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  const d = getDb();
  const entries = d.prepare(
    'SELECT * FROM index_entries WHERE nb = ? AND status = ? AND due_date >= ? AND due_date <= ?'
  ).all('WHEN', 'upcoming', todayStr, tomorrowStr) as IndexEntry[];

  if (entries.length === 0) return null;
  return {
    type: 'upcoming_event',
    entries,
    message: `${entries.length} upcoming event(s) need attention`,
  };
}

export function checkOverdueTodos(): Notification | null {
  const todayStr = new Date().toISOString().split('T')[0];
  const d = getDb();
  const entries = d.prepare(
    'SELECT * FROM index_entries WHERE nb = ? AND type = ? AND status = ? AND due_date < ?'
  ).all('NOW', 'TD', 'open', todayStr) as IndexEntry[];

  if (entries.length === 0) return null;

  for (const entry of entries) {
    updateEntry(entry.code, { status: 'overdue' });
  }

  return {
    type: 'overdue_todo',
    entries,
    message: `${entries.length} todo(s) overdue — status updated`,
  };
}

export function checkOverduePlans(): Notification | null {
  const todayStr = new Date().toISOString().split('T')[0];
  const d = getDb();
  const entries = d.prepare(
    'SELECT * FROM index_entries WHERE nb = ? AND type = ? AND status = ? AND due_date < ?'
  ).all('PLAN', 'PL', 'active', todayStr) as IndexEntry[];

  if (entries.length === 0) return null;

  return {
    type: 'overdue_plan',
    entries,
    message: `${entries.length} plan entry/entries overdue`,
  };
}

export function checkStaleQuestions(): Notification | null {
  const cutoff = daysAgo(3);
  const entries = queryStale('WHY', 'QU', 'open', cutoff);

  if (entries.length === 0) return null;
  return {
    type: 'stale_question',
    entries,
    message: `${entries.length} open question(s) unanswered for 3+ days`,
  };
}

export function checkPlanCalibration(): Notification | null {
  const cutoff = daysAgo(7);
  const entries = queryStale('PLAN', 'PL', 'active', cutoff);

  if (entries.length === 0) return null;
  return {
    type: 'stale_plan',
    entries,
    message: `${entries.length} planning entry/entries stale for 7+ days`,
  };
}

export function checkStaleProjects(): Notification | null {
  const cutoff = daysAgo(7);
  const entries = queryStale('WHAT', 'PJ', 'active', cutoff);

  if (entries.length === 0) return null;
  return {
    type: 'stale_project',
    entries,
    message: `${entries.length} active project(s) with no update in 7+ days`,
  };
}

export function checkVisionAlignment(): Notification | null {
  const d = getDb();
  const northStar = d.prepare(
    "SELECT * FROM index_entries WHERE nb = 'WHY' AND type = 'MT' AND name = 'North Star' AND status = 'active' ORDER BY updated DESC LIMIT 1"
  ).get() as IndexEntry | undefined;

  if (!northStar) return null;

  const activeProjects = d.prepare(
    "SELECT * FROM index_entries WHERE nb = 'WHAT' AND type = 'PJ' AND status = 'active'"
  ).all() as IndexEntry[];

  if (activeProjects.length === 0) return null;

  const linkedStmt = d.prepare(`
    SELECT 1
    FROM relationships
    WHERE (from_code = ? AND to_code = ?)
       OR (from_code = ? AND to_code = ?)
    LIMIT 1
  `);

  const unlinked = activeProjects.filter(project => {
    const linked = linkedStmt.get(project.code, northStar.code, northStar.code, project.code);
    return !linked;
  });

  if (unlinked.length === 0) return null;

  const questions = unlinked
    .map(project => `Project '${project.name}' has no stated connection to your vision. Still relevant?`)
    .join('\n');

  return {
    type: 'vision_alignment',
    entries: unlinked,
    message: questions,
  };
}

// --- Main heartbeat ---

export async function runHeartbeat(): Promise<HeartbeatResult> {
  const ran_at = today();
  const notifications: Notification[] = [];

  // FIX 2: Per-check error isolation — one check failing must NEVER stop other checks
  const checks = [
    checkDeadlines,
    checkOverdueTodos,
    checkOverduePlans,
    checkStaleQuestions,
    checkPlanCalibration,
    checkStaleProjects,
    checkVisionAlignment,
  ];

  for (const check of checks) {
    try {
      const result = await check();
      if (result) notifications.push(result);
    } catch (e) {
      console.error(`[heartbeat] check failed:`, e);
    }
  }

  const created: IndexEntry[] = [];

  if (notifications.length > 0) {
    const d = getDb();
    const insertQueue = d.prepare(
      'INSERT INTO heartbeat_queue (code, message, seen, created) VALUES (?, ?, 0, ?)'
    );

    for (const notification of notifications) {
      const body = `## Findings\n\n- **${notification.type}**: ${notification.message}\n\n## Details\n\n` +
        notification.entries.map(e => `- ${e.code} — ${e.name} (${e.status})`).join('\n');

      const entry = createEntry({
        nb: 'WHY',
        type: 'MT',
        name: `Heartbeat ${ran_at} — ${notification.type}`,
        status: 'active',
        summary: notification.message,
        body,
      });

      created.push(entry);
      insertQueue.run(entry.code, notification.message, ran_at);
    }
  }

  return { ran_at, notifications, created };
}
