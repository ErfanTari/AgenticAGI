import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { assertSafeUrl, safeFetch, SSRFError } from '../../core/security/ssrf.js';

// Mock dns lookup for unit-testing without real DNS
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    const map: Record<string, { address: string; family: 4 | 6 }> = {
      'example.com': { address: '93.184.216.34', family: 4 },
      'github.com':  { address: '140.82.112.3', family: 4 },
      'safe.example': { address: '8.8.8.8', family: 4 },
    };
    if (map[host]) return map[host];
    // For IP literals, return them directly
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return { address: host, family: 4 as 4 };
    if (host === '::1') return { address: '::1', family: 6 as 6 };
    if (host.startsWith('fc') || host === 'fc00::1') return { address: 'fc00::1', family: 6 as 6 };
    if (host === 'fe80::1') return { address: 'fe80::1', family: 6 as 6 };
    if (host === 'ff02::1') return { address: 'ff02::1', family: 6 as 6 };
    if (host === '::ffff:127.0.0.1') return { address: '::ffff:7f00:1', family: 6 as 6 };
    throw new Error(`DNS resolution failed: ${host}`);
  }),
}));

async function expectBlocked(url: string, reasonPart?: string) {
  await expect(assertSafeUrl(url)).rejects.toThrow(SSRFError);
  if (reasonPart) {
    try { await assertSafeUrl(url); } catch (e: any) { expect(e.message).toContain(reasonPart); }
  }
}

describe('SSRF guard — blocked URLs', () => {
  it('blocks localhost loopback 127.0.0.1', async () => {
    await expectBlocked('http://127.0.0.1:8080/admin');
  });

  it('blocks RFC1918 10.x.x.x', async () => {
    await expectBlocked('http://10.0.0.1/');
  });

  it('blocks RFC1918 192.168.x.x', async () => {
    await expectBlocked('http://192.168.1.1/');
  });

  it('blocks RFC1918 172.16-31.x.x', async () => {
    await expectBlocked('http://172.16.0.1/');
  });

  it('blocks AWS metadata 169.254.169.254', async () => {
    await expectBlocked('http://169.254.169.254/');
  });

  it('blocks IPv6 loopback ::1', async () => {
    await expectBlocked('http://[::1]/');
  });

  it('blocks ULA fc00::1', async () => {
    await expectBlocked('http://[fc00::1]/');
  });

  it('blocks link-local fe80::1', async () => {
    await expectBlocked('http://[fe80::1]/');
  });

  it('blocks IPv4-mapped IPv6 ::ffff:127.0.0.1', async () => {
    await expectBlocked('http://[::ffff:127.0.0.1]/');
  });

  it('blocks 0.0.0.0', async () => {
    await expectBlocked('http://0.0.0.0/');
  });

  it('blocks non-http(s) protocol ftp://', async () => {
    await expect(assertSafeUrl('ftp://example.com/')).rejects.toThrow(SSRFError);
  });

  it('blocks localhost hostname', async () => {
    await expect(assertSafeUrl('http://localhost/admin')).rejects.toThrow(SSRFError);
  });
});

describe('SSRF guard — allowed URLs', () => {
  it('allows https://example.com/', async () => {
    await expect(assertSafeUrl('https://example.com/')).resolves.toBeUndefined();
  });

  it('allows https://github.com/', async () => {
    await expect(assertSafeUrl('https://github.com/')).resolves.toBeUndefined();
  });
});
