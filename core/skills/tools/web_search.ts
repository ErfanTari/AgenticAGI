import type { MCPSkill, SkillResult } from '../types.js';
import { registerSkill } from '../store.js';

interface DDGResponse {
  AbstractText?: string;
  RelatedTopics?: Array<{ Text?: string }>;
}

interface NewsItem {
  title: string;
  link: string;
  pubDate?: string;
}

const NEWS_QUERY_PATTERNS = [
  /\bnews\b/i,
  /\bheadlines?\b/i,
  /\bbreaking\b/i,
  /\btoday\b/i,
];

const FETCH_TIMEOUT_MS = 5000;

function isNewsQuery(query: string): boolean {
  return NEWS_QUERY_PATTERNS.some(pattern => pattern.test(query));
}

function decodeXml(text: string): string {
  return text
    .replace(/^<!\[CDATA\[/, '')
    .replace(/\]\]>$/, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTagValue(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!match) return '';
  return decodeXml(match[1]).trim();
}

function parseNewsItems(rssXml: string, limit = 3): NewsItem[] {
  const matches = [...rssXml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  return matches
    .slice(0, limit)
    .map(match => {
      const itemXml = match[1];
      return {
        title: extractTagValue(itemXml, 'title'),
        link: extractTagValue(itemXml, 'link'),
        pubDate: extractTagValue(itemXml, 'pubDate'),
      };
    })
    .filter(item => item.title && item.link);
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function formatNewsItems(query: string, items: NewsItem[]): string {
  const lines: string[] = [`Top news for '${query}':`];
  items.forEach((item, index) => {
    const dateSuffix = item.pubDate ? ` (${item.pubDate})` : '';
    lines.push(`${index + 1}. ${item.title}${dateSuffix}`);
    lines.push(`   ${item.link}`);
  });
  return lines.join('\n');
}

const webSearchSkill: MCPSkill = {
  name: 'web_search',
  description: 'Search the web. Use when user asks to search, find online, look up current information.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
    },
    required: ['query'],
  },
  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const query = String(input.query ?? '');
    if (!query.trim()) {
      return { success: false, output: '', error: 'No search query provided' };
    }

    if (isNewsQuery(query)) {
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
      try {
        const newsResponse = await fetchWithTimeout(rssUrl);
        if (newsResponse.ok) {
          const rssText = await newsResponse.text();
          const items = parseNewsItems(rssText, 3);
          if (items.length > 0) {
            return { success: true, output: formatNewsItems(query, items) };
          }
        }
      } catch {
        // Fall through to DuckDuckGo fallback.
      }
    }

    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;

    try {
      const response = await fetchWithTimeout(ddgUrl);

      if (!response.ok) {
        return { success: false, output: '', error: 'Search unavailable' };
      }

      const data = await response.json() as DDGResponse;
      const parts: string[] = [`Search results for '${query}':`];

      if (data.AbstractText) {
        parts.push(data.AbstractText);
      }

      if (data.RelatedTopics && data.RelatedTopics.length > 0) {
        const topics = data.RelatedTopics
          .filter(t => t.Text)
          .slice(0, 3)
          .map(t => t.Text!);
        if (topics.length > 0) {
          parts.push('');
          parts.push('Related: ' + topics.join(' | '));
        }
      }

      if (parts.length === 1) {
        return { success: true, output: `No results found for '${query}'` };
      }

      return { success: true, output: parts.join('\n') };
    } catch {
      return { success: false, output: '', error: 'Search unavailable' };
    }
  },
};

registerSkill(webSearchSkill);
export default webSearchSkill;
