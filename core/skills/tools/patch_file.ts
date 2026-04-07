import fs from 'node:fs';
import path from 'node:path';
import type { MCPSkill, SkillResult } from '../types.js';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

function normalizeWorkspacePath(inputPath: string): string {
  return inputPath
    .replace(/^\.\/+/, '')
    .replace(/^\/?workspace\//, '');
}

const patchFileSkill: MCPSkill = {
  name: 'patch_file',
  description: 'Apply a targeted string replacement to a file in the workspace. Use to edit existing files without rewriting the entire content.',
  permissionLevel: 'workspace-write',

  inputSchema: {
    type: 'object',
    properties: {
      filepath: {
        type: 'string',
        description: 'Relative path inside workspace/ (e.g., "src/index.ts")',
      },
      search_string: {
        type: 'string',
        description: 'Exact string to find in the file. Must appear exactly once.',
      },
      replace_string: {
        type: 'string',
        description: 'String to replace the search_string with. May be empty to delete.',
      },
    },
    required: ['filepath', 'search_string', 'replace_string'],
  },

  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const rawPath = String(input.filepath ?? '');
    const searchString = String(input.search_string ?? '');
    const replaceString = String(input.replace_string ?? '');

    if (!rawPath.trim()) {
      return { success: false, output: '', error: 'filepath must be a non-empty string' };
    }

    if (!searchString) {
      return { success: false, output: '', error: 'search_string must be a non-empty string' };
    }

    const filePath = normalizeWorkspacePath(rawPath);

    // Workspace root (computed dynamically to support tests that change cwd)
    const WORKSPACE_ROOT = path.resolve(process.cwd(), 'workspace');
    fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });

    // Resolve path
    const resolved = path.resolve(WORKSPACE_ROOT, filePath);
    if (!resolved.startsWith(WORKSPACE_ROOT)) {
      return { success: false, output: '', error: 'Access denied: path escapes workspace boundary' };
    }

    // Symlink check — check parent directory like file_writer
    const parentDir = path.dirname(resolved);
    if (fs.existsSync(parentDir)) {
      try {
        const realParent = fs.realpathSync(parentDir);
        if (!realParent.startsWith(WORKSPACE_ROOT)) {
          return { success: false, output: '', error: 'Access denied: symlink escapes workspace boundary' };
        }
      } catch {
        // Parent doesn't exist or can't be resolved — will be caught by existsSync below
      }
    }

    // Also check the file itself if it exists
    if (fs.existsSync(resolved)) {
      try {
        const realFile = fs.realpathSync(resolved);
        if (!realFile.startsWith(WORKSPACE_ROOT)) {
          return { success: false, output: '', error: 'Access denied: symlink escapes workspace boundary' };
        }
      } catch { /* ignore */ }
    }

    // File must exist
    if (!fs.existsSync(resolved)) {
      return { success: false, output: '', error: `File not found: ${filePath}` };
    }

    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      return { success: false, output: '', error: `Not a file: ${filePath}` };
    }

    // Size check
    if (stat.size > MAX_FILE_SIZE) {
      return { success: false, output: '', error: `File size limit exceeded: ${(stat.size / 1024 / 1024).toFixed(2)}MB (max 10MB)` };
    }

    const content = fs.readFileSync(resolved, 'utf-8');

    // Count occurrences
    const occurrences: number[] = [];
    let idx = content.indexOf(searchString);
    while (idx !== -1) {
      occurrences.push(idx);
      idx = content.indexOf(searchString, idx + 1);
    }

    if (occurrences.length === 0) {
      return { success: false, output: '', error: 'search_string not found in file' };
    }

    if (occurrences.length > 1) {
      return {
        success: false,
        output: '',
        error: `search_string is ambiguous — appears ${occurrences.length} times. Make it more specific.`,
      };
    }

    // Apply single replacement
    const newContent = content.slice(0, occurrences[0]) + replaceString + content.slice(occurrences[0] + searchString.length);

    fs.writeFileSync(resolved, newContent, 'utf-8');

    return {
      success: true,
      output: `Patched ${filePath}: replaced ${searchString.length} chars with ${replaceString.length} chars`,
    };
  },
};

export default patchFileSkill;
