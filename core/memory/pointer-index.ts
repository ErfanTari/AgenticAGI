/**
 * Pointer Index — Phase 16, Section 2
 *
 * Maintains memory/MEMORY.md with two distinct zones:
 *
 *   ## Active loops   ← machine-written task-state, updated after each milestone
 *   ## Known entries  ← human-readable factual index (former single-section format)
 *
 * Active loop entry format (max 80 chars):
 *   PLAN.EX-000031: HackerNews API · M3/6 · next→ Express server · files: [src/cache.js]
 *
 * Known entry format:
 *   WHO.CT-000001: Sara Ahmadi — lead designer, Zaraban Analytics
 *
 * Max 5 active loop entries (one per concurrent plan).
 * Max 200 known entries — evicts least-recently-active when over limit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../../config/agent.config.js';
import { localDateString } from '../utils/date.js';
import { isMemoryFullyDisabled } from '../memory-mode.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PointerEntry = {
  code: string;       // WHO.CT-000001
  name: string;       // Sara Ahmadi
  summary: string;    // lead designer, Zaraban Analytics
  lastActive: string; // ISO date (YYYY-MM-DD)
};

export type ActiveLoopEntry = {
  code: string;        // PLAN.EX-000031
  taskName: string;    // HackerNews API
  mCurrent: number;    // 0-based index of last completed milestone (0 = not started)
  mTotal: number;      // total milestone count
  nextTitle: string;   // title of next milestone to execute
  files: string[];     // files written so far
  done?: boolean;      // true when plan reached terminal state
};

const MAX_KNOWN_ENTRIES = 200;
const MAX_ACTIVE_LOOPS = 5;

// ─── Path ─────────────────────────────────────────────────────────────────────

export function pointerIndexPath(): string {
  return path.join(PATHS.memory, 'MEMORY.md');
}

// ─── Raw file I/O ─────────────────────────────────────────────────────────────

/**
 * Load the full MEMORY.md content.
 */
export function loadPointerIndex(): string {
  try {
    const p = pointerIndexPath();
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf-8');
  } catch { return ''; }
}

/**
 * Extract just the `## Active loops` section content (without the heading).
 * Returns empty string when no active loops exist.
 */
export function loadActiveLoopsSection(): string {
  const content = loadPointerIndex();
  return parseActiveLoopsSection(content);
}

function parseActiveLoopsSection(content: string): string {
  const start = content.indexOf('## Active loops');
  if (start === -1) return '';
  const afterHeading = content.indexOf('\n', start) + 1;
  const end = content.indexOf('\n## ', afterHeading);
  const raw = end === -1
    ? content.slice(afterHeading)
    : content.slice(afterHeading, end);
  return raw.trim();
}

function parseKnownEntriesSection(content: string): string {
  const start = content.indexOf('## Known entries');
  if (start === -1) {
    // Legacy format: no sections, treat everything after headers as known entries
    return content
      .split('\n')
      .filter(l => !l.startsWith('#'))
      .join('\n')
      .trim();
  }
  const afterHeading = content.indexOf('\n', start) + 1;
  const end = content.indexOf('\n## ', afterHeading);
  const raw = end === -1
    ? content.slice(afterHeading)
    : content.slice(afterHeading, end);
  return raw.trim();
}

// ─── Parse active loop lines ──────────────────────────────────────────────────

/**
 * Parse the `## Active loops` section into structured entries.
 */
export function parseActiveLoopEntries(content?: string): ActiveLoopEntry[] {
  const section = content !== undefined ? parseActiveLoopsSection(content) : loadActiveLoopsSection();
  if (!section) return [];

  return section
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      // PLAN.EX-000031: HackerNews API · M3/6 · next→ Express server · files: [src/cache.js]
      // or PLAN.EX-000031: HackerNews API · DONE · all milestones complete
      const codeMatch = line.match(/^(PLAN\.EX-\d+):\s*/);
      if (!codeMatch) return null;
      const code = codeMatch[1];
      const rest = line.slice(codeMatch[0].length);
      const parts = rest.split(' · ');
      const taskName = parts[0]?.trim() ?? '';

      if (parts.some(p => p.trim().startsWith('DONE'))) {
        return { code, taskName, mCurrent: 0, mTotal: 0, nextTitle: '', files: [], done: true };
      }

      let mCurrent = 0;
      let mTotal = 0;
      let nextTitle = '';
      let files: string[] = [];

      for (const part of parts.slice(1)) {
        const trimmed = part.trim();
        const mMatch = trimmed.match(/^M(\d+)\/(\d+)$/);
        if (mMatch) { mCurrent = parseInt(mMatch[1]); mTotal = parseInt(mMatch[2]); continue; }
        if (trimmed.startsWith('next→ ')) { nextTitle = trimmed.slice(6).trim(); continue; }
        if (trimmed.startsWith('files: [')) {
          const inner = trimmed.slice(8, trimmed.lastIndexOf(']'));
          files = inner ? inner.split(',').map(f => f.trim()).filter(Boolean) : [];
        }
      }

      return { code, taskName, mCurrent, mTotal, nextTitle, files };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null) as ActiveLoopEntry[];
}

