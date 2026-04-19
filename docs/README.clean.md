# AgenticAGI — System Documentation

A local-first AI agent platform with structured memory, decomposition-first routing, and a multi-strategy execution engine.

---

## Architecture Overview

```
User message
  │
  ├─ [0] Pending plan confirmation intercept
  ├─ [1] Fast-path bypasses  (/log, /meeting, direct code fetch)
  ├─ [2] Pre-fetch gate      (quickResolve — deterministic, no LLM)
  │       → Code lookup → Identity question → Listing query → Name search
  │       → If resolved: single LLM synthesis → return
  │
  ├─ [3] Full pipeline
  │       → Intake (LLM signals: person / project / time / intent)
  │       → Decomposition (semantic units, retry on under-split)
  │       → Unit memory search (parallel, signal-scoped)
  │       → Route by unit type
  │           conversational → batched LLM reply
  │           query          → direct retrieval, hybrid fallback
  │           agentic        → complexity assessment → executor
  │               LOW/MEDIUM → QueryLoop (iterative, model-driven)
  │               HIGH/MAX   → Planner + Executor (milestone pipeline)
  └─ Sanitize output → return
```

---

## Core Philosophy

- **Files are canonical, SQLite is derived.** All authoritative content lives in markdown files. SQLite holds metadata and a full-text search index. Write order is always file first, then SQLite.
- **Index first, fetch second, search last.** Known codes are fetched directly. SQLite answers simple queries without file reads. BM25/vector search is the last resort.
- **Codes are the universal language.** Every memory entry has a unique code (`WHO.CT-000024`) that serves as a stable reference across files, SQLite, and LLM prompts.
- **Skills earn their place.** Agentic execution calls only the skills selected by the plan. Conversational and query paths load no skills.

---

## Code System

Every memory entry has a universal code:

```
[NOTEBOOK].[TYPE]-[NUMBER]
```

| Notebook | Type | Meaning         |
|----------|------|-----------------|
| WHO      | CT   | Contact         |
| WHO      | ORG  | Organization    |
| WHAT     | KN   | Knowledge entry |
| WHAT     | PJ   | Project entry (legacy; new projects use PLAN.PJ) |
| WHEN     | CA   | Calendar event  |
| WHEN     | DL   | Deadline        |
| WHEN     | EV   | Episodic event  |
| WHEN     | RF   | Reflection      |
| WHEN     | HX   | History entry   |
| HOW      | PR   | Procedure       |
| HOW      | SK   | Skill entry     |
| WHY      | MT   | Meta reflection |
| WHY      | QU   | Open question   |
| NOW      | TD   | Todo item       |
| NOW      | RP   | Report          |
| NOW      | LOG  | Log / pointer (status: logged) |
| PLAN     | PL   | Planning entry  |
| PLAN     | EX   | Execution state |
| PLAN     | CT   | Constraint      |
| PLAN     | MS   | Milestone       |
| PLAN     | PJ   | Project brain   |

Codes are sequential, never reused, generated atomically via SQLite counters.

---

## SQLite Schema

Database at `index/memory.sqlite`. Tables:

### `index_entries` (primary)

```sql
code      TEXT PRIMARY KEY
nb        TEXT NOT NULL          -- notebook (WHO, WHAT, WHEN, HOW, WHY, NOW, PLAN)
type      TEXT NOT NULL          -- entry type (CT, KN, EV, ...)
name      TEXT NOT NULL
status    TEXT NOT NULL          -- active | archived | open | closed | upcoming | logged
updated   TEXT NOT NULL          -- ISO date
summary   TEXT
path      TEXT NOT NULL          -- full path to markdown file
due_date  TEXT                   -- ISO date (deadlines, plans)

-- Lifecycle columns (migration-added)
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
ttl_days           INTEGER
fingerprint        TEXT
project_brain_cache TEXT
```

Unique constraint: `(nb, type, LOWER(name))` where `status != 'archived'`.

### `relationships`

```sql
from_code  TEXT NOT NULL
relation   TEXT NOT NULL
to_code    TEXT NOT NULL
note       TEXT
created    TEXT NOT NULL
strength   REAL DEFAULT 1.0
last_active TEXT
FOREIGN KEY (from_code) REFERENCES index_entries(code)
FOREIGN KEY (to_code)   REFERENCES index_entries(code)
```

### `counters`

```sql
type    TEXT PRIMARY KEY    -- e.g. "WHO.CT"
current INTEGER NOT NULL DEFAULT 0
```

### `settings`

