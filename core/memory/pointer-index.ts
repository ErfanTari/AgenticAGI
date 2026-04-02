/**
 * Pointer Index — Phase 16, Section 2
 *
 * Maintains memory/MEMORY.md: a thin always-loaded file mapping known names
 * to their codes. Injected into every queryLoop system prompt so the model
 * can reference known entries directly without searching.
 *
 * Format per line: "WHO.CT-000001: Sara Ahmadi — lead designer, Zaraban Analytics"
 * Max 200 entries — evicts least-recently-active when over limit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import { localDateString } from '../utils/date.js';

export type PointerEntry = {
  code: string;       // WHO.CT-000001
  name: string;       // Sara Ahmadi
  summary: string;    // lead designer, Zaraban Analytics
  lastActive: string; // ISO date (YYYY-MM-DD)
};

const MAX_ENTRIES = 200;

export function pointerIndexPath(): string {
  return path.join(PATHS.memory, 'MEMORY.md');
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export function loadPointerIndex(): string {
  try {
    const p = pointerIndexPath();
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf-8');
  } catch { return ''; }
}

export function loadPointerIndexEntries(): PointerEntry[] {
  const content = loadPointerIndex();
  if (!content) return [];

  return content
    .split('\n')
    .filter(line => /^[A-Z]+\.[A-Z]+-\d{6,}:/.test(line))
    .map(line => {
      const colonIdx = line.indexOf(': ');
      if (colonIdx === -1) return null;
      const code = line.slice(0, colonIdx).trim();
      const rest = line.slice(colonIdx + 2);
      const dashIdx = rest.indexOf(' — ');
      const name = dashIdx !== -1 ? rest.slice(0, dashIdx).trim() : rest.trim();
      const summary = dashIdx !== -1 ? rest.slice(dashIdx + 3).trim() : '';
      if (!code || !name) return null;
      return { code, name, summary, lastActive: localDateString() };
    })
    .filter((e): e is PointerEntry => e !== null);
}

// ─── Write ────────────────────────────────────────────────────────────────────

function writePointerIndex(entries: PointerEntry[]): void {
  const p = pointerIndexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });

  const lines = [
    '# Memory Index',
    '# Auto-maintained. Edit with caution.',
    '',
    ...entries.map(e =>
      e.summary
        ? `${e.code}: ${e.name} — ${e.summary}`
        : `${e.code}: ${e.name}`
    ),
    '',
  ];
  const content = lines.join('\n');

  // Atomic write: write to .tmp then rename
  const tmpPath = p + '.tmp';
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, p);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Insert or update a pointer entry. Evicts oldest when over MAX_ENTRIES.
 * Never throws — failures are logged and swallowed.
 */
export function upsertPointerEntry(entry: PointerEntry): void {
  try {
    const current = loadPointerIndexEntries();
    const idx = current.findIndex(e => e.code === entry.code);
    if (idx >= 0) {
      current[idx] = entry;
    } else {
      current.push(entry);
    }

    if (current.length > MAX_ENTRIES) {
      current.sort((a, b) =>
        new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime()
      );
      current.splice(MAX_ENTRIES);
    }

    writePointerIndex(current);
  } catch (err) {
    console.warn('[pointer-index] upsertPointerEntry failed:', err);
  }
}

/**
 * Remove a pointer entry by code.
 * Never throws.
 */
export function removePointerEntry(code: string): void {
  try {
    const current = loadPointerIndexEntries();
    const filtered = current.filter(e => e.code !== code);
    if (filtered.length !== current.length) {
      writePointerIndex(filtered);
    }
  } catch (err) {
    console.warn('[pointer-index] removePointerEntry failed:', err);
  }
}
