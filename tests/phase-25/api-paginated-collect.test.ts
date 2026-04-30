import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveCredential,
  buildAuthHeaders,
  applyAuthQuery,
  applyFilterQuery,
  applyOffset,
  applyCursor,
  getAtPath,
  parseLinkHeader,
  extractRecords,
  recordHasRequiredFields,
  buildReport,
  renderFinalMessage,
  runApiPaginatedCollect,
  SIDE_EFFECT_CLASS,
  type FetchFn,
  type FetchResponseLite,
  type PageRecord,
} from '../../core/skills/api-paginated-collect.js';
import {
  apiPaginatedCollectSpecSchema,
  type ApiPaginatedCollectSpec,
} from '../../core/schemas.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apc-'));
});

afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeSpec(overrides: Partial<ApiPaginatedCollectSpec> = {}): ApiPaginatedCollectSpec {
  return apiPaginatedCollectSpecSchema.parse({
    kind: 'api_paginated_collect',
    endpoint: 'https://api.example.com/items',
    auth: { kind: 'none' },
    pagination: { kind: 'offset', offsetParam: 'offset', limitParam: 'limit', limit: 2 },
    destFile: 'data/items.jsonl',
    maxRecords: 100,
    maxPages: 10,
    ...overrides,
  });
}

function readJsonl(filePath: string): unknown[] {
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line));
}

// ── 1. Schema ────────────────────────────────────────────────────────────────

describe('apiPaginatedCollectSpecSchema', () => {
  it('accepts a minimal valid spec with defaults', () => {
    const parsed = apiPaginatedCollectSpecSchema.parse({
      kind: 'api_paginated_collect',
      endpoint: 'https://api.example.com/items',
      pagination: { kind: 'link_header' },
      destFile: 'data/x.jsonl',
    });
    expect(parsed.method).toBe('GET');
    expect(parsed.auth.kind).toBe('none');
    expect(parsed.maxRecords).toBe(5000);
    expect(parsed.maxPages).toBe(50);
  });

  it('rejects non-URL endpoint', () => {
    expect(() =>
      apiPaginatedCollectSpecSchema.parse({
        kind: 'api_paginated_collect',
        endpoint: 'not-a-url',
        pagination: { kind: 'link_header' },
        destFile: 'data/x.jsonl',
      }),
    ).toThrow();
  });

  it('rejects unknown pagination kind', () => {
    expect(() =>
      apiPaginatedCollectSpecSchema.parse({
        kind: 'api_paginated_collect',
        endpoint: 'https://api.example.com',
        pagination: { kind: 'magic' },
        destFile: 'data/x.jsonl',
      }),
    ).toThrow();
  });

  it('accepts cursor pagination with cursorPath', () => {
    const parsed = apiPaginatedCollectSpecSchema.parse({
      kind: 'api_paginated_collect',
      endpoint: 'https://api.example.com',
      pagination: { kind: 'cursor', cursorPath: 'meta.next' },
      destFile: 'data/x.jsonl',
    });
    expect(parsed.pagination.kind).toBe('cursor');
  });
});

// ── 2. Auth helpers ──────────────────────────────────────────────────────────

describe('resolveCredential', () => {
  it('returns empty string for none', () => {
    expect(resolveCredential({ kind: 'none' })).toBe('');
  });
  it('returns null when env var unset', () => {
    delete process.env._APC_TEST_TOKEN;
    expect(resolveCredential({ kind: 'bearer', envVar: '_APC_TEST_TOKEN' })).toBeNull();
  });
  it('returns the env var value when set', () => {
    process.env._APC_TEST_TOKEN = 'secret-abc';
    expect(resolveCredential({ kind: 'bearer', envVar: '_APC_TEST_TOKEN' })).toBe('secret-abc');
    delete process.env._APC_TEST_TOKEN;
  });
});

describe('buildAuthHeaders', () => {
  it('bearer prepends Bearer prefix', () => {
    expect(buildAuthHeaders({ kind: 'bearer', envVar: 'X' }, 'tok')).toEqual({ Authorization: 'Bearer tok' });
  });
  it('header uses configured name + prefix', () => {
    expect(buildAuthHeaders({ kind: 'header', name: 'X-Api-Key', envVar: 'X', prefix: '' }, 'k')).toEqual({ 'X-Api-Key': 'k' });
  });
  it('none returns empty', () => {
    expect(buildAuthHeaders({ kind: 'none' }, '')).toEqual({});
  });
});

