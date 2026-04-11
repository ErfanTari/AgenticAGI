# AgenticAGI — Ground-Truth System Description

> Derived exclusively from reading source files. Last verified: 2026-04-11.
> Files read: core/agent.ts, core/router.ts, core/planner.ts, core/memory/quick-resolve.ts,
> core/memory/index.ts, core/skills/registry.ts, config/agent.config.ts, core/transparency.ts,
> core/decomposition.ts, core/intake.ts, core/types.ts, core/operators/resume.ts,
> core/memory/pointer-index.ts, core/memory/unit-search.ts, core/memory/session-cache.ts

---

## processMessage() — Actual Execution Order (`core/agent.ts`)

```
[0]  Pending confirmation intercept
     → if pendingConfirmationPlan exists, call confirm_plan skill → approve/reject/unclear

[1]  /log fast-path
     → regex /^\/log\s+/i → direct NOW.LOG write, return

[2]  /meeting fast-path
     → regex /^\/meeting\b/i → import('./meeting.ts').runMeetingMode(), return

[3]  Quick complexity pre-check (agentic-only fast path)
     → skipped if: likely compound, compound entity creation, greeting, question,
       matches skill/memory-write/query compatibility classifiers
     → assessComplexity() → if LOW or MEDIUM: runQueryLoop() directly, return
     → if HIGH/MAX: fall through

[4]  Quick-resolve gate (deterministic, no LLM)
     → skipped if message has relationship intent (extractRelation() !== undefined)
     → quickResolve(message) → 4 strategies (code, identity, listing, name search)
     → if resolved: single LLM synthesis call → return

[5]  Pre-decomposition action skill fast-path (FIX-T5)
     → matches file_writer or run_bash patterns
     → buildSkillCompatibilityClassification() + handleCompatibilityExecution()
     → if handled: return

[6]  Intake (LLM call)
     → runIntake() → IntakeSignals (personSignal, projectSignal, timeSignal,
       agenticSignal, querySignal, procedureSignal)

[7]  Decomposition (LLM call)
     → decomposeMessage() → DecompositionResult { units[] }
     → each unit: { id, route: conversational|agentic|query, content, order, taskType? }

[8]  Compatibility classification (single-unit shim)
     → buildSingleUnitCompatibilityClassification()
     → if skill or memory_write intent: handleCompatibilityExecution() → return if handled
     → if memory_query / relationship_query / code_fetch: handleCompatibilityExecution()

[9]  Unit memory search (parallel, signal-scoped)
     → searchMemoryForUnits(units, db, intakeSignals)

[10] Working memory load/create (agentic units only)

[11] routeDecomposedUnits(units, memoryResults, history, llmHandler, workingMemory)
     → conversational → batched LLM call
     → query → direct retrieval + hybrid fallback
     → agentic → complexity → queryLoop or planner+executor

[12] Return AgentResponse
```

---

## Router — Actual Routes (`core/router.ts`)

### `routeDecomposedUnits()`

Filters units into three buckets:
- `conversational` → `handleConversationalUnits()` → single LLM call
- `query` → `handleQueryUnits()` → direct retrieval; if confidence=0, `hybridSearch()`
- `agentic` → `handleAgenticUnits()`

After conversational reply: `persistFactualAssertions()` — fire-and-forget non-blocking upsert of factual claims inferred from the conversation (runs async via `memoryAgent`).

### `handleAgenticUnits()` routing decision

```
1. any unit has taskType === 'coding'?
   → emit coding_route_selected → runQueryLoop()

2. call assessComplexity()
   LOW / MEDIUM   → runSimplePlan() (calls decomposeTask then runs steps sequentially,
                    no milestone overhead, no PLAN.EX, no verification LLM call)
   HIGH / MAX     → decomposeTask() + executePlan() (full milestone pipeline)
   unknown value  → default to LOW (defensive guard, emits warning)
```

