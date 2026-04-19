import { EMBEDDING_CONFIG } from '../../config/agent.config.js';
import { isMemoryFullyDisabled } from '../memory-mode.js';
import { fetchByCode, getEntryByCode, queryEntries } from './mod.js';
import { searchBM25 } from './fts.js';
import { fetchEmbeddings, searchVectors } from './embeddings.js';
import { transparency } from '../transparency.js';
import { sessionCache } from './session-cache.js';
import type {
  DecomposedUnit,
  RouteKind,
  UnitMemoryResult,
} from '../types.js';
import type { IndexEntry } from './types.js';

const DEFAULT_LIMIT = 4;
export const MINIMUM_PLANNER_MEMORY_CONFIDENCE = 0.3;

// FIX 4: Options carrying intake signals into unit-search as scope constraints
export interface UnitSearchOptions {
  projectSignal?: string | null;
  personSignal?: string | null;
  timeSignal?: string | null;
}
const VECTOR_CONFIDENCE_THRESHOLD = 0.45;

const TIME_SIGNAL_PATTERNS = [
  /\blast\s+time\b/i,
  /\byesterday\b/i,
  /\bpreviously\b/i,
  /\brecently\b/i,
  /\blast\s+(week|month)\b/i,
  /\bbefore\b/i,
];

const PROCEDURE_PATTERNS = [
  /\bhow\s+to\b/i,
  /\bhow\s+do\s+i\b/i,
  /\bsteps?\s+for\b/i,
  /\bprocedure\s+for\b/i,
];

const PROJECT_PATTERNS = [
  /\bproject\s+([A-Z][A-Za-z0-9_-]+(?:\s+[A-Z][A-Za-z0-9_-]+)*)/,
  /\b([A-Z][A-Za-z0-9_-]+)\s+project\b/,
];

// Multi-word capitalized sequence (2+ words): high confidence person signal
const PERSON_MULTI_WORD_PATTERN = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/;

// Single capitalized word WITH relationship context words: medium confidence
const PERSON_SINGLE_WITH_CONTEXT_PATTERN =
  /(?:(?:with|by|from|tell|reviewed|is|will|has|about|find|remember)\s+([A-Z][a-z]+)|([A-Z][a-z]+)\s+(?:reviewed|is|will|has|works|worked))/;

// Words that are common command verbs/adjectives — never treat as person names
const PERSON_BLOCKLIST = new Set([
  'Create', 'Remember', 'Build', 'Search', 'Generate', 'Write', 'Find', 'Make',
  'Show', 'Tell', 'Get', 'Set', 'Run', 'Start', 'Stop', 'Add', 'Remove', 'Delete',
  'Update', 'Check', 'Test', 'Fix', 'Help', 'Please', 'Now', 'Today', 'Yesterday',
  'Next', 'Last', 'All', 'Any', 'New', 'Old', 'First', 'Final', 'Complete', 'Simple',
  'Complex', 'Basic', 'Full', 'Quick', 'Large', 'Small', 'Good', 'Best',
  // Question words and auxiliary verbs (appear after title-case normalization)
  'Who', 'What', 'How', 'When', 'Where', 'Why', 'Which',
  'Is', 'Are', 'Was', 'Were', 'Does', 'Did',
  'Can', 'Could', 'Would', 'Should', 'Will',
  // Pronouns and prepositions that appear in query phrasing
  'Me', 'My', 'Your', 'Their', 'Our', 'Its', 'Him', 'Her', 'Them',
  'About', 'The', 'For', 'From', 'With', 'Into', 'And', 'Or', 'Not',
]);

/** Remove terminal PLAN.EX entries — they confuse the planner into thinking work is already active */
function filterTerminalPlanEx(entries: IndexEntry[]): IndexEntry[] {
  const filtered: IndexEntry[] = [];
  for (const e of entries) {
    if (e.nb === 'PLAN' && e.type === 'EX' && (e.status === 'complete' || e.status === 'failed')) {
      transparency.emit({ type: 'memory_context_filtered', data: { code: e.code, reason: 'terminal_plan_ex', status: e.status } });
    } else {
      filtered.push(e);
    }
  }
  return filtered;
}

function uniqueByCode(entries: IndexEntry[]): IndexEntry[] {
  const seen = new Set<string>();
  const unique: IndexEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.code)) continue;
    seen.add(entry.code);
    unique.push(entry);
  }
  return unique;
}

