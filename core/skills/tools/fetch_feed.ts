import type { MCPSkill, SkillResult } from '../types.js';
import { _getNextUserAgent } from './web_fetch.js';

const MAX_ITEMS_CAP = 50;
const FEED_TIMEOUT_MS = 10_000;

const fetchFeedSkill: MCPSkill = {
  name: 'fetch_feed',
  description: 'Fetch an RSS or Atom feed and return structured entries (title, link, summary, date). Use for monitoring blogs, documentation changelogs, news sources, or academic preprint feeds. Input: { url, max_items?, since_date? }',
  permissionLevel: 'read-only',

  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Feed URL (RSS or Atom)' },
      max_items: {
        type: 'number',
        description: 'Maximum number of items to return (default 10, max 50)',
      },
      since_date: {
        type: 'string',
        description: 'ISO 8601 date string. Only return items published after this date.',
      },
    },
    required: ['url'],
  },

  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const url = String(input.url ?? '').trim();
    if (!url) return { success: false, output: '', error: 'url is required' };

    const maxItems = typeof input.max_items === 'number'
      ? Math.min(Math.max(1, Math.floor(input.max_items)), MAX_ITEMS_CAP)
      : 10;

    const sinceDate = typeof input.since_date === 'string' ? new Date(input.since_date) : null;
    const userSignal = input.__signal as AbortSignal | undefined;

    try {
      // Dynamic import to keep startup fast
      const RSSParser = (await import('rss-parser')).default;

      const controller = new AbortController();
      userSignal?.addEventListener('abort', () => controller.abort(userSignal.reason), { once: true });
      const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);

      const parser = new RSSParser({
        headers: { 'User-Agent': _getNextUserAgent() },
        requestOptions: { signal: controller.signal } as Record<string, unknown>,
        timeout: FEED_TIMEOUT_MS,
      });

      let feed: Awaited<ReturnType<typeof parser.parseURL>>;
      try {
        feed = await parser.parseURL(url);
      } catch (fetchErr: unknown) {
        clearTimeout(timer);
        const msg = String(fetchErr instanceof Error ? fetchErr.message : fetchErr);
        if (msg.toLowerCase().includes('not a feed') || msg.toLowerCase().includes('invalid xml') || msg.toLowerCase().includes('no element found')) {
          return { success: false, output: '', error: 'URL does not appear to be a valid RSS/Atom feed.' };
        }
        return { success: false, output: '', error: `Feed fetch failed: ${msg}` };
      }
      clearTimeout(timer);

      if (userSignal?.aborted) {
        return { success: false, output: '', error: 'aborted' };
      }

      let items = feed.items ?? [];

      // Filter by since_date
      if (sinceDate && !isNaN(sinceDate.getTime())) {
        items = items.filter(item => {
          const pubDate = item.isoDate ? new Date(item.isoDate) : (item.pubDate ? new Date(item.pubDate) : null);
          return pubDate && pubDate > sinceDate;
        });
      }

      // Apply max_items cap
      items = items.slice(0, maxItems);

      if (items.length === 0) {
        return { success: true, output: 'Feed fetched but no items matched the filter.' };
      }

      const feedTitle = feed.title ?? 'Untitled Feed';
      const feedUrl = feed.link ?? url;

      const parts: string[] = [
        `Feed: ${feedTitle}`,
        `URL: ${feedUrl}`,
        `Items: ${items.length}`,
        '',
      ];

      items.forEach((item, idx) => {
        const title = item.title ?? '(no title)';
        const link = item.link ?? '';
        const date = item.isoDate ?? item.pubDate ?? '';
        const snippet = (item.contentSnippet ?? item.content ?? item.summary ?? '').trim().slice(0, 300);

        parts.push(`[${idx + 1}] ${title}`);
        if (date) parts.push(`Date: ${date}`);
        if (link) parts.push(`Link: ${link}`);
        if (snippet) parts.push(`Summary: ${snippet}`);
        parts.push('');
      });

      return {
        success: true,
        output: parts.join('\n'),
        display: `Feed: ${feedTitle} (${items.length} items)`,
      };
    } catch (err: unknown) {
      return { success: false, output: '', error: `Feed error: ${String(err)}` };
    }
  },
};

export default fetchFeedSkill;
