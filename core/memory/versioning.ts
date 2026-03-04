import fs from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import type { SimpleGit } from 'simple-git';
import { PATHS } from '../../config/agent.config.js';
import { upsertEntry } from './write.js';

export interface VersionHistory {
  hash: string;
  message: string;
  date: string;
  author: string;
}

let gitInstance: SimpleGit | null = null;

export async function getGit(): Promise<SimpleGit> {
  if (gitInstance) return gitInstance;

  fs.mkdirSync(PATHS.memory, { recursive: true });

  const git = simpleGit(PATHS.memory);

  // Check if already a git repo
  const isRepo = await git.checkIsRepo().catch(() => false);

  if (!isRepo) {
    await git.init();
    await git.addConfig('user.name', 'AgenticAGI');
    await git.addConfig('user.email', 'agent@local');

    // Commit existing files if any
    const files = fs.readdirSync(PATHS.memory).filter(f => f !== '.git');
    if (files.length > 0) {
      await git.add('.');
      await git.commit('init: initial memory state').catch(() => {});
    }
  }

  gitInstance = git;
  return git;
}

export async function commitMemoryWrite(
  code: string,
  name: string,
  source = 'agent',
): Promise<void> {
  const git = await getGit();
  await git.add('.');
  await git.commit(`${code}: ${name} [${source}]`);
}

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

    // Parse the frontmatter to re-upsert properly
    const frontmatterMatch = oldContent.match(/^---\n([\s\S]*?)\n---\n?/);
    if (frontmatterMatch) {
      const meta: Record<string, string> = {};
      for (const line of frontmatterMatch[1].split('\n')) {
        const sep = line.indexOf(':');
        if (sep === -1) continue;
        meta[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
      }
      const bodyStart = oldContent.indexOf('\n---', 4);
      const bodyContent = bodyStart >= 0 ? oldContent.slice(oldContent.indexOf('\n', bodyStart + 4)).trim() : '';

      if (meta.nb && meta.type && meta.name) {
        upsertEntry({
          nb: meta.nb,
          type: meta.type,
          name: meta.name,
          status: meta.status ?? 'active',
          summary: meta.summary ?? '',
          body: bodyContent,
        });
        return true;
      }
    }

    return true;
  } catch {
    return false;
  }
}

// Reset singleton for testing
export function _resetGitInstance(): void {
  gitInstance = null;
}
