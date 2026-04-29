import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock safeFetch and ssrf to avoid real network + real DNS in tests
vi.mock('../../core/security/ssrf.js', () => ({
  SSRFError: class SSRFError extends Error {
    name = 'SSRFError';
    constructor(public reason: string, public attemptedHost: string) {
      super(`SSRF blocked: ${reason} (host: ${attemptedHost})`);
    }
  },
  safeFetch: vi.fn(),
  assertSafeUrl: vi.fn(),
}));

import { safeFetch } from '../../core/security/ssrf.js';

const ARTICLE_HTML = `<!DOCTYPE html><html><head><title>Test Article</title></head><body>
<nav>Nav links</nav>
<article>
  <h1>Test Article</h1>
  <p class="byline">By Test Author</p>
  <p>This is the main content of the article. It has enough text to be extracted by Readability as a valid article document.</p>
  <p>More content here to ensure the article threshold is met by the Readability algorithm used in this test case.</p>
</article>
<footer>Footer</footer>
</body></html>`;

function mockResponse(body: string, status = 200, contentType = 'text/html') {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(body);
  let pos = 0;
  const stream = new ReadableStream({
    pull(ctrl) {
      if (pos < bytes.length) {
        ctrl.enqueue(bytes.slice(pos, pos + 1024));
        pos += 1024;
      } else {
        ctrl.close();
      }
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => k === 'content-type' ? contentType : null },
    body: stream,
  };
}

describe('fetch_url_clean', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts article content and wraps in untrusted-content markers', async () => {
    vi.mocked(safeFetch).mockResolvedValue(mockResponse(ARTICLE_HTML) as any);
    const { default: skill } = await import('../../core/skills/tools/fetch_url_clean.js');
    const result = await skill.execute({ url: 'https://example.com/article' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('<!-- BEGIN UNTRUSTED WEB CONTENT -->');
    expect(result.output).toContain('<!-- END UNTRUSTED WEB CONTENT -->');
  });

  it('includes article title in output', async () => {
    vi.mocked(safeFetch).mockResolvedValue(mockResponse(ARTICLE_HTML) as any);
    const { default: skill } = await import('../../core/skills/tools/fetch_url_clean.js');
    const result = await skill.execute({ url: 'https://example.com/article' });
    expect(result.output).toContain('Test Article');
  });

  it('non-article page (Readability returns null) falls back to raw text', async () => {
    const minimalHtml = '<html><body><p>hi</p></body></html>';
    vi.mocked(safeFetch).mockResolvedValue(mockResponse(minimalHtml) as any);
    const { default: skill } = await import('../../core/skills/tools/fetch_url_clean.js');
    const result = await skill.execute({ url: 'https://example.com/' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('<!-- BEGIN UNTRUSTED WEB CONTENT -->');
  });

  it('5xx response returns failure', async () => {
    vi.mocked(safeFetch).mockResolvedValue(mockResponse('Server Error', 503) as any);
    const { default: skill } = await import('../../core/skills/tools/fetch_url_clean.js');
    const result = await skill.execute({ url: 'https://example.com/down' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('503');
  });

  it('byte cap enforced — returns error before writing', async () => {
    // Large body that exceeds a small cap
    const bigHtml = '<html><body>' + 'x'.repeat(100000) + '</body></html>';
    vi.mocked(safeFetch).mockResolvedValue(mockResponse(bigHtml) as any);
    const { default: skill } = await import('../../core/skills/tools/fetch_url_clean.js');
    const result = await skill.execute({ url: 'https://example.com/big', maxBytes: 1000 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exceeded/i);
  });

  it('SSRF error is caught and returned as failure', async () => {
    const { SSRFError } = await import('../../core/security/ssrf.js');
    vi.mocked(safeFetch).mockRejectedValue(new (SSRFError as any)('private-v4', '192.168.1.1'));
    const { default: skill } = await import('../../core/skills/tools/fetch_url_clean.js');
    const result = await skill.execute({ url: 'http://192.168.1.1/' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('SSRF');
  });
});