describe('applyAuthQuery', () => {
  it('appends query auth param', () => {
    const out = applyAuthQuery('https://api.example.com/items', { kind: 'query', name: 'api_key', envVar: 'X' }, 'k');
    expect(out).toContain('api_key=k');
  });
  it('is a no-op for non-query auth', () => {
    const url = 'https://api.example.com/items';
    expect(applyAuthQuery(url, { kind: 'none' }, '')).toBe(url);
  });
});

// ── 3. URL construction helpers ──────────────────────────────────────────────

describe('applyFilterQuery', () => {
  it('appends multiple filter params', () => {
    const out = applyFilterQuery('https://api.example.com/items', { since: '2026-01-01', state: 'open' });
    const u = new URL(out);
    expect(u.searchParams.get('since')).toBe('2026-01-01');
    expect(u.searchParams.get('state')).toBe('open');
  });
  it('is a no-op when query is undefined', () => {
    expect(applyFilterQuery('https://api.example.com/items', undefined)).toBe('https://api.example.com/items');
  });
});

describe('applyOffset / applyCursor', () => {
  it('applyOffset sets offset and limit params', () => {
    const out = applyOffset('https://api.example.com/x', 'offset', 'limit', 50, 25);
    const u = new URL(out);
    expect(u.searchParams.get('offset')).toBe('50');
    expect(u.searchParams.get('limit')).toBe('25');
  });
  it('applyCursor sets cursor param', () => {
    const out = applyCursor('https://api.example.com/x', 'cursor', 'abc123');
    expect(new URL(out).searchParams.get('cursor')).toBe('abc123');
  });
});

// ── 4. Path / Link header / record helpers ──────────────────────────────────

describe('getAtPath', () => {
  it('walks dotted paths', () => {
    expect(getAtPath({ a: { b: { c: 5 } } }, 'a.b.c')).toBe(5);
  });
  it('returns undefined on missing intermediate', () => {
    expect(getAtPath({ a: 1 }, 'a.b')).toBeUndefined();
  });
  it('empty path returns whole object', () => {
    const obj = { x: 1 };
    expect(getAtPath(obj, '')).toBe(obj);
  });
});

describe('parseLinkHeader', () => {
  it('parses GitHub-style next link', () => {
    const link = '<https://api.github.com/repos/x/y/issues?page=2>; rel="next", <https://api.github.com/repos/x/y/issues?page=10>; rel="last"';
    expect(parseLinkHeader(link, 'next')).toBe('https://api.github.com/repos/x/y/issues?page=2');
  });
  it('returns null when rel not present', () => {
    expect(parseLinkHeader('<https://x/y>; rel="prev"', 'next')).toBeNull();
  });
  it('returns null when header is undefined', () => {
    expect(parseLinkHeader(undefined, 'next')).toBeNull();
  });
});

describe('extractRecords', () => {
  it('returns body when no recordsPath given and body is array', () => {
    expect(extractRecords([1, 2, 3], undefined)).toEqual([1, 2, 3]);
  });
  it('returns nested array via dotted path', () => {
    expect(extractRecords({ data: { items: [{ id: 1 }] } }, 'data.items')).toEqual([{ id: 1 }]);
  });
  it('returns empty array when path resolves to non-array', () => {
    expect(extractRecords({ data: 'oops' }, 'data')).toEqual([]);
  });
});

describe('recordHasRequiredFields', () => {
  it('passes when all required present', () => {
    expect(recordHasRequiredFields({ id: 1, name: 'x' }, ['id', 'name'])).toBe(true);
  });
  it('fails when one missing', () => {
    expect(recordHasRequiredFields({ id: 1 }, ['id', 'name'])).toBe(false);
  });
  it('passes when no required fields configured', () => {
    expect(recordHasRequiredFields({ x: 1 }, [])).toBe(true);
  });
});

// ── 5. buildReport / renderFinalMessage ─────────────────────────────────────

