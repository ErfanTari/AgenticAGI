import type { Classification, LLMHandler, Message } from './types.js';
import { TaskPlanSchema, taskPlanJsonSchema } from './schemas.js';
import type { TaskPlan } from './schemas.js';
import { transparency } from './transparency.js';
import { queryEntries } from './memory/index.js';
import { fetchByCode } from './memory/fetch.js';

// --- Complexity Detection (Priority 2) ---

export interface ComplexityResult {
  isComplex: boolean;
  reason: string;
  estimatedSteps: number;
  requiresSkills: string[];
}

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
  saveToMemory: /\bsave\b.{0,30}\b(as\s+(a\s+)?NOW|entry\s+in\s+memory|in\s+memory|to\s+memory)\b/i,
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
  { skill: 'memory_write', patterns: [/\bcreate\s+(a\s+)?(contact|project|todo|entry)\b/i, /\bremember\b/i, /\bsave\s+(a\s+)?note\b/i, /\bsave\b.{0,40}\b(entry\s+in\s+memory|in\s+memory|to\s+memory|as\s+(a\s+)?NOW\.\w+)\b/i] },
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

export async function isComplexTask(
  message: string,
  _classification: Classification,
  llmHandler?: LLMHandler,
): Promise<ComplexityResult> {
  const { count, signals, skills } = countHeuristicSignals(message);

  function emitAndReturn(result: ComplexityResult): ComplexityResult {
    transparency.emit({ type: 'complexity', data: result });
    return result;
  }

  // Fast path: 2+ signals → complex
  if (count >= 2) {
    return emitAndReturn({
      isComplex: true,
      reason: `Heuristic: ${signals.join(', ')}`,
      estimatedSteps: Math.max(2, skills.length + 1),
      requiresSkills: skills,
    });
  }

  // Fast path: 0 signals and short message → simple
  if (count === 0 && message.length < 100) {
    return emitAndReturn({
      isComplex: false,
      reason: 'Short message, no complexity signals',
      estimatedSteps: 1,
      requiresSkills: skills,
    });
  }

  // Ambiguous: 1 signal or long message with 0 signals → ask LLM
  if (llmHandler) {
    try {
      const prompt: Message[] = [
        {
          role: 'system',
          content: `You are a task complexity analyzer. Given a user message, determine if it requires multiple steps to complete. Return ONLY a JSON object: {"isComplex": true/false, "reason": "brief explanation", "estimatedSteps": N, "requiresSkills": ["skill1"]}`,
        },
        { role: 'user', content: message },
      ];
      const response = await llmHandler(prompt, { maxTokens: 200 });
      // BUG 4 Fix B: sanitize thinking tags before JSON extraction
      const sanitized = response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      if (!sanitized) {
        // LLM returned nothing after sanitization — default to complex for safety
        if (process.env.DEBUG_PLANNER === 'true') {
          console.debug('[planner] LLM complexity check empty after sanitization, defaulting to complex');
        }
        return emitAndReturn({
          isComplex: true,
          reason: 'LLM response empty after sanitization, defaulting to complex',
          estimatedSteps: 3,
          requiresSkills: skills,
        });
      }
      const jsonMatch = sanitized.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return emitAndReturn({
          isComplex: Boolean(parsed.isComplex),
          reason: String(parsed.reason ?? 'LLM assessment'),
          estimatedSteps: Number(parsed.estimatedSteps ?? 1),
          requiresSkills: Array.isArray(parsed.requiresSkills) ? parsed.requiresSkills : skills,
        });
      }
    } catch {
      // LLM failed — fall back to heuristic
    }
  }

  // Fallback: 1 signal → borderline complex
  return emitAndReturn({
    isComplex: count >= 1,
    reason: count >= 1 ? `Borderline: ${signals.join(', ')}` : 'No signals detected',
    estimatedSteps: count >= 1 ? 2 : 1,
    requiresSkills: skills,
  });
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
  // Step 1: Extract first complete JSON object (bracket-depth counter stops at first complete object,
  // preventing two concatenated JSON objects from being merged into an unparseable blob)
  const extracted = extractFirstJsonObject(raw);
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
      const score = overlap / nameWords.length;
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

