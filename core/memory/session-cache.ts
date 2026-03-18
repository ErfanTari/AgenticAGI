/**
 * Session Memory Cache — Phase 15, Section 7
 *
 * In-memory cache for SQLite lookups during a single session.
 * Avoids redundant SQLite queries for entries already loaded.
 * Keys: code → IndexEntry.  Secondary: name (lowercase) → code.
 */
import type { IndexEntry } from './types.js';
import { transparency } from '../transparency.js';

class SessionCache {
  private entries: Map<string, IndexEntry> = new Map();
  private nameIndex: Map<string, string> = new Map();

  set(code: string, entry: IndexEntry): void {
    this.entries.set(code, entry);
    if (entry.name) {
      this.nameIndex.set(entry.name.toLowerCase(), code);
    }
    // FIX-H3: Emit session_cache_store transparency event
    transparency.emit({ type: 'session_cache_store', data: { code } });
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