describe('buildReport', () => {
  it('aggregates counts across pages', () => {
    const ledger: PageRecord[] = [
      { pageNumber: 1, url: 'a', recordsFetched: 5, recordsAppended: 5, status: 'ok', errorReason: null },
      { pageNumber: 2, url: 'b', recordsFetched: 5, recordsAppended: 3, status: 'ok', errorReason: null },
    ];
    const r = buildReport(ledger, 'data/x.jsonl', 1234, null);
    expect(r.totalRecords).toBe(10);
    expect(r.totalAppended).toBe(8);
    expect(r.pagesFetched).toBe(2);
  });
});

describe('renderFinalMessage', () => {
  it('includes counts and dest', () => {
    const r = buildReport([
      { pageNumber: 1, url: 'a', recordsFetched: 5, recordsAppended: 5, status: 'ok', errorReason: null },
    ], 'data/x.jsonl', 5000, null);
    const msg = renderFinalMessage(r, makeSpec());
    expect(msg).toContain('FINAL_STATUS:');
    expect(msg).toContain('pages=1');
    expect(msg).toContain('records_fetched=5');
    expect(msg).toContain('appended=5');
  });

  it('lists errors when present', () => {
    const r = buildReport([
      { pageNumber: 3, url: 'https://x/3', recordsFetched: 0, recordsAppended: 0, status: 'error', errorReason: 'HTTP 503' },
    ], null, 100, 'page 3 failed');
    const msg = renderFinalMessage(r, makeSpec());
    expect(msg).toContain('errors=[');
    expect(msg).toContain('HTTP 503');
    expect(msg).toContain('aborted: page 3 failed');
  });
});

// ── 6. Engine — offset pagination ───────────────────────────────────────────

describe('runApiPaginatedCollect — offset pagination', () => {
  it('walks pages until short page signals end', async () => {
    const fetchFn = vi.fn<FetchFn>()
      .mockResolvedValueOnce({ status: 200, headers: {}, body: [{ id: 1 }, { id: 2 }] })
      .mockResolvedValueOnce({ status: 200, headers: {}, body: [{ id: 3 }, { id: 4 }] })
      .mockResolvedValueOnce({ status: 200, headers: {}, body: [{ id: 5 }] }); // short page → halt

    const spec = makeSpec();
    const report = await runApiPaginatedCollect(spec, { workspaceRoot: tmpRoot, fetchFn });

    expect(report.pagesFetched).toBe(3);
    expect(report.totalAppended).toBe(5);
    expect(report.abortReason).toBeNull();
    const records = readJsonl(path.join(tmpRoot, 'data/items.jsonl'));
    expect(records).toHaveLength(5);
  });

  it('respects maxRecords cap mid-page', async () => {
    const fetchFn = vi.fn<FetchFn>()
      .mockResolvedValue({ status: 200, headers: {}, body: [{ id: 1 }, { id: 2 }] });

    const spec = makeSpec({ maxRecords: 3 });
    const report = await runApiPaginatedCollect(spec, { workspaceRoot: tmpRoot, fetchFn });

    expect(report.totalAppended).toBe(3);
    expect(report.abortReason).toBe('max_records_reached');
  });

  it('respects maxPages cap', async () => {
    const fetchFn = vi.fn<FetchFn>()
      .mockResolvedValue({ status: 200, headers: {}, body: [{ id: 1 }, { id: 2 }] });

    const spec = makeSpec({ maxPages: 2 });
    const report = await runApiPaginatedCollect(spec, { workspaceRoot: tmpRoot, fetchFn });

    expect(report.pagesFetched).toBe(2);
    expect(report.abortReason).toBe('max_pages_reached');
  });
});

// ── 7. Engine — link_header pagination ──────────────────────────────────────

describe('runApiPaginatedCollect — link_header pagination', () => {
  it('follows Link header next URL until none', async () => {
    const fetchFn = vi.fn<FetchFn>()
      .mockResolvedValueOnce({
        status: 200,
        headers: { link: '<https://api.example.com/items?page=2>; rel="next"' },
        body: [{ id: 1 }],
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: { link: '<https://api.example.com/items?page=3>; rel="next"' },
        body: [{ id: 2 }],
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: [{ id: 3 }],
      });

    const spec = makeSpec({ pagination: { kind: 'link_header', rel: 'next' } });
    const report = await runApiPaginatedCollect(spec, { workspaceRoot: tmpRoot, fetchFn });

    expect(report.pagesFetched).toBe(3);
    expect(report.totalAppended).toBe(3);
    // Verify second call used the next URL from Link header
    expect(fetchFn.mock.calls[1][0]).toContain('page=2');
  });
});

