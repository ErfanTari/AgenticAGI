import type { Classification, Intent } from './types.js';

const CODE_REGEX = /\b([A-Z]+\.[A-Z]+-\d{6,})\b/g;

const GREETING_REGEX = /^\s*(hi|hello|hey|good\s+(morning|afternoon|evening)|howdy|greetings)\b/i;

// --- Write patterns (order matters: checked before read patterns) ---
const WRITE_PATTERNS = [
  /\b(create|add|new|write|save|store|remember)\b/i,
  /\bremind\s+me\b/i,
  /\bschedule\b/i,
  /\bnew\s+(contact|project|todo|task|event|deadline|procedure|plan)\b/i,
];

// --- Web search patterns ---
const WEB_SEARCH_PATTERNS = [
  /\bsearch\s+the\s+web\b/i,
  /\bsearch\s+for\b/i,
  /\blook\s+up\s+online\b/i,
  /\bgoogle\b/i,
  /\bsearch\s+online\b/i,
  /\bweb\s+search\b/i,
];

// --- WHO patterns ---
const WHO_PATTERNS = [
  /\bwho\s+is\b/i,
  /\bcontacts?\b/i,
  /\bperson\b|\bpeople\b/i,
  /\bworks?\s+for\b/i,
  /\borganizations?\b|\bcompan(?:y|ies)\b/i,
  /\bfind\s+[A-Z][a-z]/,  // "find Reza" — capitalized name after "find"
];

// --- WHAT patterns ---
const WHAT_PATTERNS = [
  /\bprojects?\b/i,
  /\bstatus\s+of\b/i,
  /\bwhat\s+is\s+the\s+status\b/i,
  /\bwhat\s+is\s+(?:project|entry|knowledge)\b/i,
  /\bknowledge\b/i,
];

// --- WHEN patterns ---
const WHEN_PATTERNS = [
  /\bwhen\s+is\b/i,
  /\bmeeting\b/i,
  /\bcalendar\b/i,
  /\bdeadlines?\b/i,
  /\bevents?\b/i,
  /\bnext\s+meeting\b/i,
];

// --- HOW patterns ---
const HOW_PATTERNS = [
  /\bhow\s+do\s+I\b/i,
  /\bhow\s+to\b/i,
  /\bprocedures?\b/i,
  /\bsteps?\s+to\b/i,
];

// --- WHY patterns ---
const WHY_PATTERNS = [
  /\breflections?\b/i,
  /\bquestions?\b/i,
  /\bwhy\s+did\b/i,
  /\bopen\s+questions?\b/i,
];

// --- NOW patterns ---
const NOW_PATTERNS = [
  /\btodos?\b/i,
  /\btasks?\b/i,
  /\breports?\b/i,
  /\boverdue\b/i,
];

// --- PLAN patterns ---
const PLAN_PATTERNS = [
  /\bplanning\b|\bplans?\b/i,
];

// Notebook type mappings for pattern-based detection
const NOTEBOOK_PATTERNS: Array<{ pattern: RegExp; nb: string; type: string }> = [
  { pattern: /\bcontacts?\b/i,                        nb: 'WHO',  type: 'CT' },
  { pattern: /\borganizations?\b|\bcompan(?:y|ies)\b/i, nb: 'WHO',  type: 'ORG' },
  { pattern: /\bprojects?\b/i,                        nb: 'WHAT', type: 'PJ' },
  { pattern: /\bknowledge\b/i,                         nb: 'WHAT', type: 'KN' },
  { pattern: /\bcalendar\b|\bevents?\b|\bmeeting\b/i,  nb: 'WHEN', type: 'CA' },
  { pattern: /\bdeadlines?\b/i,                        nb: 'WHEN', type: 'DL' },
  { pattern: /\bprocedures?\b|\bhow\s+to\b/i,          nb: 'HOW',  type: 'PR' },
  { pattern: /\breflections?\b/i,                      nb: 'WHY',  type: 'MT' },
  { pattern: /\bquestions?\b/i,                        nb: 'WHY',  type: 'QU' },
  { pattern: /\btodos?\b|\btasks?\b/i,                 nb: 'NOW',  type: 'TD' },
  { pattern: /\breports?\b/i,                          nb: 'NOW',  type: 'RP' },
  { pattern: /\bplanning\b|\bplans?\b/i,               nb: 'PLAN', type: 'PL' },
];

const RELATION_PATTERNS: Array<{ pattern: RegExp; relation: string }> = [
  { pattern: /\bowns?\b/i,            relation: 'owns' },
  { pattern: /\bworks?\s+for\b/i,    relation: 'works_for' },
  { pattern: /\bsuppl(?:y|ies)\b/i,  relation: 'supplies' },
  { pattern: /\bblocks?\b/i,         relation: 'blocks' },
  { pattern: /\brefers?\s+to\b/i,    relation: 'refers' },
];

