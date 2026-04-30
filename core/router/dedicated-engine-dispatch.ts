/**
 * Dedicated-engine dispatcher (Phase 25 routing).
 *
 * Single source of truth for "should this message fire one of the deterministic
 * one-call engines?". Used by:
 *   - `core/agent.ts` processMessage, BEFORE the quick-complexity LLM call,
 *     so messages that match a dedicated kind never get rerouted to QueryLoop.
 *   - `core/router.ts` handleAgenticUnits as a defense-in-depth check after
 *     decomposition (in case decomposition rephrasing first surfaces the match).
 *
 * Whitepaper: docs/one-call-engine.md (Agents as Compilers; The LLM may produce
 * candidates, the engine decides state transitions).
 *
 * Detection precedence:
 *   1. web_download_multi_target  (Phase 24)
 *   2. file_batch_transform       (Phase 25.1)
 *   3. api_paginated_collect      (Phase 25.2)
 *
 * Each tier:
 *   - Cheap regex check on the message
 *   - One LLM call to extract the typed spec
 *   - Deterministic engine run → final message
 *
 * Routing transparency (Phase 25.4):
 *   - Emits a `route_consider` event for ALL THREE tiers up front, so the diag
 *     formatter can render a complete decision tree even when an early tier
 *     wins. Cost is three regex tests — sub-microsecond.
 *   - Emits a `spec_extraction` event for whichever tier's extractor is run,
 *     including the raw LLM output (truncated) on failure.
 *   - Emits a final `route` event for the winning tier only.
 *
 * If a regex matches but spec extraction fails, the dispatcher returns
 * { handled: false } so the caller can fall through to the next routing tier
 * (without trying lower dedicated tiers — that risks wrong-engine routing).
 */
import { transparency } from '../transparency.js';
import type { LLMHandler } from '../types.js';
import type { SpanContext } from '../transparency.js';
import type { SkillRunner as WebDownloadSkillRunner } from '../skills/web-download-multi-target.js';
import type { SkillRunner as FileBatchSkillRunner } from '../skills/file-batch-transform.js';
import type { FetchFn } from '../skills/api-paginated-collect.js';

// ── Detection regexes ────────────────────────────────────────────────────────

// Tier 1: web_download_multi_target
//
// Two-part match: (a) a download verb near a catalog/brochure/PDF noun and
// (b) at least one comma-separated list of names.
//
// Phase 25.4 — CATALOG_TARGET_LIST_RE was widened from `[A-Z][a-zA-Z]+` to
// `[A-Za-z][a-zA-Z]+` because real users write mixed-case brand names ("iris
// ceramic", "fiandre") in cataphoric "for these N brands: X, Y, Z" lists.
// The previous strict-uppercase rule silently failed those messages and the
// router downgraded them to QueryLoop, which then ran 33 LLM iterations and
// returned a hallucinated FINAL_STATUS line — the engine never fired.
// Regression coverage lives in tests/phase-25/dedicated-engine-dispatch.test.ts.
const MULTI_TARGET_DOWNLOAD_RE =
  /\b(download|find|fetch|get|grab)\b[\s\S]{0,200}?\b(catalogs?|catalogues?|brochures?|lookbooks?|pdf)\b/i;
const CATALOG_TARGET_LIST_RE = /[A-Za-z][a-zA-Z]+(?:\s*,\s*[A-Za-z][a-zA-Z]+){1,}/;

export function detectMultiTargetDownload(message: string): boolean {
  return MULTI_TARGET_DOWNLOAD_RE.test(message) && CATALOG_TARGET_LIST_RE.test(message);
}

/** Diagnostic helper — returns the per-sub-regex outcome so the dispatcher can
 *  emit a precise `route_consider.details` payload that names which check failed. */