// ── 8. Engine — cursor pagination ───────────────────────────────────────────

describe('runApiPaginatedCollect — cursor pagination', () => {
  it('follows cursor field until missing', async () => {
    const fetchFn = vi.fn<FetchFn>()
      .mockResolvedValueOnce({ status: 200, headers: {}, body: { items: [{ id: 'a' }], next_cursor: 'c1' } })
      .mockResolvedValueOnce({ status: 200, headers: {}, body: { items: [{ id: 'b' }], next_cursor: 'c2' } })
      .mockResolvedValueOnce({ status: 200, headers: {}, body: { items: [{ id: 'c' }] } });

    const spec = makeSpec({
      pagination: { kind: 'cursor', cursorPath: 'next_cursor', cursorParam: 'cursor' },
      recordsPath: 'items',
    });
    const report = await runApiPaginatedCollect(spec, { workspaceRoot: tmpRoot, fetchFn });

    expect(report.pagesFetched).toBe(3);
    expect(report.totalAppended).toBe(3);
    expect(fetchFn.mock.calls[1][0]).toContain('cursor=c1');
    expect(fetchFn.mock.calls[2][0]).toContain('cursor=c2');
  });
});

// ── 9. Engine — dedup, validation, recordsPath ───────────────────────────────

describe('runApiPaginatedCollect — dedup and validation', () => {
  it('dedups records by configured key across pages', async () => {
    const fetchFn = vi.fn<FetchFn>()
      .mockResolvedValueOnce({ status: 200, headers: {}, body: [{ id: 1 }, { id: 2 }] })
      .mockResolvedValueOnce({ status: 200, headers: {}, body: [{ id: 2 }, { id: 3 }] })
      .mockResolvedValueOnce({ status: 200, headers: {}, body: [{ id: 4 }] }); // short page → halt

    const spec = makeSpec({ dedupBy: 'id' });
    const report = await runApiPaginatedCollect(spec, { workspaceRoot: tmpRoot, fetchFn });

    expect(report.totalAppended).toBe(4);
    const records = readJsonl(path.join(tmpRoot, 'data/items.jsonl'));
    const ids = records.map(r => (r as { id: number }).id);
    expect(ids.sort()).toEqual([1, 2, 3, 4]);
  });

  it('drops records lacking required fields', async () => {
    const fetchFn = vi.fn<FetchFn>()
      .mockResolvedValueOnce({ status: 200, headers: {}, body: [{ id: 1, name: 'a' }, { id: 2 }] })
      .mockResolvedValueOnce({ status: 200, headers: {}, body: [{ id: 3, name: 'c' }] });

    const spec = makeSpec({ requireFields: ['id', 'name'] });
    const report = await runApiPaginatedCollect(spec, { workspaceRoot: tmpRoot, fetchFn });

    expect(report.totalAppended).toBe(2);
    const records = readJsonl(path.join(tmpRoot, 'data/items.jsonl')) as Array<{ id: number }>;
    expect(records.map(r => r.id).sort()).toEqual([1, 3]);
  });

  it('reads records from a nested recordsPath', async () => {
    const fetchFn = vi.fn<FetchFn>()
      .mockResolvedValueOnce({ status: 200, headers: {}, body: { data: { items: [{ id: 1 }] } } });

    const spec = makeSpec({ recordsPath: 'data.items' });
    const report = await runApiPaginatedCollect(spec, { workspaceRoot: tmpRoot, fetchFn });

    expect(report.totalAppended).toBe(1);
  });
});

// ── 10. Engine — auth and error paths ───────────────────────────────────────