```sql
key   TEXT PRIMARY KEY
value TEXT NOT NULL
```

Used for embedding model hash (migration detection) and other singleton values.

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
id         INTEGER PRIMARY KEY CHECK (id = 1)   -- singleton row
plan_json  TEXT NOT NULL
created_at TEXT NOT NULL
```

### FTS5 (`fts_content`) and `chunks` tables

Created by `initFTS()` and `initChunksTable()`. FTS5 holds tokenized body content for full-text search. `chunks` holds vector embeddings per content chunk.

---

## Markdown File Format

```markdown
---
code: WHO.CT-000024
nb: WHO
type: CT
name: Erfan Tari
status: active
updated: 2026-02-19
summary: Owner, developer
---

# Erfan Tari

Body content here.
```

Write order: markdown file first, SQLite second. If SQLite write fails, roll back the file.

---

## MEMORY.md — Two-Zone Index

`memory/MEMORY.md` is always loaded into the QueryLoop system prompt. It has two sections:

```markdown
## Active loops
PLAN.EX-000031: HackerNews API · M3/6 · next→ Express server · files: [src/cache.js]

## Known entries
WHO.CT-000024: Erfan Tari — owner, developer
PLAN.PJ-000003: Activation X-Ray — interpretability research, active
```

**Active loops** (max 5): Written at plan start, updated after each milestone, removed at terminal state. Provides the QueryLoop its task-state anchor without needing to re-read all memory.

**Known entries** (max 200, LRU eviction): Standard factual index. Goal-filtered before injection into QueryLoop prompts.

---

## Memory Query Flow

Follow this order strictly. Do not skip steps.

```
1. Code known?
   → YES: fetch file directly by path from SQLite. Done.

2. SQLite can answer without file open?
   (e.g. "show active projects" → WHERE nb='PLAN' AND type='PJ' AND status='active')
   → YES: query index_entries, return names + summaries. Done.

3. Relationship table can answer?
   → YES: query relationships, follow codes. Done.

4. Index name match?
   → YES: return match, fetch file if needed. Done.

5. Hybrid search (BM25 + vector) — LAST RESORT ONLY
   Scope to correct notebook when possible.
```

---

## Routing

### Fast-path bypasses (no LLM, no decomposition)

| Pattern | Handler |
|---------|---------|
| `/log ...` | Direct `NOW.LOG` write |
| `/meeting` | Meeting Mode (`core/meeting.ts`) |
| Direct code (e.g. `WHO.CT-000001`) | Code fetch |

### Pre-fetch gate (`core/memory/quick-resolve.ts`)

Deterministic strategies in priority order — all skip the LLM decomposition call:

1. **Code lookup** — regex extracts memory codes (including suffixed: `WHO.CT-000076_zaraban`)
2. **Identity question** — detects "who is X", "what is X", "tell me about X" → WHO-first search
3. **Listing query** — detects "show all contacts", "list projects" → type-scan via `queryEntries`
4. **Name search** — capitalized phrases / quoted strings → `queryEntries` by name (skips if >10 results to prevent broad-term flooding)

Command-intent messages (`isCommandIntent()`) bypass name search and listing strategies; code lookup still fires. Modification commands with codes fall through to the full pipeline.

### Full pipeline routing

After intake and decomposition, units are routed by type:

| Unit type | Handler |
|-----------|---------|
| `conversational` | Single batched LLM call with history + memory context |
| `query` | Direct retrieval; hybrid search fallback if confidence = 0 |
| `agentic` | Complexity assessment → LOW/MEDIUM → QueryLoop, HIGH/MAX → Planner+Executor |

Coding units (`taskType === 'coding'`) route to QueryLoop regardless of complexity level.

---

## Complexity Assessment (`core/planner.ts`)

`assessComplexity()` returns `ComplexityLevel`: `LOW | MEDIUM | HIGH | MAX`.

Key heuristics (in order):
- MAX complexity: explicit multi-agent or system-level tasks
- HIGH: large file generation + multiple artifacts, multi-milestone signals
- MEDIUM: generation + artifact target (single-file creation)
- LOW: simple single-step tasks

After planner LLM call, legacy values are coerced: `"simple"` → `"LOW"`, `"complex"` → `"MEDIUM"`. Unknown values default to `LOW`.

MAX complexity plans always require user confirmation before execution.

---

## Execution Paths

### QueryLoop (`core/query-loop.ts`)

For LOW/MEDIUM complexity. Model-driven `while(true)` loop:

1. Build messages: system prompt + task state anchor (active loops) + goal-filtered MEMORY.md + last 2 history turns + goal block
2. Call LLM → extract first JSON with `"action"` key
3. Execute skill via `runWithRetry`
4. Append result + goal reminder → repeat

Safety limits:
- MAX_ITERATIONS: 20
- Circuit breaker: 3 consecutive identical failures per `skillName:inputHash` trips the breaker
- Pre-dispatch validation for `generate_and_save_file`: rejects contradictory payloads, verifies `spec_code` exists before dispatch
- Post-write verification via `verify_state` after file generation

### Planner + Executor (`core/planner.ts` + `core/executor.ts`)

For HIGH/MAX complexity. Upfront milestone-based plan:

1. `decomposeTask()` → structured `TaskPlan` with milestones and steps
2. `executePlan()` → iterates milestones → runs steps via `runWithRetry`
3. After each milestone: update PLAN.EX + update MEMORY.md active loop entry
4. Reactive revision: `reviseRemainingMilestones()` only fires when a milestone had failures or suspicious output (skipped on happy path)
5. Post-flight synthesis: single LLM call returning verification + summary + reflection

Auto-read prerequisite: if a `generate_and_save_file` step targets an existing file, a `file_reader` step is automatically inserted before it and added to the same milestone.

---

## Plan Persistence (`PLAN.EX`)

`PLAN.EX` is the persisted execution state for planned work.

- Statuses: `active` / `in_progress` / `paused` (resumable) | `complete` / `failed` (terminal, never resurface)
- Written to both SQLite and markdown frontmatter
- MEMORY.md active loops section is the more reliable source for resume — it uses atomic file writes that survive hard kills

### Resume path (`/resume`)

1. Check `pending_plans` SQLite table (pending confirmation)
2. Parse `## Active loops` in MEMORY.md — includes milestone position (`M3/6`)
3. Fallback: query SQLite for active PLAN.EX entries