export function explainMultiTargetDownload(message: string): {
  matched: boolean;
  verb: boolean;
  list: boolean;
} {
  const verb = MULTI_TARGET_DOWNLOAD_RE.test(message);
  const list = CATALOG_TARGET_LIST_RE.test(message);
  return { matched: verb && list, verb, list };
}

// Tier 1b: file_batch_transform
const FILE_BATCH_VERB_RE =
  /\b(convert|copy|rename|move|extract\s+text|batch[- ]?(?:transform|convert|process)|process\s+all|transform\s+(?:every|each|all))\b/i;
const FILE_BATCH_GLOB_RE =
  /\b(folder|directory|every|each|all)\b[\s\S]{0,80}?\b(\.pdf|\.png|\.jpe?g|\.csv|\.txt|\.md|\.html?|pdfs?|jpe?gs?|pngs?|images?|files?|docs?|documents?|markdowns?)\b/i;

export function detectFileBatchTransform(message: string): boolean {
  return FILE_BATCH_VERB_RE.test(message) && FILE_BATCH_GLOB_RE.test(message);
}

export function explainFileBatchTransform(message: string): {
  matched: boolean;
  verb: boolean;
  glob: boolean;
} {
  const verb = FILE_BATCH_VERB_RE.test(message);
  const glob = FILE_BATCH_GLOB_RE.test(message);
  return { matched: verb && glob, verb, glob };
}

// Tier 1c: api_paginated_collect
const API_COLLECT_VERB_RE =
  /\b(collect|pull|mirror|fetch|sync|paginate|export|backfill|dump)\b/i;
const API_COLLECT_TARGET_RE =
  /\b(api|rest|endpoint|github|jira|linear|notion|airtable|sheets?|graph[- ]?api|paginate[d]?|jsonl|ndjson)\b/i;
const API_COLLECT_URL_RE = /https?:\/\/[^\s]+/;

export function detectApiPaginatedCollect(message: string): boolean {
  const verbHit = API_COLLECT_VERB_RE.test(message);
  const targetHit = API_COLLECT_TARGET_RE.test(message);
  const urlHit = API_COLLECT_URL_RE.test(message);
  return verbHit && (targetHit || urlHit);
}

export function explainApiPaginatedCollect(message: string): {
  matched: boolean;
  verb: boolean;
  target: boolean;
  url: boolean;
} {
  const verb = API_COLLECT_VERB_RE.test(message);
  const target = API_COLLECT_TARGET_RE.test(message);
  const url = API_COLLECT_URL_RE.test(message);
  return { matched: verb && (target || url), verb, target, url };
}

