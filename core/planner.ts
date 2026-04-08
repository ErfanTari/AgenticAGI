import type { Classification, LLMHandler, Message } from './types.js';
import { TaskPlanSchema, taskPlanJsonSchema, planAssertionJsonSchema, validatePlanIntegrity } from './schemas.js';
import type { TaskGoal, TaskMilestone, TaskPlan, TaskStep } from './schemas.js';
import { transparency } from './transparency.js';
import { queryEntries } from './memory/index.js';
import { fetchByCode } from './memory/fetch.js';
import { MINIMUM_PLANNER_MEMORY_CONFIDENCE } from './memory/unit-search.js';
import { loadPlannerPrompt } from './prompt-loader.js';
import { TOKEN_BUDGETS } from '../config/agent.config.js';
import type { ZodError, ZodIssue } from 'zod';

// --- Graded complexity (P6) ---

export type ComplexityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'MAX';

export interface ComplexityAssessment {
  level: ComplexityLevel;
  reason: string;
  estimatedSteps: number;
}

function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') return `${acc}[${segment}]`;
    const label = String(segment);
    return acc ? `${acc}.${label}` : label;
  }, '');
}

export function buildRepairMessage(zodError: ZodError): string {
  const issues = zodError.issues.map((issue: ZodIssue) => {
    const issueWithMeta = issue as ZodIssue & { expected?: unknown; received?: unknown };
    const path = formatIssuePath(issue.path);
    const label = path ? `"${path}"` : '"<root>"';

    if (issue.code === 'invalid_type' && issueWithMeta.received === 'undefined') {
      return `Missing required field ${label}: expected ${String(issueWithMeta.expected ?? issue.message)}`;
    }

    if (issueWithMeta.expected !== undefined || issueWithMeta.received !== undefined) {
      return `Field ${label}: ${issue.message} (expected ${String(issueWithMeta.expected ?? 'valid value')}, received ${String(issueWithMeta.received ?? 'invalid value')})`;
    }

    return `Field ${label}: ${issue.message}`;
  });

  return [
    `Schema validation failed with ${issues.length} issue(s):`,
    ...issues.map((entry, index) => `${index + 1}. ${entry}`),
    '',
    'Fix ONLY the listed issues. Do not change the plan logic. Return corrected JSON only.',
  ].join('\n');
}

// Fix 5: keywords that imply code/file output → HIGH when combined with output keywords
const GENERATION_VERBS = /\b(build|create|generate|simulation|app|tool|game|make|write|develop)\b/i;
const OUTPUT_SIGNALS = /\b(html|css|javascript|code|file|page|website|script|component|program|application)\b/i;

export async function assessComplexity(
  message: string,
  _classification: Classification,
  llmHandler?: LLMHandler,
): Promise<ComplexityAssessment> {
  // FORCE_HIGH check — certain domains always need the planner regardless of signal count
  for (const [signalName, pattern] of Object.entries(FORCE_HIGH_SIGNALS)) {
    if (pattern.test(message)) {
      return {
        level: 'HIGH',
        reason: `ForceHigh: ${signalName}`,
        estimatedSteps: 7,
      };
    }
  }

  // FIX 5: Generation + artifact target → at least MEDIUM (queryLoop for single-file tasks)
  // Do not promote to HIGH unless explicitly multi-file or multi-milestone
  if (GENERATION_VERBS.test(message) && OUTPUT_SIGNALS.test(message)) {
    return {
      level: 'MEDIUM',
      reason: 'GenerationTask: generation verb + artifact target detected',
      estimatedSteps: 2,
    };
  }

  // We call the underlying complexity detection without going through isComplexTask wrapper
  // to avoid potential circular reference issues
  const { count, signals, skills } = countHeuristicSignals(message);

  let isComplex = count >= 2;
  let reason = count >= 2 ? `Heuristic: ${signals.join(', ')}` : 'No complexity signals';
  let estimatedSteps = Math.max(1, skills.length + 1);

  if (!isComplex && llmHandler && (count === 1 || message.length >= 100)) {
    try {
      const promptMsgs: Message[] = [
        {
          role: 'system',
          content: `You are a task complexity analyzer. Return ONLY JSON: {"isComplex": true/false, "reason": "brief", "estimatedSteps": N}`,
        },
        { role: 'user', content: message },
      ];
      const resp = await llmHandler(promptMsgs, { maxTokens: 200, disableThinking: true });
      const cleaned = resp.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        isComplex = Boolean(parsed.isComplex);
        reason = String(parsed.reason ?? reason);
        estimatedSteps = Number(parsed.estimatedSteps ?? estimatedSteps);
      }
    } catch { /* use heuristic result */ }
  }

  let level: ComplexityLevel;
  if (!isComplex) {
    level = 'LOW';
  } else if (estimatedSteps <= 3) {
    level = 'MEDIUM';
  } else if (estimatedSteps <= 6) {
    level = 'HIGH';
  } else {
    level = 'MAX';
  }

  return { level, reason, estimatedSteps };
}

// --- Complexity Detection (Priority 2) ---

/**
 * FORCE_HIGH: any match → immediately return HIGH (7 estimated steps).
 * These domains always involve interdependent components regardless of phrasing length.
 */
const FORCE_HIGH_SIGNALS: Record<string, RegExp> = {
  // Game development — any genre, any platform
  gameDev: /\b(game|arcade|platformer|shooter|rpg|puzzle\s+game|beat.?em.?up|streets\s+of\s+rage|side.?scroller|top.?down|infinite\s+runner|physics\s+engine|game\s+loop|sprite|hitbox|collision\s+detection|tile\s+map|level\s+design|enemy\s+ai|player\s+controller)\b/i,
  // App / software with a UI
  appDev: /\b(web\s+app|mobile\s+app|desktop\s+app|single[\s-]page\s+app|spa|pwa|full[\s-]stack|backend\s+api|rest\s+api|graphql\s+api|dashboard|admin\s+panel|crud\s+app|e-?commerce|chat\s+app|note[\s-]taking\s+app|todo\s+app)\b/i,
  // Multi-file project scaffolding
  scaffolding: /\b(scaffold|boilerplate|starter\s+(kit|project|template)|project\s+structure|monorepo|microservice)\b/i,
  // Rendering / graphics / animation
  rendering: /\b(canvas\s+api|webgl|three\.?js|animation\s+loop|requestAnimationFrame|shader|particle\s+system|2d\s+engine|3d\s+engine)\b/i,
};