function loadContents(entries: IndexEntry[]): string[] {
  const contents: string[] = [];
  for (const entry of entries) {
    const fetched = fetchByCode(entry.code);
    if (fetched?.content) contents.push(fetched.content);
  }
  return contents;
}

export function filterPlannerContextResult(
  result: UnitMemoryResult,
  minimumConfidence = MINIMUM_PLANNER_MEMORY_CONFIDENCE,
): UnitMemoryResult {
  if (result.confidence >= minimumConfidence || result.entries.length === 0) {
    return result;
  }

  const filteredCodes = result.entries.map(entry => entry.code);
  console.debug(
    `[zaraban][planner] Filtered ${filteredCodes.length} zero-confidence memory entries from planner context for ${result.unitId || 'unknown'}: ${filteredCodes.join(', ')}`
  );

  return {
    ...result,
    entries: [],
    contents: [],
  };
}

export function detectPersonName(content: string): string | null {
  // Normalize to title case so regex matches lowercase input too
  // e.g. "who is erfan tari" → "Who Is Erfan Tari"
  const titleCased = content.replace(/\b([a-z])/g, (_, c: string) => c.toUpperCase());

  // 1. Multi-word capitalized sequence (2+ words): high confidence person signal
  const multiWordMatch = titleCased.match(PERSON_MULTI_WORD_PATTERN);
  if (multiWordMatch?.[1]) {
    const words = multiWordMatch[1].trim().split(/\s+/);
    // Strip leading and trailing blocklist words (question words, verbs, common terms)
    let start = 0;
    let end = words.length;
    while (start < end && PERSON_BLOCKLIST.has(words[start])) start++;
    while (end > start && PERSON_BLOCKLIST.has(words[end - 1])) end--;
    const filtered = words.slice(start, end);
    if (filtered.length >= 2) {
      return filtered.join(' ');
    }
  }

  // 2. Single capitalized word WITH relationship context: medium confidence
  const singleContextMatch = titleCased.match(PERSON_SINGLE_WITH_CONTEXT_PATTERN);
  const candidate = singleContextMatch?.[1] ?? singleContextMatch?.[2];
  if (candidate && !PERSON_BLOCKLIST.has(candidate)) {
    return candidate.trim();
  }

  return null;
}

function detectProjectReference(content: string): string | null {
  for (const pattern of PROJECT_PATTERNS) {
    const match = content.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function detectProcedureReference(content: string): string | null {
  if (!PROCEDURE_PATTERNS.some(pattern => pattern.test(content))) return null;
  const match = content.match(/\b(?:how\s+to|how\s+do\s+i|steps?\s+for|procedure\s+for)\s+(.+)$/i);
  return match?.[1]?.trim() ?? content.trim();
}

function hasTimeSignal(content: string): boolean {
  return TIME_SIGNAL_PATTERNS.some(pattern => pattern.test(content));
}

function getScopedNotebooks(route: RouteKind): string[] | undefined {
  switch (route) {
    case 'conversational':
      return ['WHO', 'WHAT', 'HOW', 'PLAN'];
    case 'agentic':
      return ['HOW', 'WHAT', 'PLAN', 'WHEN', 'WHO'];
    case 'query':
      return undefined;
  }
}

/**
 * FIX 1: BM25 Relevance Gate
 * Returns true if any non-stopword from the query appears in the entry's name or summary.
 * Used to filter BM25 fallback results that have zero semantic relevance to the query.
 * This is deliberately simple — the bar is "does this entry have ANY connection to the query"
 * not "is this entry highly relevant."
 */
function hasMeaningfulOverlap(query: string, entry: IndexEntry): boolean {
  const STOPWORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'it', 'this', 'that', 'be', 'as',
    'are', 'was', 'were', 'use', 'your', 'my', 'me', 'you', 'i', 'every',
    'which', 'hit', 'create', 'make', 'write', 'build', 'add', 'get', 'do',
    'have', 'has', 'will', 'can', 'should', 'would', 'could',
  ]);

  const queryWords = query
    .toLowerCase()
    .split(/\W+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));

  if (queryWords.length === 0) return true; // can't filter, pass through

  const haystack = `${entry.name} ${entry.summary ?? ''}`.toLowerCase();
  return queryWords.some(word => haystack.includes(word));
}

