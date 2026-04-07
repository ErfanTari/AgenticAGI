/**
 * quick-resolve.ts — Pre-decomposition memory retrieval (Phase 20 widened gate)
 *
 * Pattern-matches user messages to resolve memory queries WITHOUT any LLM call.
 * Runs BEFORE decomposition in agent.ts. If it finds results, the agent can
 * respond directly without spending 2-5 seconds on a decomposition call.
 *
 * This module handles four strategies (Phase 20 additions in bold):
 * 1. Code lookup — message contains WHO.CT-000001 etc.
 * 2. Identity query → WHO-first — "who is X", "what is X", "tell me about X"
 * 3. **Listing query** — **"show all contacts", "list projects"** (Phase 20)
 * 4. Name search — message contains a proper noun that matches an entry name.
 */

import { queryEntries, getEntryByCode } from './index.js';
import { fetchByCode } from './fetch.js';
import type { IndexEntry } from './types.js';

export interface QuickResolveResult {
  /** Whether quick-resolve found anything useful. */
  resolved: boolean;
  /** The memory entries found. Empty array if resolved is false. */
  entries: IndexEntry[];
  /** Which strategy succeeded. 'none' if resolved is false. */
  strategy: 'code_lookup' | 'name_search' | 'type_scan' | 'none';
  /** Full markdown body for each entry (parallel array with entries). Populated only when entries.length <= 5. */
  bodies: string[];
}

/**
 * Extracts memory codes like WHO.CT-000001 from a message.
 * Also handles suffixed codes like WHO.CT-000076_zaraban → extracts WHO.CT-000076.
 * Returns an array of unique codes found. Empty array if none.
 */
export function extractCodes(message: string): string[] {
  const trimmed = message.trim();
  // FIX A: Removed trailing \b to allow suffix matching. Uses exec loop with capture
  // groups to reconstruct canonical code without any _suffix.
  const CODE_PATTERN = /\b(WHO|WHAT|WHEN|HOW|WHY|NOW|PLAN)\.(CT|ORG|PJ|KN|CA|DL|EV|RF|HX|PR|SK|MT|QU|TD|RP|LOG|PL|EX|MS)-(\d{6})/g;
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = CODE_PATTERN.exec(trimmed)) !== null) {
    // Reconstruct canonical code from capture groups, stripping any trailing suffix
    results.push(`${match[1]}.${match[2]}-${match[3]}`);
  }
  return [...new Set(results)];
}

/**
 * Detects if the message is an identity question pattern.
 * Returns the entity name if yes, null otherwise.
 *
 * Patterns matched:
 *   "who is X"
 *   "who is X?"
 *   "what is X"
 *   "tell me about X"
 *   "what does X do"
 *
 * FIX B: Identity questions are purely retrieval, not agentic.
 */
export function extractIdentityTarget(message: string): string | null {
  const trimmed = message.trim().replace(/\?+$/, '').trim();
  const patterns: RegExp[] = [
    /^who\s+is\s+(.+)/i,
    /^what\s+is\s+(.+)/i,
    /^tell\s+me\s+about\s+(.+)/i,
    /^what\s+does\s+(.+?)\s+do$/i,
  ];
  for (const pat of patterns) {
    const m = trimmed.match(pat);
    if (m && m[1]) {
      // Strip any memory code from the name portion
      // e.g. "WHO.CT-000076_zaraban" -> "zaraban"
      let name = m[1].trim();
      name = name.replace(/\b(WHO|WHAT|WHEN|HOW|WHY|NOW|PLAN)\.\w+-\d{6}[_\s]*/gi, '').trim();
      if (name.length > 0) return name;
    }
  }
  return null;
}

/**
 * Extracts searchable terms from a message:
 * 1. Quoted strings ("tennis game", 'my project')
 * 2. Capitalized multi-word phrases (Tennis 3D Game)
 * 3. Fallback: longest non-stopword tokens
 *
 * Returns empty array if nothing useful is found.
 */
