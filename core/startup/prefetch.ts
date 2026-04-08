/**
 * Startup Prefetch — Phase 5, Task 5
 *
 * On startup:
 * 1. Load MEMORY.md pointer index (always-available name→code map)
 * 2. Prefetch first 20 active memory entries in parallel
 * 3. Cache them for fast warm-start queries
 *
 * Lazy loading: full memory context deferred until first decomposition
 */

import { queryEntries } from '../memory/index.js';
import { fetchByCode } from '../memory/fetch.js';
import { loadPointerIndex, loadPointerIndexEntries } from '../memory/pointer-index.js';
import { sessionCache } from '../memory/session-cache.js';
import { transparency } from '../transparency.js';

export interface PrefetchResult {
  pointerIndexLoaded: boolean;
  pointerEntryCount: number;
  entriesPrefetched: number;
  prefetchTimeMs: number;
}

let prefetchResult: PrefetchResult | null = null;
let pointerIndexCache: string = '';
let contextLazyLoaded = false;

/**
 * runStartupPrefetch — executes on agent startup
 * 1. Loads MEMORY.md pointer index
 * 2. Prefetches first 20 active entries in parallel
 * 3. Caches them for warm-start queries
 */
export async function runStartupPrefetch(): Promise<PrefetchResult> {
  const startTime = Date.now();
  let pointerIndexLoaded = false;
  let pointerEntryCount = 0;
  let entriesPrefetched = 0;

  try {
    // Load pointer index (always-available name→code map)
    pointerIndexCache = loadPointerIndex();
    pointerIndexLoaded = pointerIndexCache.length > 0;
    const pointerEntries = loadPointerIndexEntries();
    pointerEntryCount = pointerEntries.length;

    // Prefetch first 20 active entries in parallel
    const allEntries = queryEntries({ status: 'active' });
    const entriesToPrefetch = allEntries.slice(0, 20);

    const prefetchPromises = entriesToPrefetch.map(async (entry) => {
      try {
        const body = await fetchByCode(entry.code);
        if (body) {
          // Warm session cache with fetched entries
          sessionCache.set(entry.code, { ...entry, updated: new Date().toISOString() });
          return true;
        }
      } catch { /* continue on fetch failure */ }
      return false;
    });

    const prefetchResults = await Promise.all(prefetchPromises);
    entriesPrefetched = prefetchResults.filter(Boolean).length;

    transparency.emit({
      type: 'startup_prefetch',
      data: { pointerEntryCount, entriesPrefetched, timeMs: Date.now() - startTime },
    });
  } catch (err) {
    transparency.emit({
      type: 'startup_prefetch_error',
      data: { error: String(err).slice(0, 100) },
    });
  }

  const prefetchTimeMs = Date.now() - startTime;
  prefetchResult = { pointerIndexLoaded, pointerEntryCount, entriesPrefetched, prefetchTimeMs };
  return prefetchResult;
}

/**
 * getPointerIndexCache — returns cached pointer index
 * Safe to call before and after startup prefetch
 */
export function getPointerIndexCache(): string {
  return pointerIndexCache;
}

/**
 * getPrefetchResult — returns result of startup prefetch (or null if not yet run)
 */
export function getPrefetchResult(): PrefetchResult | null {
  return prefetchResult;
}

/**
 * markContextLazyLoaded — marks that full context has been built (lazy load complete)
 * Called by router/decomposition when first decomposition happens
 */
export function markContextLazyLoaded(): void {
  contextLazyLoaded = true;
  transparency.emit({
    type: 'context_lazy_loaded',
    data: {},
  });
}

/**
 * isContextLazyLoaded — returns true if full context has been built
 * Used to defer expensive context building until first message that needs it
 */
export function isContextLazyLoaded(): boolean {
  return contextLazyLoaded;
}
