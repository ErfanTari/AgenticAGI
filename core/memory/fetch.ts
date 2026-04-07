import fs from 'node:fs';
import { getEntryByCode } from './index.js';
import type { FetchResult } from './types.js';
import { sessionCache } from './session-cache.js';

export function fetchByCode(code: string): FetchResult | undefined {
  // Phase 15: check session cache first
  const cached = sessionCache.getByCode(code);
  if (cached) {
    // FIX B: Verify the cached entry's backing data still exists
    if (!fs.existsSync(cached.path)) {
      console.warn(`[session-cache] Stale cache entry invalidated: ${code} (file missing: ${cached.path})`);
      // Cache entry is stale — fall through to DB lookup below
    } else {
      const content = fs.readFileSync(cached.path, 'utf-8');
      return { entry: cached, content };
    }
  }

  const entry = getEntryByCode(code);
  if (!entry) return undefined;

  // Phase 15: store in session cache after SQLite lookup
  sessionCache.set(code, entry);

  if (!fs.existsSync(entry.path)) {
    console.warn(`Integrity warning: file missing for ${code} at ${entry.path}`);
    return undefined;
  }

  const content = fs.readFileSync(entry.path, 'utf-8');
  return { entry, content };
}
