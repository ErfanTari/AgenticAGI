import type { MCPSkill, SkillResult } from '../types.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB
const TIMEOUT_MS = 10_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; AgenticAGI/1.0)';

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

const webFetchSkill: MCPSkill = {
  name: 'web_fetch',
  description: 'Fetch a URL and return its page text, all links, and direct download links. Use to browse a website, find catalog links, or read page content. Input: { url, extract_links_matching? }',
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
    const url = String(input.url ?? '').trim();
    if (!url) return { success: false, output: '', error: 'url is required' };

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
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      });
      clearTimeout(timer);

      if (!response.ok) {
        return { success: false, output: '', error: `HTTP ${response.status}: ${response.statusText}` };
      }

      // Guard against oversized responses
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
        return { success: false, output: '', error: `Response too large (${contentLength} bytes, max 2MB)` };
      }

      const html = await response.text();
      if (html.length > MAX_RESPONSE_BYTES) {
        return { success: false, output: '', error: `Response body too large (${html.length} bytes, max 2MB)` };
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