---

## Skills System

20 skills registered at startup. Registry is frozen after boot — `registerSkill()` silently ignores post-freeze calls.

| Skill | Permission | Description |
|-------|-----------|-------------|
| `calculator` | read-only | Math evaluation via mathjs |
| `file_reader` | read-only | Read file from workspace |
| `web_search` | read-only | DuckDuckGo instant answer |
| `web_fetch` | read-only | Fetch URL content |
| `url_extract` | read-only | Extract content from URL |
| `memory_read` | read-only | Fetch memory entries by code or query |
| `memory_history` | read-only | Git history / rollback for memory entries |
| `content_writer` | read-only | LLM-based content generation (html/markdown/plain/code formats) |
| `verify_state` | read-only | Validate file_write / memory_write outcomes |
| `grep_workspace` | read-only | Recursive text search across workspace |
| `list_dir` | read-only | List directory contents |
| `glob` | read-only | Glob pattern file matching |
| `file_writer` | workspace-write | Write file to workspace (auto-creates parent dirs) |
| `patch_file` | workspace-write | Search-and-replace patch on a workspace file |
| `memory_write` | workspace-write | Create or update memory entries |
| `relationship_write` | workspace-write | Write relationships between memory entries |
| `generate_and_save_file` | workspace-write | Generate complete file from specification and save |
| `confirm_plan` | workspace-write | LLM-driven plan confirmation (approve/reject/unclear) |
| `implement_and_test` | full-access | Code generation + test execution + repair loop |
| `run_bash` | full-access | Execute shell commands |

Permission levels (ordered): `read-only` < `workspace-write` < `full-access`. Active permission mode from `PERMISSION_MODE` env var (default: `workspace-write`). Planner and QueryLoop prompts only list skills allowed by the current mode.

---

## Memory Write Rules

- **File first, SQLite second.** Failed SQLite writes roll back the file.
- **Dedup:** `upsertEntry()` checks for existing `(nb, type, name)` before creating.
  - `WHO.CT`: fingerprint-based dedup (email, phone, handle)
  - `WHAT.KN`: near-duplicate prevention via Jaccard word overlap
- **Append-only types** (never similarity-checked): `NOW.LOG`, `WHEN.EV`, `WHEN.RF`, `PLAN.EX`, `WHEN.HX`, `NOW.RP`
- **Status defaults:** `NOW.LOG` entries default to `status: logged` (not `active`)
- Git-backed versioning: every memory write commits to a git repo in `memory/`

---

## Configuration

### Paths (`PATHS`)

```
root      → project root
memory    → memory/
index     → index/
db        → index/memory.sqlite
workspace → workspace/
logs      → workspace/logs/
projects  → memory/PLAN/projects/
```

