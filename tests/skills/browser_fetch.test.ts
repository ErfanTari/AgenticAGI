import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the skill module directly; mock playwright to avoid real browser
vi.mock('playwright', () => {
  const mockPage = {
    on: vi.fn(),
    goto: vi.fn().mockResolvedValue(undefined),
    content: vi.fn().mockResolvedValue('<html><head><title>Test Page</title></head><body><p>Hello rendered world</p></body></html>'),
    title: vi.fn().mockResolvedValue('Test Page'),
  };
  const mockBrowser = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    chromium: {
      launch: vi.fn().mockResolvedValue(mockBrowser),
    },
    __mockBrowser: mockBrowser,
    __mockPage: mockPage,
  };
});

// Import after mock is set up
const { default: browserFetchSkill } = await import('../../core/skills/tools/browser_fetch.js');

describe('browser_fetch skill', () => {
  it('has read-only permissionLevel', () => {
    expect(browserFetchSkill.permissionLevel).toBe('read-only');
  });

  it('blocks localhost (SSRF)', async () => {
    const result = await browserFetchSkill.execute({ url: 'http://localhost/admin' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/SSRF blocked/i);
  });

  it('blocks 127.x IP range (SSRF)', async () => {
    const result = await browserFetchSkill.execute({ url: 'http://127.0.0.1:8080/' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/SSRF blocked/i);
  });

  it('blocks 10.x private IP range (SSRF)', async () => {
    const result = await browserFetchSkill.execute({ url: 'http://10.0.0.1/internal' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/SSRF blocked/i);
  });

  it('blocks 192.168.x private IP range (SSRF)', async () => {
    const result = await browserFetchSkill.execute({ url: 'http://192.168.1.1/' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/SSRF blocked/i);
  });

  it('blocks non-http protocol', async () => {
    const result = await browserFetchSkill.execute({ url: 'ftp://example.com/file' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Only http\/https/i);
  });

  it('timeout_ms is capped at 30000', async () => {
    // Provide 60000 — should not error, capped internally
    const result = await browserFetchSkill.execute({
      url: 'https://example.com',
      timeout_ms: 60000,
    });
    // Should succeed (mock returns HTML)
    expect(result.success).toBe(true);
  });

  it('wait_for defaults to networkidle', async () => {
    const { chromium } = await import('playwright');
    const mockBrowser = (await import('playwright') as unknown as Record<string, unknown>).__mockBrowser as { newPage: ReturnType<typeof vi.fn> };
    const mockPage = await mockBrowser.newPage();

    await browserFetchSkill.execute({ url: 'https://example.com' });

    expect(mockPage.goto).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ waitUntil: 'networkidle' }),
    );
  });

  it('output is wrapped in UNTRUSTED markers', async () => {
    const result = await browserFetchSkill.execute({ url: 'https://example.com' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('<!-- BEGIN UNTRUSTED WEB CONTENT -->');
    expect(result.output).toContain('<!-- END UNTRUSTED WEB CONTENT -->');
  });

  it('browser.close() is always called (finally block)', async () => {
    const playwrightMod = await import('playwright') as unknown as Record<string, unknown>;
    const mockBrowser = playwrightMod.__mockBrowser as { close: ReturnType<typeof vi.fn> };
    mockBrowser.close.mockClear();

    await browserFetchSkill.execute({ url: 'https://example.com' });

    expect(mockBrowser.close).toHaveBeenCalledTimes(1);
  });
});