describe('runApiPaginatedCollect — auth and errors', () => {
  it('refuses to start when bearer env var is unset', async () => {
    delete process.env._APC_NEVER_SET;
    const spec = makeSpec({ auth: { kind: 'bearer', envVar: '_APC_NEVER_SET' } });
    const report = await runApiPaginatedCollect(spec, { workspaceRoot: tmpRoot, fetchFn: vi.fn() });
    expect(report.pagesFetched).toBe(0);
    expect(report.abortReason).toContain('_APC_NEVER_SET');
  });

  it('passes Authorization header when bearer env var is set', async () => {
    process.env._APC_TOK = 'tok123';
    const fetchFn = vi.fn<FetchFn>()
      .mockResolvedValueOnce({ status: 200, headers: {}, body: [{ id: 1 }] });
    const spec = makeSpec({ auth: { kind: 'bearer', envVar: '_APC_TOK' } });
    await runApiPaginatedCollect(spec, { workspaceRoot: tmpRoot, fetchFn });
    delete process.env._APC_TOK;

    const init = fetchFn.mock.calls[0][1];
    expect(init.headers.Authorization).toBe('Bearer tok123');
  });

  it('aborts on 5xx after retry', async () => {
    const fetchFn = vi.fn<FetchFn>()
      .mockResolvedValue({ status: 503, headers: {}, body: null });
    const spec = makeSpec();
    const report = await runApiPaginatedCollect(spec, { workspaceRoot: tmpRoot, fetchFn });

    expect(report.pagesFetched).toBe(1);
    expect(report.ledger[0].status).toBe('error');
    expect(report.ledger[0].errorReason).toContain('HTTP 503');
    expect(report.abortReason).toContain('failed');
  });

  it('refuses to start when destFile escapes workspace', async () => {
    const spec = makeSpec({ destFile: '../escape/out.jsonl' });
    const report = await runApiPaginatedCollect(spec, { workspaceRoot: tmpRoot, fetchFn: vi.fn() });
    expect(report.abortReason).toBe('destFile escapes workspace');
  });
});

// ── 11. Transparency events ─────────────────────────────────────────────────

describe('runApiPaginatedCollect — transparency events', () => {
  it('emits engine_start, page_attempt, page_done, engine_done', async () => {
    const fetchFn = vi.fn<FetchFn>()
      .mockResolvedValueOnce({ status: 200, headers: {}, body: [{ id: 1 }] });

    const events: Array<{ type: string }> = [];
    const spec = makeSpec({ pagination: { kind: 'link_header', rel: 'next' } });
    await runApiPaginatedCollect(spec, {
      workspaceRoot: tmpRoot,
      fetchFn,
      emit: (e) => events.push(e as { type: string }),
    });

    const types = events.map(e => e.type);
    expect(types).toContain('api_paginated_collect_engine_start');
    expect(types).toContain('api_paginated_collect_page_attempt');
    expect(types).toContain('api_paginated_collect_page_done');
    expect(types).toContain('api_paginated_collect_engine_done');
  });
});

// ── 12. Side-effect classification ──────────────────────────────────────────

describe('side-effect classification', () => {
  it('engine class is local_write', () => {
    expect(SIDE_EFFECT_CLASS).toBe('local_write');
  });
});

// ── 13. Spec extractor ──────────────────────────────────────────────────────

describe('extractApiPaginatedCollectSpec', () => {
  it('parses a valid spec from a representative user message', async () => {
    const { extractApiPaginatedCollectSpec } = await import('../../core/skills/api-paginated-collect-spec-extractor.js');
    const valid = JSON.stringify({
      kind: 'api_paginated_collect',
      endpoint: 'https://api.github.com/repos/foo/bar/issues',
      method: 'GET',
      auth: { kind: 'bearer', envVar: 'GITHUB_TOKEN' },
      pagination: { kind: 'link_header', rel: 'next' },
      queryParams: { state: 'open' },
      extraHeaders: { Accept: 'application/vnd.github+json' },
      destFile: 'workspace/data/issues.jsonl',
      dedupBy: 'id',
      maxRecords: 1000,
      maxPages: 30,
    });
    const handler = vi.fn().mockResolvedValue(valid);
    const spec = await extractApiPaginatedCollectSpec(
      'collect open issues from foo/bar via the GitHub API into workspace/data/issues.jsonl',
      handler,
    );
    expect(spec).not.toBeNull();
    expect(spec!.pagination.kind).toBe('link_header');
    expect(spec!.auth.kind).toBe('bearer');
  });

  it('returns null on unparseable response', async () => {
    const { extractApiPaginatedCollectSpec } = await import('../../core/skills/api-paginated-collect-spec-extractor.js');
    const handler = vi.fn().mockResolvedValue('Sorry, I cannot help with that.');
    const spec = await extractApiPaginatedCollectSpec('do something', handler);
    expect(spec).toBeNull();
  });
});
