# Phase 25 Plan — Three Concrete Engines Before Universal `TaskSpec`

**Status:** active
**Predecessor tag:** `phase-24-download-engine-complete`
**Companion doc:** `docs/one-call-engine.md` (whitepaper, §15 governs the discipline)

---

## Discipline (load-bearing)

> Build three concrete engines first. Extract the universal `TaskSpec` runtime only after the third ships and the actually-shared parts are obvious.

Universal abstractions extracted from a single example are vague. They optimise for what the first engine happened to need and miss the structure that only emerges when independent engines start to look alike under pressure.

We refuse to extract `TaskSpec` until **three independent engines** have shipped and we can read their code side-by-side and see the shared spine. The three are below.

---

## The Three Engines

| # | Kind | Status | Sprint |
|---|------|--------|--------|
| 1 | `web_download_multi_target` | shipped | Phase 24 (`phase-24-download-engine-complete`) |
| 2 | `file_batch_transform` | shipped | Phase 25.1 (`phase-25-1-file-batch-transform-complete`) |
| 3 | `api_paginated_collect` | shipped | Phase 25.2 (`phase-25-2-api-paginated-collect-complete`) |

All three concrete engines have shipped. Phase 25.3 now extracts the `TaskSpec` registry and migrates all three. The shared spine is visible across the implementations and ready to lift.

---

## Phase 25.1 — `file_batch_transform`

**Goal.** Take a glob of input files, apply a typed transform to each, validate, write to an output directory, produce a per-file ledger. One LLM call to extract the spec; the engine handles the rest.

### Concrete examples to design against

- Rename a folder of CSVs by a deterministic template with collision detection.
- Copy/move all PDFs under `workspace/inbox/` matching a glob into a project-specific folder, validating each by `read_pdf`.
- Extract first-page text from every PDF in a folder into a side-by-side `.txt` index.

### Spec shape (initial)

```typescript
{
  kind: 'file_batch_transform',
  source: { glob: 'workspace/inputs/*.pdf' },
  transform: { kind: 'extract_text_from_pdf' | 'rename' | 'copy', /* params */ },
  destDir: 'workspace/outputs',
  filenameTemplate: '{stem}.txt',           // {stem} = original basename minus ext
  validation: {
    minBytes: 100,
    requireExtension: '.txt',
  },
}
```

### Step types (the three the engine speaks natively)

| Transform kind | Validator | Idempotent? | Side-effect class |
|---|---|---|---|
| `copy` | `dest.bytes === src.bytes` | yes (overwrite flag) | `local_write` |
| `rename` | `exists(dest) && !exists(src)` | yes (idempotent for noop) | `local_write` |
| `extract_text_from_pdf` | `outputBytes ≥ minBytes` | yes (overwrite by default) | `local_write` |

Per the whitepaper §5, three principles enforced:

- **Composable.** Every per-file record emits `{ srcPath, destPath, bytes }`.
- **Idempotent.** All three transforms are idempotent. Re-running the same spec on the same inputs is a no-op when outputs already exist (controlled by an `overwrite: 'always' | 'if-missing'` policy field, default `if-missing`).
- **Self-validating.** Each transform owns a `validate(record) → { ok, reason }` predicate. No LLM judgment.

### Ledger

```typescript
interface FileTransformRecord {
  srcPath: string;
  destPath: string | null;
  bytes: number | null;
  attempts: number;
  status: 'pending' | 'ok' | 'skipped' | 'error';
  errorReason: string | null;
}
```

### Failure taxonomy

| Failure | Detection | Response |
|---|---|---|
| Glob matches zero files | `globResult.length === 0` | Engine returns empty ledger; report says "no inputs matched" |
| Source file unreadable | `fs.statSync` throws | Mark `error`, set reason, continue to next file |
| Destination path escapes workspace | resolved path not under workspace root | Reject the spec at extraction time |
| Destination collision (overwrite=if-missing) | `fs.existsSync(destPath)` true | Mark `skipped` with reason `dest_exists` |
| Transform throws | catch block | Mark `error`, increment attempt; one retry, then skip |
| Validator returns `{ ok: false }` | post-transform check | Delete partial output; mark `error`; one retry |
| Wall-clock exceeded | `Date.now() − startMs > MAX_TOTAL_MS` | Break loop; remaining files marked `skipped: timeout` |

### Engine constants

