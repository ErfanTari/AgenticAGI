import type { MCPSkill, SkillResult } from '../types.js';

interface DDGResponse {
  AbstractText?: string;
  RelatedTopics?: Array<{ Text?: string }>;
}

const DDG_FALLBACK = 'https://api.duckduckgo.com/?q={query}&format=json&no_html=1';

function buildSearchUrl(query: string): string {
  const endpoint = process.env.SEARCH_ENDPOINT || DDG_FALLBACK;
  return endpoint.replace('{query}', encodeURIComponent(query));
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

    const url = buildSearchUrl(query);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

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

export default webSearchSkill;
