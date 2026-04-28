# CLAUDE.md — AgenticAGI Platform Architecture Guide

> Read this before writing any code. Each decision here exists for a reason.
> See `CLAUDE.legacy.md` for the full sprint-by-sprint history.

---

## 1. What We Are Building

A local-first AI agent platform with a 7-notebook structured memory system.
The goal: an agent that feels like a knowledgeable human assistant — not a search engine
that forgets everything between sessions.

**Core properties:**
- Remembers people, projects, plans, and procedures across sessions
- Fetches only what it needs (never dumps everything into context)
- Connects knowledge meaningfully via typed relationships
- Thinks in the background when idle
- Responds fast on simple queries, deep on complex ones

---

## 2. Tech Stack

| Layer | Choice |
|-------|--------|
| Language | TypeScript (ESM, `"type": "module"`) |
| Runtime | Node.js |
| Database | `better-sqlite3` (synchronous, no async complexity) |
| Schema validation | `zod` v4 + `z.toJSONSchema()` |
| Search | BM25 (FTS5) + vector (RRF merge) |
| Package manager | `pnpm` |
| Test runner | Vitest |
| Key deps | `gpt-tokenizer`, `mathjs`, `simple-git` |

---

## 3. Project Structure

```
/AgenticAGI
├── CLAUDE.md                  ← this file (current state)
├── CLAUDE.legacy.md           ← full sprint history
├── memory/                    ← 7 notebooks (WHO/WHAT/WHEN/HOW/WHY/NOW/PLAN)
│   ├── WHO/contacts/
│   ├── WHAT/knowledge/
│   ├── WHEN/{calendar,deadlines,events,reflections,history}/
│   ├── HOW/{procedures,skills}/
│   ├── WHY/{meta,questions}/
│   ├── NOW/{todos,reports,logs}/
│   ├── PLAN/{planning,execution,constraints,milestones,projects}/
│   └── MEMORY_DIGEST.md       ← weekly natural-language digest
├── index/memory.sqlite         ← master index + relationships
├── core/
│   ├── agent.ts               ← main agent loop (processMessage)
│   ├── context.ts             ← memory-aware system prompt + LightRAG ranking
│   ├── router.ts              ← unit routing after decomposition
│   ├── decomposition.ts       ← semantic unit decomposition
│   ├── executor.ts            ← milestone pipeline (HIGH/MAX plans)
│   ├── planner.ts             ← task decomposition + complexity assessment
│   ├── query-loop.ts          ← iterative while-loop engine (LOW/MEDIUM)
│   ├── heartbeat.ts           ← background idle process + AutoDream
│   ├── intake.ts              ← signal extraction from raw user message
│   ├── llm.ts                 ← LLM abstraction (local + cloud profiles)
│   ├── transparency.ts        ← event bus + correlation ID
│   ├── memory-mode.ts         ← memory enable/disable toggle + scratchpad
│   ├── memory/
│   │   ├── index.ts           ← SQLite interface + table DDL
│   │   ├── write.ts           ← memory writer (file-first then SQLite)
│   │   ├── fetch.ts           ← fetch by code
│   │   ├── search.ts          ← hybrid search (last resort)
│   │   ├── unit-search.ts     ← per-unit memory search
│   │   ├── quick-resolve.ts   ← pre-decomposition gate (deterministic)
│   │   ├── memory-agent.ts    ← queue-based async memory write processor
│   │   ├── working-memory.ts  ← per-task execution state
│   │   ├── session-cache.ts   ← warm entry cache (module-level singleton)
│   │   ├── pointer-index.ts   ← MEMORY.md active loops + known entries
│   │   ├── plan-ex.ts         ← PLAN.EX lifecycle
│   │   ├── episodic.ts        ← WHEN.EV / WHEN.RF writes
│   │   └── project.ts         ← PLAN.PJ project brains
│   └── skills/
│       ├── registry.ts        ← skill map + permission freeze
│       ├── runner.ts          ← runSkill() — never throws
│       └── tools/             ← 20 annotated MCP-compatible skills
├── config/agent.config.ts     ← model, paths, KNOWN_CLOUD_MODELS, timeouts
├── server/ui-server.ts        ← WebSocket UI server
├── public/index.html          ← single-file web UI
├── prompts/                   ← hot-reloadable markdown prompts
└── tests/                     ← Vitest test suite
```

