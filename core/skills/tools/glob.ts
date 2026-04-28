import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { MCPSkill, SkillResult } from '../types.js';
import { PATHS } from '../../../config/agent.config.js';

const DEFAULT_MAX_RESULTS = 100;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);
const RG_TIMEOUT_MS = 10000;
let rgNotFoundLogged = false;

async function globWithRipgrep(
  pattern: string,
  workspaceRoot: string,
  maxResults: number
): Promise<string[] | null> {
  return new Promise((resolve) => {
    const args = ['--files', '--glob', pattern, workspaceRoot];

    const child = spawn('rg', args, { timeout: RG_TIMEOUT_MS });
    const chunks: string[] = [];
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, RG_TIMEOUT_MS);

    child.stdout.on('data', (data) => {
      chunks.push(data.toString());
    });

    child.on('close', () => {
      clearTimeout(timeout);
      if (timedOut) {
        resolve(null);
        return;
      }

      const files: string[] = [];
      const lines = chunks.join('').split('\n').filter(l => l.trim());

      for (const line of lines) {
        if (files.length >= maxResults) break;
        const trimmed = line.trim();
        if (trimmed) {
          files.push(trimmed);
        }
      }

      resolve(files.length > 0 ? files : []);
    });

    child.on('error', () => {
      clearTimeout(timeout);
      resolve(null); // ENOENT or other error — return null to trigger fallback
    });
  });
}

function walkDirForGlob(
  dir: string,
  workspaceRoot: string,
  pattern: RegExp,
  results: string[],
  maxResults: number
): void {
  if (results.length >= maxResults) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= maxResults) return;
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(workspaceRoot, fullPath);

    if (entry.isDirectory()) {
      walkDirForGlob(fullPath, workspaceRoot, pattern, results, maxResults);
    } else if (entry.isFile()) {
      if (pattern.test(relPath)) {
        results.push(relPath);
      }
    }
  }
}

async function globWithFallback(
  pattern: string,
  workspaceRoot: string,
  maxResults: number
): Promise<string[]> {
  // Log one-time warning
  if (!rgNotFoundLogged) {
    console.warn('[glob] ripgrep not found on PATH, using fallback (slower)');
    rgNotFoundLogged = true;
  }

  // Convert glob to regex: * → [^/]*, ** → .*
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '.*');

  let patternRegex: RegExp;
  try {
    patternRegex = new RegExp(`^${regexStr}$`);
  } catch {
    patternRegex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }

  const results: string[] = [];
  walkDirForGlob(workspaceRoot, workspaceRoot, patternRegex, results, maxResults);
  return results;
}

const globSkill: MCPSkill = {
  name: 'glob',
  description: 'Fast file pattern matcher. Returns file paths matching the glob pattern relative to workspace root.',
  permissionLevel: 'read-only',

  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern, e.g. "*.ts", "src/**/*.json", "test_*.js"',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of files to return (default 100)',
      },
      offset: {
        type: 'number',
        description: 'Skip this many results before returning (for pagination, 0-based). Use with max_results to page through large result sets.',
      },
    },
    required: ['pattern'],
  },

  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const pattern = String(input.pattern ?? '').trim();
    const maxResults = typeof input.max_results === 'number' ? input.max_results : DEFAULT_MAX_RESULTS;
    const offset = typeof input.offset === 'number' ? Math.max(0, Math.floor(input.offset)) : 0;

    if (!pattern) {
      return { success: false, output: '', error: 'pattern must be a non-empty string' };
    }

    const WORKSPACE_ROOT_RAW = PATHS.workspace ?? path.resolve(process.cwd(), 'workspace');
    let WORKSPACE_ROOT: string;
    try {
      WORKSPACE_ROOT = fs.realpathSync(WORKSPACE_ROOT_RAW);
    } catch {
      WORKSPACE_ROOT = WORKSPACE_ROOT_RAW;
    }

    if (!fs.existsSync(WORKSPACE_ROOT)) {
      return { success: true, output: JSON.stringify({ files: [], truncated: false, total: 0, offset }) };
    }

    // Collect all matching files up to hard limit so we can report accurate total and support any offset
    const COLLECT_HARD_LIMIT = 10_000;

    // Try ripgrep first
    let files = await globWithRipgrep(pattern, WORKSPACE_ROOT, COLLECT_HARD_LIMIT);

    // Fall back to JS implementation if ripgrep not available
    if (files === null) {
      files = await globWithFallback(pattern, WORKSPACE_ROOT, COLLECT_HARD_LIMIT);
    }

    const page = files.slice(offset, offset + maxResults);
    const truncated = files.length > offset + maxResults;

    return {
      success: true,
      output: JSON.stringify({
        files: page,
        truncated,
        total: files.length,
        offset,
      }),
    };
  },
};

export default globSkill;