```typescript
export const MAX_RETRIES_PER_FILE = 1;
export const MAX_TOTAL_MS = 600_000;        // 10 min for batch ops
export const MAX_FILES_PER_BATCH = 1000;    // hard cap; specs requesting more are rejected
```

### Side-effect classification (per §8 of whitepaper)

The engine itself is `local_write` class. The destDir is constrained to be a workspace-relative path resolved against `process.cwd()/workspace/`. Anything outside is rejected at spec validation, not at runtime.

### Files

- `core/skills/file-batch-transform.ts` — the engine
- `core/skills/file-batch-transform-spec-extractor.ts` — the single LLM call
- `core/schemas.ts` — `fileBatchTransformSpecSchema` Zod definition
- `tests/phase-25/file-batch-transform.test.ts` — unit + integration tests
- `core/router.ts` — Tier 1b detection regex + dispatch

### Acceptance for 25.1

1. Spec schema validates representative examples.
2. Engine runs on real files in a temp dir; each transform kind has unit tests.
3. Failure taxonomy entries each have at least one regression test.
4. Wired into router behind a regex gate; falls through to QueryLoop on extractor failure.
5. RunRecord shape produced and writable to `HOW.RR` notebook (stub OK; full notebook integration in 25.3).
6. All existing tests pass; new tests pass; coverage of new module ≥ 80%.

---

## Phase 25.2 — `api_paginated_collect` (shipped)

**Goal.** Authenticate against an HTTP API, walk a paginated endpoint, collect records into JSONL, validate, deduplicate, halt on terminal page or count.

### Final spec shape

```typescript
{
  kind: 'api_paginated_collect',
  endpoint: 'https://api.github.com/repos/foo/bar/issues',
  method: 'GET',
  auth: { kind: 'bearer', envVar: 'GITHUB_TOKEN' },
  pagination: { kind: 'link_header', rel: 'next' },
  recordsPath: undefined,                 // body itself is array; or e.g. 'data.items'
  queryParams: { state: 'open' },
  extraHeaders: { Accept: 'application/vnd.github+json' },
  destFile: 'workspace/data/issues.jsonl',
  dedupBy: 'id',
  maxRecords: 5000,
  maxPages: 50,
  requireFields: ['id'],
}
```

**Schema lesson.** Originally designed with nested `filter: { query, headers }`. The structured-output repair chain in `core/structured.ts` runs `flattenSingleKeyObjects` before schema validation, which mangled `{ filter: { query: {...} } }` into the string `"query"`. Refactored to top-level `queryParams` and `extraHeaders`. **Future engines: keep schemas flat. Avoid single-key parent objects whose only value is a single-key object.**

### Step types (closed DSL)

- `auth_check` — verify the configured credential env var resolves; refuse to start if not. Side-effect class `none`.
- `fetch_page` — paginated GET, retried once on transport error, hard-fails on 5xx after retry. Side-effect class `none`.
- `validate_record` — drop records lacking `requireFields`; dedup by `dedupBy` key. Side-effect class `none`.
- `append_jsonl` — stream deduped records to workspace-sandboxed `destFile`. Side-effect class `local_write`.

### Final ledger

```typescript
interface PageRecord {
  pageNumber: number;
  url: string;
  recordsFetched: number;
  recordsAppended: number;  // post-dedup, post-validation
  status: 'ok' | 'error';
  errorReason: string | null;
}
```

### Pagination kinds (closed enum)

| Kind | Halt signal |
|---|---|
| `link_header` | RFC 5988 `Link` header has no `rel="next"` |
| `offset` | A page returns fewer records than `limit` |
| `cursor` | `cursorPath` is missing or empty in response body |

### Auth kinds (closed enum)

`none` | `bearer` | `header` | `query` — all read credentials from env vars only. The engine refuses to start when the configured env var is unset.

### Constants

```typescript
export const MAX_RETRIES_PER_PAGE = 1;
export const MAX_TOTAL_MS = 300_000;
```

Plus per-spec caps: `maxRecords` (default 5000, ceiling 100,000) and `maxPages` (default 50, ceiling 500).

### Acceptance for 25.2 — met

1. Spec schema validates representative examples (link_header / offset / cursor; bearer / header / query / none auth). ✅
2. Engine runs against mocked fetch; each pagination + auth combination has unit tests. ✅
3. Failure taxonomy entries each have at least one regression test (5xx retry, env-var-unset refuse, workspace escape, max caps). ✅
4. Wired into router (Tier 1c) behind a verb+target regex; falls through to QueryLoop on extractor failure. ✅
5. RunRecord shape produced and writable to `HOW.RR` notebook (full integration in 25.3). ⏳
6. All existing tests pass; new tests pass (47 new tests). ✅

