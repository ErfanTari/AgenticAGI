import type { MCPSkill, SkillResult } from '../types.js';
import { safeFetch, SSRFError } from '../../security/ssrf.js';

const MAX_BYTES_DEFAULT = 2_000_000;

const webFetchCleanSkill: MCPSkill = {
  name: 'fetch_url_clean',
  description: 'Fetch a web page and extract clean article content (no nav, ads, footers) via Mozilla Readability. Returns text wrapped in untrusted-content markers. Prefer this over web_fetch for article-style pages.',
  permissionLevel: 'read-only',

  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
      maxBytes: {
        type: 'number',
        description: 'Max response bytes (default 2MB, max 5MB)',
      },
    },
    required: ['url'],
  },

  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const url = String(input.url ?? '').trim();
    if (!url) return { success: false, output: '', error: 'url is required' };

    const maxBytes = Math.min(
      typeof input.maxBytes === 'number' ? input.maxBytes : MAX_BYTES_DEFAULT,
      5_000_000,
    );

    try {
      const response = await safeFetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgenticAGI/1.0)' },
      });

      if (!response.ok) {
        return { success: false, output: '', error: `HTTP ${response.status} from ${url}` };
      }

      // Read with byte cap
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
          return { success: false, output: '', error: `Response exceeded ${maxBytes} bytes` };
        }
        chunks.push(value);
      }

      const html = Buffer.concat(chunks).toString('utf-8');

      // Dynamic import to keep startup fast
      const { JSDOM } = await import('jsdom');
      const { Readability } = await import('@mozilla/readability');

      const dom = new JSDOM(html, { url });
      const article = new Readability(dom.window.document).parse();

      if (!article) {
        // Fallback: return raw text-only content, stripped of tags
        const plainText = html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 4000);
        return {
          success: true,
          output: [
            '<!-- BEGIN UNTRUSTED WEB CONTENT -->',
            `URL: ${url}`,
            '(Readability could not extract article — showing raw text)',
            '',
            plainText,
            '<!-- END UNTRUSTED WEB CONTENT -->',
          ].join('\n'),
        };
      }

      const wrapped = [
        '<!-- BEGIN UNTRUSTED WEB CONTENT -->',
        `Title: ${article.title}`,
        article.byline ? `Byline: ${article.byline}` : '',
        '',
        (article.textContent ?? '').trim(),
        '<!-- END UNTRUSTED WEB CONTENT -->',
      ].filter(Boolean).join('\n');

      return {
        success: true,
        output: wrapped,
        display: `Fetched: ${article.title} (${article.length ?? 0} chars)`,
      };
    } catch (err: unknown) {
      if (err instanceof SSRFError) {
        return { success: false, output: '', error: `SSRF guard blocked ${url}: ${err.message}` };
      }
      return { success: false, output: '', error: String(err) };
    }
  },
};

export default webFetchCleanSkill;
