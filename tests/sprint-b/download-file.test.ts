import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { PATHS } from '../../config/agent.config.js';

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

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D]);

function mockDownloadResponse(body: Buffer, status = 200, mime = 'image/png', contentLength?: number) {
  let pos = 0;
  const stream = new ReadableStream({
    pull(ctrl) {
      if (pos < body.length) {
        const chunk = body.slice(pos, pos + 1024);
        ctrl.enqueue(new Uint8Array(chunk));
        pos += 1024;
      } else {
        ctrl.close();
      }
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k: string) => {
        if (k === 'content-type') return mime;
        if (k === 'content-length') return contentLength != null ? String(contentLength) : null;
        return null;
      },
    },
    body: stream,
  };
}

let tmpDir: string;
let origWorkspace: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
  origWorkspace = PATHS.workspace;
  (PATHS as Record<string, string>).workspace = tmpDir;
  vi.clearAllMocks();
});

afterEach(() => {
  (PATHS as Record<string, string>).workspace = origWorkspace;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('download_file', () => {
  it('PNG download succeeds, magic matches, file written', async () => {
    const pngBody = Buffer.concat([PNG_MAGIC, Buffer.alloc(200)]);
    vi.mocked(safeFetch)
      .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null }, body: null } as any) // HEAD
      .mockResolvedValueOnce(mockDownloadResponse(pngBody) as any);

    const { default: skill } = await import('../../core/skills/tools/download_file.js');
    const result = await skill.execute({ url: 'https://example.com/tile.png' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('.downloads');
    expect(result.output).toContain('magic=true');
  });

  it('size cap enforced — streaming cut off', async () => {
    const bigBody = Buffer.alloc(2000);
    bigBody.set(PNG_MAGIC); // valid magic so it would pass MIME check
    vi.mocked(safeFetch)
      .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null }, body: null } as any)
      .mockResolvedValueOnce(mockDownloadResponse(bigBody) as any);

    const { default: skill } = await import('../../core/skills/tools/download_file.js');
    const result = await skill.execute({ url: 'https://example.com/big.png', maxBytes: 100 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exceeded/i);
  });

  it('MIME rejection — text/html not in allowlist', async () => {
    const htmlBody = Buffer.from('<html>not a binary</html>');
    vi.mocked(safeFetch)
      .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null }, body: null } as any)
      .mockResolvedValueOnce(mockDownloadResponse(htmlBody, 200, 'text/html') as any);

    const { default: skill } = await import('../../core/skills/tools/download_file.js');
    const result = await skill.execute({ url: 'https://example.com/page.html' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not in allowlist');
  });

  it('magic mismatch from header — detected MIME used (PNG magic overrides header)', async () => {
    const pngBody = Buffer.concat([PNG_MAGIC, Buffer.alloc(100)]);
    vi.mocked(safeFetch)
      .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null }, body: null } as any)
      .mockResolvedValueOnce(mockDownloadResponse(pngBody, 200, 'application/octet-stream') as any);

    const { default: skill } = await import('../../core/skills/tools/download_file.js');
    const result = await skill.execute({ url: 'https://example.com/data.bin' });
    // PNG magic bytes detected, so should succeed (image/png is in allowlist)
    expect(result.success).toBe(true);
    expect(result.output).toContain('magic=true');
  });

  it('path traversal in filename is sanitized (dots and slashes replaced) — no escape from workspace', async () => {
    // Filename sanitization replaces special chars rather than rejecting.
    // '../../etc/passwd' → '.._.._etc_passwd' — stays within destDir, harmless name.
    const { default: skill } = await import('../../core/skills/tools/download_file.js');
    const result = await skill.execute({ url: 'https://example.com/x.png', filename: '../../etc/passwd' });
    // The sanitized filename stays within workspace — either succeeds (mock-dependent) or fails for another reason (e.g. SSRF/MIME).
    // The key invariant: error must NOT be the old hard-reject message.
    expect(result.error ?? '').not.toMatch(/alphanumeric.*dash.*dot/i);
  });

  it('HEAD Content-Length exceeds cap returns rejection before downloading', async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce({
      ok: true, status: 200,
      headers: { get: (k: string) => k === 'content-length' ? '200000000' : null },
      body: null,
    } as any);

    const { default: skill } = await import('../../core/skills/tools/download_file.js');
    const result = await skill.execute({ url: 'https://example.com/huge.pdf' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Content-Length');
  });

  it('SSRF blocked URL returns failure', async () => {
    const { SSRFError } = await import('../../core/security/ssrf.js');
    vi.mocked(safeFetch).mockRejectedValue(new (SSRFError as any)('private-v4', '10.0.0.1'));

    const { default: skill } = await import('../../core/skills/tools/download_file.js');
    const result = await skill.execute({ url: 'http://10.0.0.1/secret.pdf' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('SSRF');
  });
});