// Heuristic regex patterns for multi-step detection
const COMPLEXITY_SIGNALS = {
  multiStep: /\b(then|after that|next|finally|first|second|and then|step \d|followed by)\b/i,
  multiSkill: null as RegExp | null, // computed dynamically
  // "project" removed (handled by memory_write); "files?" → "files" (plural only, avoids "create a file")
  multiFile: /\b(build|create|setup|generate)\b.*(page|website|structure|files)\b/i,
  // Tightened: require the second verb to be lowercase-initial (not a title-case noun like "Test")
  fileAndRun: /\b(write|create|save|build)\b.{3,}\b(run|execute|compile|verify)\b(?![A-Z])/,
  researchTask: /\b(research|investigate|analyze|compare|summarize)\b.*\b(and|then|report|write)\b/i,
  loopSignal: /\b(for each|for every|all of|batch|iterate|repeat)\b/i,
  multiAction: /\b(download|fetch|get)\b.*\b(update|modify|change)\b/i,
  webBrowseTask: /\b(go\s+(to|through)|visit|browse|navigate\s+to)\b.*\b(website|site|page|url)\b/i,
  downloadTask: /\b(download|fetch)\b.*\b(it|file|pdf|catalog|document|image|folder|resource)\b/i,
  // Numbered lists and "do the following" instructions are always multi-step
  doFollowing: /\bdo\s+the\s+following\b/i,
  numberedList: /^\d+\.\s/m,
  // Synthesis + save tasks: read memory → generate content → write outputs
  synthesisReport: /\b(write|generate|create|produce)\b.{0,40}\b(report|summary|overview|status)\b/i,
  saveToMemory: /\bsaves?\b.{0,30}\b(as\s+(a\s+)?NOW|entry\s+in\s+memory|in\s+memory|to\s+memory)\b/i,
  saveToFile: /\bsave\b.{0,50}\b(as|to)\b.{0,30}\.(md|txt|json|html|csv)\b/i,
  bulletList: /^-\s+\S/m,   // markdown bullet list (- item) signals multi-part instructions
  basedOnMemory: /\bbased\s+on\s+(everything\s+you\s+know|my\s+(memory|projects|data)|what\s+you\s+know)\b/i,
  coverMultiple: /\b(it\s+should\s+cover|cover\s+the\s+following|including\s+the\s+following)\b/i,
  // BUG 4 Fix A: synthesis-specific signals — any one = immediately complex
  synthesisTask: /\b(briefing|weekly\s+(status\s+)?report|status\s+report|catch\s+me\s+up|full\s+picture|wrap\s+up|based\s+on\s+everything)\b/i,
  multiNotebook: /\b(projects|deadlines|todos|plans)\b.*\b(and|also|plus|with)\b/i,
  saveMultiple: /save\b.{0,60}\band\s+(also\s+)?save\b/i,
};

// Skill-detection patterns (reused from intent.ts logic)
const SKILL_PATTERNS: Array<{ skill: string; patterns: RegExp[] }> = [
  { skill: 'web_search', patterns: [/\bsearch\s+(the\s+)?(web|internet|online)\b/i, /\bgoogle\b/i, /\bfind\s+online\b/i, /\bsearch\s+for\b/i] },
  { skill: 'web_fetch', patterns: [/\bfetch\s+(the\s+)?url\b/i, /\bgo\s+(to|through)\b.*\b(website|site|page)\b/i, /\bvisit\b.*\b(website|site|page)\b/i, /\bbrowse\b/i] },
  { skill: 'calculator', patterns: [/\bcalculat/i, /\bcompute\b/i, /\d+\s*[\+\-\*\/]\s*\d/] },
  { skill: 'file_reader', patterns: [/\bread\s+(the\s+)?file\b/i, /\bopen\s+(the\s+)?file\b/i] },
  { skill: 'file_writer', patterns: [/\bwrite\s+(a\s+|to\s+)?file\b/i, /\bcreate\s+(a\s+)?(file|tutorial|document)\b/i, /\bsave\s+to\s+file\b/i, /\bmake\s+a\s+(text\s+)?(tutorial|guide|document)\b/i, /\bsave\b.{0,50}\b\.(md|txt|json|html|csv)\b/i, /\bsave\s+(the\s+)?(report|summary|output)\s+as\b/i] },
  { skill: 'run_bash', patterns: [/\brun\b/i, /\bexecute\b/i, /\bbash\b/i, /\bshell\b/i, /\bcommand\b/i] },
  { skill: 'memory_write', patterns: [/\bcreate\s+(a\s+)?(contact|project|todo|entry)\b/i, /\bremember\b/i, /\bsave\s+(a\s+)?note\b/i, /\bsaves?\b.{0,40}\b(entry\s+in\s+memory|in\s+memory|to\s+memory|as\s+(a\s+)?NOW\.\w+)\b/i] },
];

function detectMatchedSkills(message: string): string[] {
  const matched: string[] = [];
  for (const { skill, patterns } of SKILL_PATTERNS) {
    if (patterns.some(p => p.test(message))) {
      matched.push(skill);
    }
  }
  return matched;
}

function countHeuristicSignals(message: string): { count: number; signals: string[]; skills: string[] } {
  const signals: string[] = [];
  const skills = detectMatchedSkills(message);

  if (COMPLEXITY_SIGNALS.multiStep.test(message)) signals.push('multiStep');
  if (skills.length > 1) signals.push('multiSkill');
  if (COMPLEXITY_SIGNALS.multiFile.test(message)) signals.push('multiFile');
  if (COMPLEXITY_SIGNALS.fileAndRun.test(message)) signals.push('fileAndRun');
  if (COMPLEXITY_SIGNALS.researchTask.test(message)) signals.push('researchTask');
  if (COMPLEXITY_SIGNALS.loopSignal.test(message)) signals.push('loopSignal');
  if (COMPLEXITY_SIGNALS.multiAction.test(message)) signals.push('multiAction');
  if (COMPLEXITY_SIGNALS.webBrowseTask.test(message)) signals.push('webBrowseTask');
  if (COMPLEXITY_SIGNALS.downloadTask.test(message)) signals.push('downloadTask');
  if (COMPLEXITY_SIGNALS.doFollowing.test(message)) signals.push('doFollowing');
  if (COMPLEXITY_SIGNALS.numberedList.test(message)) signals.push('numberedList');
  if (COMPLEXITY_SIGNALS.synthesisReport.test(message)) signals.push('synthesisReport');
  if (COMPLEXITY_SIGNALS.saveToMemory.test(message)) signals.push('saveToMemory');
  if (COMPLEXITY_SIGNALS.saveToFile.test(message)) signals.push('saveToFile');
  if (COMPLEXITY_SIGNALS.bulletList.test(message)) signals.push('bulletList');
  if (COMPLEXITY_SIGNALS.basedOnMemory.test(message)) signals.push('basedOnMemory');
  if (COMPLEXITY_SIGNALS.coverMultiple.test(message)) signals.push('coverMultiple');
  if (COMPLEXITY_SIGNALS.synthesisTask.test(message)) signals.push('synthesisTask');
  if (COMPLEXITY_SIGNALS.multiNotebook.test(message)) signals.push('multiNotebook');
  if (COMPLEXITY_SIGNALS.saveMultiple.test(message)) signals.push('saveMultiple');

  return { count: signals.length, signals, skills };
}

// --- Task Decomposer (Priority 3) ---

