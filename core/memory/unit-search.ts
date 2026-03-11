import { EMBEDDING_CONFIG } from '../../config/agent.config.js';
import { fetchByCode, getEntryByCode, queryEntries } from './mod.js';
import { searchBM25 } from './fts.js';
import { fetchEmbeddings, searchVectors } from './embeddings.js';
import { transparency } from '../transparency.js';
import type {
  DecomposedUnit,
  RouteKind,
  UnitMemoryResult,
} from '../types.js';
import type { IndexEntry } from './types.js';

const DEFAULT_LIMIT = 4;
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
  const bm25Entries = bm25.map(item => item.entry);

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
    const vectorEntries = vector.map(item => item.entry);
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

async function searchUnit(unit: DecomposedUnit): Promise<UnitMemoryResult> {
  const person = searchPerson(unit.content);
  if (person && person.entries.length > 0) {
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

export async function searchMemoryForUnits(units: DecomposedUnit[]): Promise<UnitMemoryResult[]> {
  return Promise.all(units.map(async unit => {
    try {
      return await searchUnit(unit);
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