---

## 4. Core Philosophy

**Files are canonical, SQLite is derived.**
All authoritative content lives in markdown files on disk.
SQLite holds metadata, relationships, and a full-text search index derived from file contents.
The index can always be rebuilt from files; files are never rebuilt from the index.
**Write order: file first, SQLite second. Never invert.**

**Codes are the universal language.**
```
[NOTEBOOK].[TYPE]-[NUMBER]
WHO.CT-000024  → Contact 24
PLAN.EX-000031 → Execution state 31
NOW.TD-000041  → Todo 41
```

**Skills are not filters — they are execution.**
The compatibility shim runs AFTER decomposition, not instead of it.
Skills are loaded lazily; the full list is never injected into every prompt.

---

## 5. Memory Query Flow

Follow this order strictly. Do not skip steps.

```
1. Code known? → fetch file directly by path. Done.
2. SQLite can answer? (e.g. "active projects" → WHERE clause) → Done.
3. Relationship table can answer? → query, follow codes. Done.
4. Name/tag search? → query index_entries.name. Done.
5. Hybrid search (BM25 + vector) — LAST RESORT ONLY.
   Scope to correct notebook when possible.
```

---

## 6. processMessage() Execution Order

```
[0]  Pending confirmation intercept (LLM-driven via confirm_plan skill)
[0b] Pending user input intercept (request_user_input)
[1]  Fast-path bypasses: /log → NOW.LOG; /meeting → Meeting Mode
[2]  Quick complexity pre-check → LOW/MEDIUM → runQueryLoop directly
[3]  Quick-resolve gate (deterministic, no LLM):
       code lookup → identity question → listing query → name search
     → resolved: single LLM synthesis call → return
[4]  Pre-decomposition skill fast-path (file_writer / run_bash patterns)
[5]  Intake (LLM) → IntakeSignals: personSignal, projectSignal, timeSignal,
       agenticSignal, querySignal, procedureSignal, constraints[]
[6]  Decomposition (LLM) → units[{ id, route, content, order, taskType? }]
[7]  Unit memory search (parallel, signal-scoped)
[8]  Compatibility shim (post-decomposition):
       skill | memory_write | memory_query | relationship_query | code_fetch
[9]  Working memory load / create (agentic units only)
[10] routeDecomposedUnits:
       conversational → batched LLM + persistFactualAssertions
       query          → direct retrieval; hybrid fallback if confidence=0
       agentic        → handleAgenticUnits:
                          taskType='coding' → runQueryLoop
                          LOW/MEDIUM        → runSimplePlan
                          HIGH/MAX          → decomposeTask + executePlan
[11] Return AgentResponse
```

---

## 7. Three Execution Engines

| Engine | Trigger | What it does |
|--------|---------|-------------|
| `runQueryLoop` | `taskType=coding`, LOW/MEDIUM pre-check, LOW/MEDIUM agentic coding | while-loop; model picks skills. Complexity-scaled iteration cap. Circuit breaker. |
| `runSimplePlan` | LOW/MEDIUM agentic (non-coding) | Calls `decomposeTask`, runs steps sequentially. No PLAN.EX overhead. |
| `decomposeTask` + `executePlan` | HIGH/MAX agentic | Full milestone pipeline. Writes PLAN.EX. Post-flight synthesis. |

**`runQueryLoop` options (`QueryLoopOptions`):**
```typescript
{ allowedSkillsOverride?: string[];   // sub-agent scoped skill list
  maxIterationsOverride?: number; }   // overrides COMPLEXITY_ITERATION_CAPS default
```

