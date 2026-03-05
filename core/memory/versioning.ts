import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import type { SimpleGit } from 'simple-git';
import { PATHS } from '../../config/agent.config.js';
import { getDb, insertEntry } from './index.js';
import { indexContent } from './fts.js';

export interface VersionHistory {
  hash: string;
  message: string;
  date: string;
  author: string;
}

let gitInstance: SimpleGit | null = null;
let gitInstancePath: string | null = null;
// Pending init promise — serializes concurrent getGit() calls for the same path
// so two rapid callers never double-init the same repo.
let gitInitPromise: Promise<SimpleGit> | null = null;
// Generation counter — incremented on every reset so in-flight commits
// can detect that their context was invalidated and exit early.
let generation = 0;
// All in-flight commit promises — used by _resetGitInstance to drain them before cleanup.
const pendingCommits = new Set<Promise<void>>();

export async function getGit(): Promise<SimpleGit> {
  // Key the singleton by path so test isolation (PATHS.memory reassignment)
  // works correctly and commits never bleed across different memory directories.
  if (gitInstance && gitInstancePath === PATHS.memory) return gitInstance;

  // Path changed — discard cached state
  if (gitInstancePath !== PATHS.memory) {
    gitInstance = null;
    gitInitPromise = null;
    // Claim this path synchronously before any await so concurrent callers see it
    gitInstancePath = PATHS.memory;
  }

  // Serialize concurrent callers: return the in-flight init promise if one exists
  if (gitInitPromise) return gitInitPromise;

  const claimedPath = PATHS.memory;
  const capturedGenForInit = generation;
  // Skip git operations for temp directories (used in tests) to avoid
  // cleanup races where git processes hold file handles during rmSync.
  const tmpdir = os.tmpdir();
  const isTempPath = claimedPath.startsWith('/tmp/') ||
    claimedPath.startsWith('/var/folders/') ||
    claimedPath.startsWith(tmpdir);
  gitInitPromise = (async () => {
    fs.mkdirSync(claimedPath, { recursive: true });

    const git = simpleGit(claimedPath);

    // Skip git init/commit for temp paths — no-op versioning in test environments.
    if (isTempPath) {
      if (generation === capturedGenForInit) {
        gitInstance = git;
        gitInstancePath = claimedPath;
      }
      return git;
    }

    // Check for memory/.git directly — never use checkIsRepo() which traverses
    // parent directories and would accept the project root .git when memory/.git
    // is absent, causing memory commits to run against the main repository.
    const hasOwnGit = fs.existsSync(path.join(claimedPath, '.git'));

    if (!hasOwnGit) {
      // Abort init if the context was invalidated before we started
      if (generation !== capturedGenForInit) return git;
      await git.init();
      if (generation !== capturedGenForInit) return git;
      await git.addConfig('user.name', 'AgenticAGI');
      await git.addConfig('user.email', 'agent@local');

      // Commit existing files if any
      const files = fs.readdirSync(claimedPath).filter(f => f !== '.git');
      if (files.length > 0 && generation === capturedGenForInit) {
        await git.add('.');
        if (generation === capturedGenForInit) {
          await git.commit('init: initial memory state').catch(() => {});
        }
      }
    }

    if (generation === capturedGenForInit) {
      gitInstance = git;
      gitInstancePath = claimedPath;
    }
    return git;
  })();

  return gitInitPromise;
}

export async function commitMemoryWrite(
  code: string,
  name: string,
  source = 'agent',
): Promise<void> {
  // Capture generation at call time — if reset occurs before we finish, bail.
  const capturedGen = generation;
  // Never rejects — all errors are caught and logged so fire-and-forget callers are safe.
  let resolveCommit!: () => void;
  const promise: Promise<void> = new Promise(resolve => { resolveCommit = resolve; });
  pendingCommits.add(promise);

  (async () => {
    try {
      const git = await getGit();
      // Check if the context was invalidated while we awaited getGit()
      if (generation !== capturedGen) return;
      await git.add('.');
      if (generation !== capturedGen) return;
      await git.commit(`${code}: ${name} [${source}]`);
    } catch (err) {
      if (generation !== capturedGen) return; // reset happened, suppress error
      console.warn(`[versioning] git commit failed for ${code}:`, err);
    } finally {
      resolveCommit();
      pendingCommits.delete(promise);
    }
  })();

  return promise;
}

// ─── H3/H4: Debounced batch commit ───────────────────────────────────────────
// Batches rapid writes into a single git commit (30s debounce from LAST write).
// Short-circuits silently if memory dir has no .git (test environments).

let commitTimer: ReturnType<typeof setTimeout> | null = null;
let pendingMessages: string[] = [];
const DEBOUNCE_MS = 30_000;

export function scheduleMemoryCommit(message: string): void {
  // H4: Skip silently if no .git — avoids noisy log spam in test environments
  if (!fs.existsSync(path.join(PATHS.memory, '.git'))) return;

  pendingMessages.push(message);

  // Reset timer on every write (debounce from LAST write, not first)
  if (commitTimer) clearTimeout(commitTimer);

  commitTimer = setTimeout(() => {
    void flushCommit();
  }, DEBOUNCE_MS);
}

