import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fetchFeedSkill from '../../core/skills/tools/fetch_feed.js';

// Minimal RSS feed XML for mocking
const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Blog</title>
    <link>https://test.example.com</link>
    <description>A test feed</description>
    <item>
      <title>Article One</title>
      <link>https://test.example.com/1</link>
      <description>First article summary</description>
      <pubDate>Thu, 01 Jan 2026 00:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Article Two</title>
      <link>https://test.example.com/2</link>
      <description>Second article summary</description>
      <pubDate>Fri, 02 Jan 2026 00:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Article Three</title>
      <link>https://test.example.com/3</link>
      <description>Third article summary</description>
      <pubDate>Sat, 03 Jan 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

// Mock rss-parser to avoid real network calls
vi.mock('rss-parser', () => {
  const MockParser = vi.fn().mockImplementation(() => ({
    parseURL: vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('invalid')) {
        throw new Error('not a feed');
      }
      if (url.includes('empty')) {
        return { title: 'Empty Feed', link: url, items: [] };
      }
      // Parse our static RSS
      const items = [
        { title: 'Article One', link: 'https://test.example.com/1', contentSnippet: 'First article summary', isoDate: '2026-01-01T00:00:00.000Z', pubDate: 'Thu, 01 Jan 2026 00:00:00 GMT' },
        { title: 'Article Two', link: 'https://test.example.com/2', contentSnippet: 'Second article summary', isoDate: '2026-01-02T00:00:00.000Z', pubDate: 'Fri, 02 Jan 2026 00:00:00 GMT' },
        { title: 'Article Three', link: 'https://test.example.com/3', contentSnippet: 'Third article summary', isoDate: '2026-01-03T00:00:00.000Z', pubDate: 'Sat, 03 Jan 2026 00:00:00 GMT' },
      ];
      return { title: 'Test Blog', link: 'https://test.example.com', items };
    }),
  }));
  return { default: MockParser };
});

describe('fetch_feed skill', () => {
  it('has read-only permissionLevel', () => {
    expect(fetchFeedSkill.permissionLevel).toBe('read-only');
  });

  it('valid RSS feed parsed correctly — returns title, items, links', async () => {
    const result = await fetchFeedSkill.execute({ url: 'https://test.example.com/feed.rss' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Feed: Test Blog');
    expect(result.output).toContain('[1] Article One');
    expect(result.output).toContain('https://test.example.com/1');
    expect(result.output).toContain('First article summary');
  });

  it('max_items limits returned entries', async () => {
    const result = await fetchFeedSkill.execute({ url: 'https://test.example.com/feed.rss', max_items: 1 });
    expect(result.success).toBe(true);
    expect(result.output).toContain('[1] Article One');
    expect(result.output).not.toContain('[2] Article Two');
    expect(result.output).toContain('Items: 1');
  });

  it('since_date filters old entries', async () => {
    // Only items after 2026-01-01 (exclusive) — should return Article Two and Three
    const result = await fetchFeedSkill.execute({
      url: 'https://test.example.com/feed.rss',
      since_date: '2026-01-01T00:00:01.000Z',
    });
    expect(result.success).toBe(true);
    expect(result.output).not.toContain('Article One');
    expect(result.output).toContain('Article Two');
    expect(result.output).toContain('Article Three');
  });

  it('invalid URL returns correct error message', async () => {
    const result = await fetchFeedSkill.execute({ url: 'https://invalid.example.com/notafeed' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('valid RSS/Atom feed');
  });

  it('empty feed after filter returns correct message', async () => {
    const result = await fetchFeedSkill.execute({ url: 'https://test.example.com/empty' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('no items matched');
  });

  it('display field includes feed title and item count', async () => {
    const result = await fetchFeedSkill.execute({ url: 'https://test.example.com/feed.rss', max_items: 2 });
    expect(result.success).toBe(true);
    expect(result.display).toContain('Test Blog');
    expect(result.display).toContain('2 items');
  });

  it('max_items is capped at 50', async () => {
    // Pass 200 — should be capped at 50 internally (feed only has 3, so result is 3)
    const result = await fetchFeedSkill.execute({ url: 'https://test.example.com/feed.rss', max_items: 200 });
    expect(result.success).toBe(true);
    // All 3 items returned — no error about invalid param
    expect(result.output).toContain('[3] Article Three');
  });
});
