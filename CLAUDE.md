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
| `runQueryLoop` | `taskType=coding`, LOW/MEDIUM pre-check, LOW/MEDIUM agentic coding | while-loop; model picks skills. Max 20 iterations. Circuit breaker. |
| `runSimplePlan` | LOW/MEDIUM agentic (non-coding) | Calls `decomposeTask`, runs steps sequentially. No PLAN.EX overhead. |
| `decomposeTask` + `executePlan` | HIGH/MAX agentic | Full milestone pipeline. Writes PLAN.EX. Post-flight synthesis. |

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

---

## 9. Skills System

**20 skills registered, all annotated with `permissionLevel`:**

| Level | Skills |
|-------|--------|
| `read-only` | calculator, file_reader, web_search, web_fetch, url_extract, memory_read, memory_history, content_writer, verify_state, grep_workspace, list_dir, glob |
| `workspace-write` | file_writer, patch_file, memory_write, relationship_write, generate_and_save_file, confirm_plan |
| `full-access` | run_bash, implement_and_test |

Registry is frozen at module load. `_unfreezeRegistry()` lifts for tests (without clearing built-ins).

**`generate_and_save_file`** is the preferred tool for single-file generation (HTML, JS, CSS).
Not deprecated. Single-tool approach has fewer failure points than content_writer → file_writer chain.

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

**Current baseline:** 1555/1580 tests pass.

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

**Key event types:** `plan`, `step_start`, `step_result`, `route`, `llm_request`, `llm_raw`, `memory_write`, `memory_disabled_drop`, `heartbeat_skipped_memory_disabled`, `coding_route_selected`, `context_mode_applied`, `user_constraints_extracted`, `user_input_requested`, `plan_confirmation_pending`, `decomposition_repair`

**UI:** Logs panel → `[Copy Trace]` for formatted text; `[Copy Details]` for full JSON envelopes (up to 2000 buffered in `window.__fullEnvelopes`).

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