export async function flushCommit(): Promise<void> {
  if (pendingMessages.length === 0) return;

  const messages = [...pendingMessages];
  pendingMessages = [];
  commitTimer = null;

  try {
    const memoryPath = PATHS.memory;
    if (!fs.existsSync(path.join(memoryPath, '.git'))) return;

    const git = simpleGit(memoryPath);
    await git.add('.');
    const status = await git.status();
    if (status.files.length === 0) return;

    const summary =
      messages.length === 1
        ? messages[0]
        : `memory: batch update (${messages.length} writes)\n\n${messages
            .slice(0, 10)
            .join('\n')}${messages.length > 10 ? `\n...+${messages.length - 10} more` : ''}`;

    await git.commit(summary);
  } catch (err) {
    console.warn('[versioning] batch commit failed:', err);
  }
}

// Flush on graceful shutdown so no writes are lost
let shutdownRegistered = false;
function registerShutdownFlush(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  const flush = (): void => {
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
    if (pendingMessages.length === 0) return;
    try {
      const { execSync } = require('child_process');
      execSync('git add . && git commit -m "memory: shutdown flush"', {
        cwd: PATHS.memory,
        stdio: 'ignore',
      });
    } catch { /* best-effort */ }
  };
  process.on('SIGTERM', flush);
  process.on('SIGINT', flush);
  process.on('beforeExit', flush);
}
registerShutdownFlush();

export async function getEntryHistory(code: string): Promise<VersionHistory[]> {
  try {
    const git = await getGit();
    const log = await git.log(['--', `**/${code}*.md`]);
    return log.all.map(entry => ({
      hash: entry.hash,
      message: entry.message,
      date: entry.date,
      author: entry.author_name,
    }));
  } catch {
    return [];
  }
}

export async function rollbackEntry(code: string, commitHash: string): Promise<boolean> {
  try {
    const git = await getGit();

    // Find the file for this code
    const result = await git.raw(['show', `${commitHash}:`, '--name-only']).catch(() => '');
    const files = result.split('\n').filter(f => f.includes(code) && f.endsWith('.md'));

    if (files.length === 0) {
      // Try to find the file by listing files in memory dir
      const allFiles: string[] = [];
      function walk(dir: string) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory() && e.name !== '.git') walk(full);
          else if (e.isFile() && e.name.includes(code) && e.name.endsWith('.md')) {
            allFiles.push(path.relative(PATHS.memory, full));
          }
        }
      }
      walk(PATHS.memory);
      if (allFiles.length === 0) return false;
      files.push(allFiles[0]);
    }

    const relPath = files[0].trim();
    const oldContent = await git.show([`${commitHash}:${relPath}`]);
    const fullPath = path.join(PATHS.memory, relPath);

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, oldContent, 'utf-8');

    // BUG-C1 fix: parse the frontmatter to extract the EXACT original code,
    // then restore it in SQLite with that exact code — never use upsertEntry
    // which would create a new sequential code if the row is missing.
    const frontmatterMatch = oldContent.match(/^---\n([\s\S]*?)\n---\n?/);
    if (frontmatterMatch) {
      const meta: Record<string, string> = {};
      for (const line of frontmatterMatch[1].split('\n')) {
        const sep = line.indexOf(':');
        if (sep === -1) continue;
        meta[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
      }

      const originalCode = meta.code ?? code;

      if (meta.nb && meta.type && meta.name && originalCode) {
        const d = getDb();
        const existing = d.prepare('SELECT code FROM index_entries WHERE code = ?').get(originalCode);
        if (existing) {
          // Row exists — update in-place
          d.prepare(
            'UPDATE index_entries SET summary = ?, status = ?, updated = ?, path = ? WHERE code = ?'
          ).run(
            meta.summary ?? '',
            meta.status ?? 'active',
            new Date().toISOString().slice(0, 10),
            fullPath,
            originalCode,
          );
        } else {
          // Row missing — re-insert with the EXACT original code, bypassing counter
          insertEntry({
            code: originalCode,
            nb: meta.nb,
            type: meta.type,
            name: meta.name,
            status: meta.status ?? 'active',
            updated: new Date().toISOString().slice(0, 10),
            summary: meta.summary ?? '',
            path: fullPath,
            due_date: meta.due_date ?? null,
          });
        }

        // Reindex FTS so search reflects the restored content
        try {
          indexContent(originalCode, meta.nb, `${meta.name} ${meta.summary ?? ''} ${oldContent}`);
        } catch {
          // FTS reindex is best-effort — SQLite row is already restored
        }

        return true;
      }
      // Frontmatter missing required fields — SQLite was not restored
      return false;
    }

    // No frontmatter at all — file restored on disk but SQLite not updated
    return false;
  } catch {
    return false;
  }
}

// Reset singleton for testing
export function _resetGitInstance(): void {
  generation++; // invalidate all in-flight commit operations
  gitInstance = null;
  gitInstancePath = null;
  gitInitPromise = null;
  // Note: pendingCommits may still have in-flight promises; they will self-clean
  // via the finally block. The generation increment ensures they exit early.
}

/**
 * Await all pending git commit operations. Call this before deleting the memory
 * directory to ensure git processes have released all file handles.
 * Used in tests: await _drainGitCommits(); before fs.rmSync(tmpDir, ...).
 * Note: test files call _resetGitInstance() synchronously and then wait a fixed
 * timeout — this function is available if higher-precision drain is needed.
 */
export async function _drainGitCommits(): Promise<void> {
  if (pendingCommits.size === 0) return;
  await Promise.allSettled([...pendingCommits]);
}
