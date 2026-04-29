import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { MCPSkill, SkillResult } from '../types.js';
import { assertSafeUrl, SSRFError } from '../../security/ssrf.js';
import { PATHS } from '../../../config/agent.config.js';

const screenshotUrlSkill: MCPSkill = {
  name: 'screenshot_url',
  description: 'Capture a screenshot of a URL using headless Chromium. Saves PNG to workspace/.downloads/. SSRF-protected. Returns the file path for downstream view_image calls.',
  permissionLevel: 'workspace-write',

  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to screenshot' },
      filename: {
        type: 'string',
        description: 'Optional output filename (must end in .png)',
      },
      width: { type: 'number', description: 'Viewport width (default 1280)' },
      height: { type: 'number', description: 'Viewport height (default 720)' },
      fullPage: { type: 'boolean', description: 'Capture full page (default false)' },
    },
    required: ['url'],
  },

  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const url = String(input.url ?? '').trim();
    if (!url) return { success: false, output: '', error: 'url is required' };

    try {
      await assertSafeUrl(url);
    } catch (err) {
      if (err instanceof SSRFError) {
        return { success: false, output: '', error: `SSRF blocked: ${err.message}` };
      }
      return { success: false, output: '', error: String(err) };
    }

    const width = typeof input.width === 'number' ? Math.min(Math.max(input.width, 320), 3840) : 1280;
    const height = typeof input.height === 'number' ? Math.min(Math.max(input.height, 240), 2160) : 720;
    const fullPage = input.fullPage === true;

    const rawFilename = typeof input.filename === 'string' ? input.filename.trim() : '';
    const filename = rawFilename || `screenshot_${Date.now()}.png`;
    if (!/^[a-zA-Z0-9_.\-]+\.png$/.test(filename)) {
      return { success: false, output: '', error: 'filename must be alphanumeric/dash/dot/underscore and end with .png' };
    }

    try {
      const { chromium } = await import('playwright');
      const downloadsDir = join(PATHS.workspace, '.downloads');
      await mkdir(downloadsDir, { recursive: true });
      const filePath = join(downloadsDir, filename);

      const browser = await chromium.launch({ headless: true });
      try {
        const context = await browser.newContext({ viewport: { width, height } });
        const page = await context.newPage();
        page.on('dialog', d => d.dismiss().catch(() => {}));
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
        await page.screenshot({ path: filePath, fullPage });
      } finally {
        await browser.close();
      }

      return {
        success: true,
        output: `Screenshot saved to ${filePath} (${width}×${height}, fullPage=${fullPage})`,
        display: `Screenshot: ${filename}`,
      };
    } catch (err) {
      return { success: false, output: '', error: `Screenshot failed: ${String(err)}` };
    }
  },
};

export default screenshotUrlSkill;
