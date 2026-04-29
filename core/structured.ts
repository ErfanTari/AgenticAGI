import { ZodError, type ZodSchema } from 'zod';
import type { LLMHandler, Message } from './types.js';
import { jsonrepair } from 'jsonrepair';

export interface StructuredResult<T> {
  success: boolean;
  data?: T;
  raw?: string;
  attempts: number;
  error?: string;
}

export type SafeParseJsonWithErrorResult<T> =
  | { data: T; error: null; parsed: unknown }
  | { data: null; error: ZodError<T>; parsed: unknown | null; parseError?: undefined }
  | { data: null; error: null; parsed: null; parseError: string };

/**
 * FIX 2: Attempt to repair common JSON string escape errors from LLM output.
 * Fixes:
 * - Literal newlines inside JSON strings (should be \\n)
 * - Literal tabs inside JSON strings (should be \\t)
 * - Literal carriage returns inside JSON strings (should be \\r)
 *
 * This is best-effort — not a full JSON parser. It handles the 80% case
 * where the model outputs a literal newline inside a string value.
 */
export function repairJsonEscapes(raw: string): string {
  let result = '';
  let inString = false;
  let escape = false;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];

    if (escape) {
      result += char;
      escape = false;
      continue;
    }

    if (char === '\\' && inString) {
      result += char;
      escape = true;
      continue;
    }

    if (char === '"' && !escape) {
      inString = !inString;
      result += char;
      continue;
    }

    if (inString) {
      if (char === '\n') {
        result += '\\n';
        continue;
      }
      if (char === '\t') {
        result += '\\t';
        continue;
      }
      if (char === '\r') {
        result += '\\r';
        continue;
      }
    }

    result += char;
  }

  return result;
}

/**
 * Extract the first complete JSON object from text using bracket-depth counting.
 * Stops at the closing brace of the first complete object.
 * FIX 2: Attempts to repair common escape errors on parse failure.
 */
export function extractFirstJsonObject(text: string): string | null {
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
      // BUG-M3 fix: clamp depth to 0 — ignore unmatched closing braces before any opening brace
      if (depth < 0) { depth = 0; continue; }
      if (depth === 0 && start !== -1) {
        const candidate = text.slice(start, i + 1);

        // FIX 2: Try to parse extracted candidate; if it fails, attempt escape repair
        try {
          JSON.parse(candidate);
          return candidate;  // Parsing succeeded, return as-is
        } catch {
          // First parse failed, try repairing escapes
          const repaired = repairJsonEscapes(candidate);
          try {
            JSON.parse(repaired);
            console.debug('[zaraban][json-repair] Escape repair succeeded');
            return repaired;  // Repair succeeded, return repaired version
          } catch {
            // Repair also failed, return original candidate — let caller handle the error
            return candidate;
          }
        }
      }
    }
  }
  return null;
}

/**
 * Flatten single-key nested objects recursively.
 * e.g. {"path": {"workspace/file.html": ""}} → {"path": "workspace/file.html"}
 */
export function flattenSingleKeyObjects(value: unknown, depth = 0): unknown {
  if (depth > 10) return value;
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => flattenSingleKeyObjects(v, depth + 1));

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);

  if (keys.length === 1) {
    const key = keys[0];
    const val = obj[key];

    if (val === '' || val === null) {
      if (key === 'true') return true;
      if (key === 'false') return false;
      const num = Number(key);
      if (!isNaN(num) && key.trim() !== '') return num;
      return key;
    }

    if (typeof val === 'object') {
      const inner = flattenSingleKeyObjects(val, depth + 1);
      if (typeof inner !== 'object' || inner === null) return inner;
      if (!Array.isArray(val) && Object.keys(val as object).length === 1) return key;
    }
  }

  const result: Record<string, unknown> = {};
  for (const key of keys) {
    result[key] = flattenSingleKeyObjects(obj[key], depth + 1);
  }
  return result;
}

/**
 * Apply all repair passes to raw JSON-like text.
 * Returns cleaned string, or original if no passes apply.
 *
 * BUG-H3/H4 fix: if the input is already valid JSON, return it immediately.
 * This prevents the unquoted-key repair pass from corrupting string values that
 * contain {key: value} patterns, and prevents think-tag stripping from deleting
 * content inside JSON string values.
 */