function searchExactOrFuzzy(
  entries: IndexEntry[],
  reference: string,
): { entries: IndexEntry[]; confidence: number } {
  if (entries.length === 0) return { entries: [], confidence: 0 };

  const lower = reference.toLowerCase();
  const exact = entries.filter(entry => entry.name.toLowerCase() === lower);
  if (exact.length > 0) return { entries: exact, confidence: 1.0 };

  return { entries, confidence: 0.85 };
}

function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(token => token.length >= 3);
}

function computeBm25Confidence(query: string, entry: IndexEntry | undefined): number {
  if (!entry) return 0;

  const haystack = `${entry.name} ${entry.summary ?? ''}`.toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length > 2 && haystack.includes(normalizedQuery)) {
    return 0.9;
  }

  const queryTokens = new Set(normalizeTokens(query));
  if (queryTokens.size === 0) return 0;

  const hayTokens = new Set(normalizeTokens(haystack));
  let overlap = 0;
  for (const token of queryTokens) {
    if (hayTokens.has(token)) overlap++;
  }

  const ratio = overlap / queryTokens.size;
  if (ratio >= 0.5) return 0.7;
  if (ratio >= 0.25) return 0.4;
  return 0;
}

/**
 * FIX C: Extracts a notebook hint from a query that contains a memory code prefix.
 * Returns the notebook string (e.g., 'WHO') or null if none found.
 * Exported for testing.
 */
export function extractNotebookHint(query: string): string | null {
  const m = query.match(/\b(WHO|WHAT|WHEN|HOW|WHY|NOW|PLAN)\./i);
  return m ? m[1].toUpperCase() : null;
}

function searchBM25Scoped(
  query: string,
  notebooks: string[] | undefined,
  limit = DEFAULT_LIMIT,
): Array<{ entry: IndexEntry; score: number }> {
  const combined: Array<{ entry: IndexEntry; score: number }> = [];

  if (!notebooks || notebooks.length === 0) {
    for (const result of searchBM25(query, { limit })) {
      const entry = getEntryByCode(result.code);
      if (entry) combined.push({ entry, score: result.score });
    }
    return combined.slice(0, limit);
  }

  for (const nb of notebooks) {
    for (const result of searchBM25(query, { nb, limit })) {
      const entry = getEntryByCode(result.code);
      if (entry) combined.push({ entry, score: result.score });
    }
  }

  return combined
    .sort((a, b) => a.score - b.score)
    .filter((item, index, arr) => arr.findIndex(candidate => candidate.entry.code === item.entry.code) === index)
    .slice(0, limit);
}

async function searchVectorsScoped(
  query: string,
  notebooks: string[] | undefined,
  limit = DEFAULT_LIMIT,
): Promise<Array<{ entry: IndexEntry; score: number }>> {
  const [embedding] = await fetchEmbeddings([query], EMBEDDING_CONFIG ?? undefined);
  const rows = !notebooks || notebooks.length === 0
    ? searchVectors(embedding, { limit })
    : notebooks.flatMap(nb => searchVectors(embedding, { nb, limit }));

  return rows
    .sort((a, b) => b.score - a.score)
    .filter((row, index, arr) => arr.findIndex(candidate => candidate.code === row.code) === index)
    .slice(0, limit)
    .map(row => ({ entry: getEntryByCode(row.code), score: row.score }))
    .filter((item): item is { entry: IndexEntry; score: number } => Boolean(item.entry));
}

/**
 * Vocabulary map: user-facing terms → notebook query parameters.
 * Used to fast-path "list all X" queries before BM25.
 */
export const NOTEBOOK_VOCABULARY: Record<string, { nb: string; type?: string }> = {
  // WHO notebook
  contacts:      { nb: 'WHO', type: 'CT' },
  contact:       { nb: 'WHO', type: 'CT' },
  people:        { nb: 'WHO' },
  person:        { nb: 'WHO' },
  organizations: { nb: 'WHO', type: 'ORG' },
  companies:     { nb: 'WHO', type: 'ORG' },
  // WHAT notebook
  projects:      { nb: 'WHAT', type: 'PJ' },
  project:       { nb: 'WHAT', type: 'PJ' },
  // NOW notebook
  todos:         { nb: 'NOW' },
  tasks:         { nb: 'NOW' },
  // HOW notebook
  procedures:    { nb: 'HOW', type: 'PR' },
  skills:        { nb: 'HOW', type: 'SK' },
  // WHEN notebook
  events:        { nb: 'WHEN', type: 'EV' },
  deadlines:     { nb: 'WHEN', type: 'EV' },
  reminders:     { nb: 'WHEN', type: 'EV' },
};