**Complexity iteration caps (`COMPLEXITY_ITERATION_CAPS` in `core/query-loop.ts`):**
`LOW: 20 | MEDIUM: 40 | HIGH: 80 | MAX: 150`

**Skill discovery — two-stage pattern (Context Diet sprint):**
The query-loop system prompt injects a one-liner list only (~220 tokens, 84% reduction).
When the model needs exact parameter names, it calls the `skill_schema` meta-skill by name.
Full schema injected only on demand. Never inject the full registry every iteration.

**Sub-agent primitive (`core/sub-agent.ts`):**
`spawnSubAgent(task: SubAgentTask, llmHandler)` — spawns an isolated `runQueryLoop` instance
with an explicit `allowedSkills` allowlist, no parent history, and a compact `contextHandoff` (≤2000 chars).

---

## 8. Memory Toggle

`core/memory-mode.ts` is the single source of truth for memory enable/disable.

```typescript
getMemoryMode()           → 'enabled' | 'disabled'
setMemoryMode(mode)       → void
isMemoryFullyDisabled()   → boolean (convenience check)
```

**When disabled, ALL of these gates early-return:**
- `createEntry()` / `upsertEntry()` → return `MEMORY_DISABLED_SENTINEL`
- `sessionCache.set()` → no-op
- `memoryAgent.enqueue()` → drops update, emits `memory_disabled_drop` event
- `pointer-index.ts` — `upsertPointerEntry`, `removePointerEntry`, `upsertActiveLoop`, `removeActiveLoop` → no-op
- `context.ts` — persona fetch, index summary, resolved entries, PLAN.CT block → skipped
- `heartbeat.ts` — entire run skipped → emits `heartbeat_skipped_memory_disabled`
- `router.ts` — `persistFactualAssertions()` → returns early
- `executor.ts` — PLAN.EX create/save/update, episodic event write → skipped; scratchpad used instead
- `agent.ts` — `recordActivity()` → skipped

**Scratchpad substitution (HIGH/MAX plans when disabled):**
```typescript
getScratchpadPath(requestId)                    → workspace/.scratch/plan-<id>.md
appendScratchpad(requestId, section, content)   → appends section to file
readScratchpad(requestId)                       → full file or null
clearScratchpad(requestId)                      → removes file (called on plan completion)
```

**Toggle from UI:** Settings panel → Memory section → Enabled/Disabled button.
Server handles `set_memory_mode` WebSocket message; broadcasts `memory_mode_status` to all clients.

**Memory-read signal gating (`core/memory-when.ts`):**
Every memory-read site declares WHY via a predicate. Each decision is logged as a transparency event.
```typescript
memoryWhen.personSignal(signals)   // gates WHO.CT fetches
memoryWhen.projectSignal(signals)  // gates PLAN.PJ / WHAT.PJ fetches
memoryWhen.querySignal(signals)    // gates hybrid search / episodic reads
memoryWhen.check(gate, cond, sig, reason)  // ad-hoc gate with logging
```
`buildContext()` accepts an optional `signals?: IntakeSignals` 9th parameter.
When provided, persona injection is gated on `signals.personSignal != null` and
emits `memory_gate_opened` / `memory_gate_skipped` transparency events accordingly.

---

## 9. Skills System

**22 skills registered, all annotated with `permissionLevel`:**

| Level | Skills |
|-------|--------|
| `read-only` | calculator, file_reader, web_search, web_fetch, url_extract, memory_read, memory_history, content_writer, verify_state, grep_workspace, list_dir, glob, skill_schema, request_user_input |
| `workspace-write` | file_writer, patch_file, memory_write, relationship_write, generate_and_save_file, confirm_plan |
| `full-access` | run_bash, implement_and_test |

Registry is frozen at module load. `_unfreezeRegistry()` lifts for tests (without clearing built-ins).

**`generate_and_save_file`** is the preferred tool for single-file generation (HTML, JS, CSS).
Not deprecated. Single-tool approach has fewer failure points than content_writer → file_writer chain.

