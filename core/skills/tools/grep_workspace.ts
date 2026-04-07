import fs from 'node:fs';
import path from 'node:path';
import type { MCPSkill, SkillResult } from '../types.js';
import { PATHS } from '../../../config/agent.config.js';

const DEFAULT_MAX_RESULTS = 50;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

function matchesGlob(filename: string, glob: string): boolean {
  // Simple suffix/extension matching + basic * glob
  if (!glob.includes('*')) {
    return filename.endsWith(glob) || path.basename(filename) === glob;
  }
  // Convert glob to regex: * → [^/]*, ** → .*
  const regexStr = glob
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '.*');
  try {
    return new RegExp(`^${regexStr}$`).test(filename) || new RegExp(`^${regexStr}$`).test(path.basename(filename));
  } catch {
    return filename.endsWith(glob.replace(/\*/g, ''));
  }
}

function isBinaryBuffer(buf: Buffer, bytesRead: number): boolean {
  return buf.slice(0, bytesRead).includes(0x00);
}

function walkDir(dir: string, workspaceRoot: string, results: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, workspaceRoot, results);
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
}

const grepWorkspaceSkill: MCPSkill = {
  name: 'grep_workspace',
  description: 'Search for a pattern across all files in the workspace. Returns matching lines with file path and line number.',
  permissionLevel: 'read-only',

  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Search pattern (literal string, case-insensitive; treated as regex if valid)',
      },
      file_glob: {
        type: 'string',
        description: 'Optional file glob filter, e.g. "*.ts" or "*.json"',
      },
      max_results: {
        type: 'number',
        description: 'Maximum number of results to return (default 50)',
      },
    },
    required: ['pattern'],
  },

  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const pattern = String(input.pattern ?? '').trim();
    const fileGlob = input.file_glob ? String(input.file_glob) : undefined;
    const maxResults = typeof input.max_results === 'number' ? input.max_results : DEFAULT_MAX_RESULTS;

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
      return { success: true, output: 'No matches found (workspace does not exist).' };
    }

    // Build regex
    let searchRegex: RegExp;
    try {
      searchRegex = new RegExp(pattern, 'i');
    } catch {
      // Fall back to literal match
      searchRegex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    // Collect all files
    const allFiles: string[] = [];
    walkDir(WORKSPACE_ROOT, WORKSPACE_ROOT, allFiles);

    const matches: GrepMatch[] = [];
    let totalMatches = 0;
    const SAMPLE_SIZE = 8192;

    for (const filePath of allFiles) {
      const relPath = path.relative(WORKSPACE_ROOT, filePath);

      // Apply glob filter
      if (fileGlob && !matchesGlob(relPath, fileGlob)) continue;

      // Binary check
      try {
        const buf = Buffer.allocUnsafe(SAMPLE_SIZE);
        const fd = fs.openSync(filePath, 'r');
        const bytesRead = fs.readSync(fd, buf, 0, SAMPLE_SIZE, 0);
        fs.closeSync(fd);
        if (isBinaryBuffer(buf, bytesRead)) continue;
      } catch {
        continue;
      }

      // Read and search line by line
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      const lines = content.split('\n');
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        if (searchRegex.test(lines[lineIdx])) {
          totalMatches++;
          if (matches.length < maxResults) {
            matches.push({
              file: relPath,
              line: lineIdx + 1,
              text: lines[lineIdx],
            });
          }
        }
      }
    }

    if (matches.length === 0) {
      return { success: true, output: 'No matches found.' };
    }

    const lines = matches.map(m => `${m.file}:${m.line}: ${m.text}`);
    if (totalMatches > maxResults) {
      lines.push(`Truncated — ${totalMatches} total matches found`);
    }

    return { success: true, output: lines.join('\n') };
  },
};

export default grepWorkspaceSkill;
