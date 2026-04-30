/**
 * Phase 25.2 — Deterministic API paginated-collect engine.
 *
 * Engine #3 in the One-Call Engine series. Whitepaper:
 *   docs/one-call-engine.md (§5 Step Types as a DSL, §8 Side Effects)
 *
 * Pagination kinds: link_header (RFC 5988) | offset | cursor
 * Auth kinds:       none | bearer | header | query
 *
 * The engine is fetch-injectable for testability. Production wires it to
 * global fetch; tests pass a mock that returns staged responses.
 *
 * State lives in PageRecord[] (the ledger). Termination is governed by
 * counters (maxPages, maxRecords) and the absence of a next-page signal —
 * never by LLM judgment.
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  ApiPaginatedCollectSpec,
  ApiAuth,
  ApiPagination,
} from '../schemas.js';
import { PATHS } from '../../config/agent.config.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PageRecord {
  pageNumber: number;
  url: string;
  recordsFetched: number;
  recordsAppended: number;
  status: 'ok' | 'error';
  errorReason: string | null;
}

export interface ApiPaginatedCollectReport {
  totalRecords: number;
  totalAppended: number;
  pagesFetched: number;
  destFile: string | null;
  ledger: PageRecord[];
  totalMs: number;
  abortReason: string | null;
}

export interface FetchResponseLite {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<FetchResponseLite>;

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_RETRIES_PER_PAGE = 1;
export const MAX_TOTAL_MS = 300_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

export function resolveWithinWorkspace(p: string, workspaceRoot?: string): string {
  const root = workspaceRoot ?? PATHS.workspace;
  const rootResolved = path.resolve(root);
  const candidate = path.isAbsolute(p) ? path.resolve(p) : path.resolve(rootResolved, p);
  const rel = path.relative(rootResolved, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  return candidate;
}

/**
 * Resolve a credential from the environment. Returns null if the env var is
 * unset. The engine treats null as a hard-fail at auth_check (no fallback).
 */
export function resolveCredential(auth: ApiAuth): string | null {
  switch (auth.kind) {
    case 'none':
      return '';
    case 'bearer':
    case 'header':
    case 'query':
      return process.env[auth.envVar] ?? null;
  }
}

export function buildAuthHeaders(auth: ApiAuth, credential: string): Record<string, string> {
  switch (auth.kind) {
    case 'none':
      return {};
    case 'bearer':
      return { Authorization: `Bearer ${credential}` };
    case 'header':
      return { [auth.name]: `${auth.prefix}${credential}` };
    case 'query':
      return {};
  }
}

export function applyAuthQuery(
  url: string,
  auth: ApiAuth,
  credential: string,
): string {
  if (auth.kind !== 'query') return url;
  const u = new URL(url);
  u.searchParams.set(auth.name, credential);
  return u.toString();
}

/**
 * Apply caller-provided filter.query as URL search params. Existing params on
 * the endpoint are preserved; conflicting keys are overwritten by the filter.
 */
export function applyFilterQuery(
  url: string,
  query: Record<string, string> | undefined,
): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) {
    u.searchParams.set(k, v);
  }
  return u.toString();
}

export function applyOffset(url: string, offsetParam: string, limitParam: string, offset: number, limit: number): string {
  const u = new URL(url);
  u.searchParams.set(offsetParam, String(offset));
  u.searchParams.set(limitParam, String(limit));
  return u.toString();
}

export function applyCursor(url: string, cursorParam: string, cursor: string): string {
  const u = new URL(url);
  u.searchParams.set(cursorParam, cursor);
  return u.toString();
}

