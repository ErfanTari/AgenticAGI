/**
 * Layer 2 JSON repair — wraps the `jsonrepair` npm package.
 * Applied at the structured-output parse point before Zod validation.
 * Only active at whitelisted call sites (routing, decomposition, intake, verifier, plan-delta).
 */
import { jsonrepair } from 'jsonrepair';
import { transparency } from '../transparency.js';
import { getCurrentRequestId } from '../transparency.js';

export type RepairResult =
  | { repaired: true; value: unknown; bytesChanged: number }
  | { repaired: false; reason: string };

/**
 * Try to parse `rawText` as JSON, applying `jsonrepair` if direct parse fails.
 * Also strips markdown code fences (Gemma 4 sometimes wraps JSON in ```json...```).
 */
export function tryJsonRepair(rawText: string): RepairResult {
  const requestId = getCurrentRequestId() ?? 'unknown';

  // Fast path: already valid JSON
  try {
    const value = JSON.parse(rawText);
    return { repaired: true, value, bytesChanged: 0 };
  } catch { /* continue */ }

  // Strip markdown code fences
  let candidate = rawText.trim();
  const fenceMatch = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/s);
  if (fenceMatch) candidate = fenceMatch[1].trim();

  // Try jsonrepair
  try {
    const fixed = jsonrepair(candidate);
    const value = JSON.parse(fixed);
    const bytesChanged = Math.abs(fixed.length - candidate.length);

    transparency.emit({
      type: 'json_repair_succeeded',
      data: { layer: 2, bytesChanged, originalSnippet: candidate.slice(0, 200), requestId },
    });

    return { repaired: true, value, bytesChanged };
  } catch (err: unknown) {
    return { repaired: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
