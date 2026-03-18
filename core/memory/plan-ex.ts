/**
 * P2: PLAN.EX — Execution state tracking for multi-step plans.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createEntry } from './write.js';
import { getDb } from './index.js';
import { fetchByCode } from './fetch.js';
import { transparency } from '../transparency.js';
import type { IndexEntry } from './types.js';
import { localDateString } from '../utils/date.js';
import { sessionCache } from './session-cache.js';

export type PlanEXStatus = 'active' | 'in_progress' | 'paused' | 'complete' | 'failed';

export interface Milestone {
  id: string;
  name: string;
  done: boolean;
}

export interface Todo {
  id: string;
  text: string;
  done: boolean;
}

export interface PlanEXEntry {
  code: string;
  status?: PlanEXStatus;
  abort_reason?: string;
  task_name: string;
  project_code: string;
  goal: string;
  goal_ids?: string[];
  unit_ids?: string[];
  milestones: Milestone[];
  current_milestone: number;
  next_milestone_id?: string | null;
  completed_milestone_ids?: string[];
  todos: Todo[];
  constraints: Record<string, boolean>;
  last_action: string;
  next_action: string;
  conf_score: number;
  session_id: string;
  checkpoint_ts: string;
  started: string;
  attempt_counts: Record<string, number>;
  last_failures: Record<string, string>;
  recent_turns: string[];
  loaded_memory_utility: Record<string, number>;
  file_checksums: Record<string, string>;
  revisions?: Array<{ ts: string; reason: string; milestone_ids: string[] }>;
  linked_codes?: string[];
}

export function createPlanEX(input: Omit<PlanEXEntry, 'code'>): string {
  const body = JSON.stringify(input, null, 2);
  const status = input.status ?? 'active';

  const entry = createEntry({
    nb: 'PLAN',
    type: 'EX',
    name: input.task_name,
    status,
    summary: `Execution state for: ${input.goal.slice(0, 80)}`,
    body,
  });

  return entry.code;
}

export function updatePlanEX(code: string, updates: Partial<PlanEXEntry>): void {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM index_entries WHERE code = ?')
    .get(code) as IndexEntry | undefined;

  if (!existing) throw new Error(`PlanEX entry not found: ${code}`);

  // Read existing body and merge
  const fetched = fetchByCode(code);
  let currentData: Partial<PlanEXEntry> = {};

  if (fetched?.content) {
    const bodyMatch = fetched.content.match(/^---\n[\s\S]*?\n---\n\n# [\s\S]*?\n\n([\s\S]*)$/);
    if (bodyMatch?.[1]) {
      try {
        currentData = JSON.parse(bodyMatch[1]);
      } catch { /* ignore parse errors */ }
    }
  }

  const status = updates.status ?? currentData.status ?? (existing.status as PlanEXStatus) ?? 'active';
  const merged: Partial<PlanEXEntry> = { ...currentData, ...updates, status };
  const body = JSON.stringify(merged, null, 2);
  const now = localDateString();

  db.prepare('UPDATE index_entries SET updated = ?, status = ? WHERE code = ?').run(now, status, code);

  if (existing.path && fs.existsSync(existing.path)) {
    const md = fs.readFileSync(existing.path, 'utf-8');
    const headerEnd = md.indexOf('\n---\n');
    if (headerEnd >= 0) {
      const header = md.slice(0, headerEnd + 5)
        .replace(/^status: .+$/m, `status: ${status}`)
        .replace(/^updated: .+$/m, `updated: ${now}`);
      const newMd = header + '\n# ' + existing.name + '\n\n' + body + '\n';
      try {
        fs.writeFileSync(existing.path, newMd, 'utf-8');
      } catch (err) {
        console.warn('[plan-ex] Failed to update file:', err);
      }
    }
  }

  // FIX-C5: Invalidate session cache so getEntryByCode returns fresh data
  sessionCache.set(code, { ...existing, status, updated: now } as IndexEntry);
}

