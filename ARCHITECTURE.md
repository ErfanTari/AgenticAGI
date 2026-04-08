# AgenticAGI — Architecture Deep Dive

> Based on actual source code as of QueryLoop Efficiency Fix Sprint (April 2026).
> 933 tests pass. Build clean.

---

## 1. What This System Is

AgenticAGI is a **local-first AI agent platform** with a structured, persistent memory system. It is not a chatbot that forgets between sessions. It is not a RAG pipeline that dumps documents into context. It is a system designed to behave like a knowledgeable human assistant: it remembers across sessions, fetches only what it needs, connects knowledge meaningfully, and thinks in the background when idle.

The codebase is TypeScript/Node.js (ESM), uses `better-sqlite3` for its index, writes memory as Markdown files on disk, and is tested with Vitest.

---

## 2. Project Root

```
AgenticAGI/
├── ARCHITECTURE.md          ← this file
├── CLAUDE.md                ← build philosophy + phase history
├── agent-card.json          ← A2A protocol capability card
├── chat.ts                  ← CLI REPL entry point
├── package.json             ← pnpm, ESM, vitest
├── tsconfig.json
├── .env                     ← model endpoints + API keys
│
├── config/
│   └── agent.config.ts      ← PATHS, TYPE_MAP, LLM/embedding config
│
├── core/                    ← agent runtime (see §3)
│   ├── agent.ts             ← processMessage(), fast paths, compatibility
│   ├── config.ts            ← Zod config validation (Phase 17A)
│   ├── permission.ts        ← enforcePermission(), getActivePermissionMode()
│   ├── decomposition.ts     ← LLM-first message decomposition
│   ├── router.ts            ← route dispatcher (conversational/query/agentic)
│   ├── planner.ts           ← multi-goal task planning + complexity assessment
│   ├── executor.ts          ← milestone execution loop + verification
│   ├── query-loop.ts        ← iterative skill-calling loop (LOW/MEDIUM tasks)
│   ├── context.ts           ← context assembly, token budget, compaction
│   ├── llm.ts               ← LLM endpoint adapter (primary + fallback)
│   ├── resolver.ts          ← 5-step memory query escalation
│   ├── intent.ts            ← legacy compatibility classifier (shim)
│   ├── intake.ts            ← startup intake / findings
│   ├── react.ts             ← ReAct retry wrapper for skills
│   ├── heartbeat.ts         ← background memory health checks
│   ├── meeting.ts           ← /meeting mode briefing
│   ├── autonomous.ts        ← autonomous execution loop
│   ├── schemas.ts           ← Zod v4 schemas + JSON schema export
│   ├── structured.ts        ← generic structured LLM output pipeline
│   ├── transparency.ts      ← internal event bus
│   ├── transparency-renderer.ts
│   ├── agent-card.ts        ← A2A agent card sync
│   ├── types.ts             ← shared types (Message, LLMHandler, Intent, etc.)
│   ├── utils/
│   │   └── date.ts          ← localDateString(), localDatePlusDays()
│   │
│   ├── session/
│   │   └── session-log.ts   ← JSONL conversation persistence (Phase 17B)
│   │
│   ├── skills/
│   │   ├── types.ts         ← MCPSkill, SkillResult, PermissionLevel
│   │   ├── registry.ts      ← skill registry (freezable singleton)
│   │   ├── runner.ts        ← runSkill() with permission enforcement
│   │   └── tools/
│   │       ├── calculator.ts
│   │       ├── content_writer.ts
│   │       ├── file_reader.ts        ← binary detection, size limit, symlink guard
│   │       ├── file_writer.ts        ← 10MB limit, workspace boundary, symlink guard
│   │       ├── generate_and_save_file.ts
│   │       ├── implement_and_test.ts
│   │       ├── memory_history.ts
│   │       ├── memory_read.ts
│   │       ├── memory_write.ts
│   │       ├── relationship_write.ts
│   │       ├── run_bash.ts           ← sandbox detection, command audit
│   │       ├── url_extract.ts
│   │       ├── verify_state.ts
│   │       ├── web_fetch.ts
│   │       └── web_search.ts
│   │
│   └── memory/
│       ├── mod.ts            ← re-exports (initDatabase, upsertEntry, etc.)
│       ├── index.ts          ← SQLite init, schema, bootstrap
│       ├── write.ts          ← createEntry, upsertEntry (file-first)
│       ├── fetch.ts          ← fetchByCode (markdown reader)
│       ├── codegen.ts        ← atomic code generation
│       ├── search.ts         ← hybridSearch, BM25 + vector + RRF
│       ├── fts.ts            ← FTS5 full-text index
│       ├── chunks.ts         ← vector chunk storage
│       ├── embeddings.ts     ← embedding API + cosine similarity
│       ├── relationships.ts  ← relationship CRUD
│       ├── versioning.ts     ← git-backed memory commits
│       ├── lifecycle.ts      ← decay, utility, importance scoring
│       ├── episodic.ts       ← WHEN.EV / WHEN.RF / WHEN.HX writes
│       ├── plan-ex.ts        ← PLAN.EX execution state persistence
│       ├── project.ts        ← PLAN.PJ project brain
│       ├── execution-log.ts  ← JSONL execution audit log
│       ├── pointer-index.ts  ← MEMORY.md thin always-loaded index
│       ├── session-cache.ts  ← in-memory recent-entry cache
│       ├── memory-agent.ts   ← async background memory write queue
│       ├── working-memory.ts ← per-task execution state
│       ├── unit-search.ts    ← parallel per-unit BM25/vector search
│       └── types.ts          ← IndexEntry, SearchResult, etc.
│
├── memory/                  ← markdown files (canonical truth)
│   ├── WHO/contacts/
│   ├── WHAT/projects/, knowledge/
│   ├── WHEN/calendar/, deadlines/
│   ├── HOW/procedures/
│   ├── WHY/meta/, questions/
│   ├── NOW/todos/, reports/
│   └── PLAN/planning/
│
├── index/
│   └── memory.sqlite        ← master index + relationships + FTS + chunks
│
├── tests/
│   ├── phase1/ … phase17/   ← unit tests across 17 phases
│   ├── log-fixes/            ← Log Analysis Sprint tests
│   ├── log2-fixes/           ← Log Analysis Sprint #2 tests
│   ├── fixes/                ← Four-Bug / Five-Fix sprint tests
│   ├── permission-planner/   ← Permission-Aware Planner tests
│   ├── queryloop-efficiency/ ← QueryLoop Efficiency tests
│   ├── mocks/
│   │   ├── MockLLMHandler.ts ← deterministic LLM mock (Phase 17B)
│   │   └── scenarios/        ← scripted mock scenarios
│   └── setup-env.ts
│
├── scripts/                 ← stress tests, utilities
├── server/                  ← HTTP API server
├── public/                  ← web UI (transparency panel)
├── apps/                    ← app integrations
├── docs/                    ← phase completion docs
└── dist/                    ← compiled output
```

