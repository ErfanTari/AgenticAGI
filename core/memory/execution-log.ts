/**
 * P2: PLAN.EX Execution Log
 * Append-only JSONL execution log stored in workspace/logs/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import { localDateString } from '../utils/date.js';

export interface ExecutionRecord {
  ts: string;
  session_id: string;
  step_id: string;
  skill: string;
  action: string;
  success: boolean;
  pre_hash: string;
  post_hash: string;
  artifacts: string[];
  constraints: string[];
  ms: number;
}

/**
 * Fire-and-forget — never throws, appends one JSON line to the daily log file.
 */
export function logExecution(record: ExecutionRecord): void {
  try {
    fs.mkdirSync(PATHS.logs, { recursive: true });
    const dateStr = localDateString(); // YYYY-MM-DD
    const logFile = path.join(PATHS.logs, `execution-${dateStr}.jsonl`);
    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(logFile, line, 'utf-8');
  } catch (err) {
    console.warn('[execution-log] Failed to append log record:', err);
  }
}

/**
 * Read execution log for a given date (defaults to today).
 */
export function readExecutionLog(dateStr?: string): ExecutionRecord[] {
  try {
    const date = dateStr ?? localDateString();
    const logFile = path.join(PATHS.logs, `execution-${date}.jsonl`);
    if (!fs.existsSync(logFile)) return [];

    const lines = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
    return lines.map(line => JSON.parse(line) as ExecutionRecord);
  } catch {
    return [];
  }
}
