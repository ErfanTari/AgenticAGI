/**
 * P1: PLAN.PJ — Project Brain
 * Manages persistent project-level brain entries.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import type { IndexEntry } from './types.js';
import { createEntry } from './write.js';
import { queryEntries, getDb } from './index.js';
import { fetchByCode } from './fetch.js';
import type Database from 'better-sqlite3';
import { localDateString } from '../utils/date.js';
import { transparency } from '../transparency.js';

export interface ProjectEntry {
  code: string;
  name: string;
  priority: number;
  vision: string;
  status: 'active' | 'review' | 'blocked' | 'past';
  current: string;
  next_action: string;
  blocked_by: string[];
  phase: string;
  last_worked: string;
  notes: string;
}

export function createProjectEntry(input: Omit<ProjectEntry, 'code'>): IndexEntry {
  fs.mkdirSync(PATHS.projects, { recursive: true });

  const body = `## Vision
${input.vision}

## Status
${input.status}

## Current
${input.current}

## Next Action
${input.next_action}

## Phase
${input.phase}

## Blocked By
${input.blocked_by.join(', ') || 'None'}

## Last Worked
${input.last_worked}

## Notes
${input.notes}
`;

  const entry = createEntry({
    nb: 'PLAN',
    type: 'PJ',
    name: input.name,
    status: input.status === 'past' ? 'archived' : 'active',
    summary: `Priority ${input.priority}: ${input.vision.slice(0, 80)}`,
    body,
  });

  // Also write a human-readable workspace overview file
  const sanitized = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const overviewPath = path.join(PATHS.projects, `${entry.code}_${sanitized}.md`);
  const overview = `# ${input.name} — Project Overview

**Code:** ${entry.code}
**Priority:** ${input.priority}
**Status:** ${input.status}
**Phase:** ${input.phase}
**Last Worked:** ${input.last_worked}

## Vision
${input.vision}

## Current Focus
${input.current}

## Next Action
${input.next_action}

## Blocked By
${input.blocked_by.join(', ') || 'None'}

## Notes
${input.notes}
`;

  try {
    fs.writeFileSync(overviewPath, overview, 'utf-8');
  } catch (err) {
    console.warn('[project] Failed to write workspace overview:', err);
  }

  return entry;
}

export function getActiveProjects(): ProjectEntry[] {
  const entries = queryEntries({ nb: 'PLAN', type: 'PJ', status: 'active' });
  const projects: ProjectEntry[] = [];

  for (const entry of entries) {
    const fetched = fetchByCode(entry.code);
    if (fetched) {
      const parsed = parseProjectEntry(fetched.content);
      if (parsed) {
        projects.push({ ...parsed, code: entry.code });
      }
    }
  }

  return projects;
}

export function updateProjectEntry(code: string, updates: Partial<ProjectEntry>): void {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM index_entries WHERE code = ?').get(code) as { path: string } | undefined;
  if (!existing) throw new Error(`Project entry not found: ${code}`);

  const now = localDateString();

  if (updates.status) {
    const dbStatus = updates.status === 'past' ? 'archived' : 'active';
    db.prepare('UPDATE index_entries SET status = ?, updated = ? WHERE code = ?')
      .run(dbStatus, now, code);
  }

  // Update markdown file
  if (existing.path && fs.existsSync(existing.path)) {
    let content = fs.readFileSync(existing.path, 'utf-8');

    if (updates.status) {
      content = content.replace(/^## Status\n.+$/m, `## Status\n${updates.status}`);
    }
    if (updates.current !== undefined) {
      // Replace the Current section content
      content = content.replace(
        /(## Current\n)([\s\S]*?)(\n## )/,
        `$1${updates.current}\n$3`
      );
    }
    if (updates.next_action !== undefined) {
      content = content.replace(
        /(## Next Action\n)([\s\S]*?)(\n## )/,
        `$1${updates.next_action}\n$3`
      );
    }
    if (updates.last_worked !== undefined) {
      content = content.replace(
        /(## Last Worked\n)([\s\S]*?)(\n## )/,
        `$1${updates.last_worked}\n$3`
      );
    }
    if (updates.notes !== undefined) {
      content = content.replace(
        /(## Notes\n)([\s\S]*)$/,
        `$1${updates.notes}\n`
      );
    }

    content = content.replace(/^updated: .+$/m, `updated: ${now}`);
    try {
      fs.writeFileSync(existing.path, content, 'utf-8');
    } catch (err) {
      console.warn('[project] Failed to update project file:', err);
    }
  }

  // FIX-C5: Invalidate project brain cache after update
  invalidateProjectBrain(code, db);
}

export function parseProjectEntry(content: string): ProjectEntry | null {
  try {
    // Extract frontmatter
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
    const code = fmMatch?.[1]?.match(/^code: (.+)$/m)?.[1]?.trim() ?? '';
    const name = fmMatch?.[1]?.match(/^name: (.+)$/m)?.[1]?.trim() ?? '';
    const summaryLine = fmMatch?.[1]?.match(/^summary: (.+)$/m)?.[1]?.trim() ?? '';

    // Parse sections
    const visionMatch = content.match(/## Vision\n([\s\S]*?)(?=\n## )/);
    const statusMatch = content.match(/## Status\n(.+)/);
    const currentMatch = content.match(/## Current\n([\s\S]*?)(?=\n## )/);
    const nextMatch = content.match(/## Next Action\n([\s\S]*?)(?=\n## )/);
    const phaseMatch = content.match(/## Phase\n(.+)/);
    const blockedMatch = content.match(/## Blocked By\n(.+)/);
    const lastWorkedMatch = content.match(/## Last Worked\n(.+)/);
    const notesMatch = content.match(/## Notes\n([\s\S]*)$/);

    const priorityMatch = summaryLine.match(/^Priority (\d+)/);

    const statusStr = statusMatch?.[1]?.trim() ?? 'active';
    const validStatus = (['active', 'review', 'blocked', 'past'] as const).includes(statusStr as ProjectEntry['status'])
      ? (statusStr as ProjectEntry['status'])
      : 'active';

    const blockedByStr = blockedMatch?.[1]?.trim() ?? 'None';

    return {
      code,
      name,
      priority: parseInt(priorityMatch?.[1] ?? '5'),
      vision: visionMatch?.[1]?.trim() ?? '',
      status: validStatus,
      current: currentMatch?.[1]?.trim() ?? '',
      next_action: nextMatch?.[1]?.trim() ?? '',
      blocked_by: blockedByStr === 'None' ? [] : blockedByStr.split(',').map(s => s.trim()),
      phase: phaseMatch?.[1]?.trim() ?? '',
      last_worked: lastWorkedMatch?.[1]?.trim() ?? '',
      notes: notesMatch?.[1]?.trim() ?? '',
    };
  } catch {
    return null;
  }
}

// --- Phase 15: Project Brain Cache ---

const MAX_BRAIN_TOKENS = 1500;

/**
 * Returns a materialized project brain summary for the given project code.
 * Checks `project_brain_cache` column first. If null, builds and caches it.
 * Target: fits in 1500 tokens (approximately 6000 characters).
 */
