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
| 2 | `file_batch_transform` | scaffolded this sprint | Phase 25.1 |
| 3 | `api_paginated_collect` | next | Phase 25.2 |

After #3 ships and runs in production for at least a week of real use, Phase 25.3 extracts the `TaskSpec` registry and migrates all three.

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

## Phase 25.2 — `api_paginated_collect`

**Goal.** Authenticate against an HTTP API, walk a paginated endpoint, collect records into JSONL, validate, deduplicate, halt on terminal page or count.

### Spec shape (sketched)

```typescript
{
  kind: 'api_paginated_collect',
  endpoint: 'https://api.github.com/repos/foo/bar/issues',
  auth: { kind: 'header', name: 'Authorization', envVar: 'GITHUB_TOKEN', prefix: 'Bearer ' },
  pagination: { kind: 'link_header' | 'offset' | 'cursor', /* params */ },
  filter: { since?: string, query?: Record<string, string> },
  destFile: 'workspace/data/foo-bar-issues.jsonl',
  dedupBy: 'id',
  maxRecords: 5000,
  maxPages: 50,
}
```

### Step types

- `auth_check` — validate the configured credential resolves, side-effect class `none`.
- `fetch_page` — paginated GET, side-effect class `none`.
- `append_jsonl` — write deduped records, side-effect class `local_write`.
- `validate_record` — schema-check each record (caller-provided Zod or default), side-effect class `none`.

### Ledger

```typescript
interface PageRecord {
  pageNumber: number;
  url: string;
  recordsFetched: number;
  recordsAppended: number;  // post-dedup
  status: 'ok' | 'error';
  errorReason: string | null;
}
```

### Files

- `core/skills/api-paginated-collect.ts`
- `core/skills/api-paginated-collect-spec-extractor.ts`
- `core/schemas.ts` — `apiPaginatedCollectSpecSchema`
- `tests/phase-25/api-paginated-collect.test.ts`
- `core/router.ts` — Tier 1c

Designed in detail when 25.1 ships.

---

## Phase 25.3 — Extract `TaskSpec`

After 25.2 ships and runs against at least one real API for at least a week:

1. Read all three engines side-by-side. Identify the shared spine (per whitepaper §15).
2. Define `TaskSpec<K, I>`, `EngineEntry<K, I, L>`, and `engineRegistry` per Appendix B.
3. Define `RunRecord` once, populate it from each engine's `toRunRecord`.
4. Migrate all three engines behind the registry. Router becomes a kind-discriminator with one LLM-graded "what kind of task is this?" call.
5. Implement the escalation protocol (whitepaper §7) at the runtime layer, generic across engines.
6. Implement side-effect approval gates (whitepaper §8) at the runtime layer.
7. Wire `RunRecord` writes into `HOW.RR` notebook with full memory-loop integration (whitepaper §9): on extractor entry, fetch top-K relevant prior `RunRecord`s and seed the engine's banlist + candidate priors.

### Acceptance for 25.3

- Three engines run unchanged behaviorally after migration.
- One new engine (e.g. `browser_form_submit`) added in < 1 day by registering a single tuple.
- Replanning rate measured per kind; sustained > 10% triggers a step-library review (whitepaper §13).

---

## Out of scope for this sprint

- Cross-engine concurrency (parallelism > 1).
- LLM-graded kind dispatch (still regex in 25.1 / 25.2).
- HOW.RR notebook full schema (stub now, finalised at 25.3).
- Browser/data engines (#4 and #5 — Phase 26).

---

## Sprint tag plan

- `phase-25-1-file-batch-transform-complete` after 25.1 acceptance.
- `phase-25-2-api-paginated-collect-complete` after 25.2 acceptance.
- `phase-25-3-task-spec-extracted` after 25.3 acceptance.

---

*Discipline checkpoint: if at any point the temptation arises to extract `TaskSpec` before three engines exist, re-read whitepaper §15 and stop. Universal abstractions extracted prematurely become vague.*