### CC-Adopted Safety Features (Sprint E — CC Parity)

**`file_writer` — read-before-write + mtime staleness guard:**
- Overwriting an existing file in-place requires that `file_reader` has read it first this session.
- If the file changed on disk since the last read, write is rejected: "File has been modified externally since last read."
- Partial reads (`offset`/`limit`) satisfy the registry but set `isPartial=true` — a partial read does NOT satisfy the guard for full overwrites.
- Auto-rename path (collision → new filename) is exempt — guard only applies when the file would be overwritten in-place.
- Append mode is always exempt.
- Registry: `_markFileRead(absolutePath, mtimeMs, isPartial)` / `_clearReadRegistry()` / `_getReadEntry()` exported from `file_writer.ts`.
- After a successful write, registry is updated with the new mtime so subsequent writes in the same session don't re-trigger.

**`file_reader` — offset/limit pagination:**
- New optional `offset` (1-based line number) and `limit` (max lines) params.
- Full read → `_markFileRead(path, mtime, isPartial=false)`.
- Paginated read → `_markFileRead(path, mtime, isPartial=true)`.
- Output includes pagination hint: `[Lines X–Y of Z. Use offset=N to read more.]`

**`run_bash` — description field (required) + expanded Zsh blocklist:**
- `description` is now a **required** field. Short human-readable label of what the command does.
- Surfaced in `display` field of SkillResult → shown in transparency/audit log.
- Blocklist expanded with CC's Zsh-specific bypass patterns: `<()` process substitution, `=cmd` Zsh equals expansion, `${…}` substitution, `zmodload`, `zpty`, `ztcp`, `zsocket`, `sysopen/syswrite/sysread`, `emulate -c`.
- All patterns checked per-line AND on full command text to prevent newline injection bypass.

**`glob` — offset pagination:**
- New optional `offset` param (0-based). Use with `max_results` to page through large result sets.
- Returns `{ files, truncated, total, offset }` — `total` is accurate count of all matches (up to 10,000 hard cap).

**`request_user_input` — options[] array:**
- New optional `options: string[]` param. List of multiple-choice labels (e.g. `["Yes", "No", "Skip"]`).
- Included in transparency event `user_input_requested.data.options`.
- Encoded into the `context` field for storage (no DB schema change needed).

**Test coverage:** `tests/skills/cc-adoptions.test.ts` — 22 tests covering all 5 features.

---

## 10. LLM + Model Runtime

**Default runtime (local-first):**
- `LLM_ENDPOINT` / `LLM_MODEL` → LM Studio (Gemma 4 26B primary)
- `LLM_FALLBACK_PROVIDER=gemini` with `LLM_FALLBACK_MODEL=gemini-2.5-flash`
- `PLANNER_MODEL` / `EXECUTOR_MODEL` track the same local model

**Cloud provider toggle (UI header):**
- `local` → LM Studio primary, Gemini fallback
- `cloud` → Gemini primary (or selected cloud model), LM Studio fallback

**Cloud model options (`server/ui-server.ts` `CloudModelId`):**
- `gemini` — Gemini 2.5 Flash
- `claude` — Claude Sonnet 4.6 (Anthropic)
- `gemma-4-26b` — Gemma 4 26B via Gemini API (`GOOGLE_API_KEY`)
- `gemma-4-31b` — Gemma 4 31B via Gemini API (`GOOGLE_API_KEY`)

Gemma models use the same Gemini OpenAI-compatible endpoint with a different model name.
`KNOWN_CLOUD_MODELS` exported from `config/agent.config.ts`.

**Timeouts (`getTimeoutForModel` in `config/agent.config.ts`):**

| Model pattern | Timeout |
|--------------|---------|
| 72b/70b/80b/35b/32b/26b/20b | 600,000ms |
| 7b/8b/13b/14b | 120,000ms |
| 1b/2b/3b/4b | 60,000ms |
| Default | 120,000ms |

---

## 11. Test Patterns

