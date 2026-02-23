import type { Classification, Intent } from './types.js';
import { getSkillDescriptions } from './skills/registry.js';

const CODE_REGEX = /\b([A-Z]+\.[A-Z]+-\d{6,})\b/g;

const GREETING_REGEX = /^\s*(hi|hello|hey|good\s+(morning|afternoon|evening)|howdy|greetings)\b/i;

// --- Write patterns (order matters: checked before read patterns) ---
const WRITE_PATTERNS = [
  /\b(create|add|new|write|save|store|remember)\b/i,
  /\bremind\s+me\b/i,
  /\bschedule\b/i,
  /\bplan\s+to\b/i,
  /\bvision\s+entry\b/i,
  /\bnew\s+(contact|project|todo|task|event|deadline|procedure|plan)\b/i,
];

// --- Web search patterns (now routes to skill) ---
const WEB_SEARCH_PATTERNS = [
  /\bsearch\s+(the\s+)?web\b/i,
  /\bsearch\s+(the\s+)?internet\b/i,
  /\bsearch\s+(the\s+)?internet\s+for\b/i,
  /\bcheck\s+(the\s+)?internet\s+for\b/i,
  /\bfind\s+(it\s+)?in\s+(the\s+)?internet\b/i,
  /\blook\s+up\b/i,
  /\bfind\s+online\b/i,
  /\bcheck\s+if\s+you\s+can\s+search\b/i,
  /\bcan\s+you\s+search\b/i,
  /\bsearch\s+for\b/i,
  /\bsearch\s+online\b/i,
  /\bweb[_\s-]?search\b/i,
  /\bweb\s+search\b/i,
  /\bgoogle\b/i,
  /\blatest\s+news\b/i,
  /\blatest\b[\s\S]{0,40}\bnews\b/i,
  /\btoday'?s?\s+news\b/i,
  /\bnews\s+today\b/i,
  /\bnews\s+(for|on|about)\b/i,
  /\bheadlines?\b/i,
  /\bcurrent\s+info\b/i,
  /\bfind\s+online\s+resources?\b/i,
];

// --- Web fetch/download patterns ---
const WEB_FETCH_PATTERNS = [
  /\bdownload\b/i,
  /\bfetch\b/i,
  /\bretrieve\b/i,
  /\bgrab\b/i,
  /\bget\b.*\bfrom\b/i,
  /\bgo\s+to\b/i,
  /\bvisit\b/i,
  /\bopen\s+(the\s+)?(site|website|url)\b/i,
];