export async function decomposeTask(
  message: string,
  context: { skills: string; history?: string },
  llmHandler: LLMHandler,
): Promise<TaskPlan> {
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

  const planningPrompt: Message[] = [
    {
      role: 'system',
      content: `You are a task planner. Decompose the user's request into a sequence of steps.
Each step uses one skill. Available skills:
${context.skills}

Output ONLY raw JSON in COMPACT format (single line, no newlines, no indentation). No markdown. No code blocks. No backticks. No explanations. No thinking text.
Start your response with { and end with }

CRITICAL: Use compact JSON format: {"goal":"...","steps":[{...}]} - DO NOT use pretty-printed JSON with newlines.

Return ONLY a JSON object matching this schema:
{
  "goal": "what the user wants",
  "steps": [
    {
      "id": "step1",
      "description": "what this step does",
      "skill": "skill_name",
      "input": { ... skill input params ... },
      "dependsOn": [],
      "storeResultAs": "step1_result",
      "optional": false
    }
  ],
  "estimatedDuration": "30s"
}

CRITICAL INPUT RULES:
- "input" values must be primitive only: string, number, boolean, or null
- NEVER nest objects inside "input"
- "optional" must be boolean true/false (not an object)
- "storeResultAs" must be a string or null (not an object)

CORRECT:
- "optional": false
- "storeResultAs": "step1_result"
- "input": {"path": "workspace/file.html", "content": "<!DOCTYPE html>..."}

WRONG (do not generate these):
- "optional": {"false": ""}
- "storeResultAs": {"step1_result": ""}
- "input": {"path": {"workspace/file.html": ""}}

More correct examples:
- web_search: { "query": "search term here" }
- file_reader: { "path": "/path/to/file.txt" }
- calculator: { "expression": "5 + 3" }
- run_bash: { "command": "ls -la" }
- memory_read: { "query": "projects and skills for Erfan", "nb": "WHAT", "limit": 6 }
- memory_write (project): { "nb": "WHAT", "type": "PJ", "name": "ProjectName", "summary": "one line summary", "body": "details" }
- memory_write (todo): { "nb": "NOW", "type": "TD", "name": "Task description", "summary": "brief", "body": "details" }
- memory_write (contact): { "nb": "WHO", "type": "CT", "name": "Full Name", "summary": "role or note", "body": "contact details" }
- memory_write (event): { "nb": "WHEN", "type": "CA", "name": "Event name", "summary": "brief", "body": "date and details" }
- memory_write (knowledge): { "nb": "WHAT", "type": "KN", "name": "Entry name", "summary": "one line", "body": "full content" }
- memory_write (procedure): { "nb": "HOW", "type": "PR", "name": "Procedure name", "summary": "brief", "body": "steps" }
- relationship_write: { "from_code": "WHO.CT-000001", "relation": "interested_in", "to_code": "WHAT.PJ-000003" }
- relationship_write (by name): { "from_code": "Sara Ahmadi", "relation": "interested_in", "to_code": "AgenticAGI" }
- content_writer (markdown report): { "prompt": "Write a status report...", "format": "markdown", "maxTokens": 1500 }
- content_writer (html page): { "prompt": "Write an HTML portfolio...", "format": "html", "maxTokens": 2800 }
- content_writer (plain/code): { "prompt": "Write a JavaScript function...", "format": "plain", "maxTokens": 500 }
IMPORTANT: content_writer MUST always include "format" field. Default to "markdown" for reports/assessments/briefings, "html" for web pages, "plain" for code.

RELATIONSHIP_WRITE RULES:
→ ALWAYS use entry codes not names when available
→ If a prior step stored a code via storeResultAs, use that template in relationship_write input
→ CORRECT pattern:
  Step 1: memory_write { "name": "Sara Ahmadi", ... } storeResultAs: "sara_code"
  Step 2: relationship_write { "from_code": "{{sara_code}}", "relation": "interested_in", "to_code": "WHAT.PJ-000014" }
→ WRONG pattern:
  Step 2: relationship_write { "from_code": "Sara Ahmadi", "to_code": "AgenticAGI" }
  ← names cause ambiguous lookup when duplicates exist
→ If you don't have a code from a prior step, use the exact full name as it appears in memory
→ For well-known entries like AgenticAGI, use the known code directly: WHAT.PJ-000014

CRITICAL SKILL SELECTION RULES:
- Use memory_write when: saving contacts, projects, todos, knowledge, plans, deadlines, procedures, reflections, or ANY notebook entry (WHO/WHAT/WHEN/HOW/WHY/NOW/PLAN). Memory entries use codes like WHO.CT-000001, WHAT.PJ-000003 etc.
- Use relationship_write when: linking two entries with a directional relationship (interested_in, owns, works_for, blocks, refers). NEVER use memory_write for relationships.
- Use file_writer ONLY when: the user explicitly asks to write/save/create an actual file on disk (.txt, .md, .json, .sh etc.)
- NEVER use file_writer for notebook memory entries
- run_bash runs inside workspace/ directory — NEVER include "cd workspace" in bash commands, it is already the working directory
- JavaScript files in workspace use ESM (ES modules) — use "import" NOT "require". Use: import fibonacci from './fibonacci.js'; NOT: const fibonacci = require('./fibonacci');
- When writing JS test files use node:assert: import assert from 'node:assert'; assert.strictEqual(fibonacci(1), 1);
- For test+fix loops: mark run_bash steps as optional: true so the plan continues to fix steps even if tests fail
- PREFER implement_and_test over manual write→run→fix steps when the task is: write code + run tests + fix failures. This collapses the loop into ONE plan step, freeing the remaining steps for memory_write or other tasks. Do NOT encode write→test→fix as separate plan steps when implement_and_test is available.

implement_and_test input format:
{
  "implementation_prompt": "Write a JavaScript ESM function called fibonacci that returns the nth Fibonacci number. Export as default.",
  "test_prompt": "Write ESM tests for fibonacci: fib(1)=1, fib(5)=5, fib(10)=55. Import from ./fibonacci.js",
  "filename": "fibonacci.js",
  "test_filename": "fibonacci.test.js",
  "max_attempts": 3
}
This skill handles the retry loop internally and writes a HOW.PR entry on success.
- NEVER use file_writer to "save" information unless user explicitly says "save to file" or names a file

Rules:
- Maximum 8 steps
- Use "dependsOn" to reference previous step IDs when a step needs prior output
- Use "storeResultAs" to name outputs that later steps reference via {{stepN_result}} in their input
- Mark non-critical steps as "optional": true
- If the task involves creating memory, include a memory_write step

ARCHITECTURE RULES:
- If the user asks to use memory (e.g. "from memory", "use everything you know about me"), step 1 MUST be memory_read.
- Never use file_reader to access memory notebooks; use memory_read for memory content.
- Do NOT inline large file contents in planner JSON.
- For large artifacts (HTML/CSS/JS/docs), use:
  1) content_writer step to generate content text
  2) file_writer step to write that generated text
- run_bash already executes inside workspace root; if cwd is needed, it must be a subdirectory relative to workspace (e.g. "src"), never "workspace".
- Keep planner JSON small and structural.

SYNTHESIS TASK WORKFLOW:
When asked for a report, overview, briefing, weekly status, or summary of the user's work/projects/status, ALWAYS follow this exact sequence. NEVER skip memory_read steps to save time.

STEP 1 — memory_read: read active projects
  input: { "query": "active projects", "nb": "WHAT", "limit": 10 }
  storeResultAs: "projects"
STEP 2 — memory_read: read deadlines and calendar events
  input: { "query": "deadlines events upcoming", "nb": "WHEN", "limit": 10 }
  storeResultAs: "deadlines"
STEP 3 — memory_read: read todos and active tasks
  input: { "query": "todos overdue due tasks", "nb": "NOW", "limit": 10 }
  storeResultAs: "todos"
STEP 4 — memory_read: read active plans (optional — PLAN may be empty)
  input: { "query": "active plans", "nb": "PLAN", "limit": 5 }
  storeResultAs: "plans"
  optional: true
STEP 5 — content_writer: generate the report from all memory
  input: { "prompt": "Write a weekly status report in markdown. Projects: {{projects}} Deadlines: {{deadlines}} Todos: {{todos}} Plans: {{plans}}", "format": "markdown", "maxTokens": 1500 }
  storeResultAs: "report_content"
  dependsOn: [step1, step2, step3, step4]
STEP 6 — file_writer: save report to workspace
  input: { "path": "workspace/weekly_report.md", "content": "{{report_content}}" }
  dependsOn: [step5]
STEP 7 — memory_write: save report as NOW.RP entry
  input: { "nb": "NOW", "type": "RP", "name": "Weekly Status Report", "summary": "Auto-generated weekly status report", "body": "{{report_content}}" }
  dependsOn: [step5]

SYNTHESIS RULES:
→ ALWAYS read at least WHAT and NOW notebooks before generating any report (required steps)
→ WHEN and PLAN memory_read steps are optional: true — they may return empty results
→ ALWAYS write both file AND memory entry (steps 6 and 7 are both required)
→ NEVER skip memory_read steps to save time
→ content_writer receives ALL notebook data combined in its context
→ If the user names a specific file path, use that path in file_writer

COMPARISON TASK RULES:
When asked to "compare X to our system/architecture/project":
→ Step 1: web_search for external information about X
→ Step 2: memory_read with a SPECIFIC query targeting the named project or entry
  CORRECT: { "query": "AgenticAGI architecture notebooks codes relationships", "nb": "WHAT", "limit": 3 }
  WRONG:   { "query": "memory", "nb": "WHAT", "limit": 10 }  ← too broad, returns unrelated entries
→ Do NOT use prior comparison reports or knowledge entries as source for a new comparison
  Prior reports are DERIVED content, not source truth — always read the original project entry
→ content_writer prompt must reference BOTH {{search_results}} AND {{memory_result}} explicitly
  CORRECT: { "prompt": "Compare: Research says {{search_results}}. Our system from memory: {{memory_result}}. What are we doing better? What are we missing?", "format": "markdown" }

WEB RESEARCH + SYNTHESIS WORKFLOW:
When a task requires searching the web and then writing a comparison, assessment, briefing, or report (NOT downloading a file), use this pattern:

STEP 1 — web_search: find relevant content
  input: { "query": "specific search terms" }
  storeResultAs: "search_results"
  optional: false
STEP 2 — content_writer: synthesize search results with memory data
  input: { "prompt": "Write the comparison/briefing using search results: {{search_results}} and memory: {{memory_result}}", "maxTokens": 1500 }
  storeResultAs: "report_content"
  dependsOn: [step1_id]
→ For synthesis tasks, pass {{search_results}} DIRECTLY to content_writer. Do NOT use url_extract or web_fetch.

WEB BROWSING / DOWNLOAD WORKFLOW:
When a task requires actually visiting a website or downloading a file, ALWAYS follow this exact sequence.
NEVER skip url_extract steps — they are MANDATORY between any search/fetch and the next URL-consuming step.

STEP 1 — web_search: find relevant pages
  input: { "query": "search terms" }
  storeResultAs: "search_results"
STEP 2 — url_extract: MANDATORY — get a clean URL from search results (NEVER skip this)
  input: { "text": "{{search_results}}" }
  storeResultAs: "target_url"
  dependsOn: [step1_id]
STEP 3 — web_fetch: load the actual page to find download links
  input: { "url": "{{target_url}}", "extract_links_matching": ".pdf" }
  storeResultAs: "page_content"
  dependsOn: [step2_id]
STEP 4 — url_extract: MANDATORY — get the direct download link from the page (NEVER skip this)
  input: { "text": "{{page_content}}", "filter": "pdf" }
  storeResultAs: "download_url"
  dependsOn: [step3_id]
STEP 5 — run_bash: download the file
  input: { "command": "mkdir -p downloads && curl -L -o downloads/filename.pdf '{{download_url}}'" }
  dependsOn: [step4_id]

BAD EXAMPLE (DO NOT DO THIS — skips url_extract):
  step1: web_search → step2: web_fetch(url="{{search_results}}") ← WRONG, never use raw search results as URL

GOOD EXAMPLE (correct pattern):
  step1: web_search → step2: url_extract(text="{{search_results}}") → step3: web_fetch(url="{{target_url}}")

WEB BROWSING RULES (NEVER BREAK THESE):
- NEVER pass search result text directly as a URL to curl or web_fetch
- NEVER use curl with a search query as the URL
- ALWAYS use url_extract between web_search/web_fetch and any download step — NEVER skip url_extract
- NEVER go from web_search directly to web_fetch or run_bash without url_extract in between
- web_fetch loads pages and returns links; run_bash+curl downloads files
- curl command MUST single-quote the URL: curl -L -o file '{{download_url}}'
- Use -L flag with curl to follow redirects
- url_extract output is a single clean URL string — use it directly in next step`,
    },
    { role: 'user', content: userMessageWithProcedure },
  ];

  const MAX_RETRIES = 2;
  let lastResponse = '';
  let retryFeedback = 'Your response was not valid JSON. Return ONLY a valid JSON object matching the schema.';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const messages: Message[] = attempt === 0
      ? planningPrompt
      : [
          ...planningPrompt,
          { role: 'assistant', content: lastResponse },
          { role: 'user', content: retryFeedback },
        ];

    const response = await llmHandler(messages, {
      responseSchema: taskPlanJsonSchema,
      maxTokens: 4096,  // Increased to handle large file content in plans
    });
    lastResponse = response;

    if (process.env.DEBUG_PLANNER === 'true') {
      console.log(`[planner] Attempt ${attempt + 1} response (first 500 chars):`, response.slice(0, 500));
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
      const raw = JSON.parse(sanitized);
      // Parse without max constraint, then enforce 8-step limit
      if (raw.goal && Array.isArray(raw.steps) && raw.steps.length > 0) {
        const trimmed = { ...raw, steps: raw.steps.slice(0, 8) };

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

        const result = TaskPlanSchema.safeParse(trimmed);
        if (result.success) {
          const plan: TaskPlan = {
            goal: result.data.goal,
            steps: result.data.steps,
            estimatedDuration: result.data.estimatedDuration,
            createdAt: new Date().toISOString(),
          };
          transparency.emit({ type: 'plan', data: plan });
          return plan;
        } else if (process.env.DEBUG_PLANNER === 'true') {
          console.log('[planner] Zod validation failed:', JSON.stringify(result.error.issues.slice(0, 3)));
        }
        retryFeedback = 'Schema validation failed. Ensure all fields match required types and return corrected JSON only.';
      }
    } catch (err) {
      if (process.env.DEBUG_PLANNER === 'true') {
        console.log('[planner] JSON parse or processing error:', err instanceof Error ? err.message : String(err));
      }
      retryFeedback = 'JSON parse failed. Return compact, valid JSON only. Do not include truncated or partial strings.';
    }
  }

  throw new Error('Failed to decompose task after retries');
}
