import type { MCPSkill, SkillResult } from '../types.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB
const TIMEOUT_MS = 10_000;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

let _uaIndex = 0;
export function _getNextUserAgent(): string {
  return USER_AGENTS[_uaIndex++ % USER_AGENTS.length];
}
export function _resetUaIndex(): void { _uaIndex = 0; }

function resolveUrl(href: string, base: string): string | null {
  try {
    if (href.startsWith('http')) return href;
    if (href.startsWith('//')) return 'https:' + href;
    if (href.startsWith('/')) return new URL(base).origin + href;
    if (href.startsWith('#')) return null;
    if (href.startsWith('mailto:')) return null;
    if (href.startsWith('javascript:')) return null;
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function extractLinks(html: string, baseUrl: string): string[] {
  const urls: string[] = [];

  for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const url = resolveUrl(match[1], baseUrl);
    if (url) urls.push(url);
  }

  for (const match of html.matchAll(/src=["']([^"']+)["']/gi)) {
    const url = resolveUrl(match[1], baseUrl);
    if (url) urls.push(url);
  }

  return [...new Set(urls)];
}

const DIRECT_EXTENSIONS = ['.pdf', '.zip', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.html', '.htm', '.docx', '.xlsx'];

function isDirectDownload(url: string): boolean {
  const lower = url.toLowerCase();
  return DIRECT_EXTENSIONS.some(ext => lower.includes(ext));
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim() : '';
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// FIX 7: Auto-rewrite GitHub blob URLs to raw.githubusercontent.com
export function rewriteGitHubBlobUrl(url: string): string {
  const blobMatch = url.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/
  );
  if (blobMatch) {
    const [, owner, repo, rest] = blobMatch;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${rest}`;
  }
  return url;
}

const webFetchSkill: MCPSkill = {
  name: 'web_fetch',
  description: 'Fetch a URL and return its page text, all links, and direct download links. Use to browse a website, find catalog links, or read page content. Input: { url, extract_links_matching? }',
  permissionLevel: 'read-only',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' },
      extract_links_matching: {
        type: 'string',
        description: 'Optional substring filter for links (e.g. ".pdf", "download", "catalog")',
      },
    },
    required: ['url'],
  },

  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const rawUrl = String(input.url ?? '').trim();
    if (!rawUrl) return { success: false, output: '', error: 'url is required' };
    const url = rewriteGitHubBlobUrl(rawUrl);

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return { success: false, output: '', error: `Invalid URL: ${url}` };
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return { success: false, output: '', error: 'Only http/https URLs are supported' };
    }

    try {
      const userSignal = input.__signal as AbortSignal | undefined;
      const controller = new AbortController();
      userSignal?.addEventListener('abort', () => controller.abort(userSignal.reason), { once: true });
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const FETCH_DELAY_MS = 200 + Math.floor(Math.random() * 300);
      await new Promise(r => setTimeout(r, FETCH_DELAY_MS));

      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': _getNextUserAgent(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      });
      clearTimeout(timer);

      if (!response.ok) {
        return { success: false, output: '', error: `HTTP ${response.status}: ${response.statusText}` };
      }

      // Guard against oversized responses — on Content-Length hit, return partial with advisory
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
        // Strategy A: read first 512KB and extract links — more useful than a hard error
        const PARTIAL_BYTES = 512 * 1024;
        const reader = response.body?.getReader();
        let partialHtml = '';
        if (reader) {
          const chunks: Uint8Array[] = [];
          let total = 0;
          while (total < PARTIAL_BYTES) {
            const { value, done } = await reader.read();
            if (done) break;
            total += value.byteLength;
            chunks.push(value);
          }
          await reader.cancel().catch(() => {});
          partialHtml = Buffer.concat(chunks).toString('utf-8');
        }
        const finalUrl = response.url || url;
        const allLinks = extractLinks(partialHtml, finalUrl);
        const filterPattern = input.extract_links_matching ? String(input.extract_links_matching).toLowerCase() : null;
        const filteredLinks = filterPattern ? allLinks.filter(l => l.toLowerCase().includes(filterPattern)) : allLinks;
        const directLinks = allLinks.filter(isDirectDownload);
        const linkSection = filteredLinks.length > 0
          ? `Links found (${filteredLinks.length}${filterPattern ? `, matching "${filterPattern}"` : ''}):\n${filteredLinks.slice(0, 20).join('\n')}`
          : 'Links found (0)';
        const directSection = directLinks.length > 0
          ? `Direct download links:\n${directLinks.slice(0, 20).join('\n')}`
          : 'Direct download links: none';
        return {
          success: true,
          output: `[PARTIAL — response ${contentLength} bytes exceeds 2MB cap; extracted links from first 512KB]\nURL: ${finalUrl}\n${linkSection}\n${directSection}\nHint: if you see a .pdf link above, call download_file on it directly.`,
        };
      }

      const html = await response.text();
      if (html.length > MAX_RESPONSE_BYTES) {
        // Body arrived larger than declared — same partial extraction
        const partialHtml = html.slice(0, 512 * 1024);
        const finalUrl = response.url || url;
        const allLinks = extractLinks(partialHtml, finalUrl);
        const filterPattern = input.extract_links_matching ? String(input.extract_links_matching).toLowerCase() : null;
        const filteredLinks = filterPattern ? allLinks.filter(l => l.toLowerCase().includes(filterPattern)) : allLinks;
        const directLinks = allLinks.filter(isDirectDownload);
        return {
          success: true,
          output: `[PARTIAL — body ${html.length} bytes exceeds 2MB cap; extracted links from first 512KB]\nURL: ${finalUrl}\nLinks found (${filteredLinks.length}):\n${filteredLinks.slice(0, 20).join('\n')}\nDirect download links:\n${directLinks.slice(0, 10).join('\n') || 'none'}\nHint: if you see a .pdf link above, call download_file on it directly.`,
        };
      }

      const finalUrl = response.url || url;
      const title = extractTitle(html);
      const allLinks = extractLinks(html, finalUrl);
      const directLinks = allLinks.filter(isDirectDownload);

      const filterPattern = input.extract_links_matching ? String(input.extract_links_matching).toLowerCase() : null;
      const filteredLinks = filterPattern
        ? allLinks.filter(l => l.toLowerCase().includes(filterPattern))
        : allLinks;

      const text = htmlToText(html);
      const trimmedText = text.length > 5000 ? text.slice(0, 5000) + '...[truncated]' : text;

      const linkSection = filteredLinks.length > 0
        ? `\nLinks found (${filteredLinks.length}${filterPattern ? `, matching "${filterPattern}"` : ''}):\n${filteredLinks.slice(0, 20).join('\n')}`
        : '\nLinks found (0)';

      const directSection = directLinks.length > 0
        ? `\nDirect download links:\n${directLinks.slice(0, 20).join('\n')}`
        : '\nDirect download links: none';

      const output = `Page: ${title}
URL: ${finalUrl}
Content:
${trimmedText}
${linkSection}
${directSection}`;

      return { success: true, output };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: '', error: `Fetch failed: ${message}` };
    }
  },
};

export default webFetchSkill;