```typescript
// Always isolate DB + memory paths
(PATHS as Record<string, string>).db = path.join(tmpDir, 'test.sqlite');
(PATHS as Record<string, string>).memory = path.join(tmpDir, 'memory');

// Reset memory mode after tests that toggle it
afterEach(() => { _resetMemoryMode(); });

// Close DB to prevent "database is locked" across test files
afterEach(() => { closeDatabase(); });

// Registry freeze: unfreeze before registerSkill in tests
_unfreezeRegistry();

// Git cleanup: drain before rmSync
_resetGitInstance();
await new Promise(r => setTimeout(r, 100));

// FK constraint errors on DELETE: disable FKs first
db.pragma('foreign_keys = OFF');
```

**Pre-existing failures (not regressions):**
- `tests/phase3/agent.test.ts` — 1 test: "how do I" classified as 'general' not 'memory_query'
- `tests/phase13/decomposition.test.ts` — 3 tests (decomposition retry deferred)
- `tests/phase9/pipeline.test.ts` — 4 tests (legacy pipeline shape)
- `tests/phase13/rich-artifact-compatibility.test.ts` — 4 tests (legacy compat)
- Several more listed in CLAUDE.legacy.md

**Current baseline:** 1585/1610 tests pass (30 new tests from Context Diet sprint).

---

## 12. PLAN.EX Lifecycle

```
active / in_progress / paused  → resumable
complete / failed              → terminal (never resurface as active)
```

- `loadActivePlanEX()` excludes `status: 'complete'` and `status: 'failed'`
- Terminal plans written at every exit path in `executePlan()`
- After final completion: write WHEN.RF, update PLAN.PJ, extract durable facts

**When memory is disabled:** PLAN.EX is never written. Scratchpad substitutes for milestone tracking.

---

## 13. Transparency System

Every agent action emits a `TransparencyEvent` stamped with a `requestId` (UUID per `processMessage` call).

**Enable:** `TRANSPARENT=true npx tsx chat.ts`

**Key event types:** `plan`, `step_start`, `step_result`, `route`, `llm_request`, `llm_raw`, `memory_write`, `memory_disabled_drop`, `heartbeat_skipped_memory_disabled`, `coding_route_selected`, `context_mode_applied`, `user_constraints_extracted`, `user_input_requested`, `plan_confirmation_pending`, `decomposition_repair`, `prompt_budget`, `prompt_budget_exceeded`, `memory_gate_opened`, `memory_gate_skipped`, `span_start`, `span_end`, `orphan_span`

**UI:** Logs panel → `[Copy Trace]` for formatted text; `[Copy Details]` for full JSON envelopes (up to 2000 buffered in `window.__fullEnvelopes`).

---

## 14. Trace v2 — Hierarchical Span Tree (Sprint A)

Trace v2 adds a hierarchical span tree on top of the existing flat event stream. The flat stream is unchanged; spans are additive.

**Span events (added to `TransparencyEvent` union):**
- `span_start` — `{ spanId, parentSpanId?, label, ts }`
- `span_end` — `{ spanId, durationMs, status: 'ok'|'error'|'aborted' }`
- `orphan_span` — `{ label }` — defensive sentinel when a stage is called without a parent

**`core/transparency.ts` additions:**
```typescript
SpanContext          // { spanId, parentSpanId?, requestId, startedAt }
withSpan(label, parentCtx, requestId, fn)   // async span wrapper
withSpanSync(label, parentCtx, requestId, fn) // sync variant
truncate(s, n)      // single-line truncation for span labels
```

**Pipeline instrumentation:**
- `processMessage` → root span (no `parentSpanId`); label = `request: <truncated input>`
- `runIntake` → child span, label `Intake: extract signals`
- `decomposeMessage` → child span, label `Decomposition: split into units`
- `routeDecomposedUnits` → child span, label `Route: dispatch units`
- `runSimplePlan` → child span, label `SimplePlan: run steps`
- `decomposeTask` → child span, label `Planner: build milestone tree`
- `executePlan` → child span + per-milestone try/finally spans
- `executeSingleStep` → manual span around `runWithRetry`; label `Step: <skill>`
- `runQueryLoop` → child span + per-iteration try/finally spans; label `QueryLoop iter N`
- `runSkill` → manual span around `skill.execute`; label from `labelForSkill()`
- `callLLM` → child span; label `LLM: <model>`; data includes `prefixHash` (first 8 hex of SHA-256 of first 1024 chars of system+firstUser)

