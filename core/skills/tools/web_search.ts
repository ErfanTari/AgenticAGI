import type { MCPSkill, SkillResult } from '../types.js';

interface BraveSearchResponse {
  web?: {
    results?: Array<{
      title?: string;
      description?: string;
      url?: string;
    }>;
  };
}

interface DDGResponse {
  AbstractText?: string;
  RelatedTopics?: Array<{ Text?: string }>;
}

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const DDG_FALLBACK = 'https://api.duckduckgo.com/?q={query}&format=json&no_html=1';

function buildSearchUrl(query: string): string {
  const endpoint = process.env.SEARCH_ENDPOINT || DDG_FALLBACK;
  return endpoint.replace('{query}', encodeURIComponent(query));
}

function buildOfflineFallback(query: string): SkillResult {
  return {
    success: true,
    output: `Search results for '${query}': Search is unavailable in this environment right now.`,
  };
}

const webSearchSkill: MCPSkill = {
  name: 'web_search',
  description: 'Search the web. Use when user asks to search, find online, look up current information.',
  permissionLevel: 'read-only',
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

    const userSignal = input.__signal as AbortSignal | undefined;
    // Try Brave Search API first if key available
    const braveApiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (braveApiKey) {
      try {
        const controller = new AbortController();
        userSignal?.addEventListener('abort', () => controller.abort(userSignal.reason), { once: true });
        const timer = setTimeout(() => controller.abort(), 10000);

        const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=5`;
        const response = await fetch(url, {
          headers: {
            'Accept': 'application/json',
            'X-Subscription-Token': braveApiKey,
          },
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (response.ok) {
          const data = await response.json() as BraveSearchResponse;
          const results = data.web?.results || [];

          if (results.length === 0) {
            return { success: true, output: `No results found for '${query}'` };
          }

          const parts: string[] = [`Search results for '${query}':\n`];
          for (const result of results.slice(0, 3)) {
            if (result.title && result.description) {
              parts.push(`**${result.title}**`);
              parts.push(result.description);
              if (result.url) parts.push(`URL: ${result.url}`);
              parts.push('');
            }
          }

          return { success: true, output: parts.join('\n') };
        } else {
          // Brave key is configured but returned an error — log a warning before falling through
          console.warn(`[web_search] Brave API returned HTTP ${response.status} for query '${query}' — falling back to DuckDuckGo`);
        }
      } catch (err) {
        // Brave request failed (network, timeout, etc.) — log and fall through to DuckDuckGo
        console.warn(`[web_search] Brave API request failed for query '${query}':`, err instanceof Error ? err.message : String(err));
      }
    }

    // Fallback to DuckDuckGo
    const url = buildSearchUrl(query);

    try {
      const controller = new AbortController();
      userSignal?.addEventListener('abort', () => controller.abort(userSignal.reason), { once: true });
      const timer = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (!response.ok) {
        return buildOfflineFallback(query);
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
      return buildOfflineFallback(query);
    }
  },
};

export default webSearchSkill;