Note: `runSimplePlan` ≠ `runQueryLoop`. `runSimplePlan` is a sequential step runner over a planner-generated plan. `runQueryLoop` is the iterative while-loop engine where the model decides each step.

### `executeConfirmedPlan()` (exported)

Called when a pending confirmation is approved. Runs `executePlan()` directly.

---

## Complexity Assessment — Actual Heuristics (`core/planner.ts`)

`assessComplexity(message, classification, llmHandler?)` returns `ComplexityLevel`:

### Step 1: FORCE_HIGH patterns (immediate HIGH, short-circuit)

| Signal | Pattern matches |
|--------|----------------|
| `gameDev` | game, arcade, platformer, shooter, rpg, beat-em-up, sprite, hitbox, collision detection, tile map, enemy ai... |
| `appDev` | web app, mobile app, desktop app, SPA, PWA, full-stack, REST API, GraphQL API, dashboard, admin panel, e-commerce... |
| `scaffolding` | scaffold, boilerplate, starter kit/project/template, monorepo, microservice |
| `rendering` | canvas API, WebGL, Three.js, animation loop, requestAnimationFrame, shader, particle system, 2D/3D engine |

### Step 2: Generation + artifact → MEDIUM

`GENERATION_VERBS` (`build|create|generate|simulation|app|tool|game|make|write|develop`) AND `OUTPUT_SIGNALS` (`html|css|javascript|code|file|page|website|script|component|program|application`) → `MEDIUM`

### Step 3: Heuristic signal count

Counts matches from `COMPLEXITY_SIGNALS`:
- `multiStep`, `multiFile`, `fileAndRun`, `researchTask`, `loopSignal`, `multiAction`, `webBrowseTask`, `downloadTask`, `doFollowing`, `numberedList`

Thresholds:
- 0 signals → LOW
- 1–2 signals → MEDIUM
- 3–4 signals → HIGH
- 5+ signals → MAX

### Legacy value coercion (after planner LLM call)

`"simple"` → `"LOW"`, `"complex"` → `"MEDIUM"`. Unknown values default to `LOW` with console warning.

### Plan-derived complexity fallback

If planner LLM returns no complexity: `derivePlanComplexity(stepCount)`:
- ≤2 steps → LOW
- ≤4 steps → MEDIUM
- ≤6 steps → HIGH
- 7+ steps → MAX

### MAX always requires confirmation

`shouldRequireConfirmation()` returns `true` for MAX complexity regardless of step content.

---

## Quick-Resolve — Actual Strategies (`core/memory/quick-resolve.ts`)

`quickResolve(message)` — called after pre-complexity check, before intake.

Skipped entirely if `extractRelation(message) !== undefined` (relationship intent detected in `agent.ts`).

### Strategy 1: Code lookup

Regex extracts memory codes including suffixed codes (`WHO.CT-000076_zaraban` → `WHO.CT-000076`). Fetches entries by code from SQLite. Returns `isCommand: true` if `isCommandIntent()` is true.

### Strategy 1.5: Identity question (if not command)

`extractIdentityTarget()` detects "who is X", "what is X", "tell me about X", "what does X do". Strips embedded codes from target. Queries WHO notebook first, then all notebooks.

### Strategy 2: Listing query (if not command)

`detectListingQuery()` detects listing language + vocabulary (contacts, projects, todos, procedures, events, etc.). Returns `{ nb, type }` → `queryEntries({ nb, type, status: 'active' })`. Zero results is valid (answers "you have no contacts"). Returns `isCommand: false`.

### Strategy 3: Name search (if not command)

`extractSearchTerms()` — quoted strings, capitalized phrases, non-stopword tokens. `queryEntries({ name: term })`. **Skip if term matches >10 entries** (context-cap guard).

### Command intent detection (`isCommandIntent()`)