### Model timeouts (`getTimeoutForModel`)

| Model size | Timeout |
|------------|---------|
| 70B+ / 35B / 26B / 20B | 600s (10 min) |
| 7B–14B | 120s (2 min) |
| 1B–4B | 60s (1 min) |
| Default | 120s (2 min) |

### Token budgets (`TOKEN_BUDGETS`)

| Key | Tokens |
|-----|--------|
| INTAKE | 600 |
| DECOMPOSITION | 2000 |
| PLANNER | 8192 |
| QUERY_LOOP_ITER | 4096 |
| CONTENT_WRITER_HTML | 16000 |
| (+ 9 more) | — |

### Environment variables

```
LLM_ENDPOINT         Primary LLM (OpenAI-compatible)
LLM_MODEL            Primary model name
PLANNER_MODEL        Model for planning calls
EXECUTOR_MODEL       Model for executor calls
LLM_FALLBACK_PROVIDER  e.g. gemini
LLM_FALLBACK_MODEL     e.g. gemini-2.5-flash
PERMISSION_MODE      read-only | workspace-write | full-access (default: workspace-write)
TRANSPARENT          true → enable transparency bus output
DEBUG_PLANNER        true → log planner debug output
MEMORY_DISTILLER     1 → enable heartbeat distiller pass
EMBEDDING_MODEL      local embedding model name
```

---

## Transparency System

`core/transparency.ts` exports a singleton `TransparencyBus`. Enable with `TRANSPARENT=true`.

Key event categories:
- **LLM:** `llm_request`, `llm_raw`, `llm_stripped`
- **Pipeline:** `intake`, `intake_signals`, `decomposition`, `decomposition_retry`, `decomposition_repair`
- **Memory:** `memory_write`, `memory_query`, `context_built`, `unit_memory_search`, `unit_search_filtered`, `memory_context_filtered`
- **Planning:** `plan`, `planner_reasoning`, `plan_integrity_warning`, `plan_image_warning`, `plan_repair_truncation`
- **Execution:** `step_start`, `step_result`, `milestone_start`, `milestone_result`, `milestone_revision_skipped`, `post_flight_complete`
- **Routing:** `route`, `coding_route_selected`, `context_mode_applied`
- **QueryLoop:** `query_loop_start`, `query_loop_iteration`, `query_loop_skill_call`, `query_loop_skill_result`, `query_loop_end`
- **Session:** `session_cache_hit`, `session_cache_miss`, `session_cache_store`, `session_cache_skip`
- **Plan confirmation:** `plan_confirmation_pending`, `plan_confirmed`, `plan_rejected`, `plan_confirmation_ambiguous`
- **Working memory:** `working_memory_created`, `working_memory_updated`, `working_memory_archived`

---

## Heartbeat

Runs every 30 minutes when idle. Checks (in order):

1. WHEN notebook — events or deadlines in next 24 hours → queue notification
2. NOW notebook — overdue todos; PLAN.PL entries with past due_date → mark overdue
3. WHY notebook — open questions older than 3 days → surface at next interaction
4. PLAN notebook — planning entries needing calibration
5. PLAN notebook — active project brains not updated in 7 days → flag stale
6. Vision alignment — active plans without relationship to North Star vision → `vision_drift`
7. AutoDream — idle >10 min → refresh MEMORY.md from today's WHEN.EV entries
8. Distiller — if `MEMORY_DISTILLER=1` → synthesize WHEN.RF reflections, refresh MEMORY_DIGEST.md

---

## Performance Targets

| Operation | Target | Hard limit |
|-----------|--------|------------|
| Greeting (no memory) | <1s | — |
| Known code fetch | <50ms | — |
| SQLite query (no file) | <50ms | — |
| Vague query (hybrid search) | <5s | — |
| QueryLoop (LOW task) | <30s | 20 iterations |
| Planner (HIGH task) | <90s | — |

---

## Known Limitations

- **Multi-file cross-reference coherence:** When the planner generates multiple `content_writer` steps producing separate files, element IDs, class names, and variable names are not shared between steps. Each step is stateless. Mitigated by the single-file HTML rule. Full fix requires a shared-context registry — deferred.
- **Embedding model migration:** Changing `EMBEDDING_MODEL` invalidates all stored vectors. Rebuild with `DELETE FROM chunks;` then restart.
- **Resolver step-attempt logging:** The 5-step memory query flow executes in the correct order but does not emit per-step diagnostic logs.
