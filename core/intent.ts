import type { Classification, Intent } from './types.js';

const CODE_REGEX = /\b([A-Z]+\.[A-Z]+-\d{4,})\b/g;

const GREETING_REGEX = /^\s*(hi|hello|hey|good\s+(morning|afternoon|evening)|howdy|greetings)\b/i;

const WRITE_REGEX = /\b(create|add|new|write|save|store)\b/i;

const NOTEBOOK_PATTERNS: Array<{ pattern: RegExp; nb: string; type: string }> = [
  { pattern: /\bcontacts?\b/i,                        nb: 'WHO',  type: 'CT' },
  { pattern: /\borganizations?\b|\bcompan(?:y|ies)\b/i, nb: 'WHO',  type: 'ORG' },
  { pattern: /\bprojects?\b/i,                        nb: 'WHAT', type: 'PJ' },
  { pattern: /\bknowledge\b/i,                         nb: 'WHAT', type: 'KN' },
  { pattern: /\bcalendar\b|\bevents?\b/i,              nb: 'WHEN', type: 'CA' },
  { pattern: /\bdeadlines?\b/i,                        nb: 'WHEN', type: 'DL' },
  { pattern: /\bprocedures?\b|\bhow\s+to\b/i,          nb: 'HOW',  type: 'PR' },
  { pattern: /\breflections?\b/i,                      nb: 'WHY',  type: 'MT' },
  { pattern: /\btodos?\b/i,                            nb: 'NOW',  type: 'TD' },
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

function extractCodes(message: string): string[] {
  return [...message.matchAll(CODE_REGEX)].map(m => m[1]);
}

function extractNotebookType(message: string): { nb?: string; type?: string } {
  for (const { pattern, nb, type } of NOTEBOOK_PATTERNS) {
    if (pattern.test(message)) return { nb, type };
  }
  return {};
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

  return undefined;
}

export function classifyIntent(message: string): Classification {
  const codes = extractCodes(message);
  const relation = extractRelation(message);
  const { nb, type } = extractNotebookType(message);
  const status = extractStatus(message);
  const name = extractName(message);

  let intent: Intent;

  if (GREETING_REGEX.test(message) && codes.length === 0) {
    intent = 'greeting';
  } else if (codes.length > 0 && relation) {
    intent = 'relationship_query';
  } else if (codes.length > 0 && !WRITE_REGEX.test(message)) {
    intent = 'code_fetch';
  } else if (WRITE_REGEX.test(message)) {
    intent = 'memory_write';
  } else if (nb || type || status || name) {
    intent = 'memory_query';
  } else {
    intent = 'general';
  }

  return { intent, codes, nb, type, status, name, relation };
}