**`labelForSkill(skillName, input)` in `core/skills/runner.ts`:**
Deterministic label with first key argument: `path=`, `cmd=`, or `query=`. Falls back to skill name only.

**`TraceBuilder` in `server/ui-server.ts`:**
Server-side accumulator: ingests `span_start`/`span_end` envelopes and builds a `TraceNode` tree.
Resets on each new root span (new `processMessage` call).
Emits `trace_tree` WebSocket message when the root span ends.
Emits `span_event` WebSocket message for every `span_start`/`span_end`.

**WebSocket messages added:**
- `{ type: 'span_event', requestId, spanId, label, parentSpanId?, durationMs?, status? }`
- `{ type: 'trace_tree', requestId, root: TraceNode }`

**Tests:** `tests/sprint-a/` — 28 tests total (with-span: 9, root-span: 5, pipeline-spans: 8, trace-builder: 6). All pass.

---

## 15. Abort / Stop (Sprint C)

Users can stop an in-flight `processMessage` via the UI Stop button or `Esc` key.

**Flow:**
1. UI sends `{ type: 'stop_chat' }` over WebSocket
2. Server looks up the active request's `AbortController` (in `activeRequests` map) and calls `.abort()`
3. Server responds with `{ type: 'stop_ack', stopped: true }`
4. The signal propagates: `processMessage` → `callLLM` → `fetch()`, plus iteration-boundary checks in `runQueryLoop` / `executePlan` / `runSimplePlan` / `decomposeTask`
5. `withSpan` (Sprint A) catches `AbortError` and emits `span_end` with `status: 'aborted'`
6. UI receives `agent_reply { text: '[stopped]', intent: 'aborted' }` and trace tree closes

**`processMessage` signature:**
```typescript
processMessage(message, history, options?: { llmHandler?, signal?: AbortSignal })
```
Signal is wrapped into the `llmHandler` closure and passed as a separate param to pipeline functions.

**Abort propagation path:**
- `callLLM` — re-throws AbortError immediately (does not fall back to secondary provider)
- `callOpenAICompatibleProfile` — user signal merged into timeout AbortController via `addEventListener`
- `callAnthropicProfile` — signal passed directly to `fetch()`
- `runQueryLoop` — `signal?.aborted` check at top of every iteration
- `executePlan` — check before each milestone and each step
- `runSimplePlan` — check before each step
- `decomposeTask` — check before the LLM call

**`runSkill()` abort behavior:**
- Entry check: returns `{ success: false, error: 'aborted' }` immediately if signal already aborted
- Signal injected into `input.__signal` for skills that support it:
  - `run_bash` — kills entire process group via `process.kill(-(child.pid), 'SIGKILL')`
  - `web_fetch`, `web_search` — user signal merged into internal AbortController

**UI button states:**
- Idle: `Send` (btn-primary)
- Processing: `■ Stop` (btn-stop, clickable)
- Stopping: `Stopping…` (btn-stop, disabled) — until `agent_reply` arrives
- `Esc` while processing (and no panel open) triggers stop

**Server cleanup:** `activeRequests` map cleared on completion, `stop_ack`, or WS disconnect.

**Tests:** `tests/sprint-c/` — 20 tests total (abort-plumbing: 6, server-abort: 5, ui-stop: 7, abort-trace-integration: 2).

---

## 17. LM Studio Prefix Stability + Cache Visibility (Sprint D1)

Goal: maximize KV cache reuse in LM Studio (llama.cpp) by keeping the first N tokens byte-for-byte identical across requests.

