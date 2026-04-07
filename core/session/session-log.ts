/**
 * Session JSONL Persistence
 *
 * Logs conversation turns to a JSONL file for audit trail, debugging, and future replay.
 * Implements automatic rotation (256KB max) and fire-and-forget semantics (never throws).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const SESSION_DIR = path.join(os.homedir(), '.zaraban', 'sessions');
const MAX_FILE_SIZE = 256 * 1024; // 256 KB
const MAX_ROTATIONS = 3;

export interface SessionTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: string; // ISO timestamp
}

function getSessionFilePath(sessionId: string): string {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const date = new Date().toISOString().split('T')[0];
  return path.join(SESSION_DIR, `${date}_${sessionId}.jsonl`);
}

function rotateIfNeeded(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < MAX_FILE_SIZE) return;

    // Shift existing rotations
    for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
      const old = `${filePath}.${i}`;
      const newer = `${filePath}.${i + 1}`;
      if (fs.existsSync(old)) {
        if (i === MAX_ROTATIONS - 1) fs.unlinkSync(old); // drop oldest
        else fs.renameSync(old, newer);
      }
    }
    fs.renameSync(filePath, `${filePath}.1`);
  } catch {
    // Rotation failure must never crash the agent
  }
}

export class SessionLog {
  private sessionId: string;
  private filePath: string;

  constructor(sessionId?: string) {
    this.sessionId = sessionId ?? `s${Date.now()}`;
    this.filePath = getSessionFilePath(this.sessionId);
  }

  append(turn: SessionTurn): void {
    try {
      rotateIfNeeded(this.filePath);
      fs.appendFileSync(this.filePath, JSON.stringify(turn) + '\n', 'utf-8');
    } catch {
      // Fire-and-forget — never block the agent
    }
  }

  loadLast(n: number): SessionTurn[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const lines = fs.readFileSync(this.filePath, 'utf-8')
        .split('\n')
        .filter(Boolean);
      return lines.slice(-n).map(l => JSON.parse(l) as SessionTurn);
    } catch {
      return [];
    }
  }

  get id(): string { return this.sessionId; }
  get path(): string { return this.filePath; }
}

// Singleton for the current process session
let _current: SessionLog | null = null;

export function currentSession(): SessionLog {
  if (!_current) _current = new SessionLog();
  return _current;
}

// For test isolation
export function _resetSession(): void { _current = null; }
