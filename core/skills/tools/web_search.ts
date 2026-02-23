import type { MCPSkill, SkillResult } from '../types.js';

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  extra_snippets?: string[];
}

interface BraveResponse {
  web?: { results?: BraveResult[] };
  news?: { results?: BraveResult[] };
}

interface DDGResponse {
  AbstractText?: string;
  RelatedTopics?: Array<{ Text?: string }>;
}

interface SearchResultItem {
  title?: string;
  url?: string;
  link?: string;
  content?: string;
  description?: string;
  snippet?: string;
}

interface SearchApiResponse extends DDGResponse {
  answer?: string;
  results?: SearchResultItem[];
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
const BRAVE_WEB_ENDPOINT_DEFAULT = 'https://api.search.brave.com/res/v1/web/search';
const BRAVE_NEWS_ENDPOINT_DEFAULT = 'https://api.search.brave.com/res/v1/news/search';
const SEARCH_ENDPOINT_DEFAULT = 'https://api.duckduckgo.com/?q={query}&format=json&no_html=1';

function getWebSearchConfig(): {
  braveApiKey: string;
  braveWebEndpoint: string;
  braveNewsEndpoint: string;
  searchEndpoint: string;
} {
  const configuredSearchEndpoint = String(process.env.SEARCH_ENDPOINT ?? '').trim();
  const legacyDdgEndpoint = String(process.env.DUCKDUCKGO_ENDPOINT ?? '').trim();
  const searchEndpointRaw = configuredSearchEndpoint || legacyDdgEndpoint || SEARCH_ENDPOINT_DEFAULT;

  return {
    braveApiKey: String(process.env.BRAVE_SEARCH_API_KEY ?? '').trim(),
    braveWebEndpoint: String(process.env.BRAVE_SEARCH_ENDPOINT ?? BRAVE_WEB_ENDPOINT_DEFAULT).trim() || BRAVE_WEB_ENDPOINT_DEFAULT,
    braveNewsEndpoint: String(process.env.BRAVE_NEWS_ENDPOINT ?? BRAVE_NEWS_ENDPOINT_DEFAULT).trim() || BRAVE_NEWS_ENDPOINT_DEFAULT,
    searchEndpoint: searchEndpointRaw,
  };
}

function buildSearchUrl(endpointTemplate: string, query: string): string {
  const trimmed = endpointTemplate.trim() || SEARCH_ENDPOINT_DEFAULT;

  let url = '';
  if (trimmed.includes('{query}')) {
    url = trimmed.replace(/\{query\}/g, encodeURIComponent(query));
  } else {
    const sep = trimmed.includes('?') ? '&' : '?';
    url = `${trimmed}${sep}q=${encodeURIComponent(query)}`;
  }

  if (/duckduckgo\.com/i.test(url)) {
    if (!/[?&]format=/.test(url)) {
      url += (url.includes('?') ? '&' : '?') + 'format=json';
    }
    if (!/[?&]no_html=/.test(url)) {
      url += '&no_html=1';
    }
  }

  return url;
}

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

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function formatBraveResults(query: string, results: BraveResult[]): string {
  const lines: string[] = [`Search results for '${query}' (via Brave Search):`];
  results.slice(0, 5).forEach((result, index) => {
    const title = (result.title ?? 'Untitled result').trim();
    const url = (result.url ?? '').trim();
    const description = (result.description ?? result.extra_snippets?.[0] ?? '').trim();
    const age = (result.age ?? '').trim();
    const ageSuffix = age ? ` (${age})` : '';
    lines.push(`${index + 1}. ${title}${ageSuffix}`);
    if (url) lines.push(`   ${url}`);
    if (description) lines.push(`   ${description}`);
  });
  return lines.join('\n');
}

function extractBraveResults(data: BraveResponse, preferNews: boolean): BraveResult[] {
  const news = Array.isArray(data.news?.results)
    ? data.news!.results!.filter(r => (r.title ?? '').trim() && (r.url ?? '').trim())
    : [];
  const web = Array.isArray(data.web?.results)
    ? data.web!.results!.filter(r => (r.title ?? '').trim() && (r.url ?? '').trim())
    : [];
  if (preferNews && news.length > 0) return news;
  if (web.length > 0) return web;
  return news;
}

async function searchWithBrave(query: string): Promise<SkillResult> {
  const config = getWebSearchConfig();
  if (!config.braveApiKey) {
    return { success: false, output: '', error: 'Brave API key not configured' };
  }

  const preferNews = isNewsQuery(query);
  const endpoint = preferNews ? config.braveNewsEndpoint : config.braveWebEndpoint;
  const url = `${endpoint}?q=${encodeURIComponent(query)}&count=5`;

  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': config.braveApiKey,
      },
    });
    if (!response.ok) {
      return { success: false, output: '', error: `Brave search unavailable (${response.status})` };
    }
    const data = await response.json() as BraveResponse;
    const results = extractBraveResults(data, preferNews);
    if (results.length === 0) {
      return { success: true, output: `No results found for '${query}'` };
    }
    return { success: true, output: formatBraveResults(query, results) };
  } catch {
    return { success: false, output: '', error: 'Brave search unavailable' };
  }
}

function isNoResults(result: SkillResult): boolean {
  return result.success && /^No results found for '.+'$/i.test(result.output.trim());
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

function formatGenericSearchResults(query: string, results: SearchResultItem[]): string {
  const lines: string[] = [`Search results for '${query}':`];
  results.slice(0, 5).forEach((result, index) => {
    const title = (result.title ?? 'Untitled result').trim();
    const url = (result.url ?? result.link ?? '').trim();
    const snippet = (result.content ?? result.description ?? result.snippet ?? '').trim();
    lines.push(`${index + 1}. ${title}`);
    if (url) lines.push(`   ${url}`);
    if (snippet) lines.push(`   ${snippet}`);
  });
  return lines.join('\n');
}

function extractGenericSearchResults(data: SearchApiResponse): SearchResultItem[] {
  if (!Array.isArray(data.results)) return [];
  return data.results.filter(result => {
    const title = (result.title ?? '').trim();
    const url = (result.url ?? result.link ?? '').trim();
    return title.length > 0 || url.length > 0;
  });
}

const webSearchSkill: MCPSkill = {
  name: 'web_search',
  description: 'Search the web via Brave Search API (with DuckDuckGo fallback). Use when user asks to search, find online, look up current information.',
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

    const brave = await searchWithBrave(query);
    if (brave.success && !isNoResults(brave)) return brave;

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

    const { searchEndpoint } = getWebSearchConfig();
    const searchUrl = buildSearchUrl(searchEndpoint, query);

    try {
      const response = await fetchWithTimeout(searchUrl);

      if (!response.ok) {
        return { success: false, output: '', error: 'Search unavailable' };
      }

      const data = await response.json() as SearchApiResponse;

      const genericResults = extractGenericSearchResults(data);
      if (genericResults.length > 0) {
        return { success: true, output: formatGenericSearchResults(query, genericResults) };
      }

      const parts: string[] = [`Search results for '${query}':`];

      if (data.AbstractText) {
        parts.push(data.AbstractText);
      }
      if (!data.AbstractText && typeof data.answer === 'string' && data.answer.trim()) {
        parts.push(data.answer.trim());
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

      if (parts.length > 1) {
        return { success: true, output: parts.join('\n') };
      }
      if (isNoResults(brave)) {
        return brave;
      }
      return { success: true, output: `No results found for '${query}'` };
    } catch {
      if (isNoResults(brave)) {
        return brave;
      }
      return { success: false, output: '', error: 'Search unavailable' };
    }
  },
};

export default webSearchSkill;
