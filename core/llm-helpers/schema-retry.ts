/**
 * Layer 3 — Zod retry loop.
 * When Layer 2 (jsonrepair) produces an object that doesn't satisfy the Zod schema,
 * re-prompt the model with a formatted error + schema shape. Cap: 1 retry (2 total attempts).
 */
import { z, ZodError } from 'zod';
import { transparency } from '../transparency.js';
import { getCurrentRequestId } from '../transparency.js';
import { tryJsonRepair } from './json-repair.js';

export type SchemaRetryOptions<_T> = {
  schema: z.ZodTypeAny;
  rawOutput: string;
  /** Re-prompts the model; returns new raw output string. */
  retryFn: (correctionPrompt: string) => Promise<string>;
  maxRetries?: number; // default 1
};

export type SchemaRetryResult<T = unknown> =
  | { ok: true; value: T; layer: 1 | 2 | 3; attempts: number }
  | { ok: false; error: string; lastRawOutput: string };

export async function parseWithRetry<T = unknown>(
  opts: SchemaRetryOptions<T>,
): Promise<SchemaRetryResult<T>> {
  const requestId = getCurrentRequestId() ?? 'unknown';
  const maxRetries = opts.maxRetries ?? 1;
  let attempts = 0;
  let currentRaw = opts.rawOutput;

  while (attempts <= maxRetries) {
    attempts++;

    const repair = tryJsonRepair(currentRaw);
    if (!repair.repaired) {
      if (attempts > maxRetries) {
        transparency.emit({
          type: 'json_repair_failed',
          data: { layer: 3, reason: repair.reason, requestId },
        });
        return { ok: false, error: `JSON parse failed: ${repair.reason}`, lastRawOutput: currentRaw };
      }
      const correction = buildCorrectionPrompt(currentRaw, opts.schema, `JSON parse error: ${repair.reason}`);
      currentRaw = await opts.retryFn(correction);
      continue;
    }

    const result = (opts.schema as z.ZodTypeAny).safeParse(repair.value);
    if (result.success) {
      const layer: 1 | 2 | 3 = attempts === 1
        ? (repair.bytesChanged === 0 ? 1 : 2)
        : 3;
      transparency.emit({
        type: 'schema_validation_succeeded',
        data: { layer, attempts, requestId },
      });
      return { ok: true, value: result.data as T, layer, attempts };
    }

    if (attempts > maxRetries) {
      const zodErr = formatZodError(result.error);
      transparency.emit({
        type: 'schema_validation_failed',
        data: { layer: 3, zodError: zodErr, attempts, requestId },
      });
      return { ok: false, error: zodErr, lastRawOutput: currentRaw };
    }

    const correction = buildCorrectionPrompt(currentRaw, opts.schema, formatZodError(result.error));
    currentRaw = await opts.retryFn(correction);
  }

  return { ok: false, error: 'Retry budget exhausted', lastRawOutput: currentRaw };
}

export function formatZodError(err: ZodError): string {
  return err.issues
    .map(i => {
      const received = 'received' in i ? JSON.stringify((i as Record<string, unknown>).received).slice(0, 60) : 'n/a';
      return `  • path: ${i.path.join('.') || '<root>'} — ${i.message} (received: ${received})`;
    })
    .join('\n');
}

export function buildCorrectionPrompt(
  originalOutput: string,
  schema: z.ZodTypeAny,
  errorDetails: string,
): string {
  const schemaShape = JSON.stringify(z.toJSONSchema(schema as z.ZodTypeAny), null, 2);
  return `Your previous response did not satisfy the required schema.

Errors:
${errorDetails}

Required schema (JSON Schema):
${schemaShape}

Your previous response (truncated to 1000 chars):
${originalOutput.slice(0, 1000)}

Respond with corrected JSON only. No prose, no markdown fences, just the JSON object.`;
}