Returns true for:
- Bare imperatives: `write|create|build|make|run|fix|add|generate|implement|develop|set up|configure|deploy|execute|launch|update|modify|delete|remove|rename|move|merge|refactor|test|compile|start|stop|install|upload|download|send|scan|check|debug|optimize|convert|export|import|format|validate|analyze|extract|parse|process|calculate`
- Polite commands: `(can you|please|could you|would you|I need you to|I want you to)\s+(write|create|build|...)`

---

## SQLite Schema — Actual Tables (`core/memory/index.ts`)

### `index_entries` (core DDL)

```sql
code      TEXT PRIMARY KEY
nb        TEXT NOT NULL
type      TEXT NOT NULL
name      TEXT NOT NULL
status    TEXT NOT NULL
updated   TEXT NOT NULL
summary   TEXT
path      TEXT NOT NULL
due_date  TEXT   -- migration-added
```

Unique index: `(nb, type, LOWER(name)) WHERE status != 'archived'`

Indexes: `idx_nb`, `idx_type`, `idx_status`

### Migration-added columns (added idempotently via ALTER TABLE)

Phase 11:
```
importance_score   REAL DEFAULT 0.5
utility_score      REAL DEFAULT 1.0
usage_count        INTEGER DEFAULT 0
last_accessed      TEXT
decay_rate         REAL DEFAULT 0.1
active_page        INTEGER DEFAULT 1
pinned             INTEGER DEFAULT 0
privacy_tier       TEXT DEFAULT 'MIXED'
source             TEXT DEFAULT 'user'
confidence         REAL DEFAULT 1.0
atomic_facts       TEXT
embedding          BLOB
```

Phase 15:
```
ttl_days           INTEGER
fingerprint        TEXT
project_brain_cache TEXT
```

Phase 11 indexes: `idx_importance`, `idx_active_page`, `idx_privacy`

### `relationships`

```sql
from_code  TEXT NOT NULL
relation   TEXT NOT NULL
to_code    TEXT NOT NULL
note       TEXT
created    TEXT NOT NULL
strength   REAL DEFAULT 1.0   -- migration-added
last_active TEXT              -- migration-added
FOREIGN KEY (from_code) REFERENCES index_entries(code)
FOREIGN KEY (to_code)   REFERENCES index_entries(code)
```

Indexes: `idx_from`, `idx_to`

### `counters`

```sql
type    TEXT PRIMARY KEY
current INTEGER NOT NULL DEFAULT 0
```

### `settings`

```sql
key   TEXT PRIMARY KEY
value TEXT NOT NULL
```

### `heartbeat_queue`

```sql
id       INTEGER PRIMARY KEY AUTOINCREMENT
code     TEXT NOT NULL
message  TEXT NOT NULL
seen     INTEGER DEFAULT 0
created  TEXT NOT NULL
```

### `pending_plans`

```sql
id         INTEGER PRIMARY KEY CHECK (id = 1)
plan_json  TEXT NOT NULL
created_at TEXT NOT NULL
```

### Additional tables

- `fts_content` (FTS5) — full-text search over memory entry bodies
- `chunks` — vector embeddings per content chunk

---

## Registered Skills — Actual List (`core/skills/registry.ts`)

20 skills registered at module load, registry frozen after last registration:

| Name | Permission Level |
|------|-----------------|
| `calculator` | read-only |
| `file_reader` | read-only |
| `web_search` | read-only |
| `file_writer` | workspace-write |
| `run_bash` | full-access |
| `memory_read` | read-only |
| `memory_write` | workspace-write |
| `content_writer` | read-only |
| `web_fetch` | read-only |
| `url_extract` | read-only |
| `relationship_write` | workspace-write |
| `implement_and_test` | full-access |
| `memory_history` | read-only |
| `verify_state` | read-only |
| `generate_and_save_file` | workspace-write |
| `patch_file` | workspace-write |
| `grep_workspace` | read-only |
| `list_dir` | read-only |
| `glob` | read-only |
| `confirm_plan` | workspace-write |

Permission hierarchy: `read-only` < `workspace-write` < `full-access`.
`PERMISSION_MODE` env var (default: `workspace-write`). Skills above the active level are hidden from planner/queryLoop prompts.

