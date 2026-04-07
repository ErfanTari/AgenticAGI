import fs from 'node:fs';
import path from 'node:path';
import type { MCPSkill, SkillResult } from '../types.js';
import { PATHS } from '../../../config/agent.config.js';

const MAX_RECURSIVE_ENTRIES = 500;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

function normalizeWorkspacePath(inputPath: string): string {
  return inputPath
    .replace(/^\.\/+/, '')
    .replace(/^\/?workspace\//, '');
}

function walkRecursive(dir: string, rootDir: string, files: string[], truncated: { count: number }): void {
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
      walkRecursive(fullPath, rootDir, files, truncated);
    } else if (entry.isFile()) {
      if (files.length < MAX_RECURSIVE_ENTRIES) {
        files.push(path.relative(rootDir, fullPath));
      } else {
        truncated.count++;
      }
    }
  }
}

const listDirSkill: MCPSkill = {
  name: 'list_dir',
  description: 'List files and directories in a workspace path. Use to explore workspace structure before reading or writing files.',
  permissionLevel: 'read-only',

  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative path inside workspace/ to list (e.g., "src" or "." for root)',
      },
      recursive: {
        type: 'boolean',
        description: 'If true, list all files recursively (skips node_modules, .git, dist)',
      },
    },
    required: ['path'],
  },

  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const rawPath = String(input.path ?? '.');
    const recursive = Boolean(input.recursive ?? false);

    const filePath = normalizeWorkspacePath(rawPath === '.' ? '' : rawPath);

    const WORKSPACE_ROOT_RAW = PATHS.workspace ?? path.resolve(process.cwd(), 'workspace');
    fs.mkdirSync(WORKSPACE_ROOT_RAW, { recursive: true });
    let WORKSPACE_ROOT: string;
    try {
      WORKSPACE_ROOT = fs.realpathSync(WORKSPACE_ROOT_RAW);
    } catch {
      WORKSPACE_ROOT = WORKSPACE_ROOT_RAW;
    }

    const resolved = filePath
      ? path.resolve(WORKSPACE_ROOT, filePath)
      : WORKSPACE_ROOT;

    // Boundary check
    if (!resolved.startsWith(WORKSPACE_ROOT)) {
      return { success: false, output: '', error: 'Access denied: path escapes workspace boundary' };
    }

    // Symlink check
    let realResolved = resolved;
    try {
      realResolved = fs.realpathSync(resolved);
    } catch {
      // Directory may not exist
    }
    if (!realResolved.startsWith(WORKSPACE_ROOT)) {
      return { success: false, output: '', error: 'Access denied: symlink escapes workspace boundary' };
    }

    if (!fs.existsSync(resolved)) {
      return { success: false, output: '', error: `Path not found: ${rawPath}` };
    }

    if (!fs.statSync(resolved).isDirectory()) {
      return { success: false, output: '', error: `Not a directory: ${rawPath}` };
    }

    if (recursive) {
      const files: string[] = [];
      const truncated = { count: 0 };
      walkRecursive(resolved, resolved, files, truncated);

      const lines = files.map(f => f);
      if (truncated.count > 0) {
        lines.push(`(truncated — ${truncated.count} more entries not shown, max ${MAX_RECURSIVE_ENTRIES})`);
      }
      return { success: true, output: lines.join('\n') || '(empty directory)' };
    } else {
      // Non-recursive: list dirs and files separately
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(resolved, { withFileTypes: true });
      } catch (err) {
        return { success: false, output: '', error: `Cannot read directory: ${String(err)}` };
      }

      const dirs: string[] = [];
      const files: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          dirs.push(entry.name + '/');
        } else {
          files.push(entry.name);
        }
      }

      dirs.sort();
      files.sort();

      const result = {
        dirs,
        files,
      };
      return { success: true, output: JSON.stringify(result, null, 2) };
    }
  },
};

export default listDirSkill;
