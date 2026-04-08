/**
 * Session Memory Cache — Phase 15, Section 7
 *
 * In-memory cache for SQLite lookups during a single session.
 * Avoids redundant SQLite queries for entries already loaded.
 * Keys: code → IndexEntry.  Secondary: name (lowercase) → code.
 */
import type { IndexEntry } from './types.js';
import { transparency } from '../transparency.js';
import { upsertPointerEntry } from './pointer-index.js';
import { localDateString } from '../utils/date.js';

class SessionCache {
  private entries: Map<string, IndexEntry> = new Map();
  private nameIndex: Map<string, string> = new Map();

  set(code: string, entry: IndexEntry): void {
    // FIX 6: Never cache terminal PLAN.EX entries — they cannot be resumed and
    // should not appear in context. filterTerminalPlanEx handles the read side,
    // but we should not store them at all.
    if (
      entry.nb === 'PLAN' &&
      entry.type === 'EX' &&
      (entry.status === 'complete' || entry.status === 'failed')
    ) {
      console.debug(`[session-cache] skipping terminal PLAN.EX: ${code} (${entry.status})`);
      transparency.emit({ type: 'session_cache_skip', data: { code, reason: 'terminal_plan_ex', status: entry.status } });
      return;
    }

    // FIX 4: Session cache dedup guard
    // If this code already exists in cache with the same updated timestamp (no real change),
    // skip the redundant write and event emission. This prevents churn-store events
    // when unit-search hits cached entries and then calls upsertPointerEntry for the same code.
    const existing = this.entries.get(code);
    if (existing && existing.updated === entry.updated) {
      // Already in cache with the same version — skip write and event
      return;
    }

    this.entries.set(code, entry);
    if (entry.name) {
      this.nameIndex.set(entry.name.toLowerCase(), code);
    }
    // FIX-H3: Emit session_cache_store transparency event
    transparency.emit({ type: 'session_cache_store', data: { code } });
    // Phase 16: update pointer index for always-loaded MEMORY.md
    if (entry.name && /^[A-Z]+\.[A-Z]+-\d{6,}$/.test(code)) {
      upsertPointerEntry({
        code,
        name: entry.name,
        summary: entry.summary ?? '',
        lastActive: localDateString(),
      });
    }
  }

  getByCode(code: string): IndexEntry | null {
    const entry = this.entries.get(code) ?? null;
    // FIX-H3: Emit session_cache_hit/miss transparency event
    if (entry) {
      transparency.emit({ type: 'session_cache_hit', data: { code } });
    } else {
      transparency.emit({ type: 'session_cache_miss', data: { code } });
    }
    return entry;
  }

  getByName(name: string): IndexEntry | null {
    const lower = name.toLowerCase();
    // Exact match first
    const exactCode = this.nameIndex.get(lower);
    if (exactCode) return this.entries.get(exactCode) ?? null;
    // Fuzzy match: query length >= 3
    if (lower.length >= 3) {
      for (const [cachedName, code] of this.nameIndex) {
        if (cachedName.includes(lower) || lower.includes(cachedName)) {
          return this.entries.get(code) ?? null;
        }
      }
    }
    return null;
  }

  clear(): void {
    this.entries.clear();
    this.nameIndex.clear();
  }

  size(): number {
    return this.entries.size;
  }
}

export const sessionCache = new SessionCache();