---

## 3. Core Design Principles

| Principle | What It Means in Code |
|-----------|----------------------|
| **Files are canonical, SQLite is derived** | All authoritative content lives in `.md` files on disk. SQLite holds metadata, relationships, and a full-text search index derived from file contents. The index can always be rebuilt from the files; the files are never rebuilt from the index. |
| **Index first, fetch second, search last** | Resolver tries direct code lookup → filter query → relationship traversal → only then calls `hybridSearch()`. |
| **Codes are the universal language** | Every entry has a code like `WHO.CT-000001`. Codes encode notebook + type + sequence number. |
| **Simplicity over cleverness** | Each layer must earn its place. No speculative abstractions. |
| **Permission before execution** | Every skill declares a `permissionLevel`. The runner enforces it against the active mode before calling `execute()`. |

**Note on FTS5:** The full-text search table necessarily stores tokenized body content for search performance. This is a derivation (not a duplicate source of truth) — the authoritative copy remains in the `.md` file. The FTS5 index can always be rebuilt from file contents without data loss.

---

## 4. Top-Level Request Lifecycle

```
User Message
    │
    ▼
[0] Plan confirmation intercept          ← core/agent.ts
    │  If pendingConfirmationPlan exists:
    │  ├── "yes"/"go"/"proceed" → executeConfirmedPlan() → done
    │  ├── "no"/"cancel"        → clear plan, inform user → done
    │  └── ambiguous            → re-prompt with milestones
    │
    ▼
[1] Fast-path bypasses                   ← core/agent.ts
    ├── /log ...       → NOW.LOG write
    ├── /meeting       → Meeting Mode
    └── WHO.CT-000001  → direct code fetch
    │
    ▼
[2] decomposeMessage()                   ← core/decomposition.ts
    │  LLM-structured decomposition
    │  → DecompositionResult { units[] }
    │  unit.route ∈ { conversational | agentic | query }
    │
    ▼
[3] searchMemoryForUnits()               ← core/memory/unit-search.ts
    │  Parallel per-unit BM25/vector search
    │
    ▼
[4] routeDecomposedUnits()               ← core/router.ts
    │
    ├── conversational → buildContext() → callLLM()
    │
    ├── query → direct retrieval / hybrid fallback (no LLM if results found)
    │
    └── agentic → assessComplexity()
                   ├── LOW/MEDIUM → runQueryLoop()   ← iterative skill loop
                   └── HIGH/MAX   → decomposeTask()  ← milestone planner
                                     → executePlan()
                                     → verifyExecution()
    │
    ▼
[5] Merge route outputs by original unit order
    │
    ▼
[6] AgentResponse { reply, intent, resolved, created?, error?, retries? }
    │
    ▼
[7] Session log append (user + assistant)  ← core/session/session-log.ts
```

---

