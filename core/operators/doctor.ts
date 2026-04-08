/**
 * /doctor operator — system health check and diagnostics
 */

import fs from 'node:fs';
import { getDb } from '../memory/index.js';
import { PATHS } from '../../config/agent.config.js';

export interface HealthCheck {
  databaseOK: boolean;
  memoryDirOK: boolean;
  workspaceDirOK: boolean;
  indexDirOK: boolean;
  entryCount: number;
  relationshipCount: number;
  recentErrors: string[];
}

export function runHealthCheck(): HealthCheck {
  const errors: string[] = [];
  let databaseOK = false;
  let entryCount = 0;
  let relationshipCount = 0;

  // Check database
  try {
    const db = getDb();
    const result = db.prepare('SELECT COUNT(*) as count FROM index_entries').get() as any;
    entryCount = result?.count || 0;
    const relResult = db.prepare('SELECT COUNT(*) as count FROM relationships').get() as any;
    relationshipCount = relResult?.count || 0;
    databaseOK = true;
  } catch (err) {
    databaseOK = false;
    errors.push(`Database error: ${String(err).slice(0, 50)}`);
  }

  // Check directories
  const memoryDirOK = fs.existsSync(PATHS.memory);
  const workspaceDirOK = fs.existsSync(PATHS.workspace);
  const indexDirOK = fs.existsSync(PATHS.index);

  if (!memoryDirOK) errors.push(`Memory directory missing: ${PATHS.memory}`);
  if (!workspaceDirOK) errors.push(`Workspace directory missing: ${PATHS.workspace}`);
  if (!indexDirOK) errors.push(`Index directory missing: ${PATHS.index}`);

  // Check for database file
  if (!fs.existsSync(PATHS.db)) {
    errors.push(`Database file missing: ${PATHS.db}`);
  }

  return {
    databaseOK,
    memoryDirOK,
    workspaceDirOK,
    indexDirOK,
    entryCount,
    relationshipCount,
    recentErrors: errors,
  };
}

export function formatHealthCheck(health: HealthCheck): string {
  const statusIcon = (ok: boolean) => ok ? '✓' : '✗';

  const lines: string[] = [
    '🏥 System Health Check',
    `Database: ${statusIcon(health.databaseOK)} (${health.entryCount} entries, ${health.relationshipCount} relationships)`,
    `Memory dir: ${statusIcon(health.memoryDirOK)}`,
    `Workspace dir: ${statusIcon(health.workspaceDirOK)}`,
    `Index dir: ${statusIcon(health.indexDirOK)}`,
  ];

  if (health.recentErrors.length > 0) {
    lines.push('⚠️  Issues found:');
    for (const error of health.recentErrors.slice(0, 5)) {
      lines.push(`  - ${error}`);
    }
  } else {
    lines.push('✨ All systems operational');
  }

  return lines.join('\n');
}
