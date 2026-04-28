import fs from 'node:fs';
import path from 'node:path';
import type { MCPSkill, SkillResult } from '../types.js';
import { _markFileRead } from './file_writer.js';

const MAX_CHARS = 50000;

const SUPPORTED_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.csv', '.ts', '.js', '.py',
  '.yaml', '.yml', '.toml', '.xml', '.html', '.css',
  '.sh', '.sql', '.env', '.cfg', '.ini', '.log',
]);

function normalizeWorkspacePath(inputPath: string): string {
  return inputPath
    .replace(/^\.\/+/, '')
    .replace(/^\/?workspace\//, '');
}

function isBinaryFile(filePath: string): boolean {
  const SAMPLE_SIZE = 8192;
  const buf = Buffer.allocUnsafe(SAMPLE_SIZE);
  const fd = fs.openSync(filePath, 'r');
  const bytesRead = fs.readSync(fd, buf, 0, SAMPLE_SIZE, 0);
  fs.closeSync(fd);
  return buf.slice(0, bytesRead).includes(0x00);
}

const fileReaderSkill: MCPSkill = {
  name: 'file_reader',
  description: 'Read a file from disk. Use when user asks to read, open, or load a file. Supports offset/limit for paginated reads of large files.',
  permissionLevel: 'read-only',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path' },
      offset: { type: 'number', description: 'Line number to start reading from (1-based, optional)' },
      limit: { type: 'number', description: 'Maximum number of lines to return (optional). Use with offset to paginate large files.' },
    },
    required: ['path'],
  },
  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const rawPath = String(input.path ?? '');
    const filePath = normalizeWorkspacePath(rawPath);
    if (!rawPath.trim() || !filePath.trim()) {
      return { success: false, output: '', error: 'No file path provided' };
    }

    const offset = typeof input.offset === 'number' ? Math.max(1, Math.floor(input.offset)) : undefined;
    const limit = typeof input.limit === 'number' ? Math.max(1, Math.floor(input.limit)) : undefined;
    const isPaginated = offset !== undefined || limit !== undefined;

    // Workspace root (computed dynamically to support tests that change cwd)
    const WORKSPACE_ROOT = path.resolve(process.cwd(), 'workspace');
    fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });

    // Resolve path relative to WORKSPACE_ROOT (same as file_writer)
    const resolved = path.resolve(WORKSPACE_ROOT, filePath);

    if (!resolved.startsWith(WORKSPACE_ROOT)) {
      return { success: false, output: '', error: 'Access denied: path escapes workspace boundary' };
    }

    // Resolve symlinks before re-checking jail (prevents symlink escape attacks)
    let realResolved = resolved;
    try {
      realResolved = fs.realpathSync(resolved);
    } catch {
      // File may not exist yet — realpathSync will fail; we'll handle that below
    }
    if (!realResolved.startsWith(WORKSPACE_ROOT)) {
      return { success: false, output: '', error: 'Access denied: symlink escapes workspace boundary' };
    }

    if (!fs.existsSync(resolved)) {
      return { success: false, output: '', error: `File not found: ${filePath}` };
    }

    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      return { success: false, output: '', error: `Not a file: ${filePath}` };
    }

    const ext = path.extname(resolved).toLowerCase();
    if (ext && !SUPPORTED_EXTENSIONS.has(ext)) {
      return { success: false, output: '', error: 'Binary file not supported' };
    }

    if (isBinaryFile(resolved)) {
      return { success: false, output: '', error: 'Binary file — cannot read as text' };
    }

    const fullContent = fs.readFileSync(resolved, 'utf-8');

    // ── Paginated read ──────────────────────────────────────────────────────
    if (isPaginated) {
      const lines = fullContent.split('\n');
      const totalLines = lines.length;
      const startLine = (offset ?? 1) - 1; // convert to 0-based
      const endLine = limit !== undefined ? startLine + limit : totalLines;
      const slice = lines.slice(startLine, endLine);
      const pageContent = slice.join('\n');
      const hasMore = endLine < totalLines;

      // Partial read: mark in registry so write guard knows this wasn't a full read
      _markFileRead(resolved, stat.mtimeMs, true);

      return {
        success: true,
        output: pageContent +
          (hasMore
            ? `\n\n[Lines ${startLine + 1}–${Math.min(endLine, totalLines)} of ${totalLines}. Use offset=${endLine + 1} to read more.]`
            : `\n\n[Lines ${startLine + 1}–${totalLines} of ${totalLines}. End of file.]`),
      };
    }

    // ── Full read ───────────────────────────────────────────────────────────
    // Register this read so file_writer can enforce read-before-write
    _markFileRead(resolved, stat.mtimeMs, false);

    if (fullContent.length > MAX_CHARS) {
      return {
        success: true,
        output: fullContent.slice(0, MAX_CHARS) +
          `\n\nFile truncated at ${MAX_CHARS} characters. Full file is ${fullContent.length} chars. Use offset/limit to read remaining content.`,
      };
    }

    return { success: true, output: fullContent };
  },
};

export default fileReaderSkill;