/**
 * Listing intent tokens: signals that the user wants ALL entries of a type.
 */
export const LIST_INTENT_TOKENS = ['all', 'list', 'every', 'show', 'give me', 'what are', 'tell me', 'show me'];

/**
 * Detect list-intent queries using NOTEBOOK_VOCABULARY.
 * Returns notebook params when a listing token + vocabulary keyword are found.
 */
export function detectListIntent(content: string): { nb: string; type?: string } | null {
  const lower = content.toLowerCase();
  const hasListIntent = LIST_INTENT_TOKENS.some(token => lower.includes(token));
  if (!hasListIntent) return null;
  for (const [term, params] of Object.entries(NOTEBOOK_VOCABULARY)) {
    if (lower.includes(term)) {
      return params;
    }
  }
  return null;
}

// FIX 3: Detect listing queries like "all contacts", "list all projects", "show me my todos"
function detectListingQuery(content: string): { nb: string; type: string } | null {
  const lower = content.toLowerCase();
  const listingLanguage = ['all ', 'list', 'show me', 'tell me', 'every ', 'what are my'];
  const hasListingLanguage = listingLanguage.some(l => lower.includes(l));
  if (!hasListingLanguage) return null;

  const patterns: Array<{ keywords: string[]; nb: string; type: string }> = [
    { keywords: ['contact', 'contacts', 'people', 'person'], nb: 'WHO', type: 'CT' },
    { keywords: ['project', 'projects', 'working on'], nb: 'WHAT', type: 'PJ' },
    { keywords: ['todo', 'todos', 'task', 'tasks', 'to-do'], nb: 'NOW', type: 'TD' },
    { keywords: ['note', 'notes', 'knowledge'], nb: 'WHAT', type: 'KN' },
    { keywords: ['procedure', 'procedures', 'skill', 'skills', 'how to'], nb: 'HOW', type: 'PR' },
    { keywords: ['deadline', 'deadlines', 'due'], nb: 'WHEN', type: 'DL' },
    { keywords: ['plan', 'plans', 'planning'], nb: 'PLAN', type: 'PL' },
    { keywords: ['goal', 'goals', 'objective'], nb: 'WHY', type: 'MT' },
  ];

  for (const pattern of patterns) {
    if (pattern.keywords.some(k => lower.includes(k))) {
      return { nb: pattern.nb, type: pattern.type };
    }
  }
  return null;
}

function searchPerson(content: string): UnitMemoryResult | null {
  const name = detectPersonName(content);
  if (!name) return null;

  const entries = uniqueByCode(queryEntries({ nb: 'WHO', name })).slice(0, DEFAULT_LIMIT);
  const matched = searchExactOrFuzzy(entries, name);
  return {
    unitId: '',
    strategy: 'person',
    confidence: matched.confidence,
    entries: matched.entries,
    contents: loadContents(matched.entries),
  };
}

// FIX 2: Search project by an explicit name (from intake signal or content extraction)
function searchProjectByName(name: string): UnitMemoryResult {
  const entries = uniqueByCode([
    ...queryEntries({ nb: 'PLAN', type: 'PJ', name }),
    ...queryEntries({ nb: 'WHAT', name }),
  ]).slice(0, DEFAULT_LIMIT);
  const matched = searchExactOrFuzzy(entries, name);
  return {
    unitId: '',
    strategy: 'project',
    confidence: matched.confidence,
    entries: matched.entries,
    contents: loadContents(matched.entries),
  };
}

function searchProject(content: string): UnitMemoryResult | null {
  const reference = detectProjectReference(content);
  if (!reference) return null;

  const entries = uniqueByCode([
    ...queryEntries({ nb: 'PLAN', type: 'PJ', name: reference }),
    ...queryEntries({ nb: 'WHAT', name: reference }),
  ]).slice(0, DEFAULT_LIMIT);
  const matched = searchExactOrFuzzy(entries, reference);
  return {
    unitId: '',
    strategy: 'project',
    confidence: matched.confidence,
    entries: matched.entries,
    contents: loadContents(matched.entries),
  };
}

function searchTime(): UnitMemoryResult {
  const entries = uniqueByCode([
    ...queryEntries({ nb: 'WHEN', type: 'EV' }),
    ...queryEntries({ nb: 'WHEN', type: 'RF' }),
  ])
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .slice(0, DEFAULT_LIMIT);

  return {
    unitId: '',
    strategy: 'time',
    confidence: entries.length > 0 ? 0.7 : 0,
    entries,
    contents: loadContents(entries),
  };
}

