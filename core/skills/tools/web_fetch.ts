import fs from 'node:fs';
import path from 'node:path';
import type { MCPSkill, SkillResult } from '../types.js';
import { registerSkill } from '../store.js';

const MAX_CHARS = 50000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_TIMEOUT_MS = 10000;

function isTextContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return lower.startsWith('text/')
    || lower.includes('json')
    || lower.includes('xml')
    || lower.includes('javascript');
}

const webFetchSkill: MCPSkill = {
  name: 'web_fetch',
  description: 'Fetch a URL. Can return page content or download and save files locally.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'HTTP or HTTPS URL to fetch' },
      outputPath: { type: 'string', description: 'Optional local file path to save downloaded bytes' },
      timeoutMs: { type: 'number', description: 'Optional fetch timeout in milliseconds' },
      maxBytes: { type: 'number', description: 'Optional max download size in bytes' },
    },
    required: ['url'],
  },
  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const url = String(input.url ?? '').trim();
    const outputPath = String(input.outputPath ?? '').trim();
    const timeoutMs = Number(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const maxBytes = Number(input.maxBytes ?? DEFAULT_MAX_BYTES);

    if (!url) {
      return { success: false, output: '', error: 'No URL provided' };
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { success: false, output: '', error: `Invalid URL: ${url}` };
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { success: false, output: '', error: 'Only http/https URLs are supported' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));

    try {
      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) {
        return { success: false, output: '', error: `Fetch failed: ${response.status} ${response.statusText}` };
      }

      const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
      const data = await response.arrayBuffer();
      const bytes = data.byteLength;

      if (bytes > maxBytes) {
        return {
          success: false,
          output: '',
          error: `Downloaded content too large (${bytes} bytes > ${maxBytes} bytes)`,
        };
      }

      const buf = Buffer.from(data);

      if (outputPath) {
        const resolved = path.resolve(outputPath);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, buf);
        return {
          success: true,
          output: `Downloaded ${bytes} bytes from ${url} to ${resolved} (content-type: ${contentType})`,
        };
      }

      if (!isTextContentType(contentType)) {
        return {
          success: false,
          output: '',
          error: `Fetched binary content (${contentType}). Provide outputPath to save it locally.`,
        };
      }

      const text = buf.toString('utf-8');
      if (text.length > MAX_CHARS) {
        return {
          success: true,
          output: text.slice(0, MAX_CHARS)
            + `\n\nFetched content truncated at ${MAX_CHARS} characters. Full response is ${text.length} chars.`,
        };
      }

      return { success: true, output: text };
    } catch {
      return { success: false, output: '', error: 'Web fetch unavailable' };
    } finally {
      clearTimeout(timer);
    }
  },
};

registerSkill(webFetchSkill);
export default webFetchSkill;