## 5. Full System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                           USER INPUT                                │
│                      chat.ts (CLI REPL)                             │
│              session-log.ts (JSONL persistence)                     │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       core/agent.ts                                  │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐       │
│  │ Plan Confirm  │  │  Fast Paths  │  │ Decomposition         │       │
│  │ State Machine │  │  /log /meet  │  │ (LLM-first, few-shot  │       │
│  │ (intercept @  │  │  code fetch  │  │  hardened, retry +    │       │
│  │  top of msg)  │  │              │  │  heuristic repair)    │       │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬───────────┘       │
│         │                 │                       │                   │
│         └─────────────────┼───────────────────────┘                   │
│                             ▼                                        │
│                    ┌────────────────┐                                 │
│                    │   router.ts    │                                 │
│                    │ (route by unit │                                 │
│                    │  type + complexity)                              │
│                    └───┬────┬────┬──┘                                 │
│                        │    │    │                                    │
└────────────────────────┼────┼────┼────────────────────────────────────┘
                         │    │    │
        ┌────────────────┘    │    └────────────────┐
        ▼                     ▼                     ▼
┌──────────────┐   ┌──────────────────┐   ┌──────────────────────┐
│ Conversational│   │   Query Path     │   │   Agentic Path       │
│              │   │                  │   │                      │
│ buildContext()│   │ resolver.ts      │   │ ┌──────────────────┐ │
│ callLLM()    │   │ (5-step lookup)  │   │ │ LOW/MED:         │ │
│              │   │                  │   │ │ query-loop.ts    │ │
│              │   │ hybridSearch()   │   │ │ (iterative LLM   │ │
│              │   │ (BM25 + vector)  │   │ │  + skill calls)  │ │
│              │   │                  │   │ ├──────────────────┤ │
│              │   │                  │   │ │ HIGH/MAX:        │ │
│              │   │                  │   │ │ planner.ts       │ │
│              │   │                  │   │ │ executor.ts      │ │
│              │   │                  │   │ │ (milestone loop) │ │
│              │   │                  │   │ └──────────────────┘ │
└──────────────┘   └──────────────────┘   └──────────────────────┘
        │                   │                       │
        └───────────────────┼───────────────────────┘
                            │
                            ▼
        ┌───────────────────────────────────────────┐
        │           SKILL EXECUTION                  │
        │                                            │
        │  runner.ts → enforcePermission() → skill   │
        │  react.ts  → retry on failure              │
        │                                            │
        │  15 skills:                                │
        │  calculator, file_reader, file_writer,     │
        │  run_bash, web_search, web_fetch,          │
        │  url_extract, memory_read, memory_write,   │
        │  content_writer, relationship_write,        │
        │  implement_and_test, memory_history,        │
        │  verify_state, generate_and_save_file       │
        └───────────────┬───────────────────────────┘
                        │
                        ▼
        ┌───────────────────────────────────────────┐
        │           MEMORY SYSTEM                    │
        │                                            │
        │  ┌─────────┐    ┌──────────────────┐      │
        │  │ Markdown │    │    SQLite        │      │
        │  │  Files   │◄──►│  index_entries   │      │
        │  │ (truth)  │    │  relationships   │      │
        │  │          │    │  fts_content     │      │
        │  │ memory/  │    │  chunks          │      │
        │  │  WHO/    │    │  counters        │      │
        │  │  WHAT/   │    │  settings        │      │
        │  │  WHEN/   │    │  heartbeat_queue │      │
        │  │  HOW/    │    └──────────────────┘      │
        │  │  WHY/    │                              │
        │  │  NOW/    │    ┌──────────────────┐      │
        │  │  PLAN/   │    │ Git versioning   │      │
        │  └─────────┘    │ (fire-and-forget) │      │
        │                  └──────────────────┘      │
        │                                            │
        │  pointer-index.ts → MEMORY.md (thin index) │
        │  session-cache.ts → in-memory recent cache  │
        │  memory-agent.ts  → async write queue       │
        │  working-memory.ts → per-task state          │
        └───────────────────────────────────────────┘
                        │
                        ▼
        ┌───────────────────────────────────────────┐
        │           BACKGROUND                       │
        │                                            │
        │  heartbeat.ts (30 min cycle)               │
        │  ├── deadline checks                       │
        │  ├── overdue todo/plan detection           │
        │  ├── stale question surfacing              │
        │  ├── plan calibration                      │
        │  ├── stale project detection               │
        │  ├── vision alignment check                │
        │  └── AutoDream (pointer index refresh)     │
        │                                            │
        │  transparency.ts (event bus)               │
        │  └── all subsystems emit events            │
        └───────────────────────────────────────────┘
