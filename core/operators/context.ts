/**
 * /context operator — show current memory context and relevant entries
 */

import { getDb } from '../memory/index.js';

export interface ContextSnapshot {
  activeSessions: number;
  totalEntries: number;
  entriesByNotebook: Record<string, number>;
  recentEntries: Array<{ code: string; name: string; updated: string; status: string }>;
}

export function captureContextSnapshot(): ContextSnapshot {
  const db = getDb();

  // Count total entries
  const totalResult = db.prepare('SELECT COUNT(*) as count FROM index_entries').get() as any;
  const totalEntries = totalResult?.count || 0;

  // Count entries by notebook
  const notebookRows = db.prepare(
    `SELECT nb, COUNT(*) as count FROM index_entries
     WHERE status != 'archived'
     GROUP BY nb ORDER BY nb`
  ).all() as Array<{ nb: string; count: number }>;

  const entriesByNotebook: Record<string, number> = {};
  for (const row of notebookRows) {
    entriesByNotebook[row.nb] = row.count;
  }

  // Get recent entries
  const recentRows = db.prepare(
    `SELECT code, name, updated, status FROM index_entries
     WHERE status != 'archived'
     ORDER BY updated DESC
     LIMIT 5`
  ).all() as Array<{ code: string; name: string; updated: string; status: string }>;

  // Count active sessions (rough estimate via workspace)
  // In a real implementation, this could track active PLAN.EX entries
  const planExCount = db.prepare(
    `SELECT COUNT(*) as count FROM index_entries
     WHERE nb='PLAN' AND type='EX' AND status IN ('active', 'in_progress')`
  ).get() as any;
  const activeSessions = planExCount?.count || 0;

  return {
    activeSessions,
    totalEntries,
    entriesByNotebook,
    recentEntries: recentRows,
  };
}

export function formatContextSnapshot(snapshot: ContextSnapshot): string {
  const lines: string[] = [
    '🧠 Memory Context Snapshot',
    `Total entries: ${snapshot.totalEntries}`,
    `Active sessions: ${snapshot.activeSessions}`,
    '',
    'Entries by notebook:',
  ];

  const notebookNames: Record<string, string> = {
    WHO: 'Contacts & People',
    WHAT: 'Projects & Knowledge',
    WHEN: 'Calendar & Events',
    HOW: 'Procedures & Skills',
    WHY: 'Reflections & Questions',
    NOW: 'Todos & Logs',
    PLAN: 'Planning & Execution',
  };

  for (const [nb, count] of Object.entries(snapshot.entriesByNotebook)) {
    const name = notebookNames[nb] || nb;
    lines.push(`  ${nb}: ${count} entries — ${name}`);
  }

  if (snapshot.recentEntries.length > 0) {
    lines.push('', 'Recently updated:');
    for (const entry of snapshot.recentEntries) {
      const date = entry.updated.split('T')[0];
      lines.push(`  ${entry.code}: ${entry.name} (${date})`);
    }
  }

  return lines.join('\n');
}
