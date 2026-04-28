import fs from 'node:fs';
import path from 'node:path';
import type { MCPSkill, SkillResult } from '../types.js';
import { parseDiffFenced } from '../edit/diff-fenced-parser.js';
import { findMatch } from '../edit/layered-matcher.js';
import { buildFailureFeedback } from '../edit/failure-feedback.js';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

function normalizeWorkspacePath(inputPath: string): string {
  return inputPath
    .replace(/^\.\/+/, '')
    .replace(/^\/?workspace\//, '');
}

function resolveWorkspacePath(rawPath: string): { resolved: string; filePath: string; error?: string } {
  const filePath = normalizeWorkspacePath(rawPath);
  const WORKSPACE_ROOT = path.resolve(process.cwd(), 'workspace');
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  const resolved = path.resolve(WORKSPACE_ROOT, filePath);
  if (!resolved.startsWith(WORKSPACE_ROOT)) {
    return { resolved, filePath, error: 'Access denied: path escapes workspace boundary' };
  }
  // Symlink check
  const parentDir = path.dirname(resolved);
  if (fs.existsSync(parentDir)) {
    try {
      const realParent = fs.realpathSync(parentDir);
      if (!realParent.startsWith(WORKSPACE_ROOT)) {
        return { resolved, filePath, error: 'Access denied: symlink escapes workspace boundary' };
      }
    } catch { /* ignore */ }
  }
  if (fs.existsSync(resolved)) {
    try {
      const realFile = fs.realpathSync(resolved);
      if (!realFile.startsWith(WORKSPACE_ROOT)) {
        return { resolved, filePath, error: 'Access denied: symlink escapes workspace boundary' };
      }
    } catch { /* ignore */ }
  }
  return { resolved, filePath };
}

const patchFileSkill: MCPSkill = {
  name: 'patch_file',
  description: 'PREFERRED tool for modifying existing files. Accepts diff-fenced format with layered matching (exact → whitespace-normalised → leading-whitespace-flex → fuzzy ≥0.85). Structured failure feedback on mismatch. Use file_reader before patching.',
  permissionLevel: 'workspace-write',

  inputSchema: {
    type: 'object',
    properties: {
      filepath: {
        type: 'string',
        description: 'Relative path inside workspace/ (e.g., "src/index.ts"). Also accepted as filePath.',
      },
      edits: {
        type: 'string',
        description: 'Diff-fenced edit blocks. Format: ```<lang> <path>\\n<<<<<<< SEARCH\\n<old>\\n=======\\n<new>\\n>>>>>>> REPLACE\\n```',
      },
      // Legacy fields — kept for backwards compatibility with existing callers
      search_string: {
        type: 'string',
        description: '(Legacy) Exact string to find. If edits is not provided, falls back to search_string/replace_string.',
      },
      replace_string: {
        type: 'string',
        description: '(Legacy) String to replace with.',
      },
    },
    required: ['filepath'],
  },

  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const rawPath = String(input.filepath ?? input.filePath ?? '');
    if (!rawPath.trim()) {
      return { success: false, output: '', error: 'filepath must be a non-empty string' };
    }

    const { resolved, filePath, error: pathError } = resolveWorkspacePath(rawPath);
    if (pathError) return { success: false, output: '', error: pathError };

    if (!fs.existsSync(resolved)) {
      return { success: false, output: '', error: `File not found: ${filePath}` };
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      return { success: false, output: '', error: `Not a file: ${filePath}` };
    }
    if (stat.size > MAX_FILE_SIZE) {
      return { success: false, output: '', error: `File size limit exceeded: ${(stat.size / 1024 / 1024).toFixed(2)}MB (max 10MB)` };
    }

    const fileContents = fs.readFileSync(resolved, 'utf-8');

    // ── Diff-fenced path ──────────────────────────────────────────────────────
    const editsRaw = typeof input.edits === 'string' ? input.edits : null;
    if (editsRaw) {
      const allBlocks = parseDiffFenced(editsRaw);
      // Match blocks to this file path (try both bare name and with workspace/ prefix)
      const blocks = allBlocks.filter(b =>
        b.filePath === filePath ||
        b.filePath === rawPath ||
        b.filePath.endsWith('/' + filePath) ||
        filePath.endsWith('/' + b.filePath),
      );

      if (blocks.length === 0) {
        return {
          success: false,
          output: '',
          error: `No diff-fenced blocks targeting '${filePath}' found in edits. Available targets: ${allBlocks.map(b => b.filePath).join(', ') || '(none)'}`,
        };
      }

      let workingContents = fileContents;
      const applied: Array<{ blockIndex: number; tier: number | string; search: string }> = [];

      for (const block of blocks) {
        // No-op detection
        if (block.search === block.replace) {
          const feedback = buildFailureFeedback(block, workingContents, {
            tier: 'fail',
            reason: 'no-op',
            candidates: [],
          });
          return {
            success: false,
            output: '',
            error: feedback.hint,
          } as SkillResult;
        }

        const match = findMatch(workingContents, block.search);
        if (match.tier === 'fail') {
          const feedback = buildFailureFeedback(block, workingContents, match);
          return {
            success: false,
            output: JSON.stringify(feedback, null, 2),
            error: `Patch failed: ${feedback.hint}`,
          };
        }

        workingContents =
          workingContents.slice(0, match.start) +
          block.replace +
          workingContents.slice(match.end);
        applied.push({ blockIndex: block.blockIndex, tier: match.tier, search: block.search.slice(0, 40) });
      }

      fs.writeFileSync(resolved, workingContents, 'utf-8');
      return {
        success: true,
        output: `Patched ${filePath}: ${applied.length} block(s) applied via tiers [${applied.map(a => a.tier).join(', ')}]`,
      };
    }

    // ── Legacy path (search_string / replace_string) ──────────────────────────
    const searchString = String(input.search_string ?? '');
    const replaceString = String(input.replace_string ?? '');

    if (!searchString) {
      return { success: false, output: '', error: 'Either edits (diff-fenced) or search_string is required' };
    }

    const occurrences: number[] = [];
    let idx = fileContents.indexOf(searchString);
    while (idx !== -1) {
      occurrences.push(idx);
      idx = fileContents.indexOf(searchString, idx + 1);
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

    const newContent = fileContents.slice(0, occurrences[0]) + replaceString + fileContents.slice(occurrences[0] + searchString.length);
    fs.writeFileSync(resolved, newContent, 'utf-8');
    return {
      success: true,
      output: `Patched ${filePath}: replaced ${searchString.length} chars with ${replaceString.length} chars`,
    };
  },
};

export default patchFileSkill;