```

---

## 6. Decomposition + Legacy Compatibility

`core/decomposition.ts` is the primary understanding layer.

### Decomposition model

`decomposeMessage()` asks the LLM for a structured array of semantic units:

```typescript
interface DecomposedUnit {
  id: string;
  route: 'conversational' | 'agentic' | 'query';
  content: string;
  order: number;
}
```

### Hardening behavior

- If the initial decomposition under-splits a compound message, the system retries with a stricter compound prompt.
- If that still fails, a narrow heuristic repair pass splits on strong clause boundaries.
- The heuristic layer exists to protect the decomposition architecture, not to replace it.
- **Few-shot hardening**: 3 EXAMPLE blocks (agentic, conversational, query) + WRONG/RIGHT format enforcement to prevent flat-array hallucination.
- **Bare primitive filtering**: Numbers, booleans, and invalid strings are filtered from units before validation.
- **Retry with examples**: On garbage output (no valid units after normalization), retries once with 2 few-shot examples before falling back to heuristic repair.
- **Session-wide repair counter**: `_decompositionRepairCount` tracks total heuristic repairs; warns at 3+.

### `core/intent.ts` status

`classifyIntent()` still exists as a compatibility shim for legacy tests, metadata, and a few simple direct-tool flows. It is not the primary runtime router.

### What still uses the compatibility shim

- direct/simple `file_writer`, `run_bash`, `web_search`, `calculator`
- deterministic memory writes
- single-unit, non-compound messages only

---

## 7. Memory System

### 7a. The 7-Notebook Schema

| Notebook | Purpose | Types |
|----------|---------|-------|
| **WHO** | People and organizations | CT (contact), ORG (organization) |
| **WHAT** | Projects and knowledge | PJ (project), KN (knowledge) |
| **WHEN** | Time-anchored entries | CA (calendar), DL (deadline), EV (episodic event), RF (reflection), HX (history) |
| **HOW** | Procedures and skills | PR (procedure), SK (skill) |
| **WHY** | Goals, questions, meta | MT (meta), QU (question) |
| **NOW** | Actionable current items | TD (todo), RP (report), LOG (log entry) |
| **PLAN** | Plans and constraints | PL (planning), EX (execution state), CT (constraint), MS (milestone), PJ (project brain) |

### 7b. Entry Code Format

`{NOTEBOOK}.{TYPE}-{SEQUENCE}` — e.g. `WHO.CT-000042`

Generated via atomic SQLite counter increment (`nextCounter()` in `core/memory/index.ts`).

### 7c. Dual Storage: Files + SQLite

**Markdown files** (canonical truth):
```
memory/WHO/contacts/WHO.CT-000001_john-smith.md
```
Each file has YAML frontmatter (`code`, `nb`, `type`, `name`, `status`, `updated`, `summary`, `due_date`) followed by body content.

**SQLite** (`memory.sqlite`, the map):
- `index_entries` — metadata (code, nb, type, name, status, updated, summary, path, due_date, importance_score, utility_score, usage_count, last_accessed, decay_rate, active_page, pinned, privacy_tier, source, confidence, atomic_facts, embedding)
- `relationships` — directed graph edges between entries
- `counters` — atomic sequence numbers per type key
- `fts_content` — FTS5 full-text search index
- `chunks` — vector embedding chunks (BLOB storage)
- `heartbeat_queue` — notifications from background scans
- `settings` — key/value store (e.g., `embedding_model` for migration detection)

**Write order** (`core/memory/write.ts`): File write FIRST, SQLite transaction SECOND. If the file write fails, SQLite is never touched. If SQLite fails after the file write, the file is cleaned up.

### 7d. Bootstrapping

On first startup with an empty SQLite, `bootstrapIndexFromMemoryFiles()` scans all `.md` files under `memory/`, parses frontmatter, and rebuilds the entire index. You can delete the `.sqlite` file and it will reconstruct from disk.

---

## 8. Memory Query Pipeline

When resolving memory queries, a **5-step escalating lookup** runs:

```
Step 1: Direct code lookup (if codes[] non-empty)
    → getEntryByCode() + fetchByCode() for full content

Step 2: Filter query by nb/type/status/name
    → queryEntries({ nb, type, status, name })

Step 3: Relationship traversal (if relation verb found)
    → traverse graph from resolved entries

Step 4: Name fuzzy match
    → queryEntries({ name: extractedName })

Step 5: Hybrid search fallback
    → hybridSearch(message, { nb })
```

### Hybrid Search (`core/memory/search.ts`)

```
hybridSearch(query)
    ├── BM25 via FTS5 (always available)
    └── Vector cosine similarity (optional)
         │
         └── Reciprocal Rank Fusion (RRF k=60)
              → vector results get 1.01x weight for semantic tie-breaking
```

When embedding API is unavailable, falls back to BM25-only transparently.

### Relevance Ranking (`core/context.ts`)

Before injecting memory into the LLM prompt, entries are re-ranked by `rankByLightRAG()`:

```
Score = (BM25F_field_weighted + recency_decay + importance_boost + utility_boost)
         × page_boost × pinned_boost