// --- Calculator patterns ---
const CALCULATOR_PATTERNS = [
  /\bcalculat/i,
  /\bcompute\b/i,
  /\bwhat\s+is\s+[\d(]/i,
  /\bhow\s+much\s+is\b/i,
  /\d+\s*[\+\-\*\/]\s*\d/,
  /\d+\s+percent\s+of\b/i,
  /\bpercent\s+of\b/i,
  /\btimes\b/i,
  /\bdivided\s+by\b/i,
  /\bmultiplied\s+by\b/i,
  /\bplus\b/i,
  /\bminus\b/i,
  /\bsquare\s+root\s+of\b/i,
  /\bsqrt\b/i,
  /\b\d+\s*%\s*of\s*\d+/i,
];

// --- File reader patterns ---
const FILE_READER_PATTERNS = [
  /\bread\s+(the\s+)?file\b/i,
  /\bopen\s+(the\s+)?file\b/i,
  /\bload\s+(the\s+)?(file|contents?\s+of)\b/i,
  /\bshow\s+(me\s+)?the\s+file\b/i,
  /\bshow\s+(me\s+)?(the\s+)?(contents?\s+of\s+)?\/[\w.\-/]+/i,
  /\bread\s+\/[\w.\-/]+/i,
  /\bcat\s+\/[\w.\-/]+/i,
];

// --- File writer patterns ---
const FILE_WRITER_PATTERNS = [
  /\b(write|save|append)\b[\s\S]*\b(to|into|in)\b[\s\S]*(\/[\w.\-/]+|[\w.\-/]+\.\w+)/i,
  /\bcreate\s+file\b/i,
];

// --- Shell runner patterns ---
const SHELL_RUNNER_PATTERNS = [
  /\brun\s+(the\s+)?tests?\b/i,
  /\brun\s+test\s+suite\b/i,
  /\bbuild\s+(the\s+)?(project|app)\b/i,
  /\bcompile\b/i,
  /\brun\s+(the\s+)?compiler\b/i,
  /\bpnpm\s+test\b/i,
  /\bpnpm\s+build\b/i,
  /\bvitest\b/i,
  /\btsc\b/i,
];

// --- Planner patterns ---
const TASK_PLANNER_PATTERNS = [
  /\bplan\b[\s\S]*\b(task|steps?|roadmap|approach)\b/i,
  /\bbreak\b[\s\S]*\binto\s+steps?\b/i,
  /\bcreate\b[\s\S]*\b(plan|roadmap)\b/i,
];

// --- Log analyzer patterns ---
const LOG_ANALYZER_PATTERNS = [
  /\banaly[sz]e\b[\s\S]*\b(log|error|stack trace|compiler output|test output)\b/i,
  /\bwhy\b[\s\S]*\b(test|build|compile)\b[\s\S]*\b(fail|failing|failed)\b/i,
  /\bdebug\b[\s\S]*\b(log|failure|error)\b/i,
];

// --- Code editor patterns ---
const CODE_EDITOR_PATTERNS = [
  /\breplace\b[\s\S]*\bwith\b[\s\S]*\bin\s+(\/[\w.\-/]+|[\w.\-/]+\.\w+)/i,
  /\boverwrite\b[\s\S]*\bfile\b/i,
  /\binsert\b[\s\S]*\b(before|after)\b[\s\S]*\bin\s+(\/[\w.\-/]+|[\w.\-/]+\.\w+)/i,
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
  /\binformation\s+about\b/i,
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
const MONTH_INDEX: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

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
  if (/\binformation\s+about\b/i.test(message)) return { nb: 'WHAT', type: 'KN' };
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

function toIsoDate(year: number, monthIndex: number, day: number): string {
  const d = new Date(Date.UTC(year, monthIndex, day));
  return d.toISOString().slice(0, 10);
}

function extractDueDate(message: string): string | undefined {
  const isoMatch = message.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];

  const mdMatch = message.match(
    /\bby\s+([A-Za-z]+)\s+(\d{1,2})(?:,?\s*(20\d{2}))?\b/i,
  );
  if (mdMatch) {
    const monthIndex = MONTH_INDEX[mdMatch[1].toLowerCase()];
    if (monthIndex !== undefined) {
      const nowYear = new Date().getUTCFullYear();
      const year = mdMatch[3] ? Number(mdMatch[3]) : nowYear;
      return toIsoDate(year, monthIndex, Number(mdMatch[2]));
    }
  }

  const monthOnlyMatch = message.match(/\bby\s+([A-Za-z]+)(?:\s+(20\d{2}))?\b/i);
  if (monthOnlyMatch) {
    const monthIndex = MONTH_INDEX[monthOnlyMatch[1].toLowerCase()];
    if (monthIndex !== undefined) {
      const nowYear = new Date().getUTCFullYear();
      const year = monthOnlyMatch[2] ? Number(monthOnlyMatch[2]) : nowYear;
      const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
      return toIsoDate(year, monthIndex, lastDay);
    }
  }

  return undefined;
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

// --- Skill detection ---

function detectSkill(message: string): { skill: string; skillInput: Record<string, unknown> } | null {
  // Web fetch/download detection
  const url = extractUrl(message);
  if (url && matchesAny(message, WEB_FETCH_PATTERNS)) {
    const outputPath = extractDownloadOutputPath(message);
    const skillInput: Record<string, unknown> = { url };
    if (outputPath) skillInput.outputPath = outputPath;
    return { skill: 'web_fetch', skillInput };
  }

  // Web search detection — highest priority among skills (replaces old web_search intent)
  if (matchesAny(message, WEB_SEARCH_PATTERNS)) {
    const query = extractSearchQuery(message);
    return { skill: 'web_search', skillInput: { query } };
  }

  // Task planner detection
  if (matchesAny(message, TASK_PLANNER_PATTERNS)) {
    return { skill: 'task_planner', skillInput: { goal: message } };
  }

  // Log analyzer detection
  if (matchesAny(message, LOG_ANALYZER_PATTERNS)) {
    return { skill: 'log_analyzer', skillInput: { logs: message } };
  }

  // Code editor detection
  if (matchesAny(message, CODE_EDITOR_PATTERNS)) {
    const parsed = extractCodeEditorInput(message);
    if (parsed) return { skill: 'code_editor', skillInput: parsed };
  }

  // File writer detection
  if (matchesAny(message, FILE_WRITER_PATTERNS)) {
    const outputPath = extractWritePath(message);
    const content = extractWriteContent(message);
    if (outputPath && content) {
      return {
        skill: 'file_writer',
        skillInput: {
          path: outputPath,
          content,
          append: /\bappend\b/i.test(message),
          overwrite: /\boverwrite\b/i.test(message),
        },
      };
    }
  }

  // File reader detection — before calculator to avoid path numbers matching math
  if (matchesAny(message, FILE_READER_PATTERNS)) {
    const filePath = extractFilePath(message);
    if (filePath) {
      return { skill: 'file_reader', skillInput: { path: filePath } };
    }
  }

  // Shell runner detection
  if (matchesAny(message, SHELL_RUNNER_PATTERNS)) {
    const command = extractShellCommand(message);
    if (command) {
      return { skill: 'shell_runner', skillInput: { command } };
    }
  }

  // Calculator detection
  if (matchesAny(message, CALCULATOR_PATTERNS)) {
    const expression = extractMathExpression(message);
    if (expression) {
      return { skill: 'calculator', skillInput: { expression } };
    }
  }

  return null;
}

function extractCodeEditorInput(message: string): Record<string, unknown> | null {
  const replaceMatch = message.match(
    /\breplace\s+["']([\s\S]+?)["']\s+with\s+["']([\s\S]+?)["']\s+in\s+(\/[\w.\-/]+|[\w.\-/]+\.\w+)/i
  );
  if (replaceMatch) {
    return {
      operation: 'replace',
      target: replaceMatch[1],
      content: replaceMatch[2],
      path: replaceMatch[3],
      all: /\ball\b/i.test(message),
    };
  }

  const overwriteMatch = message.match(
    /\boverwrite\s+(?:the\s+)?file\s+(\/[\w.\-/]+|[\w.\-/]+\.\w+)\s+with\s+["']([\s\S]+?)["']/i
  );
  if (overwriteMatch) {
    return {
      operation: 'overwrite',
      path: overwriteMatch[1],
      content: overwriteMatch[2],
      create: true,
    };
  }

  const insertMatch = message.match(
    /\binsert\s+["']([\s\S]+?)["']\s+(before|after)\s+["']([\s\S]+?)["']\s+in\s+(\/[\w.\-/]+|[\w.\-/]+\.\w+)/i
  );
  if (insertMatch) {
    return {
      operation: insertMatch[2].toLowerCase() === 'before' ? 'insert_before' : 'insert_after',
      content: insertMatch[1],
      target: insertMatch[3],
      path: insertMatch[4],
    };
  }

  return null;
}

function extractShellCommand(message: string): string | null {
  const normalized = message.toLowerCase();
  if (/\bpnpm\s+test\b/.test(normalized) || /\brun\s+(the\s+)?tests?\b/.test(normalized) || /\bvitest\b/.test(normalized)) {
    return 'pnpm test';
  }
  if (/\bpnpm\s+build\b/.test(normalized) || /\bbuild\s+(the\s+)?(project|app)\b/.test(normalized)) {
    return 'pnpm build';
  }
  if (/\bcompile\b/.test(normalized) || /\brun\s+(the\s+)?compiler\b/.test(normalized) || /\btsc\b/.test(normalized)) {
    return 'npx tsc --noEmit';
  }
  return null;
}

function extractUrl(message: string): string | null {
  const explicitMatch = message.match(/https?:\/\/[^\s'"]+/i);
  if (explicitMatch) {
    return explicitMatch[0].replace(/[),.;!?]+$/g, '');
  }

  // Support bare domains like "neolith.com" in web-action prompts.
  if (!matchesAny(message, WEB_FETCH_PATTERNS)) return null;

  const domainLikeMatch = message.match(
    /\b((?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s'"]*)?)/i,
  );
  if (!domainLikeMatch) return null;

  const candidate = domainLikeMatch[1].replace(/[),.;!?]+$/g, '');
  const hostPart = candidate.split('/')[0].toLowerCase();
  const tld = hostPart.split('.').pop() ?? '';

  // Avoid treating common file names like config.json as web domains.
  const blockedFileLikeTlds = new Set(['json', 'ts', 'js', 'md', 'txt', 'csv', 'xml', 'yaml', 'yml']);
  if (blockedFileLikeTlds.has(tld)) return null;

  return `https://${candidate}`;
}

function extractDownloadOutputPath(message: string): string | null {
  const explicitPath = message.match(
    /\b(?:download|save|write|fetch|get)\b[\s\S]*?\b(?:to|into|as)\s+(\/[\w.\-/]+|[\w.\-/]+\.\w+)/i,
  );
  if (explicitPath) return explicitPath[1];
  return null;
}

function extractWritePath(message: string): string | null {
  const toPath = message.match(/(?:to|into|in)\s+(?:file\s+)?(\/[\w.\-/]+|[\w.\-/]+\.\w+)/i);
  if (toPath) return toPath[1];

  const firstPath = message.match(/(\/[\w.\-/]+|[\w.\-/]+\.\w+)/);
  return firstPath ? firstPath[1] : null;
}

function extractWriteContent(message: string): string | null {
  const quoted = message.match(/\b(?:write|save|append)\s+["']([\s\S]+?)["']\s+(?:to|into|in)\b/i);
  if (quoted) return quoted[1].trim();

  const plain = message.match(/\b(?:write|save|append)\s+([\s\S]+?)\s+(?:to|into|in)\s+(?:file\s+)?(?:\/[\w.\-/]+|[\w.\-/]+\.\w+)/i);
  if (plain) return plain[1].trim();

  return null;
}

function isToolWriteRequest(message: string): boolean {
  const hasWebFetch = extractUrl(message) !== null && matchesAny(message, WEB_FETCH_PATTERNS);
  const hasFileWriter = matchesAny(message, FILE_WRITER_PATTERNS);
  return hasWebFetch || hasFileWriter;
}

function normalizeMathExpression(message: string): string {
  return message
    .replace(/\bwhat\s+is\b/i, '')
    .replace(/\bhow\s+much\s+is\b/i, '')
    .replace(/\bcalculate\b/i, '')
    .replace(/\bcompute\b/i, '')
    .replace(/(\d+(?:\.\d+)?)\s+percent\s+of\s+(\d+(?:\.\d+)?)/gi, '$1 / 100 * $2')
    .replace(/(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)/gi, '$1 / 100 * $2')
    .replace(/\bmultiplied\s+by\b/gi, '*')
    .replace(/\bdivided\s+by\b/gi, '/')
    .replace(/\btimes\b/gi, '*')
    .replace(/\bplus\b/gi, '+')
    .replace(/\bminus\b/gi, '-')
    .replace(/\s+/g, ' ')
    .replace(/[?]+$/g, '')
    .trim();
}

function extractMathExpression(message: string): string | null {
  // "square root of X"
  const sqrtMatch = message.match(/square\s+root\s+of\s+(\d+(?:\.\d+)?)/i);
  if (sqrtMatch) return `sqrt(${sqrtMatch[1]})`;

  // Natural language math normalization
  const normalized = normalizeMathExpression(message);
  const askedForCalculation = /\b(calculate|compute|what\s+is|how\s+much\s+is)\b/i.test(message);
  if (
    normalized &&
    (/[+\-*/^%]/.test(normalized) || /sqrt\s*\(/i.test(normalized)) &&
    (askedForCalculation || /\d/.test(normalized))
  ) {
    return normalized;
  }

  // Direct math expression with explicit operator
  const directMath = message.match(
    /((?:\(|\s)*\d+(?:\.\d+)?(?:\s*[\+\-\*\/\^%]\s*(?:\(|\s)*\d+(?:\.\d+)?\)*)+)/,
  );
  if (directMath) return directMath[1].trim();

  return null;
}

function extractFilePath(message: string): string | null {
  // Absolute path
  const absPath = message.match(/(?:^|\s)(\/[^\s'"]+)/);
  if (absPath) return absPath[1];

  // Relative path with extension
  const relPath = message.match(/([\w.\-/]+\.\w+)/);
  if (relPath) return relPath[1];

  return null;
}

function extractSearchQuery(message: string): string {
  const original = message.trim();
  const normalized = message
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip trigger phrases, keep the core query
  const cleaned = normalized
    .replace(/^\s*(qwen|assistant|agent|codex)\s*[:,.-]?\s+/i, '')
    .replace(/^\s*(please|pls|kindly)\s+/i, '')
    .replace(/^\s*(do\s+an?|do)\s+/i, '')
    .replace(/^\s*(can\s+you|could\s+you|would\s+you)\s+/i, '')
    .replace(/\bcheck\s+if\s+you\s+can\s+search\s+(the\s+)?internet[\s,]*(and\s+)?/i, '')
    .replace(/\bcan\s+you\s+search\s+(the\s+)?internet[\s,]*(and\s+)?/i, '')
    .replace(/\bsearch\s+(the\s+)?internet\s+for\s+/i, '')
    .replace(/\bcheck\s+(the\s+)?internet\s+for\s+/i, '')
    .replace(/\bfind\s+(?:it\s+)?in\s+(the\s+)?internet\s+(?:for\s+)?/i, '')
    .replace(/\b(?:show|give)\s+me\s+/i, '')
    .replace(/\bweb[_\s-]?search\s+(for\s+)?/i, '')
    .replace(/\bsearch\s+(the\s+)?web\s+(for\s+)?/i, '')
    .replace(/\bsearch\s+(the\s+)?internet\s+(for\s+)?/i, '')
    .replace(/\bsearch\s+(for|online)\s+/i, '')
    .replace(/\blook\s+up\s+/i, '')
    .replace(/\bfind\s+online\s+(resources?\s+(for|on|about)\s+)?/i, '')
    .replace(/\bgoogle\s+/i, '')
    .replace(/\bweb\s+search\s+(for\s+)?/i, '')
    .replace(/\bas\s+a\s+test\b/i, '')
    .replace(/\b(tell\s+me\s+the\s+results?|tell\s+me)\b/i, '')
    .replace(/^[\s,.:;!?-]+/, '')
    .replace(/[\s,.:;!?-]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  const looksEmpty = !cleaned || /^(today|latest|current|please|search)$/i.test(cleaned);
  if (looksEmpty || /^[\s,.-]*$/.test(cleaned)) {
    if (/\bnews\b/i.test(original) || /\bheadlines?\b/i.test(original)) {
      return 'top news today';
    }
    return 'top news today';
  }

  return cleaned;
}

// Expose getSkillDescriptions for external use (e.g., tests verifying registry awareness)
export { getSkillDescriptions };

export function classifyIntent(message: string): Classification {
  const codes = extractCodes(message);
  const relation = extractRelation(message);
  const status = extractStatus(message);
  const due_date = extractDueDate(message);
  const name = extractName(message);

  let intent: Intent;
  let nb: string | undefined;
  let type: string | undefined;
  let skill: string | undefined;
  let skillInput: Record<string, unknown> | undefined;

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
  else if (matchesAny(message, WRITE_PATTERNS) && !isToolWriteRequest(message)) {
    intent = 'memory_write';
    const detected = detectNotebook(message);
    nb = detected.nb;
    type = detected.type;
  }
  // Priority 4: Skill detection (web_search, calculator, file_reader)
  // Checked BEFORE notebook patterns — same priority position web_search had before
  else {
    const skillMatch = detectSkill(message);
    if (skillMatch) {
      intent = 'skill';
      skill = skillMatch.skill;
      skillInput = skillMatch.skillInput;
    } else {
      // Priority 5: Notebook-specific read patterns
      const detected = detectNotebook(message);
      nb = detected.nb;
      type = detected.type;
      if (nb || type || status || name) {
        intent = 'memory_query';
      } else {
        intent = 'general';
      }
    }
  }

  return { intent, codes, nb, type, status, due_date, name, relation, skill, skillInput };
}
