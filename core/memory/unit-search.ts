import { EMBEDDING_CONFIG } from '../../config/agent.config.js';
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

function detectPersonName(content: string): string | null {
  // 1. Multi-word capitalized sequence (2+ words): high confidence person signal
  const multiWordMatch = content.match(PERSON_MULTI_WORD_PATTERN);
  if (multiWordMatch?.[1]) {
    const name = multiWordMatch[1].trim();
    // Reject if all words are in the blocklist
    const words = name.split(/\s+/);
    if (!words.every(w => PERSON_BLOCKLIST.has(w))) {
      return name;
    }
  }

  // 2. Single capitalized word WITH relationship context: medium confidence
  const singleContextMatch = content.match(PERSON_SINGLE_WITH_CONTEXT_PATTERN);
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
): Promise<Omit<UnitMemoryResult, 'unitId'>> {
  const notebooks = getScopedNotebooks(unit.route);
  const bm25 = searchBM25Scoped(unit.content, notebooks, DEFAULT_LIMIT);
  const topBm25 = bm25[0]?.entry;
  const bm25Confidence = computeBm25Confidence(unit.content, topBm25);
  const bm25Entries = filterTerminalPlanEx(bm25.map(item => item.entry));

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
    const entries = uniqueByCode(queryEntries({ nb: listingMatch.nb, type: listingMatch.type, status: 'active' })).slice(0, 20);
    const result: UnitMemoryResult = { unitId: unit.id, strategy: 'type_scan' as UnitMemoryResult['strategy'], confidence: entries.length > 0 ? 1 : 0, entries, contents: loadContents(entries) };
    transparency.emit({ type: 'unit_search_strategy', data: { strategy: 'type_scan', projectName: null, confidence: result.confidence, codes: entries.map(e => e.code) } });
    transparency.emit({ type: 'unit_memory_search', data: { unit, result } });
    return result;
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

  const fallback = await searchFallback(unit);
  const result = { ...fallback, unitId: unit.id };
  transparency.emit({ type: 'unit_memory_search', data: { unit, result } });
  return result;
}

export async function searchMemoryForUnits(
  units: DecomposedUnit[],
  alreadyResolvedCodes?: string[],
  options?: UnitSearchOptions,
): Promise<UnitMemoryResult[]> {
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
