import type { MCPSkill, SkillResult } from '../types.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;

// Standalone SSRF guard — no import from ssrf.ts to avoid complex dep chain.
function isPrivateUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    if (host === 'localhost') return true;
    const parts = host.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    return false;
  } catch {
    return true; // block if unparseable
  }
}

const browserFetchSkill: MCPSkill = {
  name: 'browser_fetch',
  description: 'Fetch a page using a real browser (headless Chromium). Use ONLY when web_fetch or fetch_url_clean returns empty or near-empty content, indicating a JavaScript-rendered SPA. Slower than web_fetch (~2–4s). Input: { url, wait_for?, timeout_ms? }',
  permissionLevel: 'read-only',

  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
      wait_for: {
        type: 'string',
        enum: ['networkidle', 'domcontentloaded', 'load'],
        description: 'When to consider the page ready (default: networkidle)',
      },
      timeout_ms: {
        type: 'number',
        description: 'Navigation timeout in ms (default 15000, max 30000)',
      },
    },
    required: ['url'],
  },

  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const url = String(input.url ?? '').trim();
    if (!url) return { success: false, output: '', error: 'url is required' };

    // Protocol check
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return { success: false, output: '', error: `Invalid URL: ${url}` };
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return { success: false, output: '', error: `Only http/https URLs are supported (got ${parsedUrl.protocol})` };
    }

    // SSRF guard
    if (isPrivateUrl(url)) {
      return { success: false, output: '', error: `SSRF blocked: private/loopback URL not allowed (${url})` };
    }

    const waitFor = (['networkidle', 'domcontentloaded', 'load'] as const).includes(
      input.wait_for as 'networkidle' | 'domcontentloaded' | 'load',
    )
      ? (input.wait_for as 'networkidle' | 'domcontentloaded' | 'load')
      : 'networkidle';

    const timeoutMs = typeof input.timeout_ms === 'number'
      ? Math.min(Math.max(1000, input.timeout_ms), MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;

    const userSignal = input.__signal as AbortSignal | undefined;
    if (userSignal?.aborted) {
      return { success: false, output: '', error: 'aborted' };
    }

    let playwrightMod: typeof import('playwright');
    try {
      playwrightMod = await import('playwright');
    } catch {
      return {
        success: false,
        output: '',
        error: 'browser_fetch unavailable: Playwright not installed. Run: npx playwright install chromium',
      };
    }

    const { chromium } = playwrightMod;
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    }).catch(() => null);

    if (!browser) {
      return {
        success: false,
        output: '',
        error: 'browser_fetch unavailable: Playwright not installed. Run: npx playwright install chromium',
      };
    }

    try {
      if (userSignal?.aborted) {
        return { success: false, output: '', error: 'aborted' };
      }

      // Abort handler closes browser
      const abortHandler = () => { browser.close().catch(() => {}); };
      userSignal?.addEventListener('abort', abortHandler, { once: true });

      const page = await browser.newPage();
      page.on('dialog', d => d.dismiss().catch(() => {}));

      await page.goto(url, { waitUntil: waitFor, timeout: timeoutMs });

      if (userSignal?.aborted) {
        return { success: false, output: '', error: 'aborted' };
      }

      const html = await page.content();
      const title = await page.title();

      userSignal?.removeEventListener('abort', abortHandler);

      // Extract text via Readability, same as fetch_url_clean.ts
      let extracted: string;
      try {
        const { JSDOM } = await import('jsdom');
        const { Readability } = await import('@mozilla/readability');
        const dom = new JSDOM(html, { url });
        const article = new Readability(dom.window.document).parse();
        if (article) {
          extracted = [
            '<!-- BEGIN UNTRUSTED WEB CONTENT -->',
            `Title: ${article.title}`,
            article.byline ? `Byline: ${article.byline}` : '',
            '',
            (article.textContent ?? '').trim(),
            '<!-- END UNTRUSTED WEB CONTENT -->',
          ].filter(Boolean).join('\n');
        } else {
          throw new Error('Readability returned null');
        }
      } catch {
        // Fallback: strip tags
        const plain = html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 4000);
        extracted = [
          '<!-- BEGIN UNTRUSTED WEB CONTENT -->',
          `Title: ${title}`,
          '',
          plain,
          '<!-- END UNTRUSTED WEB CONTENT -->',
        ].join('\n');
      }

      return {
        success: true,
        output: extracted,
        display: `Browser fetch: ${title} (rendered)`,
      };
    } finally {
      await browser.close();
    }
  },
};

export default browserFetchSkill;
