import * as fs from 'node:fs';
import * as path from 'node:path';
import { PATHS } from '../config/agent.config.js';

export type MemoryMode = 'enabled' | 'disabled';

let _memoryMode: MemoryMode = 'enabled';

export function getMemoryMode(): MemoryMode { return _memoryMode; }
export function setMemoryMode(mode: MemoryMode): void { _memoryMode = mode; }
export function _resetMemoryMode(): void { _memoryMode = 'enabled'; }

export function isMemoryFullyDisabled(): boolean {
  return getMemoryMode() === 'disabled';
}

// --- Scratchpad helpers ---
// Ephemeral markdown files for HIGH/MAX plans when memory is disabled.
// Lives at workspace/.scratch/plan-<requestId>.md
// Never indexed, never queried by future requests.

function scratchDir(): string {
  const dir = path.join(PATHS.workspace, '.scratch');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getScratchpadPath(requestId: string): string {
  return path.join(scratchDir(), `plan-${requestId}.md`);
}

export function appendScratchpad(requestId: string, section: string, content: string): void {
  try {
    const p = getScratchpadPath(requestId);
    const header = `\n## ${section}\n\n`;
    fs.appendFileSync(p, header + content + '\n', 'utf-8');
  } catch (err) {
    console.warn(`[scratchpad] append failed for ${requestId}:`, err);
  }
}

export function readScratchpad(requestId: string): string | null {
  try {
    const p = getScratchpadPath(requestId);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
  } catch {
    return null;
  }
}

export function clearScratchpad(requestId: string): void {
  try {
    const p = getScratchpadPath(requestId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* ignore */ }
}