```

- **BM25F**: Term frequency weighted by field (name=5, summary=3)
- **Recency**: `e^(-0.05 * age_in_days)`
- **Importance**: `importance_score * 0.1`
- **Active page**: `1.2x` if page 1, `0.8x` otherwise
- **Pinned**: `2.0x` boost

---

## 9. Planner / Executor Pipeline

### 9a. Complexity Routing

`assessComplexity()` determines the execution path:

| Level | Path | Engine |
|-------|------|--------|
| LOW | iterative | `runQueryLoop()` — while-loop with LLM + skill calls |
| MEDIUM | iterative | `runQueryLoop()` — same engine, more iterations |
| HIGH | planned | `decomposeTask()` → `executePlan()` — milestone-based |
| MAX | planned | Same as HIGH, with confirmation gate |

### 9b. QueryLoop (`core/query-loop.ts`)

For LOW/MEDIUM tasks:
- `while(true)` loop: call LLM → extract JSON action → execute skill → inject result → repeat
- Circuit breaker: trips at 3 consecutive identical failures
- MAX_ITERATIONS: 20
- When model emits plain text (no JSON action) → returns that text as reply
- Permission-filtered skill list: uses `getSkillDescriptionsForPermission()` — blocked skills never shown
- MEMORY.md relevance filtering: `filterPointerIndex()` scores entries by keyword overlap with goal, reduces ~50 entries to ~15 relevant ones

**System prompt efficiency rules** (reduce wasted iterations):
- **SINGLE-FILE HTML RULE**: Produce one self-contained HTML file with inline `<style>`/`<script>` and CDN-loaded libraries
- **GENERATE-FIRST RULE**: Skip web_search when the model has sufficient knowledge; warns against fetching GitHub blob pages
- **DESCRIPTION QUALITY RULE**: `generate_and_save_file` descriptions must be detailed specs (100-300 words)
- **Post-generation hint**: After successful `generate_and_save_file`, appends "Do not re-read files you just generated"

### 9c. Task Planning (`core/planner.ts`)

For HIGH/MAX tasks, produces a milestone-aware `TaskPlan`.

**Permission-aware**: Planner prompt includes a RUNTIME CONTEXT block showing the active permission mode, available skill count, and blocked skill names. Only permission-filtered skills appear in the skill list.

**Confirmation gate**: MAX complexity plans always require user confirmation. Other plans require confirmation only for destructive ops / external side effects / risky overwrites (computed by `shouldRequireConfirmation()`, never trusting the LLM's value).

Plan structure:

```typescript
interface TaskPlan {
  goal: string;
  milestones?: TaskMilestone[];
  steps: TaskStep[];
  complexity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'MAX';
  needsConfirmation?: boolean;
}

interface TaskStep {
  id: string;
  skill: string;           // must match a registered skill name
  description: string;
  input: Record<string, unknown>;  // may contain {{template_tokens}}
  dependsOn: string[];
  confidence_score?: number;
  risk_level?: string;
}
```

### 9d. Execution (`core/executor.ts`)

```
For each milestone:
    1. Emit milestone_start
    2. Execute steps sequentially with dependency / timeout / risk guards
    3. mkdir-skip safety: run_bash + "mkdir" → auto-skipped (file_writer handles dirs)
    4. On failure: persist PLAN.EX as failed and abort
    5. On success: run post-milestone memory cycle
    6. Failure-aware revision: revision prompt includes FAILED section with errors
       → revision can return abort:true to stop execution
    7. Reactive revision: skip revision LLM call on happy path (no failures, no suspicious output)
    8. Post-flight synthesis: single runPostFlightSynthesis() LLM call
       → returns { verification, summary, reflection } with filesystem/DB ground truth snapshot
