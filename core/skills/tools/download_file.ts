import { writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { MCPSkill, SkillResult } from '../types.js';
import { safeFetch, SSRFError } from '../../security/ssrf.js';
import { PATHS } from '../../../config/agent.config.js';

const DEFAULT_MAX_BYTES = 50_000_000; // 50 MB

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];
let _dlUaIndex = 0;
function getNextUserAgent(): string {
  return USER_AGENTS[_dlUaIndex++ % USER_AGENTS.length];
}

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
    // Sanitize any provided filename — replace spaces and special chars rather than rejecting
    const sanitizedFilename = rawFilename ? rawFilename.replace(/[^a-zA-Z0-9_.\-]/g, '_').replace(/_+/g, '_') : '';

    try {
      // HEAD check for Content-Length
      const head = await safeFetch(url, { method: 'HEAD', headers: { 'User-Agent': getNextUserAgent() } }).catch(() => null);
      const contentLength = head?.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > maxBytes) {
        return { success: false, output: '', error: `Content-Length ${contentLength} exceeds cap of ${maxBytes} bytes` };
      }

      const response = await safeFetch(url, {
        headers: { 'User-Agent': getNextUserAgent() },
      });
      if (!response.ok) {
        if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after');
          const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 5000;
          return { success: false, output: '', error: `Rate limited. Retry after ${waitMs}ms.` };
        }
        return { success: false, output: '', error: `HTTP ${response.status}` };
      }

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
      const finalName = sanitizedFilename || safeBasename;
      const finalPath = join(destDir, finalName);

      // Path traversal guard on final path
      if (!finalPath.startsWith(destDir)) {
        return { success: false, output: '', error: 'Path traversal detected in filename' };
      }

      await writeFile(finalPath, buffer);

      // Compute workspace-relative path so the model can reference it without guessing
      const relativePath = finalPath.startsWith(PATHS.workspace)
        ? finalPath.slice(PATHS.workspace.length).replace(/^\//, '')
        : finalPath;

      return {
        success: true,
        output: [
          `Downloaded ${buffer.length} bytes to ${finalPath}`,
          `WORKSPACE_PATH: ${relativePath}`,
          `MIME: ${effectiveMime} (magic=${detectedMime !== null})`,
        ].join('\n'),
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