/** True iff message will trip at least one dedicated-engine gate. */
export function detectAnyDedicatedEngine(message: string): boolean {
  return (
    detectMultiTargetDownload(message) ||
    detectFileBatchTransform(message) ||
    detectApiPaginatedCollect(message)
  );
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

export type DedicatedEngineKind =
  | 'web_download_multi_target'
  | 'file_batch_transform'
  | 'api_paginated_collect';

export interface DispatchOptions {
  parentCtx?: SpanContext;
  signal?: AbortSignal;
  /** Override the default real-skill runner (used by tests). */
  runSkill?: WebDownloadSkillRunner & FileBatchSkillRunner;
  /** Override the default global fetch (used by tests). */
  fetchFn?: FetchFn;
}

export type DispatchResult =
  | { handled: false }
  | { handled: true; kind: DedicatedEngineKind; reply: string };

/** Truncate raw LLM output for diag readability — 500 chars is enough to see
 *  what the model produced (e.g. "Sorry, I cannot help with that") without
 *  bloating the diag file. */
const RAW_OUTPUT_DIAG_CAP = 500;
function trimForDiag(s: string): string {
  if (!s) return '';
  return s.length <= RAW_OUTPUT_DIAG_CAP ? s : s.slice(0, RAW_OUTPUT_DIAG_CAP) + '…';
}

/**
 * Run the appropriate dedicated engine if the message matches one of the
 * known kinds. Tries Tier 1 → 1b → 1c in order. Returns { handled: false }
 * if no kind matches OR if the matching kind's spec extractor fails.
 *
 * Always emits a `route_consider` event for all three tiers — even when an
 * early tier wins — so the diag layer can render the full decision tree.
 */
export async function dispatchDedicatedEngine(
  message: string,
  llmHandler: LLMHandler,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const { parentCtx, signal, runSkill: runSkillOverride, fetchFn: fetchFnOverride } = options;

  // Pre-compute all three regex outcomes up front so we can emit a complete
  // decision tree regardless of which tier wins (or if none does).
  const t1 = explainMultiTargetDownload(message);
  const t1b = explainFileBatchTransform(message);
  const t1c = explainApiPaginatedCollect(message);

  transparency.emit({
    type: 'route_consider',
    data: {
      tier: 'web_download_engine',
      matched: t1.matched,
      reason: t1.matched
        ? 'detectMultiTargetDownload returned true'
        : 'detectMultiTargetDownload returned false',
      details: {
        MULTI_TARGET_DOWNLOAD_RE: t1.verb,
        CATALOG_TARGET_LIST_RE: t1.list,
      },
    },
  });
  transparency.emit({
    type: 'route_consider',
    data: {
      tier: 'file_batch_transform',
      matched: t1b.matched,
      reason: t1b.matched
        ? 'detectFileBatchTransform returned true'
        : 'detectFileBatchTransform returned false',
      details: {
        FILE_BATCH_VERB_RE: t1b.verb,
        FILE_BATCH_GLOB_RE: t1b.glob,
      },
    },
  });
  transparency.emit({
    type: 'route_consider',
    data: {
      tier: 'api_paginated_collect',
      matched: t1c.matched,
      reason: t1c.matched
        ? 'detectApiPaginatedCollect returned true'
        : 'detectApiPaginatedCollect returned false',
      details: {
        API_COLLECT_VERB_RE: t1c.verb,
        API_COLLECT_TARGET_RE: t1c.target,
        API_COLLECT_URL_RE: t1c.url,
      },
    },
  });

  // ── Tier 1: web_download_multi_target ──
  if (t1.matched) {
    const { extractWebDownloadSpecVerbose } = await import('../skills/web-download-spec-extractor.js');
    const { runWebDownloadMultiTarget, renderFinalMessage } = await import(
      '../skills/web-download-multi-target.js'
    );
    const specResult = await extractWebDownloadSpecVerbose(message, llmHandler);
    if (specResult.ok) {
      transparency.emit({
        type: 'spec_extraction',
        data: {
          engine: 'web_download_engine',
          attempted: true,
          succeeded: true,
          attempts: specResult.attempts,
        },
      });
      transparency.emit({
        type: 'route',
        data: {
          level: 'MEDIUM',
          reason: 'multi-target download detected — routing to deterministic engine',
          path: 'web_download_engine',
        },
      });
      transparency.emit({
        type: 'final_reply_origin',
        data: { origin: 'engine', engine: 'web_download_multi_target' },
      });
      const skillRunner: WebDownloadSkillRunner =
        runSkillOverride ??
        (async (name, input) => {
          const { runSkill } = await import('../skills/runner.js');
          return runSkill(name, input, parentCtx, signal);
        });
      const report = await runWebDownloadMultiTarget(specResult.spec, skillRunner, (event) =>
        transparency.emit(event as Parameters<typeof transparency.emit>[0]),
      );
      return {
        handled: true,
        kind: 'web_download_multi_target',
        reply: renderFinalMessage(report, specResult.spec),
      };
    }
    transparency.emit({
      type: 'spec_extraction',
      data: {
        engine: 'web_download_engine',
        attempted: true,
        succeeded: false,
        reason: specResult.reason,
        rawLlmOutput: trimForDiag(specResult.raw),
        attempts: specResult.attempts,
      },
    });
    // Spec extraction failed — fall through. Do NOT try lower tiers on a
    // message that already matched Tier 1; that would risk wrong-engine routing.
    return { handled: false };
  }

  // ── Tier 1b: file_batch_transform ──
  if (t1b.matched) {
    const { extractFileBatchTransformSpecVerbose } = await import(
      '../skills/file-batch-transform-spec-extractor.js'
    );
    const { runFileBatchTransform, renderFinalMessage } = await import(
      '../skills/file-batch-transform.js'
    );
    const specResult = await extractFileBatchTransformSpecVerbose(message, llmHandler);
    if (specResult.ok) {
      transparency.emit({
        type: 'spec_extraction',
        data: {
          engine: 'file_batch_transform',
          attempted: true,
          succeeded: true,
          attempts: specResult.attempts,
        },
      });
      transparency.emit({
        type: 'route',
        data: {
          level: 'MEDIUM',
          reason: 'file batch transform detected — routing to deterministic engine',
          path: 'file_batch_transform_engine',
        },
      });
      transparency.emit({
        type: 'final_reply_origin',
        data: { origin: 'engine', engine: 'file_batch_transform' },
      });
      const skillRunner: FileBatchSkillRunner =
        runSkillOverride ??
        (async (name, input) => {
          const { runSkill } = await import('../skills/runner.js');
          return runSkill(name, input, parentCtx, signal);
        });
      const report = await runFileBatchTransform(specResult.spec, skillRunner, {
        emit: (event) => transparency.emit(event as Parameters<typeof transparency.emit>[0]),
      });
      return {
        handled: true,
        kind: 'file_batch_transform',
        reply: renderFinalMessage(report, specResult.spec),
      };
    }
    transparency.emit({
      type: 'spec_extraction',
      data: {
        engine: 'file_batch_transform',
        attempted: true,
        succeeded: false,
        reason: specResult.reason,
        rawLlmOutput: trimForDiag(specResult.raw),
        attempts: specResult.attempts,
      },
    });
    return { handled: false };
  }

  // ── Tier 1c: api_paginated_collect ──
  if (t1c.matched) {
    const { extractApiPaginatedCollectSpecVerbose } = await import(
      '../skills/api-paginated-collect-spec-extractor.js'
    );
    const { runApiPaginatedCollect, renderFinalMessage } = await import(
      '../skills/api-paginated-collect.js'
    );
    const specResult = await extractApiPaginatedCollectSpecVerbose(message, llmHandler);
    if (specResult.ok) {
      transparency.emit({
        type: 'spec_extraction',
        data: {
          engine: 'api_paginated_collect',
          attempted: true,
          succeeded: true,
          attempts: specResult.attempts,
        },
      });
      transparency.emit({
        type: 'route',
        data: {
          level: 'MEDIUM',
          reason: 'api paginated collect detected — routing to deterministic engine',
          path: 'api_paginated_collect_engine',
        },
      });
      transparency.emit({
        type: 'final_reply_origin',
        data: { origin: 'engine', engine: 'api_paginated_collect' },
      });
      const report = await runApiPaginatedCollect(specResult.spec, {
        emit: (event) => transparency.emit(event as Parameters<typeof transparency.emit>[0]),
        signal,
        fetchFn: fetchFnOverride,
      });
      return {
        handled: true,
        kind: 'api_paginated_collect',
        reply: renderFinalMessage(report, specResult.spec),
      };
    }
    transparency.emit({
      type: 'spec_extraction',
      data: {
        engine: 'api_paginated_collect',
        attempted: true,
        succeeded: false,
        reason: specResult.reason,
        rawLlmOutput: trimForDiag(specResult.raw),
        attempts: specResult.attempts,
      },
    });
    return { handled: false };
  }

  // No tier matched. The caller (agent.ts / handleAgenticUnits) emits its own
  // `route` event for the actual fallback engine (QueryLoop, simple-plan, etc.).
  return { handled: false };
}