const STATUS_REGEX = /\b(active|archived|open|closed|upcoming)\b/i;

function matchesAny(message: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(message));
}

function extractCodes(message: string): string[] {
  return [...message.matchAll(CODE_REGEX)].map(m => m[1]);
}

function extractNotebookType(message: string): { nb?: string; type?: string } {
  for (const { pattern, nb, type } of NOTEBOOK_PATTERNS) {
    if (pattern.test(message)) return { nb, type };
  }
  return {};
}

function detectNotebook(message: string): { nb?: string; type?: string } {
  // Check specific notebook patterns in priority order
  if (matchesAny(message, WHO_PATTERNS)) {
    // Determine sub-type
    if (/\borganizations?\b|\bcompan(?:y|ies)\b/i.test(message)) return { nb: 'WHO', type: 'ORG' };
    return { nb: 'WHO', type: 'CT' };
  }
  if (matchesAny(message, WHEN_PATTERNS)) {
    if (/\bdeadlines?\b/i.test(message)) return { nb: 'WHEN', type: 'DL' };
    return { nb: 'WHEN', type: 'CA' };
  }
  if (matchesAny(message, HOW_PATTERNS)) return { nb: 'HOW', type: 'PR' };
  if (matchesAny(message, WHY_PATTERNS)) return { nb: 'WHY', type: 'QU' };
  if (matchesAny(message, NOW_PATTERNS)) {
    if (/\breports?\b/i.test(message)) return { nb: 'NOW', type: 'RP' };
    return { nb: 'NOW', type: 'TD' };
  }
  if (matchesAny(message, PLAN_PATTERNS)) return { nb: 'PLAN', type: 'PL' };
  if (matchesAny(message, WHAT_PATTERNS)) {
    if (/\bknowledge\b/i.test(message)) return { nb: 'WHAT', type: 'KN' };
    return { nb: 'WHAT', type: 'PJ' };
  }

  // Fall back to keyword-based notebook detection
  return extractNotebookType(message);
}

function extractRelation(message: string): string | undefined {
  for (const { pattern, relation } of RELATION_PATTERNS) {
    if (pattern.test(message)) return relation;
  }
  return undefined;
}

function extractStatus(message: string): string | undefined {
  const match = message.match(STATUS_REGEX);
  return match ? match[1].toLowerCase() : undefined;
}

function extractName(message: string): string | undefined {
  // Quoted strings
  const quoted = message.match(/"([^"]+)"|'([^']+)'/);
  if (quoted) return quoted[1] ?? quoted[2];

  // "of/about/called/named [optional type word] Name"
  const namedMatch = message.match(
    /(?:of|about|called|named|for)\s+(?:project|contact|person|organization|todo|procedure|deadline|event|report|plan)?\s*([A-Z][A-Za-z0-9_-]+(?:\s+[A-Z][A-Za-z0-9_-]+)*)/
  );
  if (namedMatch) return namedMatch[1].replace(/[?.!,;:]+$/, '');

  // "who is [Name]" pattern
  const whoIsMatch = message.match(/\bwho\s+is\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)/);
  if (whoIsMatch) return whoIsMatch[1].replace(/[?.!,;:]+$/, '');

  // "find [Name]" pattern (capitalized)
  const findMatch = message.match(/\bfind\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)/);
  if (findMatch) return findMatch[1].replace(/[?.!,;:]+$/, '');

  return undefined;
}

export function classifyIntent(message: string): Classification {
  const codes = extractCodes(message);
  const relation = extractRelation(message);
  const status = extractStatus(message);
  const name = extractName(message);

  let intent: Intent;
  let nb: string | undefined;
  let type: string | undefined;

  // Priority 1: Contains a valid code
  if (codes.length > 0 && relation) {
    intent = 'relationship_query';
    const detected = detectNotebook(message);
    nb = detected.nb;
    type = detected.type;
  } else if (codes.length > 0 && !matchesAny(message, WRITE_PATTERNS)) {
    intent = 'code_fetch';
    const detected = detectNotebook(message);
    nb = detected.nb;
    type = detected.type;
  }
  // Priority 2: Greeting (only if no codes)
  else if (GREETING_REGEX.test(message) && codes.length === 0) {
    intent = 'greeting';
  }
  // Priority 3: Write patterns
  else if (matchesAny(message, WRITE_PATTERNS)) {
    intent = 'memory_write';
    const detected = detectNotebook(message);
    nb = detected.nb;
    type = detected.type;
  }
  // Priority 4: Web search
  else if (matchesAny(message, WEB_SEARCH_PATTERNS)) {
    intent = 'web_search';
  }
  // Priority 5: Notebook-specific read patterns
  else {
    const detected = detectNotebook(message);
    nb = detected.nb;
    type = detected.type;
    if (nb || type || status || name) {
      intent = 'memory_query';
    } else {
      intent = 'general';
    }
  }

  return { intent, codes, nb, type, status, name, relation };
}
