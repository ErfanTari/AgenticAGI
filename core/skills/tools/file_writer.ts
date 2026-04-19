import fs from 'node:fs';
import path from 'node:path';
import type { MCPSkill, SkillResult } from '../types.js';
import { resolveCollision } from '../../utils/path-collision.js';
import { transparency } from '../../transparency.js';

function normalizeWorkspacePath(inputPath: string): string {
  return inputPath
    .replace(/^\.\/+/, '')
    .replace(/^\/?workspace\//, '');
}

/**
 * file_writer skill
 *
 * Writes or appends content to files within the workspace directory.
 * Security: Path traversal prevented, all operations jailed to workspace/
 */
export const fileWriter: MCPSkill = {
  name: 'file_writer',
  description: 'Write a NEW file to disk. For modifying existing files, use patch_file instead. Pass overwrite:true only when fully replacing an existing file is intended.',
  permissionLevel: 'workspace-write',

  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative path inside workspace/ (e.g., "report.txt" or "src/index.js")',
      },
      content: {
        type: 'string',
        description: 'Full file content to write',
      },
      mode: {
        type: 'string',
        description: 'Mode: "write" (overwrite, default) or "append" (add to end)',
      },
      overwrite: {
        type: 'boolean',
        description: 'Only set to true when you explicitly intend to replace the entire contents of an existing file. Default is false.',
      },
    },
    required: ['path', 'content'],
  },

  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const rawPath = input.path as string;

    if (!rawPath || typeof rawPath !== 'string') {
      return {
        success: false,
        output: '',
        error: 'Invalid input: path must be a non-empty string',
      };
    }

    const filePath = normalizeWorkspacePath(rawPath);
    const content = input.content as string;
    const mode = (input.mode as string) || 'write';
    const overwrite = input.overwrite === true;

    if (!filePath) {
      return {
        success: false,
        output: '',
        error: 'Invalid input: path must be a non-empty string',
      };
    }

    if (typeof content !== 'string') {
      return {
        success: false,
        output: '',
        error: 'Invalid input: content must be a string',
      };
    }

    // 10MB size limit
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
    const contentSize = Buffer.byteLength(content, 'utf-8');
    if (contentSize > MAX_FILE_SIZE) {
      return {
        success: false,
        output: '',
        error: `File size limit exceeded: ${(contentSize / 1024 / 1024).toFixed(2)}MB (max 10MB)`,
      };
    }

    try {
      // Workspace root (create if missing)
      const WORKSPACE_ROOT = path.resolve(process.cwd(), 'workspace');
      if (!fs.existsSync(WORKSPACE_ROOT)) {
        fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
      }

      // Resolve and validate path (prevent traversal)
      const resolved = path.resolve(WORKSPACE_ROOT, filePath);
      if (!resolved.startsWith(WORKSPACE_ROOT)) {
        return {
          success: false,
          output: '',
          error: 'Access denied: path escapes workspace boundary',
        };
      }

      // Check parent directory for symlink escape (file may not exist yet)
      const parentDir = path.dirname(resolved);
      if (fs.existsSync(parentDir)) {
        const realParent = fs.realpathSync(parentDir);
        if (!realParent.startsWith(WORKSPACE_ROOT)) {
          return {
            success: false,
            output: '',
            error: 'Access denied: symlink escapes workspace boundary',
          };
        }
      }

      // Resolve filename collisions — append mode always targets original path (intentional),
      // write mode auto-renames unless overwrite: true.
      const collision = mode === 'append'
        ? { finalPath: resolved, renamed: false, originalPath: resolved }
        : resolveCollision(resolved, { overwrite });
      const finalResolved = collision.finalPath;
      const finalFilePath = path.relative(WORKSPACE_ROOT, finalResolved);

      // Create parent directories if needed
      const dirName = path.dirname(finalResolved);
      if (!fs.existsSync(dirName)) {
        fs.mkdirSync(dirName, { recursive: true });
      }

      // Emit rename event before writing
      if (collision.renamed) {
        transparency.emit({ type: 'filename_auto_renamed', data: { original: collision.originalPath, final: finalResolved, skill: 'file_writer' } });
      }

      // Write or append
      if (mode === 'append') {
        fs.appendFileSync(finalResolved, content, 'utf-8');
        return {
          success: true,
          output: `Appended to ${finalFilePath}`,
          display: `Appended to ${finalFilePath}`,
        };
      } else {
        fs.writeFileSync(finalResolved, content, 'utf-8');
        return {
          success: true,
          output: collision.renamed
            ? `Written to ${finalFilePath} (renamed from ${filePath} to avoid collision)`
            : `Written to ${finalFilePath}`,
          display: collision.renamed
            ? `File written to ${finalFilePath} (renamed from ${filePath} to avoid collision)`
            : `Written to ${finalFilePath}`,
        };
      }
    } catch (err) {
      return {
        success: false,
        output: '',
        error: `File write failed: ${String(err)}`,
      };
    }
  },
};