function flattenSingleKeyObjects(value: unknown, depth = 0): unknown {
  // Hard depth limit to prevent unbounded recursion on pathological LLM output
  if (depth > 10) return value;

  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => flattenSingleKeyObjects(v, depth + 1));

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);

  if (keys.length === 1) {
    const key = keys[0];
    const val = obj[key];

    // Empty string or null value → the key itself IS the value
    if (val === '' || val === null) {
      if (key === 'true') return true;
      if (key === 'false') return false;
      const num = Number(key);
      if (!isNaN(num) && key.trim() !== '') return num;
      return key;
    }

    // Nested object → recurse until we reach a primitive or multi-key object
    if (typeof val === 'object') {
      const inner = flattenSingleKeyObjects(val, depth + 1);
      // Recursion returned a primitive → use it directly
      if (typeof inner !== 'object' || inner === null) return inner;
      // Recursion returned an object → the outer key is likely the actual value
      if (!Array.isArray(val) && Object.keys(val as object).length === 1) return key;
    }
  }

  // Multi-key object: recurse into each value
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    result[key] = flattenSingleKeyObjects(obj[key], depth + 1);
  }
  return result;
}

/**
 * Fix escaped quotes that appear OUTSIDE of string values.
 * Tracks inString state char-by-char so valid escapes inside strings are preserved.
 * e.g. {\"key\":\"value\"} → {"key":"value"} but "charset=\"UTF-8\"" is left intact.
 */
function fixEscapedQuotes(json: string): string {
  let result = '';
  let inString = false;
  let i = 0;

  while (i < json.length) {
    const char = json[i];
    const prev = i > 0 ? json[i - 1] : '';
    const next = json[i + 1];

    if (char === '"' && prev !== '\\') {
      inString = !inString;
      result += char;
    } else if (!inString && char === '\\' && next === '"') {
      // Escaped quote outside a string value = malformed — fix it
      result += '"';
      i++; // consume the quote character
    } else {
      result += char;
    }
    i++;
  }

  return result;
}

/**
 * Extract the first complete JSON object from text using bracket-depth counting.
 * Stops at the closing brace of the first complete object — ignores any trailing text
 * or second JSON objects the model may have appended.
 */