**Key changes:**

**`core/context.ts`:**
- `buildStablePrelude(): string` — exports the `SYSTEM_PROMPT` constant (~500 stable tokens). Identical for every `processMessage` call. Used as cache anchor and for prefix hash computation.

**`core/prompt-budget.ts`:**
- `buildQueryLoopSystemPrompt()` now uses `query-loop-base.md` (no `{{goal}}` or `{{index_section}}`). System prompt is identical for all requests with the same permission mode.
- `buildQueryLoopContextBlock(ctx)` — new function assembling goal + memory index as a `<context>` block for the first user message.

**`prompts/query-loop-base.md`:** Stable base template (all instructions, skill list placeholder — no goal/index). `prompts/query-loop.md` retained for reference but no longer used at runtime.

**`core/query-loop.ts`:**
- `messages[0]` = stable system prompt (base instructions only, never mutated in loop).
- Goal and memory index injected as `<context>\n...\n</context>` prepended to the initial user message.
- Comment documents the append-only prefix invariant.

**`core/llm.ts`:**
- `OpenAICompatibleLLMProfile.providerKind?: 'lmstudio' | 'openai' | 'gemini' | 'other'` — new optional field.
- `detectProviderKind(endpoint)` — maps localhost/127.0.0.1 → `'lmstudio'`, googleapis → `'gemini'`, etc.
- `getPrimaryLLMProfile()` sets `providerKind` via `detectProviderKind`.
- `callOpenAICompatibleEndpoint()` sends `cache_prompt: true` in request body when `providerKind === 'lmstudio'`.
- `_seenPrefixHashes: Set<string>` — session-scoped seen-set; first occurrence = miss, subsequent = hit.
- `_resetSeenPrefixHashes()` — exported for test isolation.
- `llm_cache_metric` event emitted per LM Studio call: `{ prefixHash, hit, requestId, engine, stableTokens }`.

**`core/transparency.ts`:**
- New event: `llm_cache_metric` — `{ prefixHash: string; hit: boolean; requestId: string; engine: string; stableTokens: number }`.

**KV cache target achieved:**
- Query-loop: ~900 token stable prefix (base instructions + skill list) — cached across all requests with same permission mode.
- Conversational path (`buildContext`): `SYSTEM_PROMPT` (~500 tokens) — same content per session.

**Tests:** `tests/sprint-d1/` — 20 tests total (prefix-stability: 7, queryloop-prefix: 4, cache-prompt: 4, cache-metrics: 5). All pass.

---

## 16. Prompt Budget System

Per-engine token accounting and hard guardrails (Context Diet sprint, Batch 4).

**Assembly point:** `core/prompt-budget.ts` — all engines build prompts via typed context shapes.
No engine concatenates prompt parts directly.

**Key exports:**
```typescript
buildQueryLoopSystemPrompt(ctx: QueryLoopPromptContext): BuiltPrompt
buildPlannerSystemPrompt(ctx: PlannerPromptContext): BuiltPrompt
emitPromptBudget(t, built, engine, iteration?)   // emits prompt_budget + prompt_budget_exceeded
```

**`BuiltPrompt`** carries `{ text, tokenEstimate, sources[], promptId }`.
`sources` gives a per-component breakdown (e.g. `[{name: 'query-loop.md', tokens: 900}, {name: 'skill_list', tokens: 220}]`).

**Hard input limits (`PROMPT_INPUT_LIMITS` in `config/agent.config.ts`):**

| Engine | Limit |
|--------|-------|
| `query-loop` | 2,500 tokens |
| `planner` | 12,000 tokens |
| `decomposition` | 3,000 tokens |
| `intake` | 1,500 tokens |
| `router` | 4,000 tokens |

When a built prompt exceeds its engine limit, a `prompt_budget_exceeded` event fires with `{engine, totalTokens, limitTokens, overage}`.
Execution is NOT blocked — the event is a regression sentinel for tests.

