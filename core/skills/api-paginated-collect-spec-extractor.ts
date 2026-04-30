/**
 * Phase 25.2 — Single LLM call to produce an ApiPaginatedCollectSpec.
 *
 * Whitepaper rule: the LLM may produce candidates, the engine decides state
 * transitions. This module is the candidate producer; everything after it is
 * deterministic.
 */
import type { LLMHandler } from '../types.js';
import { parseStructured } from '../structured.js';
import {
  apiPaginatedCollectSpecSchema,
  type ApiPaginatedCollectSpec,
} from '../schemas.js';

const EXTRACT_SYSTEM = `You are a structured data extractor.
Extract an api_paginated_collect specification from the user message.
Return ONLY valid JSON matching this exact shape — no explanation, no markdown fences:

{
  "kind": "api_paginated_collect",
  "endpoint": "https://api.example.com/v1/items",
  "method": "GET",
  "auth": { "kind": "bearer", "envVar": "EXAMPLE_TOKEN" },
  "pagination": { "kind": "link_header", "rel": "next" },
  "recordsPath": "data.items",
  "queryParams": { "since": "2026-01-01", "state": "open" },
  "extraHeaders": { "Accept": "application/vnd.github+json" },
  "destFile": "workspace/data/items.jsonl",
  "dedupBy": "id",
  "maxRecords": 5000,
  "maxPages": 50,
  "requireFields": ["id"]
}

Rules:
- endpoint MUST be an absolute http(s) URL.
- auth.kind: one of "none", "bearer", "header", "query". When the user mentions
  "GitHub token", "API key in env X", etc., emit the matching auth object with
  envVar set to the env var name (do not include the secret value).
- pagination.kind: one of "link_header", "offset", "cursor".
    - link_header (default for GitHub-style APIs): { "kind": "link_header", "rel": "next" }
    - offset: { "kind": "offset", "offsetParam": "offset", "limitParam": "limit", "limit": 100 }
    - cursor: { "kind": "cursor", "cursorPath": "next_cursor", "cursorParam": "cursor" }
- recordsPath: dotted path to the records array within the response body. Omit
  when the response body itself IS the array.
- destFile: workspace-relative path ending in .jsonl. Anything outside the
  workspace will be rejected.
- dedupBy: top-level field name to dedup by (e.g. "id"). Omit if dedup is not
  desired.
- maxRecords / maxPages: hard caps. Use the user's request if specified;
  otherwise default to 5000 / 50.
- requireFields: top-level field names every record MUST have (records lacking
  any required field are dropped).

Pick exactly ONE pagination.kind. Do not invent kinds. Never echo secrets.`;

/**
 * Verbose result envelope so the dispatcher (and the diag layer) can surface WHY
 * extraction failed. See `web-download-spec-extractor.ts` for rationale.
 */
export type ApiPaginatedCollectSpecExtractResult =
  | { ok: true; spec: ApiPaginatedCollectSpec; raw: string; attempts: number }
  | { ok: false; raw: string; reason: string; attempts: number };

export async function extractApiPaginatedCollectSpecVerbose(
  message: string,
  llmHandler: LLMHandler,
): Promise<ApiPaginatedCollectSpecExtractResult> {
  let raw: string;
  try {
    raw = await llmHandler(
      [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: message },
      ],
      { maxTokens: 500 },
    );
  } catch (err) {
    return { ok: false, raw: '', reason: `LLM call threw: ${String(err).slice(0, 200)}`, attempts: 0 };
  }

  const result = await parseStructured(raw, apiPaginatedCollectSpecSchema, {
    maxRepairAttempts: 1,
    llmHandler,
    context: 'api-paginated-collect-spec-extractor',
  });

  if (!result.success || !result.data) {
    return {
      ok: false,
      raw,
      reason: result.error ?? 'parseStructured returned { success: false } with no error',
      attempts: result.attempts,
    };
  }
  return { ok: true, spec: result.data, raw, attempts: result.attempts };
}

export async function extractApiPaginatedCollectSpec(
  message: string,
  llmHandler: LLMHandler,
): Promise<ApiPaginatedCollectSpec | null> {
  const result = await extractApiPaginatedCollectSpecVerbose(message, llmHandler);
  return result.ok ? result.spec : null;
}