---

## Configuration — Actual Values (`config/agent.config.ts`)

### Model timeouts (`getTimeoutForModel`)

| Model size match | Timeout |
|-----------------|---------|
| `72b|70b|80b|35b|32b|26b|20b` | 600,000ms (10 min) |
| `7b|8b|13b|14b` | 120,000ms (2 min) |
| `1b|2b|3b|4b` | 60,000ms (1 min) |
| Default | 120,000ms (2 min) |

### INTAKE_TIMEOUT_MS

`120,000ms` (separate from model timeout; for intake classification calls).

### PATHS

```
root      → process.cwd()
memory    → {root}/memory
index     → {root}/index
db        → {root}/index/memory.sqlite
workspace → {root}/workspace
logs      → {root}/workspace/logs
projects  → {root}/memory/PLAN/projects
```

### TYPE_MAP (20 entries)

```
WHO.CT WHO.ORG
WHAT.PJ WHAT.KN
WHEN.CA WHEN.DL WHEN.EV WHEN.RF WHEN.HX
HOW.PR HOW.SK
WHY.MT WHY.QU
NOW.TD NOW.RP NOW.LOG
PLAN.PL PLAN.EX PLAN.CT PLAN.MS PLAN.PJ
```

### TOKEN_BUDGETS (14 keys)

```
INTAKE                  600
DECOMPOSITION          2000
PLANNER                8192
QUERY_LOOP_ITER        4096
CONTENT_WRITER_HTML   16000
(plus 9 others)
```

---

## Transparency Events — Actual Types (`core/transparency.ts`)

Full union of event type strings (85+ events). Selected important ones:

```
llm_request  llm_raw  llm_stripped
intake  intake_signals
decomposition  decomposition_retry  decomposition_repair
unit_memory_search  unit_search_filtered  memory_context_filtered
plan  planner_reasoning  plan_integrity_warning  plan_image_warning  plan_repair_truncation
step_start  step_result
milestone_start  milestone_result  milestone_revised  milestone_memory_cycle  milestone_revision_skipped
post_flight_complete  verification_snapshot  how_pr_skipped
route  coding_route_selected  context_mode_applied
query_loop_start  query_loop_iteration  query_loop_narration  query_loop_skill_call  query_loop_skill_result  query_loop_end
session_cache_hit  session_cache_miss  session_cache_store  session_cache_skip
working_memory_created  working_memory_loaded  working_memory_updated  working_memory_archived
plan_confirmation_pending  plan_confirmed  plan_rejected  plan_confirmation_ambiguous
memory_write  memory_query  context_built  context_compacted
project_brain  project_brain_hit  project_brain_miss  project_brain_rebuilt  project_brain_invalidated
failure_classified  saga_rollback  linker_pass  project_transition  meeting_complete
startup_prefetch  startup_prefetch_error  context_lazy_loaded
list_intent_detected  continuation_context_loaded
```

---

## MEMORY.md — Actual Format (`core/memory/pointer-index.ts`)

Two sections, written atomically via tmp+rename:

```markdown
# Memory Index
# Auto-maintained. Edit with caution.

## Active loops
PLAN.EX-000031: HackerNews API · M3/6 · next→ Express server · files: [src/cache.js]

## Known entries
WHO.CT-000024: Erfan Tari — owner, developer
```

**Active loops** (max 5, FIFO eviction when over limit):
- Written by `executePlan()` at start (`M0/N`)
- Updated after each successful milestone (increment counter, update next title, append files)
- Removed by `removeActiveLoop()` at plan terminal state
- File paths extracted from step outputs via regex `workspace/\S+\.\w+`; capped at 6 files

**Known entries** (max 200, sorted by `lastActive` descending, LRU eviction):
- Updated by `upsertPointerEntry()` on every memory write

**Filtering for QueryLoop:** `filterPointerIndex(fullIndex, goal, maxEntries=15)` — scores by goal keyword overlap, fills remaining slots with most recent entries.