**Context Diet sprint results (measured):**
- Query-loop skill list: 1,413 → ~220 tokens (84% reduction, one-liner list)
- Query-loop system prompt: ~2,713 → ~1,429 tokens (47% reduction)
- History collapse: iterations older than last 3 pairs collapsed to one-line summary

---

## Phase Index (summary — see CLAUDE.legacy.md for full detail)

| Tag | Sprint |
|-----|--------|
| `phase-11-lmstudio-validated` | Project Brain, Autonomous Execution, Meeting Mode |
| `phase-13-complete` | Decomposition-First Routing |
| `phase-15-stress-validated` | Stress Tests + Stability |
| `phase-16-complete` | QueryLoop, Pointer Index, AutoDream |
| `phase-17a-complete` | Security + Permission Layer |
| `permission-aware-planner-complete` | Permission-filtered planner context |
| `queryloop-efficiency-fixes` | QueryLoop single-file rules, MEMORY.md filtering |
| `phase-18-complete` | patch_file, grep_workspace, list_dir, coding route, context mode |
| `phase-18-retrieval-memory-complete` | Query retrieval fixes, listing fast-path |
| `phase-18G-complete` | Body templates, near-dedup, PLAN.EX terminal filter |
| `phase-19c-quick-resolve` | Pre-decomposition memory gate (code lookup + name search) |
| `phase-19e-who-ct-audit` | Identity routing, notebook scoping, output sanitization |
| `phase-20-simplify` | Listing query in quick-resolve gate |
| `phase-20b-intent-gate` | Command detection, context cap, intent-aware synthesis |
| `dvd-log-fixes-complete` | BM25 relevance gate, compound bypass, session cache dedup |
| `zaraban-sprint-1-complete` | LLM-driven confirm_plan, pending plan persistence |
| `phase-20-portfolio-audit-fixes` | Command guard, pre-dispatch validator, deprecation removal |
| `phase-20c-planner-contract` | Schema repair, prompt freshness, image acquisition guard |
| `log-fixes-complete` | Log analysis fixes (grounded verification, HOW.PR gate, etc.) |
| `log2-fixes-complete` | Fake-execution fix, content_writer context, session cache gate |
| `permission-aware-planner-complete` | Permission-filtered planner + failure-aware revision |
| `memory-toggle-collision-correlation-complete` | Memory toggle, collision handling, correlation IDs |
| `planner-xml-constraint-routing-complete` | JSON planner via tool_use, constraint extraction, user input skill |
| `memory-toggle-gemma4-logs-claudemd-complete` | Full memory toggle gating, Gemma 4 models, detailed log export |
| `context-diet-complete` | Token-efficient execution: one-liner skill list, prompt budget system, signal-gated memory reads, sliding history window, sub-agent primitive, complexity-scaled iteration caps, hard budget guardrails |
| `sprint-d1-prefix-cache-complete` | LM Studio KV cache prefix stability: stable system prompts, goal/index in user `<context>` block, `cache_prompt:true` in request bodies, `llm_cache_metric` events, session seen-set |
| `sprint-e-cc-parity-complete` | CC-adopted safety features: read-before-write + mtime guard (file_writer), offset/limit pagination (file_reader, glob), `description` required field + expanded Zsh blocklist (run_bash), options[] array (request_user_input) |
| `plan-step-limit-fix-complete` | Raised planner step cap 8→30, integrity-warning escalation to HIGH |
| `queryloop-webdownload-complete` | Multi-target web-download hardening: batch gather+download, file integrity check (200 KB floor), flipbook blocklist, direct-URL detection, context discipline rules |
| `queryloop-bash-split-complete` | Bash payload split (one run_bash per brand), json-repair circuit breaker (3-strike recovery injection), previous sprint Phase 2 rule corrected |
| `diag-formatter-complete` | Passive diagnostic formatter: compact .diag file per request (~300–500 tokens), subscribes to transparency bus, covers QueryLoop iters, milestones, repairs, token totals, errors. Replaces 10k–220k trace dumps for AI-assisted diagnosis. |