function extractFirstJsonObject(text: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (escape) { escape = false; continue; }
    if (char === '\\' && inString) { escape = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (char === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function sanitizePlannerJson(raw: string): string {
  // Step 0: Strip <think>/<thought> blocks BEFORE extracting JSON.
  // If a think block appears before the real JSON and contains '{', extractFirstJsonObject
  // would incorrectly grab content from inside the think block instead of the actual TaskPlan.
  const preStripped = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .trim();

  // Step 1: Extract first complete JSON object (bracket-depth counter stops at first complete object,
  // preventing two concatenated JSON objects from being merged into an unparseable blob)
  const extracted = extractFirstJsonObject(preStripped);
  if (!extracted) {
    if (process.env.DEBUG_PLANNER === 'true') {
      console.log('[planner] No valid JSON object found');
    }
    return '';
  }
  let cleaned = extracted;

  // Step 2: Remove any thinking/special tokens that appeared within the extracted JSON
  cleaned = cleaned
    .replace(/<\|im_start\|>/g, '')
    .replace(/<\|im_end\|>/g, '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();

  // Fix escaped quotes that appear outside of string values (malformed LLM output).
  // Uses a char-by-char parser tracking inString state to avoid corrupting valid
  // escaped quotes inside string values (e.g. <meta charset=\"UTF-8\">).
  cleaned = fixEscapedQuotes(cleaned);

  // MODEL-AGNOSTIC FIX: Convert pretty-printed JSON to compact (single line)
  // This prevents newlines in embedded content from breaking JSON parsing
  // Strategy: Remove ALL newlines and excess whitespace outside of string values
  let compact = '';
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];

    if (escapeNext) {
      compact += char;
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      compact += char;
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      compact += char;
      continue;
    }

    if (inString) {
      compact += char;
    } else {
      // Outside string: collapse whitespace
      if (char === '\n' || char === '\r' || char === '\t') {
        continue; // skip newlines/tabs
      } else if (char === ' ') {
        // Keep spaces only after : and ,
        if (i > 0 && (cleaned[i - 1] === ':' || cleaned[i - 1] === ',')) {
          compact += char;
        }
      } else {
        compact += char;
      }
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(compact);
  } catch {
    return compact;
  }

  parsed = flattenSingleKeyObjects(parsed);

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const parsedObj = parsed as Record<string, unknown>;

    if (Array.isArray(parsedObj.steps)) {
      parsedObj.steps = parsedObj.steps.map((step: unknown) => {
        if (!step || typeof step !== 'object' || Array.isArray(step)) {
          return step;
        }

        const s = step as Record<string, unknown>;

        if (typeof s.optional === 'string') {
          s.optional = s.optional === 'true';
        } else if (typeof s.optional !== 'boolean' && s.optional !== undefined) {
          const flattenedOptional = flattenSingleKeyObjects(s.optional);
          if (typeof flattenedOptional === 'boolean') {
            s.optional = flattenedOptional;
          } else if (typeof flattenedOptional === 'string') {
            if (flattenedOptional === 'true') s.optional = true;
            if (flattenedOptional === 'false') s.optional = false;
          }
        }

        if (s.storeResultAs !== undefined && s.storeResultAs !== null && typeof s.storeResultAs !== 'string') {
          const flattenedStoreResultAs = flattenSingleKeyObjects(s.storeResultAs);
          if (typeof flattenedStoreResultAs === 'string') {
            s.storeResultAs = flattenedStoreResultAs;
          } else if (flattenedStoreResultAs === null) {
            s.storeResultAs = null;
          } else if (typeof flattenedStoreResultAs === 'number' || typeof flattenedStoreResultAs === 'boolean') {
            s.storeResultAs = String(flattenedStoreResultAs);
          } else if (s.storeResultAs && typeof s.storeResultAs === 'object') {
            const keys = Object.keys(s.storeResultAs as object);
            s.storeResultAs = keys.length > 0 ? keys[0] : null;
          }
        }

        if (!Array.isArray(s.dependsOn)) {
          s.dependsOn = [];
        } else {
          s.dependsOn = s.dependsOn
            .map(dep => flattenSingleKeyObjects(dep))
            .map(dep => {
              if (typeof dep === 'string') return dep;
              if (typeof dep === 'number') return String(dep);
              return '';
            })
            .filter((dep): dep is string => dep.length > 0);
        }

        if (s.input && typeof s.input === 'object' && !Array.isArray(s.input)) {
          const flattenedInput = flattenSingleKeyObjects(s.input);
          if (flattenedInput && typeof flattenedInput === 'object' && !Array.isArray(flattenedInput)) {
            const inputObj = flattenedInput as Record<string, unknown>;

            if (inputObj.path && typeof inputObj.path === 'object' && !Array.isArray(inputObj.path)) {
              const pathEntries = Object.entries(inputObj.path as Record<string, unknown>);
              if (pathEntries.length === 1) {
                const [filePath, content] = pathEntries[0];
                inputObj.path = filePath;
                if (typeof content === 'string' && content.length > 0 && inputObj.content === undefined) {
                  inputObj.content = content;
                }
              }
            }

            s.input = inputObj;
          }
        }

        return s;
      });
    }
  }

  return JSON.stringify(parsed);
}

export function resolveTemplates(
  input: Record<string, unknown>,
  results: Map<string, string>,
): Record<string, unknown> {
  const clone = structuredClone(input);

  function replaceInValue(val: unknown): unknown {
    if (typeof val === 'string') {
      // Also match malformed single-brace templates like {{foo} (model sometimes omits closing })
      return val.replace(/\{\{(\w+)\}?\}/g, (_match, key: string) => {
        const direct = results.get(key);
        if (direct !== undefined) return direct;

        if (key.endsWith('_result')) {
          const withoutSuffix = results.get(key.replace(/_result$/, ''));
          if (withoutSuffix !== undefined) return withoutSuffix;
        } else {
          const withSuffix = results.get(`${key}_result`);
          if (withSuffix !== undefined) return withSuffix;
        }

        return `{{${key}}}`;
      });
    }
    if (Array.isArray(val)) return val.map(replaceInValue);
    if (val && typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = replaceInValue(v);
      }
      return out;
    }
    return val;
  }

  for (const [k, v] of Object.entries(clone)) {
    clone[k] = replaceInValue(v);
  }
  return clone;
}

const MEMORY_FIRST_PATTERNS = [
  /\bfrom memory\b/i,
  /\bread (?:my|the) memory\b/i,
  /\buse everything you know about me\b/i,
  /\buse .*memory\b/i,
];

function requiresMemoryReadFirst(message: string): boolean {
  return MEMORY_FIRST_PATTERNS.some(pattern => pattern.test(message));
}

function requestsBroadMemory(message: string): boolean {
  return /\b(use everything you know about me|all relevant memory|from memory)\b/i.test(message);
}

function hasMemoryReadFirst(steps: unknown[]): boolean {
  if (steps.length === 0) return false;
  const first = steps[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return false;
  const skill = (first as Record<string, unknown>).skill;
  return skill === 'memory_read';
}

/**
 * Find a relevant HOW.PR procedure that matches the message.
 * Returns the body of the best matching procedure, or null if none found.
 */
async function findRelevantProcedure(message: string): Promise<string | null> {
  try {
    const procedures = queryEntries({ nb: 'HOW', type: 'PR' });
    if (procedures.length === 0) return null;

    const msgWords = new Set(
      message.toLowerCase().split(/\s+/).filter(w => w.length > 3),
    );

    let bestScore = 0;
    let bestCode: string | null = null;

    for (const entry of procedures) {
      const nameWords = entry.name.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      if (nameWords.length === 0) continue;
      const overlap = nameWords.filter(w => msgWords.has(w)).length;
      // BUG-4 fix: use max(msgWords, nameWords) to prevent short messages from
      // scoring disproportionately high against long entry names (false positives).
      const score = overlap / Math.max(msgWords.size, nameWords.length);
      if (score > bestScore) {
        bestScore = score;
        bestCode = entry.code;
      }
    }

    // Only use if there's meaningful overlap
    if (bestScore < 0.3 || !bestCode) return null;

    const fetched = fetchByCode(bestCode);
    return fetched?.content ?? null;
  } catch {
    return null;
  }
}

/**
 * Extract CoT thought block from planner response.
 */
export function extractThought(raw: string): string | null {
  const match = raw.match(/<thought>([\s\S]*?)<\/thought>/i)
    ?? raw.match(/<think>([\s\S]*?)<\/think>/i);
  return match ? match[1].trim() : null;
}

export interface PlannerContext {
  skills: string;
  history?: string;
  goals?: TaskGoal[];
  memoryContext?: string;
  decompositionSummary?: string;
  projectCode?: string | null;
  permissionMode?: string;
  blockedSkillNames?: string[];
  workspaceFiles?: string;
  recentArtifact?: { path: string; format: string; description: string };
  continuationContext?: string;  // FIX 2: Prior PLAN.EX context for continuation
}

export function filterPlannerMemoryContext(
  memoryContext: string,
  minimumConfidence = MINIMUM_PLANNER_MEMORY_CONFIDENCE,
): string {
  if (!memoryContext.trim()) return '';

  const sections = memoryContext
    .split(/\n(?=##\s+)/)
    .map(section => section.trim())
    .filter(Boolean);

  const keptSections: string[] = [];
  const filteredCodes: string[] = [];

  for (const section of sections) {
    const confidenceMatch = section.match(/Confidence:\s*([0-9.]+)/i);
    const confidence = confidenceMatch ? Number(confidenceMatch[1]) : Number.NaN;
    if (!Number.isNaN(confidence) && confidence < minimumConfidence) {
      const codes = [...section.matchAll(/\[([A-Z]+\.[A-Z]+-\d+)\]/g)].map(match => match[1]);
      filteredCodes.push(...codes);
      continue;
    }
    keptSections.push(section);
  }

  if (filteredCodes.length > 0) {
    console.debug(
      `[zaraban][planner] Filtered ${filteredCodes.length} zero-confidence memory entries from planner context: ${filteredCodes.join(', ')}`
    );
  }

  return keptSections.join('\n\n');
}

function derivePlanComplexity(stepCount: number): ComplexityLevel {
  if (stepCount <= 2) return 'LOW';
  if (stepCount <= 4) return 'MEDIUM';
  if (stepCount <= 6) return 'HIGH';
  return 'MAX';
}

export function shouldRequireConfirmation(steps: TaskStep[], complexity?: ComplexityLevel, message?: string): boolean {
  // FIX 4: "plan first" intent — user explicitly asked to see the plan before execution
  if (detectPlanFirstIntent(message)) {
    return true;
  }

  // MAX complexity tasks always require confirmation — too many unknowns to proceed blindly
  if (complexity === 'MAX') return true;

  return steps.some(step => {
    const text = `${step.description} ${JSON.stringify(step.input)}`.toLowerCase();
    const destructive = /\b(delete|destroy|wipe|reset|remove|drop table|rm -rf|format disk)\b/.test(text);
    const externalSideEffect = /\b(send email|book flight|place order|charge card|publish live)\b/.test(text);
    const riskyOverwrite = step.skill === 'file_writer' && /\b(overwrite|replace existing|rewrite from scratch|rebuild)\b/.test(text);
    return destructive || externalSideEffect || riskyOverwrite;
  });
}

export function detectPlanFirstIntent(message?: string): boolean {
  if (!message) return false;
  const planFirstPatterns = /\bplan\s+first\b|\bshow\s+(?:me\s+)?the\s+plan\b|\breview\s+(?:the\s+)?plan\b/i;
  return planFirstPatterns.test(message);
}

function flattenMilestones(milestones: TaskMilestone[]): TaskStep[] {
  return milestones.flatMap(milestone => milestone.steps);
}

function buildGoals(message: string, contextGoals?: TaskGoal[]): TaskGoal[] {
  if (contextGoals && contextGoals.length > 0) return contextGoals;
  return [{ id: 'goal_1', sourceUnitIds: [], description: message }];
}

function buildMilestonesFromSteps(steps: TaskStep[], goals: TaskGoal[], complexity: ComplexityLevel): TaskMilestone[] {
  if (steps.length === 0) return [];

  if (complexity === 'LOW' || steps.length <= 2) {
    return [{
      id: 'milestone_1',
      goalIds: goals.map(goal => goal.id),
      title: 'Complete task',
      description: 'Finish the requested work.',
      completionCriteria: steps.at(-1)?.description ?? 'Requested work completed.',
      steps,
    }];
  }

  const chunkSize = steps.length <= 4 ? 2 : 3;
  const milestones: TaskMilestone[] = [];
  for (let i = 0; i < steps.length; i += chunkSize) {
    const chunk = steps.slice(i, i + chunkSize);
    milestones.push({
      id: `milestone_${milestones.length + 1}`,
      goalIds: goals.map(goal => goal.id),
      title: `Milestone ${milestones.length + 1}`,
      description: chunk.map(step => step.description).join(' Then '),
      completionCriteria: chunk.at(-1)?.description ?? 'Milestone complete.',
      steps: chunk,
    });
  }
  return milestones;
}

function normalizeMilestones(
  rawMilestones: unknown,
  fallbackSteps: TaskStep[],
  goals: TaskGoal[],
  complexity: ComplexityLevel,
): TaskMilestone[] {
  if (!Array.isArray(rawMilestones) || rawMilestones.length === 0) {
    return buildMilestonesFromSteps(fallbackSteps, goals, complexity);
  }

  const milestones: TaskMilestone[] = [];
  for (let i = 0; i < rawMilestones.length; i++) {
    const rawMilestone = rawMilestones[i];
    if (!rawMilestone || typeof rawMilestone !== 'object' || Array.isArray(rawMilestone)) continue;
    const milestone = rawMilestone as Partial<TaskMilestone>;
    const steps = Array.isArray(milestone.steps) ? milestone.steps as TaskStep[] : [];
    if (steps.length === 0) continue;

    milestones.push({
      id: typeof milestone.id === 'string' && milestone.id.trim() ? milestone.id : `milestone_${i + 1}`,
      goalIds: Array.isArray(milestone.goalIds) && milestone.goalIds.length > 0
        ? milestone.goalIds
        : goals.map(goal => goal.id),
      title: typeof milestone.title === 'string' && milestone.title.trim()
        ? milestone.title
        : `Milestone ${i + 1}`,
      description: typeof milestone.description === 'string' && milestone.description.trim()
        ? milestone.description
        : steps.map(step => step.description).join(' Then '),
      completionCriteria: typeof milestone.completionCriteria === 'string' && milestone.completionCriteria.trim()
        ? milestone.completionCriteria
        : steps.at(-1)?.description ?? 'Milestone complete.',
      steps,
    });
  }

  if (milestones.length === 0) {
    return buildMilestonesFromSteps(fallbackSteps, goals, complexity);
  }
  return milestones;
}

/**
 * Layer 3: For every generate_and_save_file step whose target path already exists
 * in the workspace manifest, ensure a file_reader step precedes it.
 * If one is missing, auto-insert it before the generation step.
 */
function enforceFileReaderPrerequisite(
  steps: TaskStep[],
  workspaceFiles?: string,
): TaskStep[] {
  if (!workspaceFiles) return steps;

  // Build set of known workspace paths from the manifest string
  const existingPaths = new Set<string>();
  for (const line of workspaceFiles.split('\n')) {
    const match = line.match(/^(workspace\/\S+)/);
    if (match) existingPaths.add(match[1]);
  }

  const result: TaskStep[] = [];
  for (const step of steps) {
    if (step.skill === 'generate_and_save_file') {
      const targetPath = typeof step.input?.path === 'string' ? step.input.path : '';
      const normalizedPath = targetPath.startsWith('workspace/')
        ? targetPath
        : `workspace/${targetPath}`;

      if (existingPaths.has(normalizedPath)) {
        // Check if a file_reader for this path already exists before this step
        const alreadyHasReader = result.some(
          s => s.skill === 'file_reader' && typeof s.input?.path === 'string' &&
            (s.input.path === targetPath || s.input.path === normalizedPath || s.input.path.endsWith(targetPath)),
        );
        // Also check if the step itself pulls content via context from a prior step
        const hasContextInput = typeof step.input?.context === 'string' && step.input.context.startsWith('{{');

        if (!alreadyHasReader && !hasContextInput) {
          const readerId = `auto_read_${step.id}`;
          const readerStep: TaskStep & { _insertedFor?: string } = {
            id: readerId,
            skill: 'file_reader',
            description: `Read existing file before modifying: ${targetPath}`,
            input: { path: normalizedPath },
            dependsOn: step.dependsOn ?? [],
            storeResultAs: `${step.id}_existing_content`,
            optional: false,
            confidence_score: 1.0,
            risk_level: 'LOW' as const,
            _insertedFor: step.id,
          };
          result.push(readerStep);
          // Wire the generation step to depend on the reader and use its content
          step.dependsOn = [...(step.dependsOn ?? []), readerId];
          if (!step.input) step.input = {};
          step.input.context = `{{${readerStep.storeResultAs}}}`;
        }
      }
    }
    result.push(step);
  }
  return result;
}

function normalizePlanPayload(
  raw: Record<string, unknown>,
  message: string,
  context: PlannerContext,
): Omit<TaskPlan, 'createdAt'> | null {
  const steps = Array.isArray(raw.steps) ? raw.steps as TaskStep[] : [];
  const rawGoals = Array.isArray(raw.goals) ? raw.goals as TaskGoal[] : [];
  const goals = rawGoals.length > 0 ? rawGoals : buildGoals(message, context.goals);
  // FIX 5A: Normalize model-returned "simple"/"complex" to canonical ComplexityLevel values
  // Legacy values (from schema description) are coerced to new enum values.
  const rawComplexity = typeof raw.complexity === 'string' ? raw.complexity : '';
  const complexityMap: Record<string, ComplexityLevel> = { simple: 'LOW', complex: 'MEDIUM' };
  const complexity: ComplexityLevel = complexityMap[rawComplexity]
    ?? (['LOW', 'MEDIUM', 'HIGH', 'MAX'].includes(rawComplexity) ? rawComplexity as ComplexityLevel : derivePlanComplexity(steps.length));

  if (complexityMap[rawComplexity]) {
    console.warn(
      `[zaraban][planner] Legacy complexity value "${rawComplexity}" normalized to "${complexity}"`
    );
  }
  const milestones = normalizeMilestones(raw.milestones, steps, goals, complexity);
  let flattenedSteps = flattenMilestones(milestones).slice(0, 8);

  if (flattenedSteps.length === 0) return null;

  // Safety net: strip pure mkdir steps and remove their dependency IDs from downstream steps.
  // file_writer creates parent directories automatically — mkdir steps are never needed.
  const mkdirStepIds = new Set(
    flattenedSteps
      .filter(s => s.skill === 'run_bash' && /^mkdir\b/.test(String(s.input?.command ?? '').trim()))
      .map(s => s.id)
  );
  if (mkdirStepIds.size > 0) {
    for (const step of flattenedSteps) {
      step.dependsOn = (step.dependsOn ?? []).filter(id => !mkdirStepIds.has(id));
    }
    flattenedSteps = flattenedSteps.filter(s => !mkdirStepIds.has(s.id));
    // Also remove mkdir steps from milestones
    for (const milestone of milestones) {
      milestone.steps = milestone.steps.filter(s => !mkdirStepIds.has(s.id));
    }
  }

  if (flattenedSteps.length === 0) return null;

  // Layer 3: enforce file_reader prerequisite for existing workspace files.
  // Operates on plan.steps — milestones are cosmetic groupings and don't need re-sync here.
  flattenedSteps = enforceFileReaderPrerequisite(flattenedSteps, context.workspaceFiles);

  return {
    goal: typeof raw.goal === 'string' && raw.goal.trim() ? raw.goal : message,
    goals,
    milestones,
    steps: flattenedSteps,
    complexity,
    needsConfirmation: shouldRequireConfirmation(flattenedSteps, complexity, message),
    estimatedDuration: typeof raw.estimatedDuration === 'string' ? raw.estimatedDuration : undefined,
  };
}

// FIX 2 — Programmatic default injection for schema-only fields
// The runtime owns metadata defaults like timestamps and baseline confidence.
export function normalizePlanDefaults(raw: Record<string, unknown>): Record<string, unknown> {
  let injectedCreatedAt = false;
  let injectedConfidence = 0;
  let injectedRiskLevel = 0;

  if (!raw.createdAt) {
    raw.createdAt = new Date().toISOString();
    injectedCreatedAt = true;
  }

  const normalizeStep = (step: unknown): unknown => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return step;

    const normalizedStep = step as Record<string, unknown>;
    if (normalizedStep.confidence_score === undefined) {
      normalizedStep.confidence_score = 0.8;
      injectedConfidence++;
    }
    if (normalizedStep.risk_level === undefined) {
      normalizedStep.risk_level = 'LOW';
      injectedRiskLevel++;
    }
    return normalizedStep;
  };

  if (Array.isArray(raw.steps)) {
    raw.steps = raw.steps.map(normalizeStep);
  }

  if (Array.isArray(raw.milestones)) {
    raw.milestones = raw.milestones.map((milestone: unknown) => {
      if (!milestone || typeof milestone !== 'object' || Array.isArray(milestone)) return milestone;
      const normalizedMilestone = milestone as Record<string, unknown>;
      if (Array.isArray(normalizedMilestone.steps)) {
        normalizedMilestone.steps = normalizedMilestone.steps.map(normalizeStep);
      }
      return normalizedMilestone;
    });
  }

  if (injectedCreatedAt || injectedConfidence > 0 || injectedRiskLevel > 0) {
    console.debug(
      `[zaraban][planner] Injected default${injectedCreatedAt ? ' createdAt' : ''}` +
      `${injectedConfidence > 0 ? `${injectedCreatedAt ? ',' : ''} confidence_score on ${injectedConfidence} step(s)` : ''}` +
      `${injectedRiskLevel > 0 ? `${injectedCreatedAt || injectedConfidence > 0 ? ',' : ''} risk_level on ${injectedRiskLevel} step(s)` : ''}`
    );
  }

  return raw;
}

const IMAGE_ACQUISITION_PATTERNS = /\b(use|include|add|embed)\s+(?:real\s+)?(?:images?|pictures?|photos?)\s+(?:on|from)\s+(?:the\s+)?(?:internet|web|online)\b/i;

export function validateImageAcquisition(plan: TaskPlan, originalMessage: string): boolean {
  if (!IMAGE_ACQUISITION_PATTERNS.test(originalMessage)) return false;

  const hasUrlExtract = plan.steps.some(step => step.skill === 'url_extract');
  const hasWebFetch = plan.steps.some(step => step.skill === 'web_fetch');
  if (hasUrlExtract || hasWebFetch) return false;

  console.warn(
    `[zaraban][planner] Plan for image-acquisition task has no url_extract or web_fetch steps. Skills: ${plan.steps.map(step => step.skill).join(', ')}`
  );
  transparency.emit({
    type: 'plan_image_warning',
    data: {
      message: 'Plan does not include image URL acquisition steps despite user requesting internet images',
      steps: plan.steps.map(step => step.skill),
    },
  });
  return true;
}

export async function decomposeTask(
  message: string,
  context: PlannerContext,
  llmHandler: LLMHandler,
): Promise<TaskPlan> {
  // Phase 15 Conflict 5: use project brain cache when projectCode is available
  let projectBrainContext = '';
  if (context.projectCode) {
    try {
      const { getProjectBrain } = await import('./memory/project.js');
      const { getDb } = await import('./memory/index.js');
      const db = getDb();
      projectBrainContext = await getProjectBrain(context.projectCode, db);
      transparency.emit({ type: 'project_brain', data: { hit: true, projectCode: context.projectCode } });
    } catch {
      transparency.emit({ type: 'project_brain', data: { hit: false, projectCode: context.projectCode } });
      // getProjectBrain failure is non-fatal — fall through to individual queries
    }
  }

  // Look for a relevant past procedure to use as starting point
  let procedurePreamble = '';
  try {
    const procedure = await findRelevantProcedure(message);
    if (procedure) {
      procedurePreamble = `RELEVANT PAST PROCEDURE:\n${procedure.slice(0, 800)}\nUse as starting point.\n\n`;
    }
  } catch {
    // findRelevantProcedure failure is non-fatal
  }

  const userMessageWithProcedure = procedurePreamble
    ? `${procedurePreamble}User request: ${message}`
    : message;

  const goalsText = context.goals && context.goals.length > 0
    ? context.goals.map(goal => `- ${goal.id}: ${goal.description} [units: ${goal.sourceUnitIds.join(', ') || '—'}]`).join('\n')
    : '- goal_1: ' + message;

  // Use project brain cache when available; otherwise fall back to memoryContext
  const memorySection = projectBrainContext
    ? `PROJECT BRAIN CONTEXT:\n${projectBrainContext}`
    : (() => {
        const filteredMemoryContext = context.memoryContext
          ? filterPlannerMemoryContext(context.memoryContext)
          : '';
        return filteredMemoryContext ? `RELEVANT MEMORY CONTEXT:\n${filteredMemoryContext}` : '';
      })();

  const workspaceSection = context.workspaceFiles
    ? `WORKSPACE STATE (files on disk right now):\n${context.workspaceFiles}`
    : '';

  const recentArtifactSection = context.recentArtifact
    ? [
        'RECENT ARTIFACT (the file just created/modified this session):',
        `- path: ${context.recentArtifact.path}`,
        `- type: ${context.recentArtifact.format}`,
        `- description: ${context.recentArtifact.description.slice(0, 300)}`,
        '→ If the user\'s message refers to "the game", "the page", "it", or "the file", they mean THIS file.',
        '→ To modify it: step 1 = file_reader(path above), step 2 = generate_and_save_file(same path, context="{{step1_result}}")',
      ].join('\n')
    : '';

  // FIX 2: Inject continuation context if resuming a prior plan
  const continuationSection = context.continuationContext
    ? `PRIOR EXECUTION STATE (resume from here):\n${context.continuationContext}`
    : '';

  const planningContextSections = [
    continuationSection,
    context.decompositionSummary ? `DECOMPOSED GOALS:\n${context.decompositionSummary}` : '',
    memorySection,
    workspaceSection,
    recentArtifactSection,
    goalsText ? `TASK GOALS:\n${goalsText}` : '',
  ].filter(Boolean).join('\n\n');

  const runtimeContext = context.permissionMode
    ? [
        '',
        'RUNTIME CONTEXT:',
        `- Permission mode: ${context.permissionMode}`,
        `- Skills available: ${context.skills.split('\n\n').length} of ${context.skills.split('\n\n').length + (context.blockedSkillNames?.length ?? 0)}`,
        ...(context.blockedSkillNames && context.blockedSkillNames.length > 0
          ? [
              `- BLOCKED skills (require higher permission): ${context.blockedSkillNames.join(', ')}`,
              '- If the user\'s task requires a blocked skill, explain the limitation and suggest what CAN be done with available skills.',
            ]
          : []),
      ].join('\n')
    : '';

  const plannerSystemPrompt = loadPlannerPrompt({
    skill_descriptions: context.skills,
    runtime_context: runtimeContext,
    planning_context_sections: planningContextSections,
  });

  const planningPrompt: Message[] = [
    {
      role: 'system',
      content: plannerSystemPrompt,
    },
    { role: 'user', content: userMessageWithProcedure },
  ];

  const MAX_REPAIR_ATTEMPTS = 2;
  let lastResponse = '';
  let retryFeedback = 'Your response was not valid JSON. Return ONLY a valid JSON object matching the schema.';
  let expectedStepCount: number | null = null;
  let expectedMilestoneCount: number | null = null;

  for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    const messages: Message[] = attempt === 0
      ? planningPrompt
      : [
          ...planningPrompt,
          { role: 'assistant', content: lastResponse },
          { role: 'user', content: retryFeedback },
        ];

    // Capture raw LLM output (before think-tag stripping) for CoT extraction
    let capturedThought: string | null = null;
    const unsubRaw = transparency.on(ev => {
      if (ev.type === 'llm_raw' && !capturedThought) {
        const raw = (ev.data as { raw: string }).raw;
        capturedThought = extractThought(raw);
      }
    });

    const response = await llmHandler(messages, {
      responseSchema: taskPlanJsonSchema,
      maxTokens: TOKEN_BUDGETS.PLANNER,
      disableThinking: true,
    });
    unsubRaw();
    lastResponse = response;

    if (process.env.DEBUG_PLANNER === 'true') {
      console.log(`[planner] Attempt ${attempt + 1} response (first 500 chars):`, response.slice(0, 500));
    }

    // Emit CoT thought from raw response (stripped version won't have it)
    const thought = capturedThought ?? extractThought(response);
    if (thought) {
      transparency.emit({ type: 'planner_reasoning', data: { thought } });
    }

    // Sanitize response before parsing
    const sanitized = sanitizePlannerJson(response);
    if (!sanitized || !sanitized.startsWith('{')) {
      if (process.env.DEBUG_PLANNER === 'true') {
        console.log('[planner] No valid JSON after sanitization');
      }
      retryFeedback = 'Your response was not valid JSON. Return ONLY compact valid JSON with no extra text.';
      continue;
    }

    if (process.env.DEBUG_PLANNER === 'true') {
      console.log('[planner] Sanitized (chars 300-400):', sanitized.slice(300, 400));
      console.log('[planner] Sanitized length:', sanitized.length);
      console.log('[planner] Sanitized (last 200 chars):', sanitized.slice(-200));
    }

    try {
      const raw = JSON.parse(sanitized) as Record<string, unknown>;
      // Parse without max constraint, then enforce 8-step limit
      if (
        raw.goal &&
        (
          (Array.isArray(raw.steps) && raw.steps.length > 0) ||
          (Array.isArray(raw.milestones) && raw.milestones.length > 0)
        )
      ) {
        const normalized = normalizePlanPayload(raw, message, context);
        if (!normalized) {
          retryFeedback = 'Your plan must include at least one valid step. Return corrected JSON only.';
          continue;
        }
        const trimmed = { ...normalized, steps: normalized.steps.slice(0, 8) };

        // DEBUG_DEEP: emit the full accepted plan JSON
        if (process.env.DEBUG_DEEP === 'true') {
          console.log('[planner:DEEP] FULL PLAN JSON:\n' + JSON.stringify(trimmed, null, 2));
        }

        if (requiresMemoryReadFirst(message) && !hasMemoryReadFirst(trimmed.steps)) {
          if (process.env.DEBUG_PLANNER === 'true') {
            console.log('[planner] Rejecting plan: first step is not memory_read');
          }
          retryFeedback = 'The user explicitly requested memory usage. Step 1 must be memory_read. Return corrected JSON only.';
          continue;
        }

        if (requestsBroadMemory(message) && trimmed.steps.length > 0) {
          const first = trimmed.steps[0];
          if (first && typeof first === 'object' && !Array.isArray(first)) {
            const firstStep = first as Record<string, unknown>;
            if (firstStep.skill === 'memory_read' && firstStep.input && typeof firstStep.input === 'object' && !Array.isArray(firstStep.input)) {
              const input = firstStep.input as Record<string, unknown>;
              if (typeof input.nb === 'string') {
                delete input.nb;
              }
            }
          }
        }

        // FIX 2: Inject defaults before Zod validation to prevent infinite schema loops
        const withDefaults = normalizePlanDefaults(trimmed);
        const result = TaskPlanSchema.safeParse(withDefaults);
        if (result.success) {
          // FIX 1: Validate milestone/step count on repair attempt
          if (attempt > 0 && (expectedStepCount !== null || expectedMilestoneCount !== null)) {
            const currentStepCount = result.data.steps?.length ?? 0;
            const currentMilestoneCount = result.data.milestones?.length ?? 0;

            const stepTruncated = expectedStepCount !== null && currentStepCount < expectedStepCount;
            const milestoneTruncated = expectedMilestoneCount !== null && currentMilestoneCount < expectedMilestoneCount;

            if (stepTruncated || milestoneTruncated) {
              transparency.emit({
                type: 'plan_repair_truncation',
                data: {
                  attempt,
                  expectedSteps: expectedStepCount,
                  actualSteps: currentStepCount,
                  expectedMilestones: expectedMilestoneCount,
                  actualMilestones: currentMilestoneCount,
                },
              });
            }
          }

          const plan: TaskPlan = {
            goal: result.data.goal,
            steps: result.data.steps,
            goals: result.data.goals,
            milestones: result.data.milestones,
            complexity: result.data.complexity,
            needsConfirmation: result.data.needsConfirmation,
            estimatedDuration: result.data.estimatedDuration,
            createdAt: result.data.createdAt,
          };

          // FIX 3: Validate plan referential integrity (orphaned steps, missing steps, broken deps)
          const integrity = validatePlanIntegrity(plan);
          if (!integrity.valid) {
            console.warn(
              `[zaraban][planner] Plan has referential integrity issues:`,
              {
                orphaned: integrity.orphanedSteps,
                missing: integrity.missingSteps,
                brokenDeps: integrity.brokenDependencies,
              }
            );
            transparency.emit({
              type: 'plan_integrity_warning',
              data: {
                orphanedSteps: integrity.orphanedSteps,
                missingSteps: integrity.missingSteps,
                brokenDependencies: integrity.brokenDependencies,
              },
            });

            // FIX 3: Auto-repair orphaned steps by assigning them to the correct milestone
            if (integrity.orphanedSteps.length > 0 && integrity.missingSteps.length === 0) {
              for (const orphanId of integrity.orphanedSteps) {
                const step = plan.steps.find(s => s.id === orphanId);
                if (!step) continue;

                // Find which milestone contains the step this one depends on
                let targetMilestone = plan.milestones && plan.milestones.length > 0
                  ? plan.milestones[plan.milestones.length - 1]
                  : null;

                if (step.dependsOn && step.dependsOn.length > 0 && plan.milestones) {
                  for (const milestone of plan.milestones) {
                    if (milestone.steps?.some(mstep => step.dependsOn!.includes((mstep as any).id))) {
                      targetMilestone = milestone;
                      break;
                    }
                  }
                }

                // Add the orphaned step to the target milestone
                if (targetMilestone) {
                  if (!targetMilestone.steps) targetMilestone.steps = [];
                  targetMilestone.steps.push(step);  // milestone.steps contains TaskStep objects
                  console.warn(
                    `[zaraban][planner] Auto-assigned orphaned step ${orphanId} to milestone ${targetMilestone.id}`
                  );
                }
              }
            }

            // If steps are missing from root (referenced in milestones but don't exist),
            // log loudly but don't crash
            if (integrity.missingSteps.length > 0) {
              console.error(
                `[zaraban][planner] CRITICAL: Milestone references non-existent steps: ` +
                integrity.missingSteps.join(', ')
              );
            }
          }

          validateImageAcquisition(plan, message);
          transparency.emit({ type: 'plan', data: plan });
          return plan;
        } else if (process.env.DEBUG_PLANNER === 'true') {
          console.log('[planner] Zod validation failed:', JSON.stringify(result.error.issues.slice(0, 3)));
        }
        // FIX 1: Extract step/milestone counts from failed attempt for validation on repair
        if (expectedStepCount === null || expectedMilestoneCount === null) {
          try {
            const parsed = JSON.parse(sanitized) as Record<string, unknown>;
            if (expectedStepCount === null && Array.isArray(parsed.steps)) {
              expectedStepCount = parsed.steps.length;
            }
            if (expectedMilestoneCount === null && Array.isArray(parsed.milestones)) {
              expectedMilestoneCount = parsed.milestones.length;
            }
          } catch { /* extraction failed */ }
        }
        retryFeedback = buildRepairMessage(result.error);
      }
    } catch (err) {
      if (process.env.DEBUG_PLANNER === 'true') {
        console.log('[planner] JSON parse or processing error:', err instanceof Error ? err.message : String(err));
      }
      // FIX 1: Extract counts before parse failure
      if (expectedStepCount === null || expectedMilestoneCount === null) {
        try {
          const parsed = JSON.parse(sanitized) as Record<string, unknown>;
          if (expectedStepCount === null && Array.isArray(parsed.steps)) {
            expectedStepCount = parsed.steps.length;
          }
          if (expectedMilestoneCount === null && Array.isArray(parsed.milestones)) {
            expectedMilestoneCount = parsed.milestones.length;
          }
        } catch { /* extraction failed */ }
      }
      retryFeedback = 'JSON parse failed. Return compact, valid JSON only. Do not include truncated or partial strings.';
    }
  }

  throw new Error('Failed to decompose task after retries');
}

/**
 * Post-plan assertion checker. Used in tests only.
 * Not called during runtime execution.
 */
export async function verifyPlanAssertions(
  plan: TaskPlan,
  llmHandler: LLMHandler,
): Promise<{ passed: boolean; failedAssertions: string[]; rewritePrompt?: string }> {
  const MAX_REJECTION_CYCLES = 2;
  let rejectionCycles = 0;
  let lastFailedAssertions: string[] = [];
  let lastRewritePrompt: string | undefined;

  while (rejectionCycles < MAX_REJECTION_CYCLES) {
    rejectionCycles++;
    try {
      const stepSummary = plan.steps.map(s => `- ${s.id} (${s.skill}): ${s.description}`).join('\n');

      const messages: Message[] = [
        {
          role: 'system',
          content: 'You are a plan verifier. Check if the plan is safe, feasible, and correct. Return JSON: {"passed": true/false, "failedAssertions": ["assertion1"], "rewritePrompt": "optional fix hint"}',
        },
        {
          role: 'user',
          content: `Goal: ${plan.goal}\n\nSteps:\n${stepSummary}`,
        },
      ];

      // FIX 1: Add responseSchema for engine-level JSON enforcement
      const response = await llmHandler(messages, {
        responseSchema: planAssertionJsonSchema,
        maxTokens: 300,
        disableThinking: true
      });
      const cleaned = response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const passed = Boolean(parsed.passed);
        const failedAssertions = Array.isArray(parsed.failedAssertions) ? parsed.failedAssertions : [];
        const rewritePrompt = parsed.rewritePrompt;

        if (passed) {
          return { passed: true, failedAssertions: [] };
        }

        lastFailedAssertions = failedAssertions;
        lastRewritePrompt = rewritePrompt;
        // Continue to next rejection cycle
      } else {
        // No JSON found — treat as passed to avoid false rejection
        return { passed: true, failedAssertions: [] };
      }
    } catch { /* advisory — non-fatal, treat as passed */
      return { passed: true, failedAssertions: [] };
    }
  }

  // Exhausted rejection cycles — return failed
  return { passed: false, failedAssertions: lastFailedAssertions, rewritePrompt: lastRewritePrompt };
}