```

### 9e. Plan Confirmation State Machine (`core/agent.ts`)

When a plan requires confirmation (`needsConfirmation: true`), a module-level `pendingConfirmationPlan` stores the plan. At the TOP of the next `processMessage()` call — before intake, decomposition, or routing — the interceptor checks:

- **Confirmation** (`isUserConfirmation()` — regex: yes/go/proceed/do it/etc.) → executes the plan via `executeConfirmedPlan()`, clears state
- **Rejection** (`isUserRejection()` — regex: no/cancel/stop/etc.) → clears state, informs user
- **Ambiguous** → re-prompts with milestone summary, keeps plan pending

This prevents the "fake execution" hallucination where the conversational LLM fabricates plan completion after reading confirmation in chat history.

### 9f. Post-milestone memory cycle

After each milestone: write `WHEN.EV`, optionally write `HOW.PR`, update `PLAN.EX`.
After full completion: write `WHEN.RF`, update `PLAN.PJ`, extract durable facts.

---

## 10. Security & Permission Layer (Phase 17A)

### Permission Model

Three permission modes, enforced at the skill runner level:

| Mode | Allows |
|------|--------|
| `read-only` | calculator, file_reader, memory_read, memory_history, web_search, web_fetch, url_extract, content_writer |
| `workspace-write` | All read-only + file_writer, memory_write, relationship_write, generate_and_save_file, verify_state |
| `full-access` | All workspace-write + run_bash, implement_and_test |

Every `MCPSkill` declares a `permissionLevel`. Before execution, `runner.ts` calls `enforcePermission()` to compare against the active mode.

### Config Validation (`core/config.ts`)

Zod schema validates required environment variables at startup:
- `LLM_ENDPOINT` (valid URL, required)
- `LLM_MODEL` (non-empty string, required)
- `PERMISSION_MODE` (enum, defaults to `workspace-write`)

### Registry Freeze

`freezeRegistry()` is called at module load. After freezing, `registerSkill()` calls are silently rejected. `_unfreezeRegistry()` exists only for test isolation.

### Bash Security (`core/skills/tools/run_bash.ts`)

- **Blocked patterns**: `rm -rf`, fork bombs, `mkfs`, `dd`, `sudo`, `shred`, `wipefs`, pipe-to-shell, eval subshells (18 patterns)
- **Confirmation-required**: `rm` (non-recursive), `rmdir`, destructive git, SQL drops (8 patterns)
- **Workspace scope**: Path traversal detection (`../`, `~/`, `$HOME`, `/etc/`, `/usr/`, `/var/`)
- **Sandbox detection**: Probes `unshare --user --map-root-user` capability, caches result. Warning prefix when running without sandbox in `full-access` mode.

### File Security

Both `file_reader` and `file_writer` enforce:
- Workspace boundary (resolved path must start with workspace root)
- Symlink escape detection (`realpathSync` re-check after resolution)
- Binary file detection (NUL-byte scan in first 8KB)
- Size limits (file_reader: 50K chars, file_writer: 10MB)

---

## 11. Session Persistence (Phase 17B)

### Session JSONL (`core/session/session-log.ts`)

Every conversation turn is appended to a JSONL file:

```
~/.zaraban/sessions/{YYYY-MM-DD}_{sessionId}.jsonl
```

- **Rotation**: At 256KB, current file moves to `.1`, previous `.1` to `.2`, etc. Max 3 rotations.
- **Fire-and-forget**: `append()` never throws — agent continues even if disk is full.
- **Singleton**: `currentSession()` returns the process-scoped session.
- **Wiring**: `chat.ts` calls `append()` after user input and after assistant reply.

### Mock LLM Handler (`tests/mocks/MockLLMHandler.ts`)

Deterministic LLM replacement for testing:
- Scenario-based: match trigger substring in last user message → return canned response
- Call history tracking via `.calls[]`
- Three scenario files: decompose-simple, plan-file-write, conversational

---

## 12. Context Assembly (`core/context.ts`)

`buildContext()` assembles the final message array sent to the LLM:

```
System Prompt
    + Owner Persona (WHO.CT, cached 60s)
    + Notebook Counts (only for summary/overview queries)
    + Resolved Memory (ranked by rankByLightRAG)
    + Active Constraints (PLAN.CT entries)
    + Skill Output (if skill ran)
    + Conversation Summary (if history compacted)
    ────────────────────
    [system message]
    [history messages]
    [user message]
