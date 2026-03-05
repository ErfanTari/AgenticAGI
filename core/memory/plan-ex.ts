/**
 * P2: PLAN.EX — Execution state tracking for multi-step plans.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createEntry } from './write.js';
import { queryEntries, getDb } from './index.js';
import { fetchByCode } from './fetch.js';
import type { IndexEntry } from './types.js';

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
  task_name: string;
  project_code: string;
  goal: string;
  milestones: Milestone[];
  current_milestone: number;
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
}

export function createPlanEX(input: Omit<PlanEXEntry, 'code'>): string {
  const body = JSON.stringify(input, null, 2);

  const entry = createEntry({
    nb: 'PLAN',
    type: 'EX',
    name: input.task_name,
    status: 'active',
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

  const merged: Partial<PlanEXEntry> = { ...currentData, ...updates };
  const body = JSON.stringify(merged, null, 2);
  const now = new Date().toISOString().slice(0, 10);

  db.prepare('UPDATE index_entries SET updated = ? WHERE code = ?').run(now, code);

  if (existing.path && fs.existsSync(existing.path)) {
    const md = fs.readFileSync(existing.path, 'utf-8');
    const headerEnd = md.indexOf('\n---\n');
    if (headerEnd >= 0) {
      const header = md.slice(0, headerEnd + 5);
      const newMd = header + '\n# ' + existing.name + '\n\n' + body + '\n';
      try {
        fs.writeFileSync(existing.path, newMd, 'utf-8');
      } catch (err) {
        console.warn('[plan-ex] Failed to update file:', err);
      }
    }
  }
}

export function loadActivePlanEX(): PlanEXEntry | null {
  const entries = queryEntries({ nb: 'PLAN', type: 'EX', status: 'active' });
  if (entries.length === 0) return null;

  // Return most recently updated
  const sorted = entries.sort((a, b) => b.updated.localeCompare(a.updated));
  const entry = sorted[0];
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
    updatePlanEX(entry.code, entry);
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
