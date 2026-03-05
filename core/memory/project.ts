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

  const now = new Date().toISOString().slice(0, 10);

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