---

## Resume Path — Actual Order (`core/operators/resume.ts`)

`selectResumablePlan(nameOrCode?)`:

1. `loadPendingPlan()` from SQLite `pending_plans` table — returns synthetic `PENDING` code
2. `parseActiveLoopEntries(loadPointerIndex())` — parse MEMORY.md active loops, filter `!done`, match by code/name substring; most recently added entry used when no nameOrCode given
3. `findResumablePlans()` — SQLite query for `PLAN.EX` where `status IN ('paused', 'in_progress', 'active')`, ordered by `updated DESC`, limit 10

---

## Intent Types — Actual (`core/types.ts`)

```typescript
type Intent =
  | 'greeting'
  | 'code_fetch'
  | 'memory_query'
  | 'synthesis_query'
  | 'relationship_query'
  | 'relationship_write'
  | 'memory_write'
  | 'web_search'
  | 'skill'
  | 'planned_workflow'
  | 'episodic_query'
  | 'meeting'
  | 'general'
```

---

## Unit Search Strategies — Actual (`core/types.ts`)

```typescript
type UnitSearchStrategy =
  | 'person'
  | 'project'
  | 'time'
  | 'procedure'
  | 'type_scan'
  | 'list_intent'
  | 'bm25'
  | 'bm25_person_scoped'
  | 'bm25_project_scoped'
  | 'vector_fallback'
```

BM25 fallback has a relevance gate (`hasMeaningfulOverlap`): at least one non-stopword from the query must appear in the entry name or summary. Results with no overlap are dropped; if all results are dropped, confidence returns 0.

---

## Compatibility Shim — Actual Behavior (`core/agent.ts`)

A single-unit compatibility path still exists for simple direct-tool cases. It runs **after** decomposition (not instead of it), using the decomposition result to inform a `buildSingleUnitCompatibilityClassification()` call.

Handled intents via shim:
- `skill` (direct skill call: web_search, calculator, file_reader, etc.)
- `memory_write` (direct upsert)
- `memory_query` (direct retrieval)
- `relationship_query` (relationship table lookup)
- `code_fetch` (direct code fetch)

Skill outputs for read-only skills (`web_search`, `calculator`, `file_reader`, `memory_read`, `web_fetch`, `url_extract`) are returned directly without a second LLM call (deterministic output path).

---

## Session Cache — Actual Behavior (`core/memory/session-cache.ts`)

In-memory cache (per request lifecycle). Two indexes: code → entry, name → entry.

**`set()` dedup guard:** If code already cached with same `updated` timestamp, skip write and event — prevents churn stores on warm cache hits within a request.

**Terminal PLAN.EX filter:** `set()` rejects entries where `nb='PLAN'`, `type='EX'`, `status ∈ {complete, failed}`. Emits `session_cache_skip` transparency event.

---

## Executor — Actual PLAN.EX + MEMORY.md Integration

`executePlan()` (`core/executor.ts`):

1. `createPlanEX()` → write initial PLAN.EX entry
2. `upsertActiveLoop({ code, taskName, mCurrent: 0, mTotal, nextTitle, files: [] })` → MEMORY.md
3. Per milestone success:
   - `savePlanEX()` (via `writeMilestoneMemoryCycle`)
   - `upsertActiveLoop(...)` with updated mCurrent, nextTitle, files extracted from step outputs
4. Reactive milestone revision: **only fires if milestone had failures OR suspicious output** (output <50 chars depended on by future steps). Skipped on happy path.
5. Terminal (complete/failed/paused): `removeActiveLoop(planExCode)`; `savePlanEX()` with terminal status; post-flight synthesis (single LLM call: verification + summary + reflection).

Auto-read prerequisite: `enforceFileReaderPrerequisite()` inserts a `file_reader` step before any `generate_and_save_file` step targeting an existing workspace file. The inserted step is now also added to the correct milestone's `steps[]` array (not just `plan.steps`).