export function applyRepairPasses(raw: string): string {
  // Fast path: already valid JSON — no repairs needed
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    // Not valid JSON — apply repairs
  }

  // Strip thinking/LM Studio tokens before attempting jsonrepair
  let s = raw;
  s = s.replace(/<\|im_start\|>/g, '').replace(/<\|im_end\|>/g, '');
  s = s.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  s = fixEscapedQuotes(s);

  // Layer 2: try jsonrepair (npm package — handles trailing commas, unquoted keys,
  // single quotes, comment blocks, markdown fences, and more)
  try {
    const repaired = jsonrepair(s);
    JSON.parse(repaired); // validate
    return repaired;
  } catch { /* fall through to manual passes */ }

  // Fallback: manual passes for cases jsonrepair can't handle
  s = s.replace(/,(\s*[}\]])/g, '$1');
  s = s.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');

  return s;
}

export function safeParseJsonWithError<T>(
  raw: string,
  schema: ZodSchema<T>,
  callSite: string,
): SafeParseJsonWithErrorResult<T> {
  try {
    const extracted = extractFirstJsonObject(raw);
    if (!extracted) {
      return {
        data: null,
        error: null,
        parsed: null,
        parseError: `[zaraban][${callSite}] No JSON object found in response`,
      };
    }

    const repaired = applyRepairPasses(extracted);
    const parsed = flattenSingleKeyObjects(JSON.parse(repaired));
    const result = schema.safeParse(parsed);
    if (!result.success) {
      return { data: null, error: result.error, parsed };
    }

    return { data: result.data, error: null, parsed };
  } catch (error) {
    return {
      data: null,
      error: null,
      parsed: null,
      parseError: `[zaraban][${callSite}] JSON parse error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

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
      result += '"';
      i++;
    } else {
      result += char;
    }
    i++;
  }

  return result;
}

async function llmRepair<T>(
  broken: string,
  parseError: string,
  schema: ZodSchema<T>,
  llmHandler: LLMHandler,
): Promise<string | null> {
  try {
    const schemaDesc = JSON.stringify((schema as any)._def ?? {}).slice(0, 300);
    const prompt: Message[] = [
      {
        role: 'system',
        content: `You are a JSON repair assistant. Fix the malformed JSON below to match the required schema. Return ONLY valid JSON, no explanations.
Schema hint: ${schemaDesc}`,
      },
      {
        role: 'user',
        content: `Malformed JSON:\n${broken}\n\nError: ${parseError}\n\nReturn the corrected JSON only.`,
      },
    ];
    return await llmHandler(prompt, { maxTokens: 500 });
  } catch {
    return null;
  }
}

/**
 * Parse structured output from raw LLM text using a Zod schema.
 * Applies repair passes and optional LLM-assisted repair on failure.
 */
export async function parseStructured<T>(
  raw: string,
  schema: ZodSchema<T>,
  options?: {
    maxRepairAttempts?: number;
    llmHandler?: LLMHandler;
    context?: string;
  },
): Promise<StructuredResult<T>> {
  const maxRepairs = options?.maxRepairAttempts ?? 1;
  let attempts = 0;

  // Attempt 1: extract + repair passes
  const extracted = extractFirstJsonObject(raw);
  if (!extracted) {
    return { success: false, raw, attempts: 1, error: 'No JSON object found in response' };
  }

  attempts++;
  let repaired = applyRepairPasses(extracted);

  // Try to parse and validate
  let lastError = '';
  try {
    const json = JSON.parse(repaired);
    const flat = flattenSingleKeyObjects(json);
    const result = schema.safeParse(flat);
    if (result.success) {
      return { success: true, data: result.data, raw, attempts };
    }
    lastError = JSON.stringify(result.error.issues?.slice(0, 3) ?? {});
  } catch (err) {
    lastError = String(err);
  }

  // BUG-M2 fix: loop LLM repair up to maxRepairAttempts times, breaking on success.
  if (options?.llmHandler) {
    while (attempts <= maxRepairs) {
      const repairResult = await llmRepair(repaired, lastError, schema, options.llmHandler);
      attempts++;
      if (!repairResult) break;

      const repairExtracted = extractFirstJsonObject(repairResult);
      if (!repairExtracted) break;

      try {
        const repairJson = JSON.parse(applyRepairPasses(repairExtracted));
        const repairFlat = flattenSingleKeyObjects(repairJson);
        const repairParsed = schema.safeParse(repairFlat);
        if (repairParsed.success) {
          return { success: true, data: repairParsed.data, raw, attempts };
        }
        lastError = JSON.stringify(repairParsed.error.issues?.slice(0, 3) ?? {});
        repaired = repairExtracted; // use latest repaired version for next attempt
      } catch (err) {
        lastError = String(err);
        break;
      }
    }
  }

  return {
    success: false,
    raw,
    attempts,
    error: lastError.startsWith('{') || lastError.startsWith('[')
      ? `Schema validation failed: ${lastError}`
      : `JSON parse error: ${lastError}`,
  };
}