export async function getProjectBrain(
  projectCode: string,
  db: Database.Database,
): Promise<string> {
  // Check cache column
  try {
    const row = db.prepare(
      'SELECT project_brain_cache FROM index_entries WHERE code = ?'
    ).get(projectCode) as { project_brain_cache?: string | null } | undefined;

    if (row?.project_brain_cache) {
      // FIX-H3: Emit project_brain_hit transparency event
      transparency.emit({ type: 'project_brain_hit', data: { projectCode } });
      return row.project_brain_cache;
    }
  } catch {
    // Column may not exist yet — will be added by migration
  }

  // FIX-H3: Emit project_brain_miss + project_brain_rebuilt transparency events
  transparency.emit({ type: 'project_brain_miss', data: { projectCode } });

  // Build brain from file
  const brain = buildProjectBrain(projectCode, db);

  transparency.emit({ type: 'project_brain_rebuilt', data: { projectCode } });

  // Cache it (best-effort)
  try {
    db.prepare(
      'UPDATE index_entries SET project_brain_cache = ? WHERE code = ?'
    ).run(brain, projectCode);
  } catch {
    // Cache write is best-effort
  }

  return brain;
}

function buildProjectBrain(projectCode: string, db: Database.Database): string {
  // Fetch the main project entry
  const entry = db.prepare('SELECT * FROM index_entries WHERE code = ?')
    .get(projectCode) as { name: string; summary: string; path: string } | undefined;

  if (!entry) return `Project ${projectCode} not found.`;

  const lines: string[] = [
    `# Project Brain: ${entry.name}`,
    `Code: ${projectCode}`,
    `Summary: ${entry.summary ?? ''}`,
    '',
  ];

  // Add file content (truncated to ~4000 chars / ~1000 tokens)
  try {
    if (entry.path && fs.existsSync(entry.path)) {
      const content = fs.readFileSync(entry.path, 'utf-8');
      // Strip frontmatter
      const bodyStart = content.indexOf('\n---\n');
      const body = bodyStart >= 0 ? content.slice(bodyStart + 5) : content;
      const truncated = body.slice(0, 4000);
      lines.push(truncated);
    }
  } catch { /* best-effort */ }

  // Find related entries (relationships)
  try {
    const related = db.prepare(`
      SELECT ie.code, ie.name, ie.summary, r.relation
      FROM relationships r
      JOIN index_entries ie ON ie.code = r.to_code
      WHERE r.from_code = ?
      LIMIT 10
    `).all(projectCode) as Array<{ code: string; name: string; summary: string; relation: string }>;

    if (related.length > 0) {
      lines.push('', '## Related Entries');
      for (const rel of related) {
        lines.push(`- [${rel.relation}] ${rel.code}: ${rel.name} — ${rel.summary ?? ''}`);
      }
    }
  } catch { /* best-effort */ }

  return lines.join('\n').slice(0, MAX_BRAIN_TOKENS * 4); // ~1500 tokens cap
}

/**
 * Invalidates the project brain cache for the given project code.
 * Called whenever any entry linked to the project is written.
 */
export function invalidateProjectBrain(
  projectCode: string,
  db: Database.Database,
): void {
  try {
    db.prepare(
      'UPDATE index_entries SET project_brain_cache = NULL WHERE code = ?'
    ).run(projectCode);
    // FIX-H3: Emit project_brain_invalidated transparency event
    transparency.emit({ type: 'project_brain_invalidated', data: { projectCode } });
  } catch {
    // Non-fatal — cache invalidation is best-effort
  }
}