function searchProcedure(content: string): UnitMemoryResult | null {
  const reference = detectProcedureReference(content);
  if (!reference) return null;

  const entries = uniqueByCode(queryEntries({ nb: 'HOW', type: 'PR', name: reference })).slice(0, DEFAULT_LIMIT);
  const matched = searchExactOrFuzzy(entries, reference);
  return {
    unitId: '',
    strategy: 'procedure',
    confidence: matched.confidence,
    entries: matched.entries,
    contents: loadContents(matched.entries),
  };
}

async function searchFallback(
  unit: DecomposedUnit,
  personSearchResult?: UnitMemoryResult | null,
  projectSearchResult?: UnitMemoryResult | null,
): Promise<Omit<UnitMemoryResult, 'unitId'>> {
  const notebooks = getScopedNotebooks(unit.route);

  // FIX C: If searchPerson found results but with LOW confidence (0 < conf < 0.7),
  // try WHO-scoped BM25 to improve confidence and avoid cross-notebook contamination.
  if (personSearchResult && personSearchResult.entries.length > 0 && personSearchResult.confidence < 0.7) {
    const personName = personSearchResult.entries[0].name;
    const whoScoped = searchBM25Scoped(personName, ['WHO'], DEFAULT_LIMIT);
    if (whoScoped.length > 0) {
      const topWho = whoScoped[0]?.entry;
      const whoConfidence = computeBm25Confidence(personName, topWho);
      const whoEntries = filterTerminalPlanEx(whoScoped.map(item => item.entry));
      if (whoConfidence >= 0.5) {
        return {
          strategy: 'bm25_person_scoped',
          confidence: whoConfidence,
          entries: whoEntries,
          contents: loadContents(whoEntries),
        };
      }
    }
  }

  // FIX C: If searchProject found results but with LOW confidence (0 < conf < 0.7),
  // try WHAT+PLAN-scoped BM25 to improve confidence.
  if (projectSearchResult && projectSearchResult.entries.length > 0 && projectSearchResult.confidence < 0.7) {
    const projectName = projectSearchResult.entries[0].name;
    const whatScoped = searchBM25Scoped(projectName, ['WHAT', 'PLAN'], DEFAULT_LIMIT);
    if (whatScoped.length > 0) {
      const topWhat = whatScoped[0]?.entry;
      const whatConfidence = computeBm25Confidence(projectName, topWhat);
      const whatEntries = filterTerminalPlanEx(whatScoped.map(item => item.entry));
      if (whatConfidence >= 0.5) {
        return {
          strategy: 'bm25_project_scoped',
          confidence: whatConfidence,
          entries: whatEntries,
          contents: loadContents(whatEntries),
        };
      }
    }
  }

  // FIX C: Apply notebook hint scoping to BM25 query if a code prefix is present
  // When user searches for code like "WHO.CT-000076_zaraban", scope results to WHO notebook
  const nbHint = extractNotebookHint(unit.content);

  let bm25 = searchBM25Scoped(unit.content, notebooks, DEFAULT_LIMIT);
  // If notebook hint exists and unscoped results exist, try scoped results first
  if (nbHint && bm25.length > 0) {
    const scopedBm25 = searchBM25Scoped(unit.content, [nbHint], DEFAULT_LIMIT);
    if (scopedBm25.length > 0) {
      bm25 = scopedBm25; // Use scoped results if they exist
    }
  }

  // FIX 1: BM25 Relevance Gate
  // When using generic unscoped BM25 fallback (no prior signal match), filter out results
  // that have zero semantic overlap with the query. This prevents irrelevant entries
  // (e.g., calendar events) from polluting agentic coding unit context.
  const beforeGate = bm25.map(item => item.entry);
  const filteredByGate = beforeGate.filter(entry => hasMeaningfulOverlap(unit.content, entry));

  if (filteredByGate.length < beforeGate.length && filteredByGate.length === 0) {
    // Gate filtered ALL results — emit event and return empty
    transparency.emit({
      type: 'unit_search_filtered',
      data: {
        unitId: unit.id,
        reason: 'bm25_no_overlap',
        droppedCount: beforeGate.length,
      },
    });
    return {
      strategy: 'bm25',
      confidence: 0,
      entries: [],
      contents: [],
    };
  }

  const topBm25 = filteredByGate[0];
  const bm25Confidence = topBm25 ? computeBm25Confidence(unit.content, topBm25) : 0;
  const bm25Entries = filterTerminalPlanEx(filteredByGate);

  if (bm25Entries.length > 0 && bm25Confidence >= VECTOR_CONFIDENCE_THRESHOLD) {
    return {
      strategy: 'bm25',
      confidence: bm25Confidence,
      entries: bm25Entries,
      contents: loadContents(bm25Entries),
    };
  }

  try {
    const vector = await searchVectorsScoped(unit.content, notebooks, DEFAULT_LIMIT);
    const vectorEntries = filterTerminalPlanEx(vector.map(item => item.entry));
    if (vectorEntries.length > 0) {
      return {
        strategy: 'vector_fallback',
        confidence: Math.max(bm25Confidence, 0.5),
        entries: vectorEntries,
        contents: loadContents(vectorEntries),
      };
    }
  } catch {
    // Vector fallback is best-effort.
  }

  return {
    strategy: 'bm25',
    confidence: bm25Confidence,
    entries: bm25Entries,
    contents: loadContents(bm25Entries),
  };
}