### Files (final)

- `core/skills/api-paginated-collect.ts` — engine
- `core/skills/api-paginated-collect-spec-extractor.ts` — single LLM call
- `core/schemas.ts` — `apiPaginatedCollectSpecSchema`, `apiAuthSchema`, `apiPaginationSchema`
- `tests/phase-25/api-paginated-collect.test.ts` — 47 tests
- `core/router.ts` — Tier 1c gate

---

## Phase 25.3 — Extract `TaskSpec`

All three concrete engines have shipped. The shared spine is now provably visible — read the three implementations side-by-side and the structure is obvious:

### Observed shared spine

| Concern | `web_download_multi_target` | `file_batch_transform` | `api_paginated_collect` | Shared? |
|---|---|---|---|---|
| Ledger = flat array of typed records | `TargetRecord[]` | `FileTransformRecord[]` | `PageRecord[]` | **yes** |
| Per-record status enum | `pending\|ok\|skipped` | `pending\|ok\|skipped\|error` | `ok\|error` | yes (union) |
| Counter-driven loop with hard caps | searches/pages/downloads | retries/files | pages/records | **yes** |
| Wall-clock guard (`MAX_TOTAL_MS`) | 120s | 600s | 300s | **yes** (per-engine constant) |
| Workspace-sandboxed dest | `destDir` | `destDir` | `destFile` | **yes** |
| Single LLM extractor (~400-500 tokens) | yes | yes | yes | **yes** |
| Self-validating outputs (no LLM) | size + read_pdf | size + extension + bytes | requireFields + dedup | **yes** (predicate per kind) |
| Transparency events | yes | yes | yes | **yes** |
| `renderFinalMessage(report, spec)` | yes | yes | yes | **yes** |
| Side-effect class `local_write` | yes | yes | yes | **yes** |
| Skill runner / fetch injection | `runSkill` | `runSkill` | `fetchFn` | partial (different deps) |
| Banned-input set | `bannedUrls: Set` | (n/a per file) | (dedup set) | partial |

The bolded rows are the **TaskSpec runtime contract.** Engine-specific dependencies stay engine-local — they are correctly injectable.

### Sprint 25.3 work items

1. Define `TaskSpec<K, I>`, `EngineEntry<K, I, L>`, and `engineRegistry` per whitepaper Appendix B.
2. Define `Ledger<R>` generic shape: `R[]` with the union status enum, plus aggregate `{ totalMs, abortReason }`.
3. Define `RunRecord` once. Add `toRunRecord` to each engine. Wire writes into `HOW.RR` notebook.
4. Migrate all three engines behind the registry. Router becomes a kind-discriminator. One LLM-graded "what kind of task is this?" call replaces the three regex tiers (1, 1b, 1c).
5. Implement the escalation protocol (whitepaper §7) at the runtime layer, generic across engines.
6. Implement side-effect approval gates (whitepaper §8) at the runtime layer. Per-engine `sideEffectClass` declared at registration; runtime gates `external_write` and `destructive` regardless of engine.
7. Implement the memory-loop seed: on extractor entry, fetch top-K relevant prior `RunRecord`s by `kind` + semantic similarity; pass the relevant subset to the extractor as a typed prior; seed the engine's banlist / candidate set from `RunRecord.dead_ends` / `winning_path`.

### Acceptance for 25.3

- Three engines run **byte-equal** behaviorally after migration (modulo timestamps). Capture pre-migration ledgers for representative inputs, replay post-migration, assert equality. The abstraction adds capability without changing semantics.
- One new engine (e.g. `browser_form_submit`) added in < 1 day by registering a single `(schema, runner, classifier, formatter, toRunRecord)` tuple.
- Replanning rate measured per kind; sustained > 10% on any kind triggers a step-library review (whitepaper §13).
- Memory loop verified: a second run of the same task uses prior `RunRecord` data (e.g. seeds `bannedUrls` from prior `dead_ends`).

---

## Out of scope for this sprint