export function extractSearchTerms(message: string): string[] {
  const terms: string[] = [];

  // 1. Quoted strings — highest quality signal
  const QUOTE_PATTERN = /["'\u201C\u201D]([^"'\u201C\u201D]{2,})["'\u201C\u201D]/g;
  let match: RegExpExecArray | null;
  while ((match = QUOTE_PATTERN.exec(message)) !== null) {
    terms.push(match[1].trim());
  }

  // 2. Capitalized multi-word phrases (skip first word of each sentence)
  const sentenceBodies = message.replace(/^[A-Z][a-z]+\s/gm, '');
  const CAP_PATTERN = /\b([A-Z][a-z]+(?:\s+[A-Z0-9][a-z0-9]*)+)\b/g;
  while ((match = CAP_PATTERN.exec(sentenceBodies)) !== null) {
    terms.push(match[1].trim());
  }

  // 3. Stopword list — common English words that carry no search value
  const STOPWORDS = new Set([
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'must', 'need',
    'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'for', 'at', 'by',
    'in', 'on', 'to', 'of', 'with', 'from', 'up', 'out', 'off', 'over',
    'into', 'about', 'after', 'before', 'between', 'under', 'above',
    'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how',
    'all', 'each', 'every', 'both', 'few', 'more', 'most', 'some', 'any',
    'no', 'other', 'such', 'only', 'same', 'than', 'too', 'very',
    'just', 'also', 'now', 'then', 'here', 'there', 'still', 'already',
    'show', 'tell', 'find', 'get', 'give', 'make', 'know', 'think',
    'see', 'come', 'go', 'take', 'want', 'look', 'use', 'say', 'let',
    'this', 'that', 'these', 'those', 'if', 'as', 'while', 'because',
    'since', 'until', 'unless', 'although', 'though', 'even',
    'please', 'thanks', 'thank', 'hello', 'hi', 'hey',
    'remember', 'recall', 'memory', 'memories', 'everything',
    'list', 'display', 'regarding', 'related',
  ]);

  // If no quoted or capitalized phrases found, extract non-stopword tokens
  if (terms.length === 0) {
    const tokens = message
      .replace(/[^\w\s-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2 && !STOPWORDS.has(t.toLowerCase()));

    // Take at most the 4 longest tokens as search terms
    tokens.sort((a, b) => b.length - a.length);
    terms.push(...tokens.slice(0, 4));
  }

  return [...new Set(terms)];
}

/**
 * Detects listing queries like "show all contacts", "list projects", "what are my todos".
 * Returns { nb, type } for type-scanning, or null if no listing detected.
 *
 * This is moved from unit-search.ts into quickResolve for Phase 20
 * to handle listing queries before decomposition.
 */
export function detectListingQuery(message: string): { nb: string; type: string } | null {
  const lower = message.toLowerCase();

  // Must have explicit listing language
  const LISTING_WORDS = [
    'all ', 'list ', 'list\n', 'show ', 'every ', 'what are my', 'what are the',
    'tell me all', 'tell me the', 'display ', 'give me all', 'give me the',
  ];
  if (!LISTING_WORDS.some(w => lower.includes(w))) return null;

  // Vocabulary: search keywords → notebook + type for listing
  // Copied from unit-search.ts NOTEBOOK_VOCABULARY for Phase 20
  const VOCABULARY: Array<{ keywords: string[]; nb: string; type: string }> = [
    // WHO notebook
    { keywords: ['contact', 'contacts'], nb: 'WHO', type: 'CT' },
    { keywords: ['people', 'person'], nb: 'WHO', type: 'CT' },
    { keywords: ['organization', 'organizations', 'companies', 'company'], nb: 'WHO', type: 'ORG' },
    // WHAT notebook
    { keywords: ['project', 'projects'], nb: 'WHAT', type: 'PJ' },
    { keywords: ['knowledge', 'notes', 'note'], nb: 'WHAT', type: 'KN' },
    // NOW notebook
    { keywords: ['todo', 'todos', 'task', 'tasks', 'to-do', 'to-dos'], nb: 'NOW', type: 'TD' },
    // HOW notebook
    { keywords: ['procedure', 'procedures', 'howto', 'how to', 'how-to'], nb: 'HOW', type: 'PR' },
    { keywords: ['skill', 'skills'], nb: 'HOW', type: 'SK' },
    // WHEN notebook
    { keywords: ['event', 'events'], nb: 'WHEN', type: 'EV' },
    { keywords: ['deadline', 'deadlines', 'due date', 'due dates'], nb: 'WHEN', type: 'DL' },
    // PLAN notebook
    { keywords: ['plan', 'plans', 'planning'], nb: 'PLAN', type: 'PL' },
  ];

  for (const vocab of VOCABULARY) {
    if (vocab.keywords.some(k => lower.includes(k))) {
      return { nb: vocab.nb, type: vocab.type };
    }
  }
  return null;
}

/**
 * Attempts to resolve a user message deterministically without any LLM call.
 *
 * Strategy priority:
 * 1. Code lookup — if the message contains a memory code like WHO.CT-000001
 * 2. Identity query → WHO-first — if "who is X" pattern, search WHO notebook first
 * 3. Listing query → type scan — if "show all contacts" pattern, type-scan results
 * 4. Name search — if extractSearchTerms finds proper nouns or quoted strings,
 *    try queryEntries({ name: term }) before giving up
 *
 * Returns { resolved: false } if no strategy produced results.
 * The caller should then fall through to the normal decomposition pipeline.
 */
export async function quickResolve(message: string): Promise<QuickResolveResult> {
  const EMPTY: QuickResolveResult = { resolved: false, entries: [], strategy: 'none', bodies: [] };

  // ── Strategy 1: Code lookup ──
  const codes = extractCodes(message);
  if (codes.length > 0) {
    const entries: IndexEntry[] = [];
    const bodies: string[] = [];
    for (const code of codes) {
      const entry = getEntryByCode(code);
      if (entry) {
        entries.push(entry);
        try {
          const body = fetchByCode(code);
          bodies.push(typeof body === 'string' ? body : (body?.content ?? ''));
        } catch {
          bodies.push('');
        }
      }
    }
    if (entries.length > 0) {
      return { resolved: true, entries, strategy: 'code_lookup', bodies };
    }
  }

  // ── Strategy 1.5: Identity question → WHO-first name search ──
  // FIX B: Identity questions should search WHO notebook first (people/contacts)
  const identityTarget = extractIdentityTarget(message);
  if (identityTarget) {
    const whoEntries = queryEntries({ nb: 'WHO', name: identityTarget });
    if (whoEntries.length > 0) {
      const bodies: string[] = [];
      for (const entry of whoEntries.slice(0, 5)) {
        try {
          const body = fetchByCode(entry.code);
          bodies.push(typeof body === 'string' ? body : (body?.content ?? ''));
        } catch {
          bodies.push('');
        }
      }
      return { resolved: true, entries: whoEntries.slice(0, 5), strategy: 'name_search', bodies };
    }
    // If no WHO match, fall through to general name search (Strategy 2)
  }

  // ── Strategy 3: Listing query → type scan ──
  // Phase 20: Listing queries like "show all contacts", "list projects"
  const listing = detectListingQuery(message);
  if (listing) {
    const entries = queryEntries({ nb: listing.nb, type: listing.type });
    if (entries.length > 0) {
      // For listing results, don't pre-fetch full bodies (could be 50+ entries)
      // Return summaries only via empty bodies array
      return { resolved: true, entries, strategy: 'type_scan', bodies: [] };
    }
    // Even zero results is a valid resolution — "you have no contacts" is a real answer
    return { resolved: true, entries: [], strategy: 'type_scan', bodies: [] };
  }

  // ── Strategy 4: Name search ──
  const terms = extractSearchTerms(message);
  if (terms.length > 0) {
    for (const term of terms) {
      // queryEntries({ name: ... }) does a name-match lookup in SQLite
      const byName = queryEntries({ name: term });
      if (byName.length > 0) {
        const bodies: string[] = [];
        if (byName.length <= 5) {
          for (const entry of byName) {
            try {
              const body = fetchByCode(entry.code);
              bodies.push(typeof body === 'string' ? body : (body?.content ?? ''));
            } catch {
              bodies.push('');
            }
          }
        }
        return { resolved: true, entries: byName, strategy: 'name_search', bodies };
      }
    }
  }

  return EMPTY;
}