async function searchUnit(unit: DecomposedUnit, alreadyResolved?: string[], options?: UnitSearchOptions): Promise<UnitMemoryResult> {
  // Phase 15 Conflict 1: if alreadyResolved codes are provided and any match cached entries,
  // serve from session cache and skip SQLite/BM25/vector for those entries.
  if (alreadyResolved && alreadyResolved.length > 0) {
    const cachedEntries: IndexEntry[] = [];
    for (const code of alreadyResolved) {
      const cached = sessionCache.getByCode(code);
      if (cached) cachedEntries.push(cached);
    }
    const filteredCachedEntries = filterTerminalPlanEx(cachedEntries);
    if (filteredCachedEntries.length > 0) {
      const result: UnitMemoryResult = {
        unitId: unit.id,
        strategy: 'bm25',
        confidence: 0.8,
        entries: filteredCachedEntries,
        contents: loadContents(filteredCachedEntries),
      };
      transparency.emit({ type: 'unit_memory_search', data: { unit, result } });
      return result;
    }
  }

  // FIX-T3: Check session cache by person name BEFORE going to SQLite.
  // This allows the second turn of a multi-turn conversation to get a cache hit
  // when intake doesn't resolve the person (borderline confidence).
  const personName = detectPersonName(unit.content);
  if (personName) {
    const cachedByName = sessionCache.getByName(personName);
    if (cachedByName) {
      // Call getByCode to emit session_cache_hit transparency event
      const cachedEntry = sessionCache.getByCode(cachedByName.code);
      if (cachedEntry) {
        const result: UnitMemoryResult = {
          unitId: unit.id,
          strategy: 'person',
          confidence: 0.8,
          entries: [cachedEntry],
          contents: loadContents([cachedEntry]),
        };
        transparency.emit({ type: 'unit_memory_search', data: { unit, result } });
        return result;
      }
    }
  }

  // FIX 3: Listing fast-path runs FIRST — "all contacts", "list all projects", etc.
  // Must precede signal guards: a false-positive personSignal ("contacts") would otherwise
  // short-circuit before listing detection fires. Listing intent is unambiguous.
  const listingMatch = detectListingQuery(unit.content);
  if (listingMatch) {
    const rawEntries = uniqueByCode(queryEntries({ nb: listingMatch.nb, type: listingMatch.type })).slice(0, 20);
    const entries = filterTerminalPlanEx(rawEntries);
    const result: UnitMemoryResult = { unitId: unit.id, strategy: 'type_scan' as UnitMemoryResult['strategy'], confidence: entries.length > 0 ? 1 : 0, entries, contents: loadContents(entries) };
    transparency.emit({ type: 'unit_search_strategy', data: { strategy: 'type_scan', projectName: null, confidence: result.confidence, codes: entries.map(e => e.code) } });
    transparency.emit({ type: 'unit_memory_search', data: { unit, result } });
    return result;
  }

  // FIX 2a/2b/2c: Vocabulary-based list-intent fast-path for terms not caught by detectListingQuery.
  // Runs AFTER detectListingQuery to avoid breaking existing type_scan behavior.
  // If entries found: return list_intent strategy. If empty: fall through to BM25.
  const vocabMatch = detectListIntent(unit.content);
  if (vocabMatch) {
    const qParams = vocabMatch.type
      ? { nb: vocabMatch.nb, type: vocabMatch.type }
      : { nb: vocabMatch.nb };
    const vocabEntries = uniqueByCode(queryEntries(qParams)).slice(0, 20);
    transparency.emit({ type: 'list_intent_detected', data: { unitContent: unit.content, matched: vocabMatch, resultCount: vocabEntries.length } });
    if (vocabEntries.length > 0) {
      const result: UnitMemoryResult = { unitId: unit.id, strategy: 'list_intent', confidence: 1, entries: vocabEntries, contents: loadContents(vocabEntries) };
      transparency.emit({ type: 'unit_memory_search', data: { unit, result } });
      return result;
    }
    // Empty notebook: fall through to BM25
  }

  // FIX 4+2: Intake projectSignal takes priority over content heuristics (non-listing queries)
  if (options?.projectSignal) {
    const projectResult = searchProjectByName(options.projectSignal);
    const result = { ...projectResult, unitId: unit.id };
    transparency.emit({ type: 'unit_search_strategy', data: { strategy: 'project', projectName: options.projectSignal, confidence: result.confidence, codes: result.entries.map(e => e.code) } });
    transparency.emit({ type: 'unit_memory_search', data: { unit, result } });
    return result;
  }

  // FIX 4+2: Intake personSignal takes priority over content heuristics (when no project signal)
  if (options?.personSignal) {
    const entries = uniqueByCode(queryEntries({ nb: 'WHO', name: options.personSignal })).slice(0, DEFAULT_LIMIT);
    const matched = searchExactOrFuzzy(entries, options.personSignal);
    const result: UnitMemoryResult = { unitId: unit.id, strategy: 'person', confidence: matched.confidence, entries: matched.entries, contents: loadContents(matched.entries) };
    transparency.emit({ type: 'unit_memory_search', data: { unit, result } });
    return result;
  }

  const person = searchPerson(unit.content);
  // Person signal takes priority: if confidence >= 0.7, return immediately without checking project
  if (person && person.entries.length > 0 && person.confidence >= 0.7) {
    // Seed the session cache for future turns (FIX-T3: enables cache hit on next turn)
    for (const entry of person.entries) {
      sessionCache.set(entry.code, entry);
    }
    const result = { ...person, unitId: unit.id };
    transparency.emit({ type: 'unit_memory_search', data: { unit, result } });
    return result;
  }

  const project = searchProject(unit.content);
  if (project && project.entries.length > 0) {
    const result = { ...project, unitId: unit.id };
    transparency.emit({ type: 'unit_memory_search', data: { unit, result } });
    return result;
  }

  // Person found but confidence < 0.7 — still use it if no project match
  if (person && person.entries.length > 0) {
    const result = { ...person, unitId: unit.id };
    transparency.emit({ type: 'unit_memory_search', data: { unit, result } });
    return result;
  }

  if (hasTimeSignal(unit.content)) {
    const result = { ...searchTime(), unitId: unit.id };
    transparency.emit({ type: 'unit_memory_search', data: { unit, result } });
    return result;
  }

  const procedure = searchProcedure(unit.content);
  if (procedure && procedure.entries.length > 0) {
    const result = { ...procedure, unitId: unit.id };
    transparency.emit({ type: 'unit_memory_search', data: { unit, result } });
    return result;
  }

  const fallback = await searchFallback(unit, person, project);
  const result = { ...fallback, unitId: unit.id };
  transparency.emit({ type: 'unit_memory_search', data: { unit, result } });
  return result;
}

export async function searchMemoryForUnits(
  units: DecomposedUnit[],
  alreadyResolvedCodes?: string[],
  options?: UnitSearchOptions,
): Promise<UnitMemoryResult[]> {
  if (isMemoryFullyDisabled()) {
    return units.map(unit => ({
      unitId: unit.id,
      strategy: 'disabled' as const,
      confidence: 0,
      entries: [],
      contents: [],
    }));
  }
  return Promise.all(units.map(async unit => {
    try {
      return await searchUnit(unit, alreadyResolvedCodes, options);
    } catch {
      const result: UnitMemoryResult = {
        unitId: unit.id,
        strategy: 'bm25',
        confidence: 0,
        entries: [],
        contents: [],
      };
      transparency.emit({ type: 'unit_memory_search', data: { unit, result } });
      return result;
    }
  }));
}
