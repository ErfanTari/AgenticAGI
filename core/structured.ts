import type { ZodSchema } from 'zod';
import type { LLMHandler, Message } from './types.js';

export interface StructuredResult<T> {
  success: boolean;
  data?: T;
  raw?: string;
  attempts: number;
  error?: string;
}

/**
 * Extract the first complete JSON object from text using bracket-depth counting.
 * Stops at the closing brace of the first complete object.
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
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1);
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
 */
export function applyRepairPasses(raw: string): string {
  let s = raw;

  // Remove thinking tags and LM Studio tokens
  s = s.replace(/<\|im_start\|>/g, '').replace(/<\|im_end\|>/g, '');
  s = s.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  // Fix escaped quotes outside string values
  s = fixEscapedQuotes(s);

  // Fix trailing commas before } or ]
  s = s.replace(/,(\s*[}\]])/g, '$1');

  // Fix unquoted keys: {key: "value"} → {"key": "value"}
  s = s.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');

  return s;
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
  try {
    const json = JSON.parse(repaired);
    const flat = flattenSingleKeyObjects(json);
    const result = schema.safeParse(flat);
    if (result.success) {
      return { success: true, data: result.data, raw, attempts };
    }

    // Try LLM repair
    if (options?.llmHandler && attempts <= maxRepairs) {
      const repairResult = await llmRepair(repaired, JSON.stringify(result.error), schema, options.llmHandler);
      if (repairResult) {
        attempts++;
        const repairExtracted = extractFirstJsonObject(repairResult);
        if (repairExtracted) {
          const repairJson = JSON.parse(applyRepairPasses(repairExtracted));
          const repairFlat = flattenSingleKeyObjects(repairJson);
          const repairParsed = schema.safeParse(repairFlat);
          if (repairParsed.success) {
            return { success: true, data: repairParsed.data, raw, attempts };
          }
        }
      }
    }

    return {
      success: false,
      raw,
      attempts,
      error: `Schema validation failed: ${JSON.stringify(result.error.issues?.slice(0, 3) ?? {})}`,
    };
  } catch (err) {
    // JSON parse failed, try LLM repair
    if (options?.llmHandler && attempts <= maxRepairs) {
      const repairResult = await llmRepair(repaired, String(err), schema, options.llmHandler);
      if (repairResult) {
        attempts++;
        try {
          const repairExtracted = extractFirstJsonObject(repairResult);
          if (repairExtracted) {
            const repairJson = JSON.parse(applyRepairPasses(repairExtracted));
            const repairFlat = flattenSingleKeyObjects(repairJson);
            const repairParsed = schema.safeParse(repairFlat);
            if (repairParsed.success) {
              return { success: true, data: repairParsed.data, raw, attempts };
            }
          }
        } catch {
          // repair also failed
        }
      }
    }

    return { success: false, raw, attempts, error: `JSON parse error: ${String(err)}` };
  }
}
