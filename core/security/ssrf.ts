import { lookup } from 'node:dns/promises';

export class SSRFError extends Error {
  readonly name = 'SSRFError';
  constructor(public reason: string, public attemptedHost: string) {
    super(`SSRF blocked: ${reason} (host: ${attemptedHost})`);
  }
}

const PRIVATE_V4_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^255\.255\.255\.255$/,
  /^224\./,
  /^240\./,
];

function isPrivateV4(addr: string): boolean {
  return PRIVATE_V4_PATTERNS.some(re => re.test(addr));
}

function isPrivateV6(addr: string): boolean {
  const lower = addr.toLowerCase();
  if (lower === '::1') return true; // loopback
  if (lower.startsWith('fe80:')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
  if (lower.startsWith('ff')) return true; // multicast
  return false;
}

function extractMappedV4(v6addr: string): string | null {
  // ::ffff:a.b.c.d or ::ffff:0xaabbccdd
  const mapped = v6addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) return mapped[1];
  // ::ffff:hex hex (e.g. ::ffff:7f00:1 → 127.0.0.1)
  const hexMapped = v6addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hexMapped) {
    const a = parseInt(hexMapped[1], 16);
    const b = parseInt(hexMapped[2], 16);
    return `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
  }
  return null;
}

export async function assertSafeUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SSRFError('invalid-url', url);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new SSRFError('protocol-not-http(s)', parsed.hostname);
  }

  const host = parsed.hostname;

  // Reject bare IP-style hostnames that need no DNS lookup early
  // (lookup() handles them but this avoids an unnecessary syscall)
  if (isPrivateV4(host)) throw new SSRFError('private-v4-literal', host);
  if (host === 'localhost') throw new SSRFError('localhost', host);

  let resolved: { address: string; family: 4 | 6 };
  try {
    resolved = await lookup(host) as { address: string; family: 4 | 6 };
  } catch {
    throw new SSRFError('dns-resolution-failed', host);
  }

  const { address, family } = resolved;

  if (family === 4) {
    if (isPrivateV4(address)) throw new SSRFError('private-v4', host);
  } else {
    if (isPrivateV6(address)) throw new SSRFError('private-v6', host);
    const mappedV4 = extractMappedV4(address);
    if (mappedV4 && isPrivateV4(mappedV4)) {
      throw new SSRFError('mapped-private-v4', host);
    }
  }
}

export async function safeFetch(
  url: string,
  options: RequestInit = {},
  redirectDepth = 0,
): Promise<Response> {
  if (redirectDepth > 5) throw new SSRFError('too-many-redirects', url);

  await assertSafeUrl(url);

  const response = await fetch(url, { ...options, redirect: 'manual' });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) return response;
    const nextUrl = new URL(location, url).toString();
    return safeFetch(nextUrl, options, redirectDepth + 1);
  }

  return response;
}