export function loadActivePlanEX(): PlanEXEntry | null {
  const db = getDb();

  // FIX-4: Auto-close stale PLAN.EX entries older than 24 hours
  try {
    const staleEntries = db.prepare(`
      SELECT code FROM index_entries
      WHERE type = 'EX'
        AND status IN ('active', 'in_progress')
        AND datetime(updated) < datetime('now', '-24 hours')
    `).all() as { code: string }[];
    for (const stale of staleEntries) {
      try {
        db.prepare(`
          UPDATE index_entries
          SET status = 'failed',
              summary = summary || ' [auto-closed: exceeded 24h active window]'
          WHERE code = ?
        `).run(stale.code);
        // Also update the markdown file frontmatter
        const existing = db.prepare('SELECT * FROM index_entries WHERE code = ?').get(stale.code) as IndexEntry | undefined;
        if (existing?.path && fs.existsSync(existing.path)) {
          const md = fs.readFileSync(existing.path, 'utf-8');
          const headerEnd = md.indexOf('\n---\n');
          if (headerEnd >= 0) {
            const now = localDateString();
            const header = md.slice(0, headerEnd + 5)
              .replace(/^status: .+$/m, 'status: failed')
              .replace(/^updated: .+$/m, `updated: ${now}`);
            const rest = md.slice(headerEnd + 5);
            fs.writeFileSync(existing.path, header + rest, 'utf-8');
          }
        }
      } catch { /* non-fatal per entry */ }
    }
  } catch { /* cleanup is best-effort */ }

  const entries = db.prepare(
    "SELECT * FROM index_entries WHERE nb = 'PLAN' AND type = 'EX' AND status IN ('active', 'in_progress', 'paused')",
  ).all() as IndexEntry[];
  if (entries.length === 0) return null;

  if (entries.length > 1) {
    console.warn(`[plan-ex] WARNING: ${entries.length} active PLAN.EX entries found — expected at most 1`);
    transparency.emit({
      type: 'error',
      data: {
        source: 'plan-ex',
        error: `Multiple active PLAN.EX entries (${entries.length}) — returning most recent by checkpoint_ts`,
      },
    });
  }

  // Sort by checkpoint_ts DESC by reading the file data
  const withCheckpoint = entries.map(e => {
    const fetched = fetchByCode(e.code);
    let checkpoint_ts = e.updated;
    if (fetched?.content) {
      const bodyMatch = fetched.content.match(/^---\n[\s\S]*?\n---\n\n# [\s\S]*?\n\n([\s\S]*)$/);
      if (bodyMatch?.[1]) {
        try {
          const data = JSON.parse(bodyMatch[1]);
          if (data.checkpoint_ts) checkpoint_ts = data.checkpoint_ts;
        } catch { /* ignore */ }
      }
    }
    return { entry: e, checkpoint_ts };
  });
  withCheckpoint.sort((a, b) => b.checkpoint_ts.localeCompare(a.checkpoint_ts));

  const entry = withCheckpoint[0].entry;
  const fetched = fetchByCode(entry.code);

  if (!fetched?.content) return null;

  const bodyMatch = fetched.content.match(/^---\n[\s\S]*?\n---\n\n# [\s\S]*?\n\n([\s\S]*)$/);
  if (!bodyMatch?.[1]) return null;

  try {
    const data = JSON.parse(bodyMatch[1]);
    return { ...data, code: entry.code } as PlanEXEntry;
  } catch {
    return null;
  }
}

export function savePlanEX(entry: PlanEXEntry): void {
  if (entry.code) {
    // Verify the code exists in DB before updating
    const db = getDb();
    const existing = db.prepare('SELECT code FROM index_entries WHERE code = ?').get(entry.code);
    if (existing) {
      updatePlanEX(entry.code, entry);
      return;
    }
  }
  // No code or code not found — check if a PLAN.EX with this task_name already exists
  const db = getDb();
  const existingByName = db.prepare(
    "SELECT code FROM index_entries WHERE nb = 'PLAN' AND type = 'EX' AND name = ? LIMIT 1"
  ).get(entry.task_name) as { code: string } | undefined;
  if (existingByName) {
    updatePlanEX(existingByName.code, entry);
  } else {
    createPlanEX(entry);
  }
}

/**
 * Validate file checksums — returns list of changed/missing files.
 */
export function validateChecksums(checksums: Record<string, string>): string[] {
  const changed: string[] = [];

  for (const [filePath, expectedHash] of Object.entries(checksums)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const actualHash = createHash('sha256').update(content).digest('hex');
      if (actualHash !== expectedHash) {
        changed.push(filePath);
      }
    } catch {
      changed.push(filePath); // missing file = changed
    }
  }

  return changed;
}