- Cross-engine concurrency (parallelism > 1).
- LLM-graded kind dispatch (still regex in 25.1 / 25.2).
- HOW.RR notebook full schema (stub now, finalised at 25.3).
- Browser/data engines (#4 and #5 — Phase 26).

---

## Sprint tag plan

- ✅ `phase-25-1-file-batch-transform-complete` — shipped.
- ✅ `phase-25-2-api-paginated-collect-complete` — shipped.
- ⏳ `phase-25-3-task-spec-extracted` — next.

---

## Engine kinds taxonomy — the download intent space

Stress-testing `web_download_multi_target` against generic download intents (see `tests/phase-25/web-download-stress-corpus.test.ts` "Generality audit") surfaced a clear taxonomy: this engine handles ONE specific shape (find a PDF per target via web search). Other download shapes need sibling engines — same architectural pattern, different validators and URL filters.

The architecture supports these as drop-in additions: each is one new `<kind>SpecSchema`, one new engine implementation, one new spec extractor, one new dispatcher tier. The framework is right — we just have one engine in this family today. New engines slot in after Phase 25.3 (TaskSpec extraction) so they all share the runtime.

| # | Intent | Example user message | Status | Differs from #1 by |
|---|--------|---------------------|--------|---------------------|
| 1 | **PDF artifact (multi-target)** | "Download Neolith, Sapiens Stone catalogs to /catalogs/" | shipped | — (this engine) |
| 2 | **Software installer** | "Download Inkscape, Firefox, VS Code macOS installers" | not built | URL filter accepts `.dmg`/`.pkg`/`.exe`; validator checks file magic + signed-bundle structure (no read_pdf) |
| 3 | **Source archive** | "Download nginx, redis, postgres source tar.gz" | not built | URL filter accepts `.tar.gz`/`.tgz`/`.zip`; validator checks archive integrity + expected top-level dir name |
| 4 | **Image asset** | "Download official Tesla, Apple, Microsoft logos as PNG" | not built | URL filter accepts `.png`/`.svg`/`.jpg`; validator checks dimensions ≥ N×N + transparency for logos |
| 5 | **GitHub release** | "Download v1.2.3 release of anthropics/claude-code" | not built | Search → GitHub releases API (not Brave); URL is `https://api.github.com/.../releases/...`; auth via `GITHUB_TOKEN` |
| 6 | **Git clone** | "Clone tantivy-py, meilisearch, qdrant" | not built | Different verb space (clone, not download); uses git skill; "validation" = `git rev-parse HEAD` succeeds |

**The pattern is the engine, not the engine-kind.** Each row above is a `(SpecSchema, Engine, Validator, URLFilter, BannedDomains)` tuple registered with the same runtime. Phase 25.3's TaskSpec extraction makes adding rows 2-6 a one-day exercise per kind.

**What we do NOT need to do:** attempt a single "universal downloader" engine. That's the path that fails. Each row above has different success predicates (PDF text vs binary magic vs image dimensions vs git rev-parse), and a single engine that tries to be all of them ends up either over-specialized or impossibly under-constrained. Three concrete engines is the *minimum* discipline; six concrete engines (when the download space matures) is fine. Every row earns its own engine.

### What changed in Phase 25.2.1 (post-shipping audit fix)

Two real bugs surfaced when the user inspected the workspace after a successful-looking run:

1. **Orphan files from failed validation** were never cleaned up. A failed download could leave a file on disk that, in a later run, would block the redownload (because `download_file` skipped existing). Fixed: `cleanupFailedDownload()` deletes the orphan workspace-sandboxed; the engine emits `web_download_validation_failed` with the deletion outcome.
2. **No content-relevance check.** A 27 MB email-as-PDF passed both gates (size + read_pdf parses) and was saved as a "Neolith catalog". Fixed: `validatePdf` now takes optional `target` + `artifact` and runs `checkContentRelevance` on the first 20 KB of extracted PDF text. Brand name absent → reject; brand present but no catalog/datasheet/brochure keyword → reject; else ok.

Coverage broadened in the same patch:

- Dispatcher regex now accepts datasheets/manuals/whitepapers and alphanumeric brand names (STM32F4, RP2040). The engine's `ARTIFACT_KEYWORDS` was expanded to match.
- Spec extractor prompt now explicitly tells the LLM to **return `{}`** for non-PDF artifacts (DMG, github clone, source archive, image asset) so the router falls through.

The stress-test corpus in `tests/phase-25/web-download-stress-corpus.test.ts` contains the audit cases as enforceable contracts — including 9 "intent shape" cases with explicit `in-scope` / `out-of-scope` labels.

---

*Discipline checkpoint: if at any point the temptation arises to extract `TaskSpec` before three engines exist, re-read whitepaper §15 and stop. Universal abstractions extracted prematurely become vague.*