```

### Token Budget

- **Soft limit**: 1,500 tokens
- **Hard ceiling**: 2,000 tokens
- **Compaction triggers**: 70% of budget (1,050) OR 100K absolute threshold
- **Circuit breaker**: Compaction disabled after 3 consecutive failures

Progressive degradation when budget exceeded:
1. Token-budget-aware history trim (keep recent turns in 40% budget)
2. Trim memory to summaries only + cap skill output at 2,000 chars
3. Drop all history, keep system + user only
4. Truncate user input

---

## 13. Skills Registry

### MCPSkill Interface

```typescript
interface MCPSkill {
  name: string;
  description: string;
  permissionLevel: PermissionLevel;    // 'read-only' | 'workspace-write' | 'full-access'
  inputSchema: Record<string, unknown>;
  execute(input: Record<string, unknown>): Promise<SkillResult>;
}
```

### 15 Registered Skills

| Skill | Permission | Purpose |
|-------|-----------|---------|
| `calculator` | read-only | Math via `mathjs` |
| `file_reader` | read-only | Read workspace files (binary detection, size limit, symlink guard) |
| `web_search` | read-only | Web search (Brave/SerpAPI/fallback) |
| `web_fetch` | read-only | Fetch URL content (auto-rewrites GitHub blob URLs to raw) |
| `url_extract` | read-only | Extract structured data from URLs |
| `memory_read` | read-only | Query agent's memory by code, notebook, or search |
| `memory_history` | read-only | Git-backed entry history and rollback |
| `content_writer` | read-only | LLM-based content generation (markdown/html/plain/code formats, optional context for modification) |
| `file_writer` | workspace-write | Write workspace files (10MB limit, workspace boundary, auto-creates dirs) |
| `memory_write` | workspace-write | Create/update memory entries |
| `relationship_write` | workspace-write | Create directed relationships between entries |
| `generate_and_save_file` | workspace-write | LLM-generate large files via sub-LLM + save to disk |
| `verify_state` | workspace-write | Validate file/memory/process outcomes |
| `run_bash` | full-access | Execute shell commands (sandbox detection, blocked patterns, workspace scope) |
| `implement_and_test` | full-access | Write code + run tests + fix loop |

### content_writer Formats (`core/skills/tools/content_writer.ts`)

| Format | Min Output | Token Floor | Notes |
|--------|-----------|-------------|-------|
| `html` | 500 chars | 6000 tokens | Single-file HTML with inline CSS/JS |
| `markdown` | 200 chars | 4000 tokens | Standard markdown |
| `plain` | 100 chars | 4000 tokens | Plain text |
| `code` | 80 chars | 4000 tokens | Pure source code, balanced-brace validation |

- Optional `context` input for modifying existing content
- Minimum length validation: output below floor returns `{ success: false }`
- Balanced-brace check: always fires for `code` format, catches truncated output

### web_fetch GitHub Rewrite (`core/skills/tools/web_fetch.ts`)

`rewriteGitHubBlobUrl()` transparently converts `github.com/.../blob/...` URLs to `raw.githubusercontent.com/...`, so the agent gets raw source content instead of GitHub UI chrome.

### ReAct Retry (`core/react.ts`)

`runWithRetry(skill, input, llmHandler)` — on failure, asks LLM to propose corrected input and retries up to a configured limit.

---

## 14. Heartbeat (`core/heartbeat.ts`)

Runs every 30 minutes while idle (`isProcessingMessage = false`):

| Check | What it does |
|-------|-------------|
| `checkDeadlines()` | WHEN entries due within 24h |
| `checkOverdueTodos()` | NOW.TD / PLAN.PL past due_date → marks 'overdue' |
| `checkStaleQuestions()` | WHY.QU open for 3+ days |
| `checkPlanCalibration()` | PLAN.PL active 7+ days without update |
| `checkStaleProjects()` | WHAT.PJ active 7+ days |
| `checkVisionAlignment()` | Plans with no overlap with North Star vision |
| `checkStalePlanPJ()` | PLAN.PJ project brains not updated in 3+ days |
| `checkAutoDream()` | Idle > 10 min → refresh pointer index from today's events |

Findings → `heartbeat_queue` table → surfaced at next user interaction.

---

## 15. Memory Versioning (`core/memory/versioning.ts`)

Every write triggers `commitMemoryWrite()` (fire-and-forget):
- Initializes git repo in memory directory if needed
- Stages + commits the changed `.md` file
- Generation counter invalidates in-flight commits on `_resetGitInstance()`
- `memory_history` skill exposes full change history per entry

---

## 16. Transparency System (`core/transparency.ts`)

Event emitter for internal agent observability:

| Event | Source |
|-------|--------|
| `decomposition` | decomposition.ts |
| `decomposition_retry` | decomposition.ts |
| `decomposition_repair` | decomposition.ts |
| `unit_memory_search` | unit-search.ts |
| `memory_context_filtered` | unit-search.ts |
| `plan` | planner.ts |
| `planner_reasoning` | planner.ts |
| `project_brain` | planner.ts |
| `plan_confirmation_pending` | agent.ts |
| `plan_confirmed` / `plan_rejected` | agent.ts |
| `plan_confirmation_ambiguous` | agent.ts |
| `route` | router.ts, agent.ts |
| `step_start` / `step_result` | executor.ts |
| `milestone_revision_skipped` | executor.ts |
| `how_pr_skipped` | executor.ts |
| `failure_classified` | executor.ts |
| `verification_snapshot` | executor.ts |
| `post_flight_complete` | executor.ts |
| `context_compacted` | context.ts |
| `llm_raw` / `llm_stripped` | llm.ts |
| `query_loop_start` / `query_loop_end` | query-loop.ts |
| `query_loop_iteration` / `query_loop_narration` | query-loop.ts |
| `query_loop_skill_call` / `query_loop_skill_result` | query-loop.ts |
| `working_memory_created` / `_updated` / `_archived` / `_loaded` | working-memory.ts |
| `session_cache_store` / `_hit` / `_miss` / `_skip` | session-cache.ts |
| `project_brain_hit` / `_miss` / `_rebuilt` / `_invalidated` | project.ts |
| `meeting_complete` | meeting.ts |
| `saga_rollback` | autonomous.ts |
| `milestone_memory_cycle` | executor.ts |

Enable with `TRANSPARENT=true`.

---

## 17. LLM Configuration (Thinking Suppression)

Per-call thinking suppression via `disableThinking: true` in LLMHandler options:

```typescript
// Suppress thinking on intake and decomposition
const response = await llmHandler(messages, {
  maxTokens: TOKEN_BUDGETS.INTAKE,
  disableThinking: true  // Passes {"thinking":{"type":"disabled"}} to LM Studio
});
```

- Only applied to local-primary LLM calls (LM Studio)
- Prevents thinking blocks from consuming token budget on deterministic tasks
- Gemma 4 emits `<|channel>thought` blocks; stripping required via `stripThinkingTags()`
- Fallback to cloud providers (Gemini, Anthropic) continues without thinking suppression

---

## 19. LLM Configuration (Provider Selection)

```
Primary:   LLM_ENDPOINT + LLM_MODEL (local LM Studio)
Fallback:  LLM_FALLBACK_PROVIDER + LLM_FALLBACK_MODEL (Gemini/Anthropic)
```

- Timeout tiered by model size: 70B+=90s, 7B-14B=20s, 1B-4B=10s
- Provider selection is async-scoped (`core/llm.ts` `AsyncLocalStorage`) — nested LLM calls in planner/executor use the same provider order
- `stripThinkingTags()` removes reasoning artifacts from all model families (Qwen, Gemma, Gemini, generic `<think>` tags)

---

## 18. Quick-Resolve: Pre-Decomposition Memory Retrieval (`core/memory/quick-resolve.ts`)

Early-exit path in `processMessage` for structurally obvious memory queries that don't need LLM decomposition:

### Strategy 1: Code Lookup
```
Input:  "Show me WHO.CT-000001"
→ extractCodes() finds WHO.CT-000001
→ getEntryByCode() retrieves entry
→ fetchByCode() loads markdown body
→ Single LLM call answers user
Time saved: ~2-3 seconds (skips decomposition + intake)
```

### Strategy 2: Name Search
```
Input:  "Tell me about Tennis 3D Game"
→ extractSearchTerms() extracts "Tennis 3D Game"
→ queryEntries({ name: "Tennis 3D Game" }) finds match
→ Single LLM call with resolved memory
Time saved: ~2-3 seconds
```

### Integration
- Inserted in `processMessage` AFTER fast-paths (/log, /meeting, code fetch) but BEFORE intake/decomposition
- Guards relationship queries (e.g., "what does X own?") to preserve `relationship_query` intent routing
- Non-blocking: Returns `resolved: false` for unmatched queries; falls through to normal pipeline

### Modules
| File | Purpose |
|------|---------|
| `core/memory/quick-resolve.ts` | extractCodes, extractSearchTerms, quickResolve |
| `core/agent.ts` | Integration: early-exit block before decomposition |
| `tests/phase19/quick-resolve.test.ts` | 18 tests: code extraction, term extraction, integration |

### Design Principles
- **Deterministic**: Pure regex + SQLite name query — no LLM involved
- **Composable**: Works alongside Phase 19's `detectListIntent()` listing detection
- **Non-disruptive**: Falls through to normal routing if no match found
- **Type-safe**: Skips for relationship queries; doesn't break existing intent classification

---

## 20. DVD Log Analysis Fix Sprint

Five targeted bug fixes derived from transparency log analysis of a DVD screensaver task.
Address BM25 relevance pollution, unnecessary decomposition retries, session cache churn,
legacy complexity routing, and router defensive gaps.

### Fixes Summary

| Fix | Issue | Solution | File(s) |
|-----|-------|----------|---------|
| FIX 1 | BM25 injects irrelevant memory into agentic tasks | `hasMeaningfulOverlap()` relevance gate on BM25 fallback | `core/memory/unit-search.ts` |
| FIX 2 | Compound re-trigger on single-intent messages | Bypass second decomposition when first pass returns 1 valid unit | `core/decomposition.ts` |
| FIX 3 | Schema leak in decomposition output | **Verified closed** by json-integrity-complete sprint (responseSchema present) | `core/decomposition.ts` |
| FIX 4 | Session cache churn-stores same entry | Dedup guard: skip write if code already cached with same updated timestamp | `core/memory/session-cache.ts` |
| FIX 5A | Legacy "simple"/"complex" complexity routed to unknown path | Coerce legacy values post-Zod: "simple"→"LOW", "complex"→"MEDIUM" | `core/planner.ts` |
| FIX 5B | Router has no defense against unknown complexity | Validate complexity is in {LOW, MEDIUM, HIGH, MAX}, default to LOW if unrecognized | `core/router.ts` |

### New Transparency Event

- `unit_search_filtered`: `{ unitId, reason: 'bm25_no_overlap', droppedCount }` — emitted when BM25 gate filters all results

### Test Coverage

- 28 new tests in `tests/dvd-log-fixes/fixes.test.ts`
  - 10 tests for FIX 1 (relevance gate behavior, edge cases, regression checks)
  - 6 tests for FIX 2 (bypass conditions, heuristic preservation)
  - 2 tests for FIX 3 (schema verification)
  - 4 tests for FIX 4 (dedup behavior, edge cases)
  - 6 tests for FIX 5 (legacy coercion, router guard, schema preservation)

---

## 21. Testing

- **1282 tests** across 95 test files (1254 core + 28 DVD log fixes)
- **Vitest** with ESM support
- **Test isolation**: Each test overrides `PATHS.db` and `PATHS.memory` to a `tmpDir`
- **Mock LLM**: `tests/mocks/MockLLMHandler.ts` for deterministic pipeline tests
- **Stress tests**: `pnpm stress:p15:codex` — 8 adversarial scenarios (empty input, long input, concurrency, circuit breaker, compound routing, follow-up context)
- **Stress critical**: `pnpm stress:critical` — focused critical-path stress tests

```bash
pnpm test                        # all 1282 tests
pnpm test tests/dvd-log-fixes/   # DVD log fixes only
pnpm test tests/phase17/         # phase 17 only
pnpm build                       # tsc compilation check
pnpm stress:p15:codex            # stress test suite (requires LM Studio)
pnpm stress:critical             # critical-path stress tests
```