function formatActiveLoopLine(entry: ActiveLoopEntry): string {
  if (entry.done) {
    return `${entry.code}: ${entry.taskName} · DONE · all milestones complete`;
  }
  const filesStr = entry.files.length > 0 ? ` · files: [${entry.files.join(', ')}]` : '';
  return `${entry.code}: ${entry.taskName} · M${entry.mCurrent}/${entry.mTotal} · next→ ${entry.nextTitle}${filesStr}`;
}

// ─── Parse known entry lines ──────────────────────────────────────────────────

export function loadPointerIndexEntries(): PointerEntry[] {
  const content = loadPointerIndex();
  const section = parseKnownEntriesSection(content);
  if (!section) return [];

  return section
    .split('\n')
    .filter(line => /^[A-Z]+\.[A-Z]+-\d{6,}:/.test(line.trim()))
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

// ─── Atomic file writer ───────────────────────────────────────────────────────

function writeFullIndex(activeLoops: ActiveLoopEntry[], knownEntries: PointerEntry[]): void {
  const p = pointerIndexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });

  const lines: string[] = [
    '# Memory Index',
    '# Auto-maintained. Edit with caution.',
    '',
  ];

  lines.push('## Active loops');
  if (activeLoops.length > 0) {
    for (const entry of activeLoops) {
      lines.push(formatActiveLoopLine(entry));
    }
  }
  lines.push('');

  lines.push('## Known entries');
  for (const entry of knownEntries) {
    lines.push(
      entry.summary
        ? `${entry.code}: ${entry.name} — ${entry.summary}`
        : `${entry.code}: ${entry.name}`,
    );
  }
  lines.push('');

  const content = lines.join('\n');
  const tmpPath = p + '.tmp';
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, p);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

// ─── Public API — Known entries ───────────────────────────────────────────────

/**
 * Insert or update a known pointer entry. Evicts oldest when over MAX_KNOWN_ENTRIES.
 * Never throws.
 */
export function upsertPointerEntry(entry: PointerEntry): void {
  if (isMemoryFullyDisabled()) return;
  try {
    const content = loadPointerIndex();
    const activeLoops = parseActiveLoopEntries(content);
    const known = loadPointerIndexEntries();

    const idx = known.findIndex(e => e.code === entry.code);
    if (idx >= 0) {
      known[idx] = entry;
    } else {
      known.push(entry);
    }

    if (known.length > MAX_KNOWN_ENTRIES) {
      known.sort((a, b) =>
        new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime()
      );
      known.splice(MAX_KNOWN_ENTRIES);
    }

    writeFullIndex(activeLoops, known);
  } catch (err) {
    console.warn('[pointer-index] upsertPointerEntry failed:', err);
  }
}

/**
 * Remove a known pointer entry by code. Never throws.
 */
export function removePointerEntry(code: string): void {
  if (isMemoryFullyDisabled()) return;
  try {
    const content = loadPointerIndex();
    const activeLoops = parseActiveLoopEntries(content);
    const known = loadPointerIndexEntries().filter(e => e.code !== code);
    writeFullIndex(activeLoops, known);
  } catch (err) {
    console.warn('[pointer-index] removePointerEntry failed:', err);
  }
}

// ─── Public API — Active loops ────────────────────────────────────────────────

/**
 * Write or update an active loop entry for a running PLAN.EX.
 * Evicts oldest entries when over MAX_ACTIVE_LOOPS.
 * Never throws.
 */
export function upsertActiveLoop(entry: ActiveLoopEntry): void {
  if (isMemoryFullyDisabled()) return;
  try {
    const content = loadPointerIndex();
    const loops = parseActiveLoopEntries(content);
    const known = loadPointerIndexEntries();

    const idx = loops.findIndex(e => e.code === entry.code);
    if (idx >= 0) {
      loops[idx] = entry;
    } else {
      loops.push(entry);
    }

    // Evict oldest if over limit (keep most recently added / last in list)
    if (loops.length > MAX_ACTIVE_LOOPS) {
      loops.splice(0, loops.length - MAX_ACTIVE_LOOPS);
    }

    writeFullIndex(loops, known);
  } catch (err) {
    console.warn('[pointer-index] upsertActiveLoop failed:', err);
  }
}

/**
 * Mark a plan as DONE then remove it. Call at terminal plan state.
 * Never throws.
 */
export function removeActiveLoop(code: string): void {
  if (isMemoryFullyDisabled()) return;
  try {
    const content = loadPointerIndex();
    const loops = parseActiveLoopEntries(content).filter(e => e.code !== code);
    const known = loadPointerIndexEntries();
    writeFullIndex(loops, known);
  } catch (err) {
    console.warn('[pointer-index] removeActiveLoop failed:', err);
  }
}
