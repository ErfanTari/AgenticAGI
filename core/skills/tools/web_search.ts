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

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

const webSearchSkill: MCPSkill = {
  name: 'web_search',
  description: 'Search the web via Brave Search API. Returns up to 5 results with title, description, and URL. Set snippet_only=true when you plan to web_fetch each result separately.',
  permissionLevel: 'read-only',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      snippet_only: {
        type: 'boolean',
        description: 'When true, return title+URL only (no description). Use when you plan to web_fetch each result.',
      },
    },
    required: ['query'],
  },
  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const query = String(input.query ?? '');
    if (!query.trim()) {
      return { success: false, output: '', error: 'No search query provided' };
    }

    const snippetOnly = input.snippet_only === true;
    const userSignal = input.__signal as AbortSignal | undefined;
    const braveApiKey = process.env.BRAVE_SEARCH_API_KEY;

    if (!braveApiKey) {
      return { success: false, output: '', error: 'Search unavailable: no BRAVE_SEARCH_API_KEY configured and DuckDuckGo fallback has been removed. Set BRAVE_SEARCH_API_KEY in your environment.' };
    }

    try {
      const controller = new AbortController();
      userSignal?.addEventListener('abort', () => controller.abort(userSignal.reason), { once: true });
      const timer = setTimeout(() => controller.abort(), 10000);

      const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=10`;
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'X-Subscription-Token': braveApiKey,
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        return { success: false, output: '', error: `Brave Search API returned HTTP ${response.status}` };
      }

      const data = await response.json() as BraveSearchResponse;
      const results = data.web?.results || [];

      if (results.length === 0) {
        return { success: true, output: `No results found for '${query}'` };
      }

      const parts: string[] = [`Search results for '${query}':\n`];
      let i = 0;
      for (const result of results.slice(0, 5)) {
        if (!result.title || !result.url) continue;
        i++;
        if (snippetOnly) {
          parts.push(`${i}. ${result.title} — ${result.url}`);
        } else {
          parts.push(`**${result.title}**`);
          if (result.description) parts.push(result.description);
          parts.push(`URL: ${result.url}`);
          parts.push('');
        }
      }

      return { success: true, output: parts.join('\n') };
    } catch (err) {
      return { success: false, output: '', error: `Brave Search request failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

export default webSearchSkill;
