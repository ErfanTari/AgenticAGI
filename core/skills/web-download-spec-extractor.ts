import type { LLMHandler } from '../types.js';
import { parseStructured } from '../structured.js';
import { webDownloadSpecSchema, type WebDownloadSpec } from '../schemas.js';

const EXTRACT_SYSTEM = `You are a structured data extractor.
Extract a web download specification from the user message.
Return ONLY valid JSON matching this exact shape — no explanation, no markdown fences:

{
  "kind": "web_download_multi_target",
  "targets": ["Brand1", "Brand2"],
  "artifact": "2025 general catalog PDF",
  "minBytes": 7000000,
  "destDir": "Porcelain_PDF/catalogs",
  "filenameTemplate": "{BrandName}_generalcatalog.pdf"
}

Rules:
- This engine is for finding ONE PDF artifact per target via web search. Examples
  of supported artifact classes: brand catalogs, product brochures, lookbooks,
  datasheets, technical specifications, reference manuals, user guides,
  application notes, whitepapers. If the user asks for a non-PDF artifact
  (software installer .dmg/.exe, github repository, image asset, source
  archive .zip/.tar.gz), return an empty JSON object {} so the router falls
  through to a more appropriate engine.
- targets: every distinct brand / part-number / company name mentioned. May
  include alphanumerics like "STM32F4" or "RP2040". Preserve casing.
- artifact: short noun phrase that names what to find ("2025 catalog PDF",
  "RP2040 datasheet", "user manual PDF").
- minBytes: convert any size hint (e.g. "7MB" → 7000000, "1.5MB" → 1500000).
  If unspecified default to 200000 (200 KB) — small enough to accept short
  datasheets, large enough to reject 1-page flyers and HTML save-as-PDF noise.
- destDir: workspace-relative folder. Use the user's exact path if given;
  otherwise infer from context (e.g. "Catalogs/", "Datasheets/").
- filenameTemplate: must contain {BrandName}; keep it short and filesystem-safe.`;

/**
 * Verbose result envelope. Returned alongside the simple null-or-spec function so
 * callers (and the diag layer) can surface WHY extraction failed — not just that
 * it returned null. This is critical for diagnosing "engine never fired" bugs:
 * without raw LLM output we have no idea what the model actually produced.
 */
export type WebDownloadSpecExtractResult =
  | { ok: true; spec: WebDownloadSpec; raw: string; attempts: number }
  | { ok: false; raw: string; reason: string; attempts: number };

export async function extractWebDownloadSpecVerbose(
  message: string,
  llmHandler: LLMHandler,
): Promise<WebDownloadSpecExtractResult> {
  let raw: string;
  try {
    raw = await llmHandler(
      [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: message },
      ],
      { maxTokens: 400 },
    );
  } catch (err) {
    return { ok: false, raw: '', reason: `LLM call threw: ${String(err).slice(0, 200)}`, attempts: 0 };
  }

  const result = await parseStructured(raw, webDownloadSpecSchema, {
    maxRepairAttempts: 1,
    llmHandler,
    context: 'web-download-spec-extractor',
  });

  if (!result.success || !result.data) {
    return {
      ok: false,
      raw,
      reason: result.error ?? 'parseStructured returned { success: false } with no error',
      attempts: result.attempts,
    };
  }
  if (result.data.targets.length < 1) {
    return {
      ok: false,
      raw,
      reason: 'spec.targets[] was empty after parse',
      attempts: result.attempts,
    };
  }

  return { ok: true, spec: result.data, raw, attempts: result.attempts };
}

export async function extractWebDownloadSpec(
  message: string,
  llmHandler: LLMHandler,
): Promise<WebDownloadSpec | null> {
  const result = await extractWebDownloadSpecVerbose(message, llmHandler);
  return result.ok ? result.spec : null;
}
