import { writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { MCPSkill, SkillResult } from '../types.js';
import { safeFetch, SSRFError } from '../../security/ssrf.js';
import { PATHS } from '../../../config/agent.config.js';

const DEFAULT_MAX_BYTES = 50_000_000; // 50 MB

const MIME_ALLOWLIST = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf',
  'text/plain', 'text/markdown', 'text/csv',
  'application/json',
  'application/zip',
];

const MAGIC: Array<{ mime: string; bytes: number[] }> = [
  { mime: 'image/png',  bytes: [0x89, 0x50, 0x4E, 0x47] },
  { mime: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/gif',  bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'application/zip', bytes: [0x50, 0x4B, 0x03, 0x04] },
];

function detectMime(buf: Buffer): string | null {
  for (const { mime, bytes } of MAGIC) {
    if (bytes.every((b, i) => buf[i] === b)) return mime;
  }
  return null;
}

const downloadFileSkill: MCPSkill = {
  name: 'download_file',
  description: 'Download a binary file from a URL to workspace. Enforces 50MB cap, MIME allowlist, and magic-number verification. SSRF-protected. Defaults to workspace/.downloads/ unless destDir is specified.',
  permissionLevel: 'workspace-write',

  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to download' },
      filename: {
        type: 'string',
        description: 'Optional filename (alphanumeric/dash/dot/underscore only). Defaults to URL basename.',
      },
      destDir: {
        type: 'string',
        description: 'Optional destination directory relative to workspace root (e.g. "Catalogs_2026"). Must stay within workspace. Defaults to .downloads/',
      },
      maxBytes: {
        type: 'number',
        description: 'Max bytes to download (default 50MB, max 100MB)',
      },
    },
    required: ['url'],
  },

  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const url = String(input.url ?? '').trim();
    if (!url) return { success: false, output: '', error: 'url is required' };

    const maxBytes = Math.min(
      typeof input.maxBytes === 'number' ? input.maxBytes : DEFAULT_MAX_BYTES,
      100_000_000,
    );

    const rawFilename = typeof input.filename === 'string' ? input.filename.trim() : '';
    if (rawFilename && !/^[a-zA-Z0-9_.\-]+$/.test(rawFilename)) {
      return { success: false, output: '', error: 'filename must only contain alphanumeric, dash, dot, or underscore characters' };
    }

    try {
      // HEAD check for Content-Length
      const head = await safeFetch(url, { method: 'HEAD' }).catch(() => null);
      const contentLength = head?.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > maxBytes) {
        return { success: false, output: '', error: `Content-Length ${contentLength} exceeds cap of ${maxBytes} bytes` };
      }

      const response = await safeFetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgenticAGI/1.0)' },
      });
      if (!response.ok) return { success: false, output: '', error: `HTTP ${response.status}` };

      const reader = response.body?.getReader();
      if (!reader) return { success: false, output: '', error: 'No response body' };

      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          return { success: false, output: '', error: `Download exceeded ${maxBytes} bytes` };
        }
        chunks.push(value);
      }

      const buffer = Buffer.concat(chunks);
      const detectedMime = detectMime(buffer);
      const headerMime = response.headers.get('content-type')?.split(';')[0]?.trim() ?? null;
      const effectiveMime = detectedMime ?? headerMime;

      if (!effectiveMime || !MIME_ALLOWLIST.includes(effectiveMime)) {
        return { success: false, output: '', error: `MIME type '${effectiveMime ?? 'unknown'}' not in allowlist` };
      }

      const rawDestDir = typeof input.destDir === 'string' ? input.destDir.trim() : '';
      const destDir = rawDestDir
        ? join(PATHS.workspace, rawDestDir.replace(/^\/+/, ''))
        : join(PATHS.workspace, '.downloads');
      // Path traversal guard on destDir
      if (!destDir.startsWith(PATHS.workspace)) {
        return { success: false, output: '', error: 'destDir must stay within workspace' };
      }
      await mkdir(destDir, { recursive: true });

      const urlBasename = basename(new URL(url).pathname) || 'download';
      const safeBasename = urlBasename.replace(/[^a-zA-Z0-9_.\-]/g, '_');
      const finalName = rawFilename || safeBasename;
      const finalPath = join(destDir, finalName);

      // Path traversal guard on final path
      if (!finalPath.startsWith(destDir)) {
        return { success: false, output: '', error: 'Path traversal detected in filename' };
      }

      await writeFile(finalPath, buffer);

      return {
        success: true,
        output: `Downloaded ${buffer.length} bytes to ${finalPath} (${effectiveMime}, magic=${detectedMime !== null})`,
        display: `Downloaded: ${finalName} (${Math.round(buffer.length / 1024)}KB, ${effectiveMime})`,
      };
    } catch (err: unknown) {
      if (err instanceof SSRFError) {
        return { success: false, output: '', error: `SSRF blocked: ${err.message}` };
      }
      return { success: false, output: '', error: String(err) };
    }
  },
};

export default downloadFileSkill;