/** Get a value at a dotted JSON path. Missing paths return undefined. */
export function getAtPath(obj: unknown, dottedPath: string): unknown {
  if (!dottedPath) return obj;
  const parts = dottedPath.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Parse an RFC 5988 Link header for the URL whose rel matches `rel`.
 * Returns null when no matching link is found.
 */
export function parseLinkHeader(linkHeader: string | undefined, rel: string): string | null {
  if (!linkHeader) return null;
  const parts = linkHeader.split(',');
  for (const raw of parts) {
    const m = raw.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?([^";]+)"?/i);
    if (m && m[2].trim().toLowerCase() === rel.toLowerCase()) {
      return m[1].trim();
    }
  }
  return null;
}

export function extractRecords(body: unknown, recordsPath: string | undefined): unknown[] {
  const value = recordsPath ? getAtPath(body, recordsPath) : body;
  if (Array.isArray(value)) return value;
  return [];
}

export function recordHasRequiredFields(rec: unknown, requiredFields: string[]): boolean {
  if (rec == null || typeof rec !== 'object') return requiredFields.length === 0;
  for (const f of requiredFields) {
    if (!(f in (rec as Record<string, unknown>))) return false;
  }
  return true;
}

// ── Pagination state ─────────────────────────────────────────────────────────

interface PaginationState {
  next: { kind: 'url'; url: string } | { kind: 'offset'; offset: number } | { kind: 'cursor'; cursor: string | null } | null;
}

function initialPaginationState(spec: ApiPaginatedCollectSpec): PaginationState {
  switch (spec.pagination.kind) {
    case 'link_header':
      return { next: { kind: 'url', url: spec.endpoint } };
    case 'offset':
      return { next: { kind: 'offset', offset: 0 } };
    case 'cursor':
      // First request has no cursor; null means "send the endpoint as-is"
      return { next: { kind: 'cursor', cursor: null } };
  }
}

function buildPageUrl(
  spec: ApiPaginatedCollectSpec,
  state: PaginationState,
  credential: string,
): string {
  let url: string;
  const pag: ApiPagination = spec.pagination;

  if (pag.kind === 'link_header') {
    if (!state.next || state.next.kind !== 'url') throw new Error('invalid link_header state');
    url = state.next.url;
  } else if (pag.kind === 'offset') {
    if (!state.next || state.next.kind !== 'offset') throw new Error('invalid offset state');
    url = applyOffset(spec.endpoint, pag.offsetParam, pag.limitParam, state.next.offset, pag.limit);
  } else {
    if (!state.next || state.next.kind !== 'cursor') throw new Error('invalid cursor state');
    url = state.next.cursor != null ? applyCursor(spec.endpoint, pag.cursorParam, state.next.cursor) : spec.endpoint;
  }

  url = applyFilterQuery(url, spec.queryParams);
  url = applyAuthQuery(url, spec.auth, credential);
  return url;
}

function advancePaginationState(
  spec: ApiPaginatedCollectSpec,
  state: PaginationState,
  response: FetchResponseLite,
  recordsLen: number,
): PaginationState {
  const pag: ApiPagination = spec.pagination;

  if (pag.kind === 'link_header') {
    const next = parseLinkHeader(response.headers.link ?? response.headers.Link, pag.rel);
    return { next: next ? { kind: 'url', url: next } : null };
  }

  if (pag.kind === 'offset') {
    if (!state.next || state.next.kind !== 'offset') return { next: null };
    if (recordsLen < pag.limit) return { next: null };
    return { next: { kind: 'offset', offset: state.next.offset + recordsLen } };
  }

  // cursor
  const cursor = getAtPath(response.body, pag.cursorPath);
  if (typeof cursor === 'string' && cursor.length > 0) {
    return { next: { kind: 'cursor', cursor } };
  }
  return { next: null };
}

// ── Report rendering ──────────────────────────────────────────────────────────

export function buildReport(
  ledger: PageRecord[],
  destFile: string | null,
  totalMs: number,
  abortReason: string | null,
): ApiPaginatedCollectReport {
  const totalRecords = ledger.reduce((sum, p) => sum + p.recordsFetched, 0);
  const totalAppended = ledger.reduce((sum, p) => sum + p.recordsAppended, 0);
  return {
    totalRecords,
    totalAppended,
    pagesFetched: ledger.length,
    destFile,
    ledger,
    totalMs,
    abortReason,
  };
}

export function renderFinalMessage(
  report: ApiPaginatedCollectReport,
  spec: ApiPaginatedCollectSpec,
): string {
  const lines: string[] = ['FINAL_STATUS:'];
  lines.push(`endpoint=${spec.endpoint}`);
  lines.push(`pages=${report.pagesFetched} records_fetched=${report.totalRecords} appended=${report.totalAppended}`);
  if (report.destFile) lines.push(`dest=${spec.destFile}`);

  const errors = report.ledger.filter(p => p.status === 'error');
  if (errors.length > 0) {
    lines.push('errors=[');
    for (const p of errors.slice(0, 10)) {
      lines.push(`  page ${p.pageNumber} (${p.url}): ${p.errorReason ?? 'unknown'}`);
    }
    if (errors.length > 10) lines.push(`  … and ${errors.length - 10} more`);
    lines.push(']');
  }

  if (report.abortReason) lines.push(`aborted: ${report.abortReason}`);
  lines.push(`Duration: ${Math.round(report.totalMs / 1000)}s`);
  return lines.join('\n');
}

// ── Main engine ───────────────────────────────────────────────────────────────

export interface RunOptions {
  workspaceRoot?: string;
  fetchFn?: FetchFn;
  emit?: (event: unknown) => void;
  signal?: AbortSignal;
}

const defaultFetchFn: FetchFn = async (url, init) => {
  const res = await fetch(url, init);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* leave null */ }
  return { status: res.status, headers, body };
};

export async function runApiPaginatedCollect(
  spec: ApiPaginatedCollectSpec,
  options: RunOptions = {},
): Promise<ApiPaginatedCollectReport> {
  const emit = options.emit ?? (() => {});
  const fetchFn = options.fetchFn ?? defaultFetchFn;
  const startMs = Date.now();
  const workspaceRoot = options.workspaceRoot ?? PATHS.workspace;

  emit({ type: 'api_paginated_collect_engine_start', data: { spec } });

  // ── auth_check ────────────────────────────────────────────────────────────
  const credential = resolveCredential(spec.auth);
  if (credential == null) {
    const reason = `auth env var '${(spec.auth as { envVar?: string }).envVar ?? '?'}' is not set`;
    emit({ type: 'api_paginated_collect_engine_done', data: { abortReason: reason, totalMs: Date.now() - startMs } });
    return buildReport([], null, Date.now() - startMs, reason);
  }

  // ── destFile workspace guard ──────────────────────────────────────────────
  let destAbs: string;
  try {
    destAbs = resolveWithinWorkspace(spec.destFile, workspaceRoot);
  } catch {
    const reason = 'destFile escapes workspace';
    emit({ type: 'api_paginated_collect_engine_done', data: { abortReason: reason, totalMs: Date.now() - startMs } });
    return buildReport([], null, Date.now() - startMs, reason);
  }
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });

  const ledger: PageRecord[] = [];
  const seenKeys = new Set<string>();
  const writeStream = fs.createWriteStream(destAbs, { flags: 'w' });

  let appendedCount = 0;
  let abortReason: string | null = null;
  let pageNumber = 0;
  let state = initialPaginationState(spec);

  try {
    while (state.next != null && pageNumber < spec.maxPages) {
      pageNumber++;

      if (Date.now() - startMs > MAX_TOTAL_MS) {
        abortReason = 'timeout';
        break;
      }
      if (options.signal?.aborted) {
        abortReason = 'aborted';
        break;
      }
      if (appendedCount >= spec.maxRecords) {
        abortReason = 'max_records_reached';
        break;
      }

      const url = buildPageUrl(spec, state, credential);
      const headers = {
        Accept: 'application/json',
        ...buildAuthHeaders(spec.auth, credential),
        ...spec.extraHeaders,
      };

      emit({ type: 'api_paginated_collect_page_attempt', data: { pageNumber, url } });

      let pageResult: PageRecord = {
        pageNumber, url, recordsFetched: 0, recordsAppended: 0,
        status: 'error', errorReason: null,
      };
      let response: FetchResponseLite | null = null;

      for (let attempt = 0; attempt <= MAX_RETRIES_PER_PAGE; attempt++) {
        try {
          response = await fetchFn(url, { method: spec.method, headers, signal: options.signal });
          if (response.status >= 200 && response.status < 300) {
            pageResult.status = 'ok';
            pageResult.errorReason = null;
            break;
          }
          pageResult.errorReason = `HTTP ${response.status}`;
        } catch (err) {
          pageResult.errorReason = err instanceof Error ? err.message : String(err);
        }
        response = null;
      }

      if (pageResult.status !== 'ok' || response == null) {
        ledger.push(pageResult);
        emit({ type: 'api_paginated_collect_page_done', data: { ...pageResult } });
        // Stop fetching on a hard page failure — continuing would just churn
        abortReason = abortReason ?? `page ${pageNumber} failed`;
        break;
      }

      const records = extractRecords(response.body, spec.recordsPath);
      pageResult.recordsFetched = records.length;

      for (const rec of records) {
        if (appendedCount >= spec.maxRecords) break;
        if (!recordHasRequiredFields(rec, spec.requireFields)) continue;

        if (spec.dedupBy) {
          const key = (rec as Record<string, unknown>)[spec.dedupBy];
          const keyStr = typeof key === 'string' || typeof key === 'number' ? String(key) : null;
          if (keyStr != null) {
            if (seenKeys.has(keyStr)) continue;
            seenKeys.add(keyStr);
          }
        }

        writeStream.write(`${JSON.stringify(rec)}\n`);
        pageResult.recordsAppended++;
        appendedCount++;
      }

      ledger.push(pageResult);
      emit({ type: 'api_paginated_collect_page_done', data: { ...pageResult } });

      // Advance pagination
      state = advancePaginationState(spec, state, response, records.length);
    }

    if (state.next == null && abortReason == null) {
      // Natural completion — no more pages
    } else if (pageNumber >= spec.maxPages && abortReason == null) {
      abortReason = 'max_pages_reached';
    }
  } finally {
    await new Promise<void>((resolve) => {
      writeStream.end(() => resolve());
    });
  }

  const report = buildReport(ledger, spec.destFile, Date.now() - startMs, abortReason);
  emit({
    type: 'api_paginated_collect_engine_done',
    data: {
      pagesFetched: report.pagesFetched,
      totalRecords: report.totalRecords,
      totalAppended: report.totalAppended,
      abortReason: report.abortReason,
      totalMs: report.totalMs,
    },
  });
  return report;
}

// ── Side-effect classification (whitepaper §8) ───────────────────────────────

export const SIDE_EFFECT_CLASS = 'local_write' as const;
