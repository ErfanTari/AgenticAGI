# CLAUDE.md — Agent Platform Architecture Guide

This file defines the architecture, memory system, and build philosophy for this agent platform.
Read this fully before writing any code. Every decision here exists for a reason.

---

## What We Are Building

A local-first AI agent platform with a structured memory system.
The goal: an agent that feels like a knowledgeable human assistant —
not a search engine that forgets everything between sessions.

The agent must:
- Remember people, projects, plans, and procedures across sessions
- Fetch only what it needs (never dump everything into context)
- Connect pieces of knowledge to each other meaningfully
- Think in the background when idle
- Respond fast on simple queries, deep on complex ones

---

## Core Philosophy

**Simplicity over cleverness.** Every layer must earn its place.
If a feature adds complexity without clear benefit, do not build it yet.

**Index first, fetch second, search last.**
The agent should almost never need to search memory for known things.
Search is the last resort, not the default.

**Files are truth. SQLite is the map.**
All real content lives in markdown files.
SQLite holds only what is needed to find and connect those files.
Never duplicate content between them.

**Codes are the universal language.**
Every memory entry has a code. That code is readable by humans and machines.
It tells you the notebook, the type, and the number — without opening anything.

---

## Project Structure

```
/agent
├── CLAUDE.md                  ← this file
├── memory/
│   ├── WHO/                   ← contacts, people, organizations
│   │   └── contacts/
│   ├── WHAT/                  ← projects, knowledge entries
│   │   ├── projects/
│   │   └── knowledge/
│   ├── WHEN/                  ← calendar events, deadlines
│   │   ├── calendar/
│   │   └── deadlines/
│   ├── HOW/                   ← procedures, routines, learned patterns
│   │   └── procedures/
│   ├── WHY/                   ← meta reflections, open questions
│   │   ├── meta/
│   │   └── questions/
│   ├── NOW/                   ← todos, reports, active tasks
│   │   ├── todos/
│   │   └── reports/
│   └── PLAN/                  ← planning entries, time estimates
│       └── planning/
├── index/
│   └── memory.sqlite          ← master index + relationships
├── core/
│   ├── agent.ts               ← main agent loop
│   ├── memory/
│   │   ├── index.ts           ← SQLite interface
│   │   ├── fetch.ts           ← file fetcher by code
│   │   ├── search.ts          ← hybrid search (last resort)
│   │   └── write.ts           ← memory writer
│   ├── heartbeat.ts           ← background idle process
│   └── skills/                ← MCP-compatible skill modules
│       ├── types.ts           ← MCPSkill + SkillResult interfaces
│       ├── registry.ts        ← Map-based skill registry
│       ├── runner.ts          ← runSkill() — never throws
│       ├── memory_read.ts     ← legacy skill descriptor
│       ├── memory_write.ts    ← legacy skill descriptor
│       └── tools/
│           ├── calculator.ts  ← math evaluation via mathjs
│           ├── file_reader.ts ← read files from disk
│           └── web_search.ts  ← DuckDuckGo Instant Answer API
└── config/
    └── agent.config.ts        ← model, paths, settings
```

---

## The Code System

Every memory entry has a universal code. Format:

```
[NOTEBOOK].[TYPE]-[NUMBER]

Examples:
WHO.CT-000024   → Contact number 24
WHAT.PJ-000003  → Project number 3
WHEN.CA-000118  → Calendar event 118
HOW.PR-000012   → Procedure number 12
WHY.QU-000013   → Open question 13
WHY.MT-000004   → Meta reflection 4
NOW.TD-000041   → Todo item 41
PLAN.PL-000007  → Planning entry 7
```

### Type Reference

| Notebook | Type Code | Meaning         |
|----------|-----------|-----------------|
| WHO      | CT        | Contact         |
| WHO      | ORG       | Organization    |
| WHAT     | PJ        | Project         |
| WHAT     | KN        | Knowledge entry |
| WHEN     | CA        | Calendar event  |
| WHEN     | DL        | Deadline        |
| HOW      | PR        | Procedure       |
| WHY      | MT        | Meta reflection |
| WHY      | QU        | Open question   |
| NOW      | TD        | Todo item       |
| NOW      | RP        | Report          |
| PLAN     | PL        | Planning entry  |

### Rules for codes
- Codes are generated sequentially and never reused
- Codes are written into both the markdown file header AND SQLite
- When an agent writes a markdown file referencing another entry, it uses the code inline
- Codes in markdown content act as live references — always fetchable

---

## SQLite Schema

Three tables. Nothing more until justified.

### Table: index_entries

```sql
CREATE TABLE index_entries (
  code      TEXT PRIMARY KEY,   -- e.g. WHO.CT-000024
  nb        TEXT NOT NULL,      -- e.g. WHO  (indexed for fast filter)
  type      TEXT NOT NULL,      -- e.g. CT   (indexed for fast filter)
  name      TEXT NOT NULL,      -- human readable name
  status    TEXT NOT NULL,      -- active | archived | open | closed | upcoming
  updated   TEXT NOT NULL,      -- ISO date string
  summary   TEXT,               -- one line, agent answers simple queries from this
  path      TEXT NOT NULL,      -- full path to markdown file
  due_date  TEXT                -- optional ISO date for deadlines and plans
);

CREATE INDEX idx_nb     ON index_entries(nb);
CREATE INDEX idx_type   ON index_entries(type);
CREATE INDEX idx_status ON index_entries(status);
```

### Table: relationships

```sql
CREATE TABLE relationships (
  from_code  TEXT NOT NULL,   -- e.g. WHO.CT-000025
  relation   TEXT NOT NULL,   -- e.g. supplies | owns | works_for | blocks | refers
  to_code    TEXT NOT NULL,   -- e.g. WHO.CT-000024
  note       TEXT,            -- optional human note about this relationship
  created    TEXT NOT NULL,   -- ISO date string

  FOREIGN KEY (from_code) REFERENCES index_entries(code),
  FOREIGN KEY (to_code)   REFERENCES index_entries(code)
);

CREATE INDEX idx_from ON relationships(from_code);
CREATE INDEX idx_to   ON relationships(to_code);
```

### Table: counters

```sql
CREATE TABLE counters (
  type    TEXT PRIMARY KEY,   -- e.g. "WHO.CT"
  current INTEGER NOT NULL DEFAULT 0
);
```

Used by the code generator. Each type key (e.g. `WHO.CT`) gets an atomic counter
that is incremented inside a SQLite transaction when a new entry is created.
This prevents the lexicographic sort bug and race conditions.

### What SQLite is NOT used for
- Do not store full content in SQLite
- Do not store embeddings in SQLite initially (add only when hybrid search is needed)
- Do not add tables without a clear, demonstrated need

---

## Markdown File Format

Every memory entry is a markdown file with a structured frontmatter header.
The header is machine-readable. The body is human-readable.

```markdown
---
code: WHO.CT-000024
nb: WHO
type: CT
name: Erfan Tari
status: active
updated: 2026-02-19
summary: Owner, developer, ceramic specialist
---

# Erfan Tari

## Communication
- email: erfan@anatolia.com
- telegram: @erfan

## Style
- Prefers direct answers and diagrams
- Thinks architecturally before diving into detail

## Projects
- Owns WHAT.PJ-000003 (Activation X-Ray)
- Owns WHAT.PJ-000002 (meeting_local)

## Notes
- Deep interest in AI interpretability
- Building new agent platform — this one
```

### Rules for markdown files
- Frontmatter header is always present and always complete
- References to other entries always use their code (e.g. WHAT.PJ-000003)
- Never duplicate information that lives in another file — use a code reference instead
- Body content is written for a human to read, not just for the agent

---

## The Memory Query Flow

This is the most important rule in the entire system.
Follow this order strictly. Do not skip steps.

```
1. Is the code already known?
   → YES: fetch file directly by path from SQLite. Done.
   → NO: continue

2. Can SQLite answer without opening a file?
   (e.g. "show active projects" → WHERE type='PJ' AND status='active')
   → YES: query index_entries, return names + summaries. Done.
   → NO: continue

3. Can the relationship table answer it?
   (e.g. "what does WHO.CT-000025 own?" → WHERE from_code='WHO.CT-000025')
   → YES: query relationships, follow codes. Done.
   → NO: continue

4. Can index tags/names find it?
   (e.g. search name field for "Erfan")
   → YES: return match, fetch file if needed. Done.
   → NO: continue

5. Run hybrid search (BM25 + vector) — LAST RESORT ONLY
   Scope the search to the correct notebook if possible.
   Never run across all notebooks unless the query has no notebook signal.
```

---

## Current Runtime Routing (Phase 13+)

The runtime no longer starts by classifying the entire user message into one
top-level intent. Understanding comes first, routing comes second.

### Fast-path bypasses

These stay in TypeScript and skip decomposition entirely:

- `/log ...` → immediate `NOW.LOG` write
- `/meeting` → immediate Meeting Mode
- Direct code fetch like `WHO.CT-000001` → direct fetch path

### Normal runtime flow

```
1. Decompose the message into ordered semantic units
   route ∈ { conversational | agentic | query }

2. Search memory for every unit in parallel
   - person signal     → WHO
   - project signal    → PLAN.PJ / WHAT
   - time signal       → WHEN.EV / WHEN.RF
   - procedure signal  → HOW.PR
   - otherwise         → BM25 first, vector only as fallback

3. Execute by route
   - conversational units → one batched LLM response
   - query units          → direct retrieval / hybrid fallback
   - agentic units        → multi-goal planner + executor

4. Merge route outputs by original unit order
```

### Important routing rules

- Query units that precede agentic work are resolved first and injected into the
  planner as prior context. They are not treated as goals.
- Compound messages must not be swallowed by a single legacy compatibility path.
  If decomposition under-splits, the system retries with a stricter prompt and
  then uses a narrow heuristic repair pass.
- Legacy intent labels still exist for compatibility in tests and metadata, but
  runtime routing in `processMessage()` is decomposition-first.
- Greeting, `synthesis_query`, `relationship_write`, and old classifier-first
  branching are no longer primary execution routes.

### Skills in the current architecture

- Skills are primarily execution steps inside plans.
- Conversational arithmetic is the main exception (`calculator`).
- A narrow single-unit compatibility shim still exists for simple cases like
  `file_writer`, `run_bash`, `web_search`, `calculator`, and deterministic
  memory writes, but it is not the source of truth for routing.
- Deterministic read-only skills (`web_search`, `calculator`, `file_reader`,
  `memory_read`, `web_fetch`, `url_extract`) now return their real output
  directly in the compatibility path instead of asking the LLM to paraphrase
  them. This prevents false-complete replies like "Let me search for you"
  after the skill has already run.
- If an LLM reply still starts with deferred-action narration (`Let me...`,
  `I'll use...`, `I should...`) after a skill or conversational response, the
  runtime strips that reasoning preamble before returning text to the user.
- `implement_and_test` is now grounded to the real workspace when filenames
  already exist: it reuses existing implementation/test files, syntax-checks
  both artifacts before execution, and can repair either file instead of only
  retrying code generation.
- `implement_and_test` now resolves execution relative to the actual project
  directory for nested workspace paths, creates a project-local `package.json`
  when needed, and installs detected npm dependencies from that directory
  before the first run. Scoped packages and side-effect imports are normalized
  correctly before install.
- The assistant identity is fixed in the runtime system prompt: the agent name
  is `zaraban`. Identity questions should resolve from prompt context first,
  not from memory search.

### Current model runtime

- Default runtime is local-first:
  - `LLM_ENDPOINT` / `LLM_MODEL` point at LM Studio
  - `PLANNER_MODEL` and `EXECUTOR_MODEL` track the same local model
  - `LLM_FALLBACK_PROVIDER=gemini` with `LLM_FALLBACK_MODEL=gemini-2.5-flash`
- `chat.ts` stays local-primary by default and falls back to Gemini automatically.
- `pnpm ui` exposes a provider toggle in the header:
  - `local` → LM Studio primary, Gemini fallback
  - `cloud` → Gemini primary, LM Studio fallback
- Provider selection is async-scoped in `core/llm.ts`, so nested LLM calls
  inside planner/executor flows and LLM-backed skills use the same provider
  order as the top-level request.
- Embeddings are separate from this toggle and continue using the embedding
  configuration already present in the runtime.

---

## PLAN.EX Lifecycle (Current Rules)

`PLAN.EX` is the persisted execution-state notebook for planned work.

- `active` / `in_progress` / `paused` = resumable execution state
- `complete` / `failed` = terminal state, must never resurface as active
- Status is written to both SQLite and markdown frontmatter
- Startup surfaces resumable plans differently:
  - `paused` → show the pause reason
  - `in_progress` / `active` → show the next milestone/action
- After each milestone:
  - write `WHEN.EV`
  - optionally write `HOW.PR` if a reusable pattern was discovered
  - update `PLAN.EX`
  - infer/write relationships where possible
- After final completion:
  - write `WHEN.RF`
  - update `PLAN.PJ` when relevant
  - extract durable facts into `WHAT` / `WHO` where justified

This lifecycle had a real bug during the Phase 13 transition: completed plans
were not being marked terminal, which caused active PLAN.EX accumulation and
false “Continue?” prompts on startup. The fix is now part of the architecture:
terminal plan states must always be persisted.

---

## Heartbeat (Background Process)

The heartbeat runs every 30 minutes when the agent is idle.
It does not respond to the user. It only reads and writes to memory.

### What heartbeat checks (in order)

```
1. WHEN notebook — any events or deadlines in next 24 hours?
   → if yes: queue a user notification

2. NOW notebook — any todos overdue? Also checks PLAN.PL with past due_date.
   → if yes: update status to 'overdue', flag in summary

3. WHY notebook — any open questions older than 3 days?
   → if yes: surface to user at next interaction

4. PLAN notebook — any planning entries needing calibration?
   → compare estimated vs actual time on completed tasks
   → update accuracy score

5. WHAT notebook — any active projects with no update in 7 days?
   → flag as stale, queue check-in question

6. Vision alignment — any active plans/projects misaligned with North Star vision?
   → queries WHY.MT entries with name LIKE '%North Star%'
   → compares active PLAN.PL and WHAT.PJ entries against vision keywords
   → excludes entries with 'refers' relationship to vision entry
   → if no keyword overlap and no relationship: flags vision_drift notification
   → if no vision entry exists: skips silently (no false positives)
```

### Rules for heartbeat
- Never modifies user-facing responses during a heartbeat run
- Writes findings to WHY.MT entries (meta reflections)
- Queues questions for the user — never interrupts
- If nothing needs action: does nothing, leaves no trace

---

## Skills System

Skills are loaded lazily. The full skill list is NOT injected into every prompt.

### How skills are loaded

```
Query arrives
→ Fast-path check (/log, /meeting, direct code fetch)
→ Decompose into semantic units
→ If agentic work exists: planner gets only relevant skill descriptions
→ Executor runs only the skills selected by the plan
→ Simple single-unit compatibility may directly invoke one skill when safe

"hello"                     → no skills loaded
"show active projects"      → no skills loaded
"build a REST API"          → planner sees skill catalog, selects steps
"write notes.txt with ..."  → compatibility shim may use file_writer directly
```

### Required skills (build in this order)

1. `memory_read` — fetch entries by code or query SQLite
2. `memory_write` — create or update entries + SQLite index
3. `web_search` — search the web (scoped, not default)
4. `file_read` — read files from the user's system
5. `file_write` — write files to the user's system
6. `run_code` — execute scripts

Do not build more until these six work correctly.

---

## Build Order

Build in this sequence. Do not jump ahead.
Each phase must work cleanly before the next begins.

### Phase 1 — Memory Foundation
- SQLite setup with both tables and all indexes
- Code generator (sequential, never reuse)
- Markdown file writer with frontmatter
- Basic fetch by code (direct path lookup)
- Basic SQLite query (index_entries filter)

**Done when:** agent can create a contact entry, store it, and retrieve it by code in under 50ms.

### Phase 2 — Relationships
- Relationship writer (add rows to relationships table)
- Relationship reader (query by from_code or to_code)
- Bidirectional traversal (follow a chain of relationships)

**Done when:** agent can answer "what does WHO.CT-000024 own?" using only the relationships table, no file reads.

### Phase 3 — Agent Core Loop
- Receive message
- Run fast-path bypass checks
- Decompose into semantic units
- Follow memory query flow (5 steps above, in order)
- Search memory per unit in parallel
- Route conversational/query/agentic work separately
- Load only relevant skills for the selected execution path
- Call LLM with lean context only where needed
- Write memory as part of milestone and post-execution flows
- Return response

**Done when:** simple queries ("what's the status of project Xray?") resolve in under 2 seconds with no hybrid search triggered.

### Phase 4 — Hybrid Search
- BM25 keyword search over markdown content
- Embedding model integration (local, via LM Studio or Ollama)
- Vector storage in SQLite (add chunks table)
- Merge BM25 + vector results
- Scoped search (notebook-level, not global)

**Done when:** vague queries ("find the ceramic color work") return correct results without the agent knowing the code in advance.

### Phase 5 — Heartbeat
- Background timer (30 min interval)
- Five notebook checks (as listed above)
- Notification queue
- Planning calibration logic

**Done when:** agent proactively surfaces a deadline or stale project without being asked.

### Phase 6 — MCP Skills Layer (COMPLETE)
- Universal MCP-compatible Skill interface (MCPSkill + SkillResult)
- Map-based registry with registerSkill / getSkill / getAllSkills / getSkillDescriptions
- Runner (runSkill) that never throws — errors contained in SkillResult
- Three skills built: calculator (mathjs), file_reader, web_search (DuckDuckGo API)
- Classifier extended with 'skill' intent + skill name + param extraction
- Skills self-register on import — adding a new skill touches zero existing files
- Skill output injected into context builder, passed through LLM
- web_search intent migrated from stub to live skill
- 42 new tests (181 total), pnpm build clean

**Done when:** all three skills work end-to-end through full agent loop, adding a 4th skill touches zero existing files, memory queries unchanged. DONE.

---

## What NOT to Build (Yet)

Do not build these until Phases 1-3 are solid:

- Multi-agent routing
- Web UI (use terminal or Telegram to start)
- Image or media handling
- Spatial/location memory (WHERE notebook)
- Cross-device sync
- Any cloud dependency

If scope creep appears — stop. Return to this file.

---

## LLM Configuration

- Default: local model via LM Studio or Ollama (OpenAI-compatible API)
- Fallback: Claude API (claude-sonnet-4-6) for complex reasoning tasks
- Embedding model: small local model for vectors (nomic-embed-text or similar)
- Never send full memory to LLM — only the entries the query flow resolved

### Context window discipline

```
What goes into every prompt:
- System prompt (lean, no skill list unless needed)
- Master index summary (just notebook names + entry counts)
- Resolved memory entries for this query (1-4 entries max for simple queries)
- Conversation history (last 6 turns only)
- Relevant skills (only those needed)

What never goes into a prompt:
- Full notebook contents
- All todos
- All projects
- Unrelated memory
- Search results beyond top 3
```

---

## Code Style and Standards

- Language: TypeScript
- Runtime: Node.js
- Database: better-sqlite3 (synchronous, simple, no async complexity)
- No ORM — write SQL directly, it is readable and debuggable
- No unnecessary abstractions in Phase 1-3
- Every function does one thing
- Every file has a clear single responsibility

---

## Testing Each Phase

Before marking a phase complete, verify:

**Phase 1:**
```
create entry → WHO.CT-000001 written to SQLite and markdown
fetch WHO.CT-000001 → returns correct file path
query "active contacts" → returns list with summaries
total time → under 50ms
```

**Phase 2:**
```
add relationship WHO.CT-000001 owns WHAT.PJ-000001
query "what does WHO.CT-000001 own?" → returns WHAT.PJ-000001 from table only
no file reads triggered
```

**Phase 3:**
```
send "what is the status of project Xray?"
→ memory query flow completes
→ SQLite answers without search
→ LLM receives lean context (< 500 tokens)
→ response returns in under 2 seconds
```

**Phase 4:**
```
send "find the work I did on ceramic colors"
→ hybrid search runs (scoped to WHAT notebook)
→ correct entry returned
→ no hallucination
```

**Phase 5:**
```
create a deadline for tomorrow
wait for heartbeat cycle
→ notification queued without being asked
```

---

## What Good Looks Like

When this is working correctly:

- A "hello" message triggers zero memory reads, zero searches, responds in under 1 second
- A known project status query reads one SQLite row and one markdown file
- A vague query triggers scoped hybrid search in one notebook only
- The agent surfaces a forgotten deadline before the user asks
- A contact entry contains enough relationship context to navigate a business network
- The LLM receives a context window that would fit comfortably in 2000 tokens for most queries

If any of these are failing — stop adding features and fix the foundation.

---

## Transition Notes (Legacy Intent Removal)

These notes override older classifier-first assumptions elsewhere in this file.

- `processMessage()` no longer begins with `classifyIntent()`. Runtime routing is
  decomposition-first.
- Old top-level routes such as greeting-only execution, `synthesis_query`, and
  explicit `relationship_write` are not primary runtime branches anymore.
- The compatibility shim is intentionally narrow and exists to preserve older
  tests and simple direct tool flows, not to decide overall message meaning.
- Bugs fixed during the transition:
  - PLAN.EX accumulation: completed/failed plans now persist terminal status
  - Compound routing loss: under-split messages now retry decomposition and avoid
    single-unit compatibility hijacking
- Context-then-task failure: resolved query units are injected into planning
  context instead of being ignored or treated as goals
- Conversational factual persistence is now best-effort after the reply:
  project starts, person-role clauses, project/person relationships, and
  deadlines can be written without a second LLM call
- Signal-based memory search no longer gets stuck on empty direct hits: if a
  person/project/procedure signal yields no entries, the runtime falls through
  to BM25/vector fallback instead of returning empty direct-search context
- Milestone revision now preserves executable steps even when the LLM revises
  remaining milestone ids/titles, so re-evaluation cannot silently drop the
  runnable tail of the plan
- Memory write integrity is file-first again in practice: markdown frontmatter
  now includes `due_date`, update paths rewrite the file before SQLite changes,
  and failed SQLite updates roll the file back instead of leaving markdown/DB
  drift
- Report-back skill prompts like “run X and tell me what happened” stay on the
  simple skill path rather than being over-upgraded into compound routing
- Existing-code repair is now a first-class skill behavior: executor reports
  like “Tests did not pass after 3 attempts” should only happen after both the
  implementation and the generated/reused tests have been given a chance to be
  repaired inside the loop

When in doubt, trust the current runtime flow above, not historical classifier
descriptions from earlier implementation phases.

## Performance Targets

LLM response times depend on model size. These are the realistic targets
for local inference on Mac Studio hardware:

| Model size | Acceptable response | Warning threshold | Abort timeout |
|------------|--------------------:|------------------:|--------------:|
| 70B+       | under 60s           | over 45s          | 90000ms (90s) |
| 7B–14B     | under 10s           | —                 | 20000ms (20s) |
| 1B–4B      | under 5s            | —                 | 10000ms (10s) |

These timeouts are configured in `config/agent.config.ts` (`getTimeoutForModel`).
The primary LLM call in `core/llm.ts` uses the configured timeout and logs
a warning when the model is still processing near the threshold.

Non-LLM operations (memory reads, SQLite queries, file fetches) should
complete in under 50ms. If they don't, fix the foundation before adding features.

---

## Known Gaps (non-blocking)

- **Resolver step-attempt logging:** The 5-step query flow executes in the correct order (verified by tests), but does not emit per-step diagnostic logs. Useful for debugging but not a functional requirement. Defer to Phase 4 or add when needed for troubleshooting.

## Known Gap: Embedding Model Migration

If the embedding model is changed in .env,
all existing embeddings in the chunks table become invalid.
Different models produce incompatible vector spaces.
To rebuild: `DELETE FROM chunks;` then restart agent.
Agent will re-embed all entries on next write or query.
A migration script will be added in a future phase.
Do not change EMBEDDING_MODEL without rebuilding the index.

---

## Phase 6 — Thanks

Phase 6 adds a universal skills layer. Three skills (calculator, file_reader, web_search)
work end-to-end through the full agent loop. The architecture is MCP-compatible:
every skill implements one interface, self-registers on import, and adding a new skill
requires creating one file and one import line — zero changes to agent.ts, intent.ts,
or runner.ts. Memory queries are untouched. 181 tests pass. The foundation holds.

---

## Phase 7 — ReAct Loop + Structured Outputs + Planning (COMPLETE)

Phase 7 adds three capabilities:

### ReAct Self-Correction Loop (`core/react.ts`)
- `runWithRetry(skillName, input, handler, maxRetries=3)` — retries failed skills with LLM-based input repair
- `repairSkillInput()` — asks LLM to fix a failed skill input, never throws
- Memory write path retries up to 2 times on invalid LLM JSON responses
- `retries` field added to `AgentResponse` for observability

### Structured Outputs via JSON Schema (`core/schemas.ts`)
- Zod v4 schemas for `WriteEntrySchema` with `z.toJSONSchema()` for LM Studio `response_format`
- `LLMHandler` accepts optional `{ responseSchema }` — backwards compatible
- `callLLM` passes `response_format: { type: 'json_schema', ... }` to primary (LM Studio) endpoint
- Memory write path validates LLM response with `WriteEntrySchema.safeParse()` first, falls back to regex extraction
- Dependency: `zod` (zod v4 has built-in JSON schema conversion, no `zod-to-json-schema` needed)

### Basic Planning + Vision Alignment
- `checkVisionAlignment()` — CHECK 6 in heartbeat: detects plans that don't align with North Star vision
- `checkOverdueTodos()` extended to also flag overdue `PLAN.PL` entries with past `due_date`
- `classifyIntent()` extracts `due_date` from messages ("due 2025-03-15", "due tomorrow", "due next week")
- `due_date` passes through agent write path to `createEntry()`
- `due_date` column documented in `index_entries` schema

### Files added/modified
- `core/react.ts` (NEW) — ReAct retry loop
- `core/schemas.ts` (NEW) — Zod schemas + JSON schema
- `core/types.ts` — `retries` in AgentResponse, `due_date` in Classification, `LLMHandler` options
- `core/agent.ts` — skill retry via `runWithRetry`, write retry loop, Zod validation, due_date pass-through
- `core/llm.ts` — `responseSchema` parameter in `callPrimary` and `callLLM`
- `core/heartbeat.ts` — `checkVisionAlignment` (CHECK 6), overdue PLAN.PL, `vision_drift` notification type
- `core/intent.ts` — `extractDueDate()` with ISO/tomorrow/next-week patterns

226 tests pass (202 existing + 24 new). Build clean.

---

## Phase 9 — Planner + Executor Loop (COMPLETE)

Phase 9 implements the agentic planning and execution system that enables multi-step task decomposition and autonomous execution.

### Architecture Components

**Complexity Detector (`core/planner.ts`)**
- `isComplexTask()` — 2-tier detection: fast heuristic patterns (multiStep, multiFile, fileAndRun, etc.) + LLM fallback for ambiguous cases
- Returns `ComplexityResult` with reason, estimated steps, and required skills
- Sub-100ms for most queries via regex patterns, only calls LLM when unclear

**Task Decomposer (`core/planner.ts`)**
- `decomposeTask()` — converts user request into structured `TaskPlan` with up to 8 steps
- Uses Zod schemas with `z.toJSONSchema()` for LM Studio structured output
- `resolveTemplates()` — replaces `{{stepN_result}}` patterns with actual outputs
- Retry logic with up to 3 attempts if JSON validation fails
- Max tokens increased to 4096 to handle large file content in plans

**Executor Loop (`core/executor.ts`)**
- `executePlan()` — iterates steps in order, checks dependencies, calls skills via `runWithRetry()`
- `flattenInput()` — handles nested objects from LLM responses before skill execution
- 100ms delay between steps, 5-minute total timeout
- Returns `ExecutionResult` with completed/failed steps

**Execution Verification (`core/executor.ts`)**
- `verifyExecution()` — LLM validates if plan goal was achieved
- Returns `VerificationResult` with confidence score, issues, suggestions
- Advisory only — never re-executes on failure

**User Report (`core/executor.ts`)**
- `buildUserReport()` — formats results with icons (Done/Warning), brief step outputs, failure messages
- Under 300 words, includes memory codes if created
- Strips thinking tags from reasoning models

### Model Compatibility Journey

Tested with multiple local models via LM Studio:

**GLM 7B Flash** (`zai-org/glm-4.7-flash`)
- ✅ Fast: 10-20s per attempt
- ❌ Poor quality: generates `"path": false` instead of actual filenames
- ❌ Creates wrong/empty files

**Qwen 32B Kimi K2** (`qwen3-32b-kimi-k2-thinking-distill-i1`)
- ✅ Better quality: actual HTML content
- ❌ Slow: 60-70s per attempt
- ❌ JSON parsing fails: generates `{"path\":\"index.html\"}` with escaped quotes inside JSON

**GPT OSS 20B** (`openai-gpt-oss-20b`)
- ❌ Same JSON escaping issue as Qwen 32B
- ❌ Slow: 37-38s per attempt
- ❌ 400 errors on some invocations

**Qwen 3.5 35B** (`qwen/qwen3.5-35b-a3b`) — **CURRENT**
- ✅ Fast: 21-31s per attempt (faster than Qwen 32B)
- ✅ Proper JSON formatting: no escaped quote issues
- ✅ Better quality than GLM 7B
- ⚠️ Nests input structures: `{"path": {"index.html": "..."}}` instead of flat
- ✅ **WORKING** after sanitizer improvements

### JSON Sanitization Strategy (Model-Agnostic)

Built robust sanitizer that handles common LLM output issues:

1. **Remove thinking tags** — `<think>...</think>`, `<|im_start|>`, `<|im_end|>`
2. **Fix escaped quotes at boundaries** — `{\"` → `{"`, `:\"` → `:"`, `\"}` → `"}` (but preserve valid escapes inside strings)
3. **Compact pretty-printed JSON** — Remove newlines/indentation outside string values to prevent embedded content from breaking parsing
4. **Flatten nested path objects** — Manual parser detects `"path": {"filename": "content"}` and converts to `{"path": "filename", "content": "content"}`
5. **Increase token limit** — maxTokens: 1024 → 4096 to prevent response truncation

### Known Issues (Resolved in Phase 9.2)

**Pervasive Nested Structure Problem (RESOLVED)**
- General `flattenSingleKeyObjects()` now handles ALL fields, not just `path`
- Depth limit of 10 prevents infinite recursion
- `extractFirstJsonObject()` bracket-depth counter prevents double-JSON merges

**Plan Quality Issues (RESOLVED)**
- `cleanCode()` in `implement_and_test.ts` strips LLM preamble sentences
- `stripThinkingTags()` fully rewritten to handle all known reasoning model artifacts

### Test Results (5-Test Suite)

Ran with Qwen 3.5 35B on 2026-02-26:

1. **Build Landing Page** — ✅ SUCCESS (43s, planned_workflow, file created)
2. **Search & Download Image** — ⚠️ PARTIAL (40s, planner works, invalid bash command)
3. **Create React Starter** — ⚠️ PARTIAL (18s, nested input issue)
4. **Portfolio from Memory** — ✅ SUCCESS (25s, personalized content)
5. **Node.js REST API** — ✅ SUCCESS (18s, correctly classified as simple task)

**3/5 complete success, 2/5 partial** — Architecture functional, plan quality needs improvement.

### Integration Points

- Wired into `core/agent.ts` after greeting detection, before memory_write
- Falls through to normal flow if planning fails
- Added `'planned_workflow'` intent type to `core/types.ts`
- Planning prompt includes skill descriptions from registry
- Executor uses existing `runWithRetry()` from `core/react.ts`

### Files Added/Modified

**New Files:**
- `core/planner.ts` — Complexity detection, task decomposition, JSON sanitization
- `core/executor.ts` — Plan execution loop, verification, user report

**Modified Files:**
- `core/schemas.ts` — TaskStepSchema, TaskPlanSchema, VerificationResultSchema
- `core/types.ts` — Added `'planned_workflow'` intent
- `core/agent.ts` — Wired planner/executor pipeline
- `config/agent.config.ts` — Added PLANNER_CONFIG, EXECUTOR_CONFIG, timeout for 20B/35B models
- `.env` — Added PLANNER_MODEL, EXECUTOR_MODEL, DEBUG_PLANNER

### Configuration

```env
LLM_MODEL=qwen/qwen3.5-35b-a3b
PLANNER_MODEL=qwen/qwen3.5-35b-a3b
EXECUTOR_MODEL=qwen/qwen3.5-35b-a3b
DEBUG_PLANNER=true
```

Timeout configuration recognizes 20B/35B models (90s), 7B-14B models (20s), 1B-4B models (10s).

Build clean. Architecture proven functional with model-agnostic sanitization. All known issues resolved in Phase 9.2 Audit Sprint.

---

---

## Fix Sprint — 2026-03-02 (COMPLETE)

Five targeted fixes applied to resolve persistent bugs in the planner/executor loop.

### Completed Fixes

**FIX 1 ✅ — `relationship_write` canonical resolution**
- SQL-direct entity lookup: `LOWER(name) = LOWER(?)` exact + `LIKE` fuzzy, `ORDER BY updated DESC LIMIT 1`
- Stable even with 15+ duplicate names

**FIX 2 ✅ — `content_writer` format contract**
- Added `format: "markdown"|"html"|"plain"` parameter
- `validateFormat()` + retry on violation; fallback with warning

**FIX 3 ✅ — `implement_and_test` skill**
- New skill: collapses write→test→fix→retry loop into 1 plan step
- Handles all code generation/execution internally; writes HOW.PR on success

**FIX 4 ✅ — Planner grounding for comparison tasks**
- `COMPARISON TASK RULES` block added to planner prompt

**FIX 5 ✅ — Dedupe on `memory_write`**
- `upsertEntry()` in `core/memory/write.ts` — checks nb+type+name before creating
- `memory_write` output is now bare code (`WHO.CT-XXXXXX`) for template use
- `display` field added to `SkillResult` for human-readable output in reports

### Architecture Changes
- `SkillResult` now has optional `display?: string` field — machine output (`output`) vs human display (`display`) are separated
- `CompletedStep` in `executor.ts` stores `display` and uses it in `buildUserReport`

### Test Results (2026-03-02)
| Test | Score |
|------|-------|
| Test 3: Search → Compare → Save | 5/5 ✅ |
| Test 4: Fibonacci implement+test loop | 5/5 ✅ |
| Test 5: Full 7-op pipeline | 7/7 ✅ |

---

## Phase 9.2 — Audit & Hardening Sprint (COMPLETE)

Full audit of the planner/executor pipeline following the Fix Sprint. 29 bugs identified (8 critical, 9 high, 11 medium, 1 low). All critical and high issues resolved. 377 tests pass.

### Transparency Bus (BUG 14, 18, 19, 20)

`core/transparency.ts` — event emitter singleton now fully wired across the pipeline:

| Event | Emitted from | When |
|-------|-------------|------|
| `intent` | `core/agent.ts` | after `classifyIntent()` |
| `complexity` | `core/planner.ts` | at every `isComplexTask()` return point |
| `plan` | `core/planner.ts` | after Zod validation succeeds in `decomposeTask()` |
| `step_start` | `core/executor.ts` | before each skill execution |
| `step_result` | `core/executor.ts` | after each skill execution with elapsed ms |
| `llm_request` | `core/llm.ts` | before LLM call with system/messages/schema |
| `llm_raw` | `core/llm.ts` | raw model output with elapsed ms |
| `llm_stripped` | `core/llm.ts` | after `stripThinkingTags()` |
| `memory_write` | `core/memory/write.ts` | already present |

Enable with `TRANSPARENT=true npx tsx chat.ts`. Overhead: ~0.004ms per event (negligible).

### FIX 1 — `extractFirstJsonObject()` (planner.ts)

Bracket-depth counter replaces naive `indexOf('{')` + `lastIndexOf('}')`.
Stops at the first complete JSON object — prevents two concatenated JSON objects from merging into an unparseable blob.

```typescript
function extractFirstJsonObject(text: string): string | null {
  let depth = 0, start = -1, inString = false, escape = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (escape) { escape = false; continue; }
    if (char === '\\' && inString) { escape = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '{') { if (depth === 0) start = i; depth++; }
    else if (char === '}') { depth--; if (depth === 0 && start !== -1) return text.slice(start, i + 1); }
  }
  return null;
}
```

`sanitizePlannerJson()` now calls this first, then sanitizes the extracted object only.

### FIX 2 — `validateFormat()` HTML allowlist (content_writer.ts)

Replaced broad `/<[a-z][a-z0-9]*[\s/>]/i` (which matched TypeScript generics like `<T>`) with an explicit allowlist of real HTML tag names. Code blocks stripped before checking to prevent false positives on inline code.

```typescript
const HTML_TAG_PATTERN = new RegExp(
  '<(html|head|body|div|span|p|a|br|hr|h[1-6]|ul|ol|li|table|tr|td|th|' +
  'section|article|nav|header|footer|main|aside|form|input|button|select|' +
  'script|style|link|meta|title|strong|em|b|i|u|code|pre|blockquote|img|' +
  'figure|figcaption|video|audio|canvas|svg)[\\s/>]', 'i'
);
```

Empty-output guard added: if output is < 10 chars after stripping, retries with a prefix-forcing prompt. Returns `{ success: false }` if the retry also produces only an artifact.

### FIX 3 — `stripThinkingTags()` full rewrite (llm.ts)

Handles all known reasoning model artifacts:
- `<think>...</think>` blocks (complete and orphaned tags)
- `<|im_start|>` / `<|im_end|>` LM Studio tokens
- `Thinking Process:` + numbered step blocks
- Artifact-only output (`/^\d+\.?\s*$/` → returns `''`)
- Opening preamble sentences (`Let me`, `I need to`, `The user wants`, etc.)
- Extended thinking artifacts (`**Constraint Checklist`, `Confidence Score:`, `**Mental Sandbox`, `**Analyze`)

### FIX 4 — `upsertEntry()` atomic transaction (write.ts)

DB update + markdown file rewrite now execute inside a single SQLite transaction.
FTS re-index runs after the transaction commits (outside the transaction to avoid locking issues).

### FIX 5 — Direct memory_write path dedup (agent.ts)

The direct `memory_write` intent path in `agent.ts` was calling `createEntry()` directly, bypassing dedup.
Now uses `upsertEntry()`. Response distinguishes "Created" vs "Updated" and returns the full entry for `resolved` field.

### System Prompt — Skill Mandate (context.ts)

`SYSTEM_PROMPT` updated to make skill usage mandatory with explicit hard rules per skill domain. Prompt kept at 403 tokens (within the 407-token budget required by token tests).

```
Use skills for their domains. Never substitute your own reasoning:
- calculator: ANY math. Never compute directly.
- web_search: ANY current events or real-time data. Never answer from training.
- file_reader: ANY file read. Never invent contents.
- run_bash: ANY commands. Never simulate output.
- memory_read: ANY user data or saved entries. Never guess.
Use skills. No exceptions.
```

### Other Fixes

| Bug | File | Fix |
|-----|------|-----|
| Orphaned `<think>` opening tags | `core/llm.ts` | Added explicit removal pass |
| `cleanCode()` preamble leakage | `core/skills/tools/implement_and_test.ts` | Strips leading `Let me / I need to / I will / I can see / I should / Let's` lines |
| `upsertEntry` FTS not re-indexed on update | `core/memory/write.ts` | `indexContent()` called after update transaction |
| `flattenSingleKeyObjects()` recursion | `core/planner.ts` | Depth limit of 10 |

### Test Results
- 377/377 tests pass
- Build: zero TypeScript errors
- Token budgets verified: system prompt 403 tokens, simple query 406 tokens total, P1D 1496 tokens total

---

## Phase 10 — Intelligence Layer (COMPLETE)

Phase 10 adds six intelligence capabilities. 420 tests pass. Build clean.

### P1: Git-backed memory versioning (`core/memory/versioning.ts`)
- `getGit()` — lazy init, creates git repo in `PATHS.memory`, sets `user.name = 'AgenticAGI'`, commits existing files as `init: initial memory state`
- `commitMemoryWrite(code, name, source)` — `git add . && git commit` with format `${code}: ${name} [${source}]`; fire-and-forget in `write.ts`
- `getEntryHistory(code)` — `git log --` scoped to matching files, returns `[]` on failure
- `rollbackEntry(code, commitHash)` — git show + file restore + re-upsert
- `memory_history` skill registered — get history or rollback a memory entry
- `.gitignore` updated: `memory/.git`

### P2: Generalized structured output pipeline (`core/structured.ts`)
- `extractFirstJsonObject(text)` — bracket-depth counter (moved from planner.ts, still used there)
- `flattenSingleKeyObjects(value)` — recursive flattener (moved from planner.ts)
- `applyRepairPasses(raw)` — strips think tags, fixes trailing commas, fixes escaped quotes
- `parseStructured<T>(raw, schema, options)` — extract + repair + validate with optional LLM-assisted repair

### P3: Context orchestrator (`core/context.ts`)
- `trimHistoryToTokenBudget(history, budget)` — walks backwards consuming tokens until budget exceeded; used in Step 1 degradation
- `rankByRelevance(entries, message)` — 60% name word overlap + 40% recency over 30 days; applied before `formatResolved()`
- `context_built` transparency event emitted after every `buildContext()` call with `{ tokens, sections }`
- Backwards-compatible: existing `buildContext()` signature unchanged

### P4: Episodic memory + HOW auto-write
- `writeEpisodicMemory(plan, result, verification)` in `executor.ts` — writes HOW.PR when 2+ steps completed AND verified; fire-and-forget in `agent.ts`
- `findRelevantProcedure(message)` in `planner.ts` — queries HOW.PR entries, returns body if name similarity ≥ 0.3; prepended to planner prompt

### P5: Embedding migration detection (`core/memory/search.ts`)
- `hashModel(name)` — char-code sum hash for model name
- `checkEmbeddingMigration()` — compares stored vs current hash; warns + calls `reIndexAllEntries()` on mismatch
- `reIndexAllEntries()` — re-indexes all non-archived entries via `indexContent()`; per-entry errors silently ignored
- `initDatabase()` seeds `embedding_model_hash` counter row and runs check async (never blocks init)

### P6: A2A Agent Card
- `agent-card.json` at project root — A2A/1.0 protocol spec with capabilities, notebooks, planning config
- `core/agent-card.ts` — `getAgentCard()` + `updateAgentCard()` (syncs skills from registry)
- `startAgent()` calls `updateAgentCard()` to keep skills list current

### Dependencies added
- `simple-git` (^3.x) — only new dependency

### Test Results
- 420/420 tests pass (43 new Phase 10 tests)
- Build: zero TypeScript errors

---

## Phase 10 Hardening Sprint (COMPLETE)

10 risk areas audited. 5 bugs fixed, 2 tests-only validations, 3 code-level confirmations. 437 tests pass.

### BUG-1 (LOW) — commitMemoryWrite fire-and-forget contract
Confirmed by test: `commitMemoryWrite` always returns a Promise. Callers use `.catch(err => console.warn(...))` — non-blocking.

### BUG-2 (MEDIUM) — fire-and-forget error logging
`write.ts` and `agent.ts` `.catch(() => {})` upgraded to `.catch(err => console.warn(...))`. Failures now visible in stderr without blocking writes.

### BUG-3 (LOW) — writeEpisodicMemory explicit guard
`!verification.verified` changed to `verification.verified !== true` in `executor.ts:376`. Rejects `undefined`/`null`/non-boolean truthy values explicitly.

### BUG-4 (HIGH) — findRelevantProcedure false positives
`score = overlap / nameWords.length` → `score = overlap / Math.max(msgWords.size, nameWords.length)` in `planner.ts`. Short messages no longer score 1.0 against long entry names.

### BUG-5 (LOW) — rankByRelevance denominator
Same fix applied to `rankByRelevance` in `context.ts` (already implemented in Phase 10, confirmed by test).

### BUG-6 (HIGH) — trimHistoryToTokenBudget drops last message
Fixed to always include at least the most recent message even when it alone exceeds the token budget. Now exported for testing.

### BUG-7 (HIGH) — hashModel collision risk
Replaced char-code sum hash with full model name string stored in new `settings` table (`key TEXT, value TEXT`). Strings like "ab" and "ba" now correctly detected as different models. `initDatabase()` creates `settings` table.

### BUG-8 (LOW) — updateAgentCard throws on missing file
`getAgentCard()` returns `DEFAULT_CARD` on file read failure instead of throwing. `updateAgentCard()` can safely create the card from scratch.

### BUG-9, BUG-10 (test-only)
Confirmed by source inspection: 2000-char skill output cap and `HARD_CEILING` truncation logic both present in `context.ts`.

### Phase 3 test cleanup fix
`afterAll` in `tests/phase3/agent.test.ts` now calls `_resetGitInstance()` and waits 100ms before `rmSync` to prevent `ENOTEMPTY` from in-flight git commits.

### Files modified
- `core/context.ts` — exported `trimHistoryToTokenBudget`, `rankByRelevance`
- `core/executor.ts` — BUG-3 fix
- `core/planner.ts` — BUG-4 fix
- `core/memory/write.ts` — BUG-2 fix
- `core/agent.ts` — BUG-2 fix
- `core/agent-card.ts` — BUG-8 fix + DEFAULT_CARD constant
- `core/memory/search.ts` — BUG-7: settings table string comparison
- `core/memory/index.ts` — BUG-7: settings table DDL
- `tests/phase10/hardening.test.ts` — 17 new tests
- `tests/phase3/agent.test.ts` — cleanup fix

### Test Results
- 437/437 tests pass (17 new hardening tests)
- Build: zero TypeScript errors
- Tag: `phase-10-hardened`

---

## Phase 10 Hardening Sprint — Round 2 (COMPLETE)

15 bugs fixed (4 CRITICAL, 6 HIGH, 5 MEDIUM). 467 tests pass. Build clean.

### BUG-C1 (CRITICAL) — rollbackEntry restores exact original code
`versioning.ts` no longer calls `upsertEntry()` after restoring a file. Instead it reads the `code` field from the restored frontmatter and either UPDATEs the existing row or INSERTs with the EXACT original code via `insertEntry()`, bypassing the sequential counter. Broken import (`upsertEntry`) replaced with `insertEntry` + direct DB update.

### BUG-C2 (CRITICAL) — SQLite transaction before file write
`createEntry()` order reversed: SQLite transaction runs first, file write runs second. If file write fails after commit, the error is logged but does not throw — the index row is valid and can be repaired. Previous order (file first) left orphaned files on kill-between-operations.

### BUG-C3 (CRITICAL) — Unique constraint prevents concurrent duplicate entries
Added `CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_entry ON index_entries(nb, type, LOWER(name)) WHERE status != 'archived'` in `initDatabase()`. Safe to run on existing databases. Two concurrent `upsertEntry` calls with the same name now produce exactly one entry.

### BUG-C4 (CRITICAL) — upsertEntry recreates missing Markdown file
In the existing-row branch of `upsertEntry()`, added `fs.existsSync(entry.path)` check. If the file is missing, treats it as a create: writes a new file, updates the SQLite row with the new path. Same code is returned — no duplicate created.

### BUG-H1 (HIGH) — Executor enforces dependency ordering
`executePlan()` now explicitly handles unmet dependencies that are not yet completed and not failed: marks the blocked step as BLOCKED (with appropriate error), adds it to `failed[]`, continues for optional steps or aborts for required steps. Previously fell through and executed anyway.

### BUG-H2 (HIGH) — rankByRelevance was dead code
Moved `rankByRelevance()` call to BEFORE `formatResolved()` in `buildContext()`. Previously ranking was applied after the already-formatted system prompt was constructed — result was discarded. Now the most relevant entries appear first in the injected context.

### BUG-H3/H4 (HIGH) — applyRepairPasses preserves valid JSON
Added fast-path guard at the start of `applyRepairPasses()`: `try { JSON.parse(raw); return raw; } catch {}`. If input is already valid JSON, returns immediately without any repairs. This prevents unquoted-key regex from corrupting `{key: val}` patterns inside string values, and prevents think-tag stripping from deleting content inside JSON strings.

### BUG-H5 (HIGH) — reIndexAllEntries idempotent; indexContent delete-then-insert
`indexContent()` now runs `DELETE FROM fts_content WHERE code = ?` before INSERT, making individual updates idempotent. `reIndexAllEntries()` runs `DELETE FROM fts_content` before the full rebuild — no more doubling on repeated migrations.

### BUG-H6 (HIGH) — reIndexAllEntries clears stale chunk vectors
`reIndexAllEntries()` now runs `DELETE FROM chunks` after clearing FTS rows. Stale vectors from the old embedding model are removed. System falls back to BM25-only until vectors are regenerated by new writes (rather than silently using incompatible vectors).

### BUG-M1 (MEDIUM) — trimHistoryToTokenBudget preserves last 2 turns
Rewrote to always include at least the last 2 messages (1 user + 1 assistant turn) regardless of token budget. Additional messages added if budget allows.

### BUG-M2 (MEDIUM) — parseStructured loops LLM repair correctly
Replaced single-attempt repair branch with a `while (attempts <= maxRepairs)` loop. Each iteration calls `llmRepair()`, extracts and validates, breaks on success or when budget exhausted.

### BUG-M3 (MEDIUM) — extractFirstJsonObject ignores leading unmatched `}`
Added `if (depth < 0) { depth = 0; continue; }` guard. Unmatched closing braces before any `{` are now ignored, not corrupting the depth counter for subsequent valid JSON.

### BUG-M5 (MEDIUM) — initDatabase closes existing connection
Added `if (db) { try { db.close(); } catch {}; db = null; }` at the start of `initDatabase()`. Calling `initDatabase(pathA)` then `initDatabase(pathB)` no longer leaks the first connection.

### BUG-M6 (MEDIUM) — due_date preserved in Zod write path
Added `due_date?: string` to `writeData` type in `agent.ts`. Zod-parsed branch now includes `due_date: zodResult.data.due_date` in the writeData mapping. LLM-extracted due_date is no longer silently dropped when structured output validation succeeds.

### Files modified
- `core/memory/versioning.ts` — BUG-C1
- `core/memory/write.ts` — BUG-C2, BUG-C4
- `core/memory/index.ts` — BUG-C3 (unique index), BUG-M5 (close on reinit)
- `core/memory/fts.ts` — BUG-H5 (delete-then-insert in indexContent)
- `core/memory/search.ts` — BUG-H5 (clear FTS), BUG-H6 (clear chunks)
- `core/executor.ts` — BUG-H1
- `core/context.ts` — BUG-H2 (rank before format), BUG-M1 (2-turn minimum)
- `core/structured.ts` — BUG-H3/H4 (valid JSON early return), BUG-M2 (repair loop), BUG-M3 (clamp depth)
- `core/agent.ts` — BUG-M6
- `tests/phase10/hardening-r2.test.ts` — 30 new tests

### Test Results
- 467/467 tests pass (30 new Round 2 hardening tests)
- Build: zero TypeScript errors
- Tag: `phase-10-hardened-r2`

---

## Phase 11 — Project Brain, Autonomous Execution & Meeting Mode (COMPLETE)

Phase 11 adds eight capabilities. 587 tests pass. Build clean.

### Pre-Flight Schema Changes

- `config/agent.config.ts` — Added `PATHS.workspace`, `PATHS.logs`, `PATHS.projects`; extended `TYPE_MAP` with 9 new types: `WHEN.EV`, `WHEN.RF`, `WHEN.HX`, `HOW.SK`, `PLAN.EX`, `PLAN.CT`, `PLAN.MS`, `PLAN.PJ`, `NOW.LOG`
- `core/memory/index.ts` — Added 12 new columns to `index_entries`: `importance_score`, `utility_score`, `usage_count`, `last_accessed`, `decay_rate`, `active_page`, `pinned`, `privacy_tier`, `source`, `confidence`, `atomic_facts`, `embedding`; added indexes `idx_importance`, `idx_active_page`, `idx_privacy`

### P1: PLAN.PJ Project Brain (`core/memory/project.ts`)
- `ProjectEntry` interface with `vision`, `phase`, `blocked_by`, `priority`, `last_worked`
- `createProjectEntry()` — creates PLAN.PJ entry + workspace overview markdown in `PATHS.projects/`
- `getActiveProjects()`, `updateProjectEntry()`, `parseProjectEntry()`
- `checkStalePlanPJ()` in `core/heartbeat.ts` — detects PLAN.PJ entries not updated in 7+ days; adds `stale_project_brain` notification type

### P2: PLAN.EX Execution State + Execution Log (`core/memory/plan-ex.ts`, `core/memory/execution-log.ts`)
- `PlanEXEntry` interface: milestones, todos, conf_score, session_id, checkpoint_ts, attempt_counts, last_failures, recent_turns, loaded_memory_utility, file_checksums
- `createPlanEX()`, `updatePlanEX()`, `loadActivePlanEX()`, `savePlanEX()`, `validateChecksums()`
- `ExecutionRecord` interface: JSONL-based execution log at `workspace/logs/execution-{YYYY-MM-DD}.jsonl`
- `logExecution()` (fire-and-forget), `readExecutionLog()`
- `classifyFailure()` in `core/executor.ts` — classifies errors as `SYNTAX_ERROR`, `STATE_ERROR`, or `CAPABILITY_ERROR`
- `failure_classified` transparency event emitted after each failed step

### P3: Episodic Memory (`core/memory/episodic.ts`)
- `writeEpisodicEvent()` → WHEN.EV, `writeReflection()` → WHEN.RF, `compactEpisodicHistory()` → WHEN.HX, `detectMacroSkills()` → HOW.SK
- `episodic_query` intent added — routes to WHEN notebook search
- `EPISODIC_QUERY_PATTERNS` in `core/intent.ts` — tightened to prevent false positives

### P4: Memory Lifecycle (`core/memory/lifecycle.ts`)
- `NOTEBOOK_DECAY_RATES` — NOW=0.3 (highest), WHEN=0.2, WHAT=0.1, WHO=0.05, HOW=0.03, PLAN=0.02, WHY=0.01 (lowest)
- `computeDecayScore(entry, now)` — exponential decay: S(t) = importance × e^(-decay × days) + usage × 0.1 × e^(-decay × days)
- `runDecayCycle()` — updates `importance_score` and `active_page` (entries below threshold become inactive page)
- `updateUtilityScore(code, delta)` — clamps to [0.1, 10.0], increments `usage_count`, sets `last_accessed`
- `extractMemoryMetadata(code, body, summary, llm)` — LLM-based atomic fact extraction (fire-and-forget)
- `resolveConflict(existing, incoming, llm)` — triggers only when name similarity > 0.6; returns `APPEND_NEW`, `SUPERSEDE_OLD`, or `MERGE_FACTS`

### P5: LightRAG Relevance + RRF (`core/context.ts`, `core/memory/search.ts`)
- `rankByLightRAG(entries, message)` — BM25F scoring (NAME_WEIGHT=5, SUMMARY_WEIGHT=3, k1=1.2, b=0.75) + recency decay + importance/utility boost + active_page boost + pinned boost
- `rankByRelevance` kept as alias
- Context compaction at 70% token budget — drops inactive-page entries while protecting PINNED messages
- `context_compacted` transparency event emitted with `{ before, after }` token counts
- `reciprocalRankFusion(bm25, vector, k=60)` in `core/memory/search.ts` — tie-breaking uses best original score (vector scores weighted 1.01× for semantic preference)
- `computeAndStoreEmbedding(code, text)` in `core/memory/embeddings.ts` — Ollama endpoint, BLOB storage, no-op when unconfigured

### P6: Enhanced Planner (`core/planner.ts`)
- `ComplexityLevel` type: `'LOW' | 'MEDIUM' | 'HIGH' | 'MAX'`
- `assessComplexity(message, classification)` — multi-signal heuristic returning `{ level, estimatedSteps, reason }`
- `isComplexTask()` remains as backward-compatible wrapper
- `extractThought(text)` — extracts `<thought>...</thought>` blocks from LLM output
- `verifyPlanAssertions(plan, llm)` — post-plan assertion checking; returns `{ passed, failedAssertions }`
- `planner_reasoning` transparency event with extracted CoT thought
- `confidence_score` (0-1, default 0.8) and `risk_level` ('LOW'|'MED'|'HIGH', default 'LOW') fields added to `TaskStepSchema`
- `HIGH_RISK_LOW_CONFIDENCE` abort in `executePlan()` — aborts when `confidence_score < 0.75` AND `risk_level === 'HIGH'`

### P7: Meeting Mode (`core/meeting.ts`)
- `MeetingBriefing` interface: `{ prompt, context, suggestedUpdates }`
- `runMeetingMode(history, llm)` — gathers memory (todos, projects, upcoming events), generates structured briefing
- `processMeetingResponse(response, briefing, llm)` — extracts updates from user response, writes NOW.LOG entries
- `meeting` intent added — classified from `/meeting` command or "start meeting mode" phrase
- `/log` prefix intent — creates NOW.LOG entry directly from message
- `meeting_complete` transparency event
- `NOW.LOG` added to TYPE_MAP

### P8: Autonomous Execution Loop (`core/autonomous.ts`, `core/skills/tools/verify_state.ts`)
- `runAutonomousLoop(projectCode, llm)` — drives milestone execution via PLAN.EX state machine; returns `AutonomousResult { completed, pauseReason }`
- `withRollback<T>(operation, rollback, verify)` — runs operation, calls rollback on failure or verify failure, throws with reason
- `commitCheckpoint(planEx)` — saves `checkpoint_ts` to PLAN.EX entry
- `verify_state` MCP skill — validates `file_write`, `memory_write`, `run_bash` outcomes; optional `expected` content check
- `saga_rollback` and `linker_pass` and `project_transition` transparency events added

### Versioning Stability Fix (`core/memory/versioning.ts`)
- Added `generation` counter — incremented on `_resetGitInstance()` to invalidate all in-flight commit operations
- Added `pendingCommits` set — tracks in-flight commit promises for `_drainGitCommits()`
- `isTempPath` detection — skips git init/commit for `/tmp/` and macOS temp paths (`/var/folders/`) to prevent cleanup races in tests
- Exported `_drainGitCommits()` — awaits all pending commits before filesystem cleanup

### New Files
- `core/memory/project.ts` (PLAN.PJ Project Brain)
- `core/memory/execution-log.ts` (JSONL execution log)
- `core/memory/plan-ex.ts` (PLAN.EX execution state)
- `core/memory/episodic.ts` (WHEN.EV/RF/HX episodic memory)
- `core/memory/lifecycle.ts` (decay, utility, conflict resolution)
- `core/meeting.ts` (Meeting Mode)
- `core/autonomous.ts` (Autonomous Execution Loop)
- `core/skills/tools/verify_state.ts` (verify_state skill)
- `tests/phase11/p1-project.test.ts` through `p8-autonomous.test.ts` (120 new tests)

### Test Results
- 587/587 tests pass (120 new Phase 11 tests)
- Build: zero TypeScript errors
- Tag: `phase-11-complete`

---

## Phase 11 Hardening Sprint

12 known bugs fixed. All tests pass. Build clean.

### Bug Fixes

**Bug 1 — `savePlanEX` duplicates** (`core/memory/plan-ex.ts`)
- Before calling `createPlanEX`, check DB for existing PLAN.EX by task_name.
- If found, call `updatePlanEX` instead. No more duplicate entries on repeated saves.

**Bug 2 — `loadActivePlanEX` race** (`core/memory/plan-ex.ts`)
- When multiple active PLAN.EX entries exist, reads `checkpoint_ts` from each file body and sorts DESC.
- Emits `error` transparency event as warning when count > 1.

**Bug 3 — `compactEpisodicHistory` premature archive** (`core/memory/episodic.ts`)
- WHEN.HX entry is written first, then confirmed in SQLite via `getEntryByCode`.
- Source WHEN.EV entries are only archived AFTER confirmation. If write fails, sources remain active.

**Bug 4 — `withRollback` swallows error** (`core/autonomous.ts`)
- Already correctly throws after rollback. Tests added to confirm behavior.

**Bug 5 — Autonomous loop missing `savePlanEX`** (`core/autonomous.ts`)
- All exit paths (conf_score pause, milestone complete, failure, error, max iterations) now call `savePlanEX` before returning.
- Added conf_score < 0.8 pause check at top of each iteration.

**Bug 6 — Decay cycle pages out WHO/PLAN.CT** (`core/memory/lifecycle.ts`)
- After PAGE step, runs `UPDATE index_entries SET active_page=1 WHERE nb='WHO' OR (nb='PLAN' AND type='CT')`.

**Bug 7 — `verifyPlanAssertions` cycle limit** (`core/planner.ts`)
- Added explicit `let rejectionCycles = 0; while (rejectionCycles < MAX_REJECTION_CYCLES)` loop guard.
- Returns `passed=false` with `failedAssertions` after exactly 2 cycles.

**Bug 8 — `assessComplexity` null reference** (`core/planner.ts`)
- Existing guard `if (!isComplex && llmHandler && ...)` already prevents null dereference.
- Verified behavior: `undefined` llmHandler returns heuristic-based level without throwing.

**Bug 9 — `fetchOwnerPersona` missing + no cache** (`core/context.ts`)
- Added `fetchOwnerPersona()` with try/catch returning null on error.
- Module-level cache with 60-second TTL prevents repeated queries.
- `_resetPersonaCache()` exported for test isolation.
- Persona injected into system prompt via `buildContext`.

**Bug 10 — `checkAMemLinker` unlimited LLM calls** (`core/heartbeat.ts`)
- Created `checkAMemLinker()` function. Selects at most 5 entries per heartbeat run.
- Selects oldest entries (by `updated ASC`) with no relationships.

**Bug 11 — PINNED detection uses `includes`** (`core/context.ts`)
- Already used `startsWith('[PINNED]')`. Verified and added tests to confirm correct behavior.

**Bug 12 — Execution log dir not created** (`core/memory/execution-log.ts`)
- Already had `fs.mkdirSync(PATHS.logs, { recursive: true })`. Verified and added tests.

### New Test File
- `tests/phase11/hardening.test.ts` — 23 new tests covering all 12 bugs

### Test Results
- 610/610 tests pass (23 new hardening tests)
- Build: zero TypeScript errors
- Tag: `phase-11-hardened`

---

## Phase 11 — LM Studio Pre-Validation Fixes

Pre-behavioral-test code review identified 6 bugs that would cause LM Studio test failures.
All fixed before running live tests against Qwen 3.5 35B.

### Fix 1 — T6.1/T6.2/T6.3: WHEN.EV/RF episodic events never written (`core/agent.ts`)
- `writeEpisodicEvent` and `writeReflection` from `core/memory/episodic.ts` were never called.
- `writeEpisodicMemory` in executor.ts only writes HOW.PR, never WHEN.EV/RF.
- Fixed: After any planned_workflow and synthesis_query execution (success AND failure), agent.ts now calls `writeEpisodicEvent` then chains `writeReflection` fire-and-forget.

### Fix 2 — T3.1: `extractThought` only handled `<thought>` tags (`core/planner.ts`)
- Qwen and other models emit `<think>...</think>` for reasoning, not `<thought>`.
- Fixed: `extractThought` now matches both `<thought>` and `<think>` blocks.

### Fix 3 — T4.3: `/log` entries triggered LLM extraction call (`core/agent.ts`)
- All `memory_write` intents went through LLM extraction (up to 3 retries).
- `/log` entries have fully deterministic structure — no LLM needed.
- Fixed: `/log` messages are short-circuited to `inferWriteData` directly, returning `"Logged."` without any LLM call.

### Fix 4 — T2.2: Meeting briefing was 3 sections not 5 (`core/meeting.ts`)
- Old prompt asked for 3 sections. Test expects 5 + closing question.
- Fixed: Prompt now specifies exactly 5 sections: Status Summary, Priorities, Open Risks, Key Questions, Suggested Next Actions. Ends with a clarifying question.

### Fix 5 — T8.2: Active PLAN.EX not surfaced on startup (`chat.ts`)
- chat.ts never checked for a resumable execution plan.
- Fixed: On startup, `loadActivePlanEX()` is called. If active plan exists, a notice with task name and next milestone is printed before the REPL prompt.

### Fix 6 — T7.2: PLAN.CT constraints not in execution context (`core/context.ts`)
- `buildContext` never loaded PLAN.CT entries.
- Fixed: `queryEntries({ nb: 'PLAN', type: 'CT' })` now appended to system prompt under `## Active Constraints`.

### New Test File
- `tests/phase11/lmstudio-fixes.test.ts` — 8 tests covering all 6 fixes

### Test Results
- 618/618 tests pass (8 new lmstudio-fixes tests)
- Build: zero TypeScript errors
- Ready for live LM Studio behavioral testing

---

## Phase 11 — LM Studio Live Test Results

Live behavioral testing against Qwen 3.5 35B (`qwen/qwen3.5-35b-a3b`) at `http://10.40.20.174:1234`.
23/23 pass (100%). T8.2 skipped (requires prior autonomous run).

### Additional Fixes Found During Live Testing

**Fix 7 — T3.5: CODING_TASK_PATTERNS exclusion not wired into classifyIntent (`core/intent.ts`)**
- `CODING_TASK_PATTERNS` were defined but not added to the WRITE_PATTERNS exclusion guard.
- "write a web scraper" was routing to `memory_write` instead of planned_workflow.
- Fixed: Added `&& !matchesAny(message, CODING_TASK_PATTERNS)` to the Priority 3 WRITE_PATTERNS check.

**Fix 8 — T3.1: plan event not captured by transparency listener (`lmstudio-test-runner.ts`)**
- Test code subscribed to `plan` event AFTER calling `msg()` then immediately unsubscribed.
- Fixed: Combined into a single listener subscribed BEFORE the message is sent.

**Fix 9 — T3.1: `<think>` blocks stripped before `extractThought` runs (`core/planner.ts`)**
- `callLLM` in llm.ts strips `<think>` blocks before returning to `decomposeTask`.
- `extractThought(response)` never saw the think block.
- Fixed: In `decomposeTask`, subscribed to `llm_raw` transparency event to capture the raw response before stripping, then extract the thought from raw.

**Fix 10 — T4.1: `extractMemoryMetadata` only called on CREATE not UPDATE (`core/agent.ts`)**
- If the entry was already in the DB from a previous run, `created = false` and metadata extraction was skipped.
- Fixed: Removed the `created &&` guard — `extractMemoryMetadata` now fires on every write (create and update).

**Fix 11 — T4.1: LLM response for metadata starts with "Thinking Process:" (empty after strip) (`core/memory/lifecycle.ts`)**
- Qwen's `stripThinkingTags` in llm.ts strips the `<think>` block but leaves "Thinking Process:" preamble.
- The metadata JSON was inside the think block → extracted response was empty → `jsonMatch` null.
- Fixed: Added `responseSchema` to the metadata extraction LLM call to force JSON output in the response body (not in the think block).

**Fix 12 — T3.4: No safety prompt for destructive operations (`core/context.ts`)**
- System prompt had no guidance about pausing before destructive operations.
- Fixed: Added "Safety: ALWAYS ask for confirmation before destructive operations" to SYSTEM_PROMPT.

### Final Test Results
- All 23/23 live tests pass (100%)
- T8.2 SKIP — requires prior autonomous execution session
- 621/621 unit tests pass (3 new tests added)
- Build: zero TypeScript errors
- Tag: `phase-11-lmstudio-validated`

### Files Modified in Live Test Sprint
- `core/intent.ts` — Fix 7: wired CODING_TASK_PATTERNS into classifyIntent
- `core/planner.ts` — Fix 9: capture llm_raw event for CoT extraction
- `core/agent.ts` — Fix 10: removed `created &&` guard on extractMemoryMetadata
- `core/memory/lifecycle.ts` — Fix 11: added responseSchema to metadata LLM call
- `core/context.ts` — Fix 12: safety confirmation prompt added
- `lmstudio-test-runner.ts` — Fix 8: corrected plan event listener ordering
- `tests/phase11/lmstudio-fixes.test.ts` — 3 new tests (total 11)

---

*This document is the source of truth for this project.
Update it when architecture decisions change.
Do not let implementation drift from it silently.*

---

## Phase 12.1 — Intent Hardening Notes

- Intent routing now treats explicit software/app/program creation prompts as `planned_workflow`, not `memory_write`
- Assistant identity questions such as "what should I refer to you as" are `general` and must not trigger relationship detection
- HOW notebook routing is narrowed to stored procedures and workflow-style implementation questions, avoiding false `memory_query` matches for generic world how-to prompts
- Synthesis prompts like "write a weekly status report based on everything you know" route to `synthesis_query` instead of being swallowed by broad write patterns

---

## Phase 13 — Decomposition-First Routing (COMPLETE)

Phase 13 replaces the top-level intent classifier as the primary router with a decomposition-first pipeline. 758 tests pass. Build clean.

### Architecture Change

`processMessage()` no longer begins with `classifyIntent()`. Every message goes through semantic decomposition first:

```
1. Fast-path bypasses (unchanged):
   /log → NOW.LOG write
   /meeting → Meeting Mode
   Direct code fetch (e.g. WHO.CT-000001) → code_fetch

2. Decompose message into ordered semantic units
   route ∈ { conversational | agentic | query }

3. Search memory for every unit in parallel (unit-scoped BM25/vector)

4. Route by unit type:
   conversational → batched LLM response with history + memory context
   query          → direct retrieval + hybrid fallback (no LLM if results found)
   agentic        → goals/milestones planner + executePlan pipeline

5. Merge route outputs in original unit order
```

### New Module: `core/decomposition.ts`

- `decomposeMessage(text, llm)` — calls LLM with structured decomposition prompt, returns `DecomposedMessage { units }`
- Retry with stricter "This message is compound." prompt when first pass under-splits a multi-sentence message
- Heuristic repair pass: sentence-level route inference as fallback when both LLM passes fail
- `/log` and `/meeting` commands bypass decomposition entirely

### New Module: `core/router.ts`

- `routeDecomposedUnits(units, results, history, llm, workingMemory?)` — dispatches each unit type to the appropriate handler
- `handleConversationalUnits` — single batched LLM call with full history + memory context
- `handleQueryUnits` — direct retrieval; if confidence = 0 → `hybridSearch` fallback (no LLM)
- `handleAgenticUnits` — `decomposeTask` + `executePlan` pipeline; prior query results injected as planning context
- Conversational facts auto-persisted after reply: project starts, person roles, project/person relationships

### New Module: `core/memory/unit-search.ts`

- `searchMemoryForUnits(units, db)` — parallel BM25/vector search scoped per unit's signals (person → WHO, project → WHAT, time → WHEN, etc.)
- Returns `UnitMemoryResult[]` with strategy, confidence, entries, and full text content

### Bugs Fixed (Phase 13 Transition)

- Completed PLAN.EX entries now always persist terminal status — no more false "Continue?" prompts
- Compound messages no longer collapse to a single legacy compatibility path
- Under-split messages retry decomposition then use heuristic sentence-level repair
- Query units that precede agentic work inject their resolved entries into the planner instead of being treated as goals
- Signal-based memory search now falls through to BM25/vector when direct hits are empty

### Test Results

- 758/758 tests pass (new tests: `tests/phase13/decomposition.test.ts`, `tests/phase13/router.test.ts`)
- Build: zero TypeScript errors
- Tag: `phase-13-complete`

---

## Phase 14 — Memory Agent + Working Memory (COMPLETE)

Phase 14 adds background memory writes via a non-blocking agent queue and a per-task working memory object that tracks execution state across milestones.

### `core/memory/memory-agent.ts`

- `MemoryAgent` — singleton queue processor; drains one task at a time off a FIFO queue; never throws to callers
- Task types: `task_complete` (writes WHEN.EV + WHEN.RF + HOW.PR), `conversational_facts` (upserts project/person/relationship entries from conversational units), `update_project_brain` (refreshes PLAN.PJ summary)
- `memoryAgent.enqueue(task)` — non-blocking; callers fire-and-forget
- `working_memory_created`, `working_memory_updated`, `working_memory_archived` transparency events

### `core/memory/working-memory.ts`

- `WorkingMemory` — tracks `taskId`, `projectCode`, `milestonesCompleted`, `filesWritten`, `codesCreated`, `sessionStarted`
- Created at the start of every agentic route in `router.ts`
- Updated after each milestone result in `executor.ts`
- Archived (via memory agent) after plan completion

### Changes to Existing Files

- `core/router.ts` — creates `WorkingMemory` before `handleAgenticUnits`, passes it through to `executePlan`; enqueues `task_complete` after execution; enqueues `conversational_facts` after conversational reply
- `core/executor.ts` — calls `workingMemory.recordMilestone()` and `workingMemory.recordStep()` after each milestone; passes `workingMemory` to skills that need it
- `core/agent.ts` — starts/stops `memoryAgent` alongside heartbeat

### Test Results

- Tests pass with new phase14 test file
- Build: zero TypeScript errors

---

## Phase 15 — Stress Tests + Stability Sprint (COMPLETE)

Phase 15 adds a comprehensive stress test suite covering edge cases and validates the full pipeline under adversarial conditions.

### Stress Test Suite (`pnpm stress:p15:codex`)

8 scenarios covering:
1. Empty/whitespace message handling
2. Very long message (>4000 chars) without crashing
3. Concurrent `processMessage` calls (race conditions)
4. Memory write + immediate read consistency
5. Plan with all steps failing gracefully
6. Circuit breaker trips and recovers
7. Compound message with 4 semantic units routes correctly
8. Follow-up context preserved across turns

All 8 scenarios pass consistently across 3 consecutive runs.

### Stability Fixes Applied

- `core/memory/write.ts` — `upsertEntryWithRetry` wraps `upsertEntry` with 3 attempts + 50ms backoff on UNIQUE constraint violation
- `core/context.ts` — compaction circuit breaker: module-level failure counter, opens at 3 failures, resets on success; `_resetCompactionCircuit()` exported for tests
- `core/memory/versioning.ts` — generation counter invalidates in-flight git commits on `_resetGitInstance()`; `_drainGitCommits()` exported for cleanup
- `core/memory/session-cache.ts` — pointer index updated on every `set()` for valid code patterns

### Cleanup Sprint (Run Before Phase 15 Tag)

- Deleted: `core/intent-llm.ts`, `writeEpisodicMemory()` from executor, `isComplexTask()` from planner
- Deleted: `SUMMARY_INTENTS` from context.ts, `relationship_write` branch from intent.ts
- Fixed: ESM shutdown flush in versioning.ts (was `require()`, now ESM import)
- Fixed: UTC date bug — `new Date().toISOString().split('T')[0]` replaced with `localDateString()` throughout
- Deleted: 43 orphaned test-artifact memory files
- Moved `typescript` from devDependencies → dependencies (runtime use in ui-bootstrap.mjs)
- ARCHITECTURE.md write-order corrected (file-first, not SQLite-first)
- Added `core/utils/date.ts` — shared `localDateString()` / `localDatePlusDays()` helpers

### Test Results

- 758/758 unit tests pass
- `pnpm stress:p15:codex` → 8/8 + Follow-up: 3 consecutive runs all pass
- Build: zero TypeScript errors
- Tag: `phase-15-stress-validated`

---

## Phase 16 — QueryLoop, Pointer Index, Circuit Breakers, AutoDream (COMPLETE)

Phase 16 adds a while-loop execution engine for simple tasks, a thin always-loaded memory index, compaction circuit protection, and background memory consolidation. 770 tests pass.

### Section 1: QueryLoop (`core/query-loop.ts`)

`runQueryLoop(goal, llmHandler, workingMemory?, history?)` — execution engine for LOW/MEDIUM complexity agentic units:

- `while(true)` loop: call LLM → extract first JSON with `"action"` key → execute skill → inject result → repeat
- Circuit breaker: `Map<skillName:inputHash → failures>`, trips at 3 consecutive identical failures
- MAX_ITERATIONS: 20 per run
- Goal block (`GOAL / COMPLETION CONDITION / ITERATION`) reinjected after each tool result
- When model emits plain text (no JSON action) → `stoppedBecause: 'no_action'` → returns that text as reply
- History injection: last 6 non-system turns prepended before goal block
- CRITICAL WORKSPACE RULE in system prompt: model must use `file_writer` skill — never write file content in text reply
- Transparency events: `query_loop_start`, `query_loop_iteration`, `query_loop_skill_call`, `query_loop_skill_result`, `query_loop_end`

### Section 2: Pointer Index (`core/memory/pointer-index.ts`)

- `upsertPointerEntry(entry)` — writes/updates a single line in `memory/MEMORY.md`
- `loadPointerIndex()` — returns the full MEMORY.md string (always-loaded in queryLoop system prompt)
- MAX_ENTRIES = 200 with LRU eviction (oldest lines removed when limit hit)
- Atomic writes via tmp file + rename — never throws
- Line format: `WHO.CT-000001: Sara Ahmadi — lead designer`
- Wired into: `write.ts` (all `upsertEntry` return paths), `session-cache.ts` (every `set()` with valid code), `heartbeat.ts` (AutoDream refresh)

### Section 3: Complexity Routing (`core/router.ts`)

`handleAgenticUnits()` now calls `assessComplexity()` first:
- LOW / MEDIUM → `runQueryLoop` (iterative, model-driven)
- HIGH / MAX → existing `decomposeTask` + `executePlan` pipeline
- `[route]` transparency event emitted after every complexity assessment

### Section 4: Compaction Circuit Breaker (`core/context.ts`)

- Module-level `_compactionFailures` counter; opens at 3 failures; resets on success
- Compaction only runs when `tokens > MAX_TOKENS * 0.7` AND circuit is closed
- `_resetCompactionCircuit()` exported for test isolation

### Section 5: AutoDream + Activity Tracking (`core/heartbeat.ts`)

- `recordActivity()` — exported, called from `agent.ts` on every `processMessage`; updates `_lastActivityAt`
- `checkAutoDream()` — fires when idle > 10 minutes; reads today's WHEN.EV entries; extracts code references; calls `upsertPointerEntry` for each → refreshes MEMORY.md without an LLM call
- `AUTO_DREAM_IDLE_MS = 10 * 60 * 1000`

### Section 6: `upsertEntryWithRetry` (`core/memory/write.ts`)

- 3 attempts, 50ms backoff on UNIQUE constraint violation
- Used internally; prevents concurrent write races from surfacing as unhandled errors

### Phase 16 Usability Sprint

Four bugs found in live use, all fixed:

1. **Confirmation gate** (`core/planner.ts`): `parsePlan()` was trusting LLM's `"needsConfirmation": true`. LLMs over-eagerly set this. Fix: always compute via `shouldRequireConfirmation()` (only triggers for destructive ops / external side effects / risky overwrites) — never trust LLM's value.

2. **History not passed to queryLoop**: `handleAgenticUnits()` and `runQueryLoop()` now accept `history?: Message[]`. Last 6 non-system turns injected before the goal block.

3. **CRITICAL WORKSPACE RULE** added to queryLoop system prompt: prevents model from writing HTML/code directly into text reply instead of calling `file_writer`.

4. **`[route]` transparency event**: emitted after every complexity assessment showing level, reason, and path taken.

### Test Results

- 770/770 tests pass (12 new Phase 16 tests in `tests/phase16/p16-query-loop.test.ts`)
- Build: zero TypeScript errors
- Tags: `phase-16-complete`, `phase-16-usability`

---

## Quick Tasks Sprint — Gemma 4 + Transparency UI (COMPLETE)

### Task 1: Primary Model Switch to Gemma 4 26B A4B

- `.env`: All 3 model entries (`LLM_MODEL`, `PLANNER_MODEL`, `EXECUTOR_MODEL`) updated from `qwen/qwen3.5-35b-a3b` to `google/gemma-4-26b-a4b`
- `core/llm.ts` — `stripThinkingTags()` extended with Gemma 4 thinking tag patterns:
  - `<|channel>thought\n...<channel|>` (complete block)
  - `<|channel>thought...<channel|>` (malformed variant)
  - `<|channel>thought...` (orphaned open tag — no closing tag)

### Task 2: Transparency Panel Readability Fixes (`public/index.html`)

- Fixed `eventPreview()` for `llm_raw`/`llm_stripped`: removed `.replace(/\s+/g, ' ')` whitespace collapse — text now preserves newlines (`.event-preview` already has `white-space: pre-wrap`)
- Added formatted previews for all event types:
  - `plan` → goal + milestone list with M1/M2/M3 labels
  - `step_start` / `step_result` → `▶ [skill]` / `✓|✗ [skill] Nms` format
  - `route` → `⚡ QueryLoop` or `🗺 Planner` + level + reason
  - `query_loop_*` → iteration count, skill name, success/fail icons
  - `working_memory_*` → clean one-line status
  - `session_cache_*` → cache hit/miss with code
  - `project_brain` → project code display
- Added `route` event theme class → cyan highlight
- Scoped `.thinking-panel .panel-head` flex layout to not affect other panels

### Task 3: Copy Button for Transparency Panel

- `[copy]` button added to thinking panel header
- `copyTransparencyLog()` collects all `.event-row` elements, formats with timestamps and event names, copies with `Zaraban Transparency Log` header to clipboard
- Shows "Copied!" for 1.5 seconds then reverts to `[copy]`
- CSS: monospace style, subtle border, hover highlight — matches existing panel aesthetic

### Test Results

- 769/770 tests pass (1 pre-existing flaky `sleep 35` timeout — unrelated)
- Build: zero TypeScript errors

---

## Phase 17A — Security & Permission Layer (COMPLETE)

Phase 17A adds a hardened security layer across the skills system. 809 tests pass. Build clean.

### Task 1 + 2: Workspace Boundary Validation + Binary Detection (`core/skills/tools/file_reader.ts`, `core/skills/tools/file_writer.ts`)

- **Path traversal blocked**: resolved paths outside `workspace/` return `{ success: false, error: '...boundary...' }` — error message always contains the word `boundary`
- **Symlink escape blocked**: symlinks that resolve outside the workspace are rejected before any read/write
- **Binary file detection**: `file_reader` samples the first 8 KB; any NUL byte triggers `{ success: false, error: '...Binary...' }` — plain text and empty files pass unblocked

### Task 4: Permission Enforcement (`core/permission.ts`, `core/skills/runner.ts`)

- `PermissionLevel` type: `'read-only' | 'workspace-write' | 'full-access'` (ordered by privilege)
- `enforcePermission(skillName, requiredLevel, activeMode)` — returns `{ allowed: boolean, error?: string }` where errors always contain `'Permission denied'`
- `getActivePermissionMode()` — reads `PERMISSION_MODE` env var, defaults to `'workspace-write'`
- `runSkill()` in `runner.ts` calls `enforcePermission` before executing any skill; blocked skills return `{ success: false, error: '...' }` without executing
- **All 15 skills annotated** with `permissionLevel`:
  - `read-only`: `web_search`, `url_extract`, `web_fetch`, `memory_history`, `memory_read`, `content_writer`, `calculator`, `file_reader`, `verify_state`, `memory_history`
  - `workspace-write`: `file_writer`, `memory_write`, `relationship_write`, `generate_and_save_file`
  - `full-access`: `run_bash`, `implement_and_test`

### Task 6: Config Zod Validation (`core/config.ts`, `chat.ts`)

- New `core/config.ts` module: Zod schema validates `LLM_ENDPOINT` (URL), `LLM_MODEL` (non-empty string), `PERMISSION_MODE` (enum with default `'workspace-write'`)
- `validateConfig()` calls `process.exit(1)` with a formatted error when validation fails
- `_resetConfig()` exported for test isolation (clears cached config singleton)
- `chat.ts` calls `validateConfig()` at startup before `initDatabase()`

### Task 8: Skill Registry Singleton Freeze (`core/skills/registry.ts`)

- Registry is frozen immediately after all built-in skills are registered at module load time
- `registerSkill()` emits `console.warn('...[registry]...frozen...')` and returns early when frozen — does not throw
- `_unfreezeRegistry()` — lifts freeze without clearing built-ins (for tests that need to add temporary skills)
- `_resetRegistry()` — clears all skills AND lifts freeze (full reset for isolated test suites)

### Test Files Updated for Registry Freeze Compatibility

The registry freeze broke tests that called `registerSkill()` after module load. Fixed across:

- `tests/phase6/skills.test.ts` — `_unfreezeRegistry()` before each `registerSkill()`; error message assertions updated to `.toContain('Access denied')`
- `tests/phase7/react.test.ts` — `_unfreezeRegistry()` before each `registerSkill()`; `permissionLevel: 'read-only'` added to all test skill objects
- `tests/phase7/stress-react.test.ts` — same pattern; applied to `createFlakeySkill()` and inline skill definitions
- `tests/phase7/stress-integration.test.ts` — same pattern
- `tests/phase9/p1-stress.test.ts` — `PERMISSION_MODE=full-access` scoped to Group 3 and Group 4 `describe` blocks only (was top-level `beforeAll`); this fixed test 2H where the sandbox warning prefix (`[warning: no sandbox...]`) was being prepended to truncated output, pushing length from 10000 to 10085 and breaking the `≤ 10050` assertion

### New Test File

- `tests/phase17/instance-a.test.ts` — 15 tests covering all 5 tasks:
  - 4 boundary validation tests (path traversal, symlink escape, valid path, new subdir)
  - 3 binary detection tests (NUL bytes, plain text, empty file)
  - 4 permission enforcement tests (direct `enforcePermission()` calls)
  - 2 config validation tests (missing `LLM_ENDPOINT` → `exit(1)`, valid env → Config object)
  - 2 registry freeze tests (post-freeze registration blocked with warning, `_resetRegistry()` lifts freeze)

### Test Results

- 809/809 tests pass (51 new tests: 15 phase17a + prior test suite growth)
- Build: zero TypeScript errors
- Tag: `phase-17a-complete`

---

## Permission + File Creation Sprint (COMPLETE)

Fixes for mkdir permission failures observed in live agentic runs (e.g. Street of Rage game task). 824/824 tests pass. Build clean. Tag: `phase-17a-complete`.

### Fix 1 — Planner prompt FILE CREATION RULES block (`core/planner.ts`)

- `NEVER use run_bash to create directories` rule added to planner system prompt
- `CORRECT` / `WRONG` examples showing `file_writer` auto-creates parent directories
- `run_bash` restricted to: git, npm, node execution, test runners, compilers

### Fix 2 — Executor mkdir-skip safety net (`core/executor.ts`)

- Before `runWithRetry`, detects `step.skill === 'run_bash'` + command starts with `mkdir`
- Skips the step, pushes a synthetic completed entry: `"Directory creation skipped (file_writer handles this automatically)"`
- Returns `null` (no failure recorded) — plan continues cleanly

### Fix 3 — `parsePlan` post-processor strips mkdir steps (`core/planner.ts`)

- After plan validation, iterates steps and removes any `run_bash { command: "mkdir ..." }` steps
- Repairs `dependsOn` arrays of subsequent steps that referenced the removed mkdir step IDs
- Prevents a model-generated mkdir from blocking downstream steps

---

## Four-Bug Fix Sprint (COMPLETE)

15 tests in `tests/fixes/four-bugs.test.ts`. Build clean.

### Fix 1A — `TYPE_MAP` extended (`config/agent.config.ts`)

- Added missing entries for `WHEN.EV`, `WHEN.RF`, `HOW.SK`, `PLAN.EX`, `PLAN.CT`, `PLAN.PJ`, `NOW.LOG` and other Phase 11 types that were absent from the map

### Fix 1B — `isRepairableSkillInputError` notebook+type patterns (`core/react.ts`)

- Added two new repair-eligible patterns:
  - `/\binvalid notebook\+type\b/i`
  - `/\bnotebook .* does not support type\b/i`

### Fix 2 — `resolveMaxTokens` floor (`core/skills/tools/content_writer.ts`)

- `FORMAT_FLOORS: Record<ContentFormat, number> = { html: 6000, markdown: 4000, plain: 4000 }`
- `resolveMaxTokens(value, format)` — takes the max of the requested value and the format floor
- Replaces old `parseMaxTokens` which had no minimum

### Fix 3 — Terminal PLAN.EX filter in unit-search (`core/memory/unit-search.ts`)

- `filterTerminalPlanEx(entries)` — removes PLAN.EX entries with `status: 'complete'` or `status: 'failed'` from search results
- Emits `memory_context_filtered` transparency event per filtered entry
- Applied to BM25 results, vector results, and session-cache path

### Fix 4 — `stripThinkingTags` PREAMBLE_PATTERNS (`core/llm.ts`)

- Added 5 preamble patterns stripping "Here is the JSON…", "Certainly, here is…", "Sure, here is…", "Of course, here is…", "I'll provide…" prefixes before JSON output

---

## Five Targeted Fixes Sprint (COMPLETE)

### Fix 1 — content_writer debug log

- `console.log('[content_writer] resolved tokens: ...')` added after `resolveMaxTokens` call

### Fix 2 — Working memory archival fresh disk load (`core/memory/memory-agent.ts`)

- `task_complete` handler always loads from disk via `loadWorkingMemory(wmId)` before archiving
- Falls back to `update.workingMemory` only if disk load fails

### Fix 3 — MAX complexity forces confirmation (`core/planner.ts`)

- `shouldRequireConfirmation(steps, complexity?)` — added `complexity?: ComplexityLevel` param
- `if (complexity === 'MAX') return true` — any MAX complexity plan requires user confirmation
- `parsePlan` wires `complexity` into `shouldRequireConfirmation` call

### Fix 4 — Decomposition repair counter + transparency (`core/decomposition.ts`)

- Module-level `_decompositionRepairCount` + `_resetDecompositionCounter()` exported for test isolation
- Two heuristic repair sites increment counter and emit `decomposition_repair` transparency event
- Warning logged when count reaches 3+: `"heuristic repair has fired 3+ times this session"`

---

## Log Analysis Fix Sprint (COMPLETE)

10 fixes derived from real transparency log analysis of a failed Street of Rage game task. 858/858 tests pass. Build clean. Tag: `log-fixes-complete`.

### FIX 1 — Raise maxTokens/timeouts on helper LLM calls

- `intake.ts`: `maxTokens: 256` → `600`; added `console.warn` on parse failure
- `working-memory.ts` archive summary: `maxTokens: 100` → `500`

### FIX 2 — `extractFirstJsonObject` + `safeParseJson` universally applied (`core/executor.ts`)

- `safeParseJson<T>(response, schema, callSite, fallback)` helper added to executor
- Applied to `reviseRemainingMilestones` and verification parsing
- `intake.ts` now uses `extractFirstJsonObject(stripThinkingTags(response))`

### FIX 3 — Terminal PLAN.EX filter with transparency events (`core/memory/unit-search.ts`)

- `filterTerminalPlanEx` emits `memory_context_filtered` with `{ code, reason: 'terminal_plan_ex', status }` per entry

### FIX 4 — Grounded verification with filesystem/DB snapshot (`core/executor.ts`)

- `buildGroundTruthSnapshot(completed)` — reads `fs.statSync` for file paths found in step outputs; checks SQLite for memory codes found in outputs
- Returns `{ text, fileStates, memoryStates }` — injected into `runPostFlightSynthesis` prompt

### FIX 5 — Reactive milestone revision (`core/executor.ts`)

- Revision LLM call skipped on happy path — only fires when `milestoneHadFailures || milestoneHadSuspiciousOutput`
- `milestoneHadSuspiciousOutput`: completed step whose output is depended upon by future steps AND is < 50 chars
- Saves ~2-3s per milestone on successful runs
- Emits `milestone_revision_skipped` transparency event on skip

### FIX 6 — Merged post-execution into single `runPostFlightSynthesis` call (`core/executor.ts`, `core/router.ts`)

- `runPostFlightSynthesis(plan, result, llmHandler)` — single LLM call returning `{ verification, summary, reflection }`
- `PostFlightSchema` / `postFlightJsonSchema` in `core/schemas.ts`
- Router non-escalated path uses `runPostFlightSynthesis` + `writeCompletionMemoryFromPostFlight`
- Replaces three separate calls (verifyExecution, buildUserReport, writeCompletionMemory)

### FIX 7 — content_writer minimum length + balanced-brace validation (`core/skills/tools/content_writer.ts`)

- `MIN_OUTPUT_LENGTHS: { html: 500, markdown: 200, plain: 100 }` — output shorter than floor returns `{ success: false }`
- `hasBalancedBraces(code)` — validates that `{` / `}` depth is balanced in plain format output; unbalanced = truncated code

### FIX 8 — HOW.PR gate (`core/executor.ts`)

- `hasExecutableStep` check: HOW.PR only written when milestone contains a `run_bash` or `implement_and_test` step
- Content/file-writer-only milestones skip the HOW.PR write (noise without reusable value)
- Emits `how_pr_skipped` transparency event with `{ milestoneId, reason: 'no_executable_step', skills }`

### FIX 9 — Working memory step recording wiring

- `getStepSummary(wm: WorkingMemory): string` added to `core/memory/working-memory.ts` — formats `stepLog` as `"- skill: summary"` lines
- `archiveWorkingMemory` now uses `getStepSummary(wm)` in the LLM archive prompt
- `appendStepLog` called from `memory-agent.ts` `step_complete` handler (already wired, verified)

### FIX 10 — Planner single-file HTML deliverable rule (`core/planner.ts`)

- `SINGLE-FILE HTML RULE` block added to planner prompt: produce ONE self-contained HTML file with CSS/JS inline; use `content_writer` with `format:"html"` then `file_writer`; no separate `.css` / `.js` files unless explicitly requested

### New Transparency Events

`verification_snapshot`, `milestone_revision_skipped`, `post_flight_complete`, `how_pr_skipped`, `memory_context_filtered`, `decomposition_repair`

### New Schemas (`core/schemas.ts`)

`MilestoneRevisionSchema`, `PostFlightSchema`, `PostFlightResult`, `postFlightJsonSchema`

### Test Results

- 858/858 tests pass (34 new in `tests/log-fixes/fixes.test.ts`)
- 8/8 stress tests pass (`pnpm stress:critical`)
- Build: zero TypeScript errors
- Tag: `log-fixes-complete`

---

## Log Analysis Fix Sprint #2 (COMPLETE)

8 fixes derived from two transparency log analyses plus independent Gemini review. Addresses
the "fake execution" hallucination bug and 7 structural gaps. 888/888 tests pass. Build clean.
Tag: `log2-fixes-complete`.

### FIX 0 — Plan Confirmation State Machine (`core/agent.ts`)

- `pendingConfirmationPlan` module-level variable stores plan when `needsConfirmation: true`
- Top-of-`processMessage` intercept: checks pending plan BEFORE intake/decomposition
- `isUserConfirmation()` / `isUserRejection()` — deterministic regex, no LLM
- Confirmation → execute plan immediately via `executeConfirmedPlan()` (router.ts), clear state
- Rejection → clear state, inform user
- Ambiguous → re-prompt, keep plan pending
- Prevents the "fake execution" hallucination where the conversational LLM fabricates
  completion after reading chat history

### FIX 1 — content_writer `context` input (`core/skills/tools/content_writer.ts`, `core/planner.ts`)

- Optional `context` input parameter for existing content to modify
- Modification-specific system prompt when context provided
- Planner prompt updated with CONTENT MODIFICATION RULES

### FIX 2 — `code` format for content_writer (`core/skills/tools/content_writer.ts`, `core/planner.ts`)

- `code` format with "Output ONLY source code" system prompt
- FORMAT_FLOORS.code = 4000; MIN_OUTPUT_LENGTHS.code = 80
- Balanced-brace check always fires for `code` format

### FIX 3 — Deduplicate intake transparency event (`core/agent.ts`)

- Single emit per intake classification

### FIX 4 — Multi-file cross-reference coherence (DEFERRED)

- Known limitation logged

### FIX 5 — Decomposition normalization for garbage output (`core/decomposition.ts`)

- Pre-validation: bare primitives (numbers, booleans, invalid strings) filtered from units
- Stringified JSON objects parsed to objects

### FIX 6 — Session cache terminal PLAN.EX gate (`core/memory/session-cache.ts`)

- Store rejects entries with nb=PLAN, type=EX, status∈{complete,failed}
- Emits `session_cache_skip` transparency event on rejection

### FIX 7 — Decomposition retry with few-shot examples (`core/decomposition.ts`)

- On garbage output (no valid units after normalization), retry once with 2 few-shot examples
- Single retry only; failed retry falls back to heuristic repair
- `decomposition_retry` transparency event emitted

### New Transparency Events

`plan_confirmation_pending`, `plan_confirmed`, `plan_rejected`,
`plan_confirmation_ambiguous`, `session_cache_skip`, `decomposition_retry`

### Test Results

- 888/888 tests pass (28 new in `tests/log2-fixes/fixes.test.ts`)
- Build: zero TypeScript errors
- Tag: `log2-fixes-complete`

---

## Permission-Aware Planner Sprint (COMPLETE)

3 fixes derived from transparency log analysis of a Street-of-Rage game task in `workspace-write`
mode. The planner was listing blocked skills, the revision prompt omitted failures, and the
decomposition model kept hallucinating flat arrays. 909/909 tests pass. Build clean.
Tag: `permission-aware-planner-complete`.

### FIX 1 — Permission-Aware Planner (`core/skills/registry.ts`, `core/router.ts`, `core/planner.ts`, `core/query-loop.ts`)

- `getSkillsByPermission(mode)` filters registry by `LEVEL_RANK` comparison
- `getSkillDescriptionsForPermission(mode)` builds formatted skill list for allowed skills only
- Router passes `permissionMode` and `blockedSkillNames` to planner context
- Planner prompt includes RUNTIME CONTEXT block listing permission mode, skill count, and blocked skill names
- QueryLoop system prompt also uses permission-filtered skill list
- Runtime enforcement in `runner.ts` unchanged (defense in depth)

### FIX 2 — Failure-Aware Plan Revision (`core/executor.ts`, `core/schemas.ts`)

- `reviseRemainingMilestones` now accepts optional `failedSteps` parameter
- When failures exist, revision prompt includes FAILED section with step ID, skill name, and error message
- `MilestoneRevisionSchema` extended with optional `abort: boolean` field
- Revision returning `abort: true` causes executor to stop and report the reason
- Both revision call sites (REVISE response path + reactive revision) pass failure context

### FIX 3 — Decomposition Few-Shot Hardening (`core/decomposition.ts`)

- 3 few-shot examples added to decomposition system prompt (agentic, conversational, query)
- WRONG/RIGHT format enforcement block directly addresses the flat-array hallucination pattern
- Heuristic repair preserved as safety net
- `_decompositionRepairCount` counter continues tracking across session

### Test Results

- 909/909 tests pass (21 new in `tests/permission-planner/fixes.test.ts`)
- Build: zero TypeScript errors
- Tag: `permission-aware-planner-complete`

---

## QueryLoop Efficiency Fix Sprint (COMPLETE)

7 fixes derived from transparency log analysis of a "milky way 3D simulation" task that took
12 iterations (~48s) when it should have taken 1-2 (~8s). 933/933 tests pass. Build clean.
Tag: `queryloop-efficiency-fixes`.

### FIX 1 — Single-File HTML Rule in QueryLoop (`core/query-loop.ts`)

- Added `SINGLE-FILE HTML RULE` to queryLoop system prompt (was only in planner prompt)
- Inline `<style>` and `<script>` tags; load libraries via CDN
- Prevents multi-file splits with broken cross-references

### FIX 2 — Generate-First Rule (`core/query-loop.ts`)

- Added `GENERATE-FIRST RULE` — skip web_search for tasks where the model has sufficient knowledge
- Warns against fetching GitHub blob pages (return HTML wrappers, not source)

### FIX 3 — Description Quality Rule (`core/query-loop.ts`)

- Added `DESCRIPTION QUALITY RULE` — generate_and_save_file descriptions must be detailed specs
- Specifies CDN URLs, visual features, interaction model, algorithms (100-300 words)

### FIX 4 — Suppress Self-Read After Generation (`core/query-loop.ts`)

- After successful `generate_and_save_file`, appends hint: "Do not re-read files you just generated"
- Conditional on success only — failure results don't get the hint

### FIX 5 — Permission-Filtered Skill List (already done in previous sprint)

- `getSkillDescriptionsForPermission(getActivePermissionMode())` already in queryLoop
- `run_bash` and `implement_and_test` hidden in `workspace-write` mode

### FIX 6 — MEMORY.md Relevance Filtering (`core/query-loop.ts`)

- `filterPointerIndex(fullIndex, goal, maxEntries)` scores entries by keyword overlap with goal
- Relevant entries kept first; remaining slots filled with most recent entries
- Reduces ~50 irrelevant entries to ~15 goal-relevant ones per LLM call

### FIX 7 — GitHub Blob URL Auto-Rewrite (`core/skills/tools/web_fetch.ts`)

- `rewriteGitHubBlobUrl()` converts `/blob/` URLs to `raw.githubusercontent.com`
- Transparent to the agent — gets raw source content instead of GitHub UI chrome

### Test Results

- 933/933 tests pass (24 new in `tests/queryloop-efficiency/efficiency.test.ts`)
- Build: zero TypeScript errors
- Tag: `queryloop-efficiency-fixes`

---

## Known Limitations (Tracked)

### Multi-file cross-reference coherence
When the planner generates multiple content_writer steps that produce separate files (e.g.
HTML + JS + CSS), element IDs, class names, and variable names are not shared between steps.
Each content_writer call is stateless. Mitigated by the single-file HTML rule for browser
deliverables. Full fix requires a shared-context registry in the planner — deferred to a
future phase.

---

## Phase 18 — New Skills, Coding Route, Context Mode (COMPLETE)

981 tests pass. Build clean.

### Upgrade 1 — `patch_file` skill (`core/skills/tools/patch_file.ts`)

- `patch_file`, permissionLevel: `workspace-write`
- Input: `{ filepath, search_string, replace_string }`
- Boundary + symlink guard (same pattern as file_writer/file_reader)
- Returns error if search_string not found or appears more than once (ambiguity)
- Single replacement via `str.slice` — empty replace_string deletes the block
- Max file size 10 MB
- Registered in `core/skills/registry.ts`

### Upgrade 2 — `grep_workspace` and `list_dir` skills

**`grep_workspace`** (`core/skills/tools/grep_workspace.ts`), permissionLevel: `read-only`
- Walks `PATHS.workspace` recursively, skips `node_modules`, `.git`, `dist`
- `file_glob` filter via simple suffix/glob matching
- Case-insensitive search; regex fallback if valid
- Skips binary files (NUL byte in first 8 KB)
- Default max_results: 50; appends truncation note when exceeded
- WORKSPACE_ROOT resolved via `realpathSync` to handle macOS `/tmp` → `/private/tmp`

**`list_dir`** (`core/skills/tools/list_dir.ts`), permissionLevel: `read-only`
- Non-recursive: returns `{ dirs: string[], files: string[] }` as JSON
- Recursive: flat list of all file paths relative to given path (skips node_modules, .git, dist)
- Max recursive entries: 500 with truncation note
- Boundary + symlink guard; WORKSPACE_ROOT resolved via `realpathSync`

### Upgrade 3 — `taskType` field + coding route + context mode

**3A** — `taskType?: 'coding' | 'general'` added to `DecomposedUnit` in `core/types.ts`

**3B** — `prompts/decomposition.md` updated with taskType instruction; `DECOMPOSITION_RESPONSE_SCHEMA` in `core/decomposition.ts` includes `taskType` as optional enum field

**3C** — Coding route in `core/router.ts` (`handleAgenticUnits`): if any unit has `taskType === 'coding'`, emits `coding_route_selected` event and runs `runQueryLoop` instead of the planner pipeline

**3D** — `contextMode?: ContextMode` added to `buildContext()` in `core/context.ts`. When `'agentic_coding'`: soft limit 8000 tokens, hard ceiling 16000 tokens, compaction threshold 5600. Emits `context_mode_applied` transparency event.

**3E** — Two new transparency events added to `core/transparency.ts`:
- `coding_route_selected`: `{ unitIds, complexity, reason }`
- `context_mode_applied`: `{ mode, softLimit, hardCeiling }`

### Upgrade 4 — Deprecate `generate_and_save_file`

- JSDoc `@deprecated` comment added at file top
- `console.warn('[generate_and_save_file] DEPRECATED — prefer content_writer + file_writer')` at start of `execute()`
- Description string updated to note `[DEPRECATED: prefer content_writer + file_writer]`

### Test Results

- 981/981 tests pass (33 new Phase 18 tests)
- Build: zero TypeScript errors
- Tags: `phase-18-complete`

---

## Phase 18F — Query Retrieval Fixes + Memory Body Format (COMPLETE)

### Root Causes Fixed
Three consecutive user queries ("tell me all plans about the tennis 3d game", "tell me all
contacts in your memory", "tell me all projects you're working on") returned zero results
despite entries existing in memory. Root causes: intake signal parser mapping wrong types,
unit-search strategy ignoring project signals, listing queries hitting BM25 with no keywords,
intake signals not passed to unit-search.

### FIX 1 — Intake Signal Parser (`core/intake.ts`)
- `IntakeSignals.personSignal` changed from `{ name, confidence }` to `string | null`
- `IntakeSignals.projectSignal` changed from `{ name, confidence }` to `string | null`
- `IntakeSignals.timeSignal` changed from `{ description }` to `string | null`
- Confidence threshold (> 0.7) applied inline during signal construction
- `querySignal` and `agenticSignal` now use `=== true` (strict boolean check)
- `intake_signals` transparency event emitted with resolved string values

### FIX 2 — Strategy Priority (`core/memory/unit-search.ts`)
- `projectSignal` from options short-circuits all content heuristics (top priority)
- `personSignal` from options fires before content-based person detection
- Temporal language no longer overrides project signal when options.projectSignal is set
- `searchProjectByName()` helper added — searches PLAN.PJ + WHAT by name

### FIX 3 — Listing Fast Path (`core/memory/unit-search.ts`)
- `detectListingQuery()` — detects "all contacts / projects / tasks / etc" patterns
- Returns `strategy: 'type_scan'` → `queryEntries({ nb, type, status: 'active' })`
- Fires before BM25 path; no keyword matching needed; returns empty array not error
- `UnitSearchStrategy` type extended with `'type_scan'` in `core/types.ts`

### FIX 4 — Signal Passthrough (`core/memory/unit-search.ts`, `core/agent.ts`)
- `UnitSearchOptions` interface: `{ projectSignal?, personSignal?, timeSignal? }`
- `searchMemoryForUnits()` accepts optional third argument `UnitSearchOptions`
- `core/agent.ts` passes intake signals from `intakeResult.signals` into unit-search

### FIX 5 — PLAN.PJ Body Format (`core/memory/project.ts`)
- `ProjectEntry` interface extended with optional: `initialPrompt`, `goal`, `decisions[]`, `conclusions`
- Body template now includes `## Initial Request`, `## Goal`, `## Key Decisions`, `## Conclusions`
- `initialPrompt` stores verbatim user request that started the project

### FIX 6 — WHAT.PJ Body + Task Relationships (`core/router.ts`, `core/memory/memory-agent.ts`)
- WHAT.PJ bodies created in `persistFactualAssertions` now include structured sections:
  `## Description`, `## Initial Request`, `## Tasks`, `## Status`
- `contains` relationship written from WHAT.PJ → NOW.TD in `memory-agent.ts` `new_code` handler
  (fires when executor creates a NOW.TD and working memory has a projectCode)

### Transparency Events Added (`core/transparency.ts`)
- `intake_signals`: `{ personSignal, projectSignal, querySignal, agenticSignal }`
- `unit_search_strategy`: `{ strategy, projectName, confidence, codes }`

### Test Results
- 18 new tests in `tests/retrieval-fixes/retrieval.test.ts` — all pass
- 999/999 total tests pass (zero regressions)
- Build: zero TypeScript errors
- Tag: `phase-18-retrieval-memory-complete`

---

## Phase 18G — Listing Wiring + Memory Quality (COMPLETE)

### Root Causes Fixed
Five memory quality issues causing silent failures or data pollution:
1. `detectListingQuery()` was unreachable in some code paths — listing queries fell through to BM25
2. Empty memory bodies (WHO.CT, WHAT.PJ) stored blank markdown with no structure
3. WHAT.KN near-duplicates (e.g. "Favorite Color" / "Favorite Vericolor") slipping through dedup
4. Completed PLAN.EX entries resurfacing as `status: active` in type_scan results
5. NOW.LOG entries using `status: active` polluting todo and active-entry scans

### FIX 1 — Listing Fast-Path Confirmed Wiring (`core/memory/unit-search.ts`)
- `detectListingQuery()` verified to run FIRST in `searchUnit()` — before all signal guards
- Works purely from content; no signals required
- Regression test added: "tell me a list of all your contacts" with no options → `type_scan`

### FIX 2 — Body Templates (`core/memory/write.ts`)
- `defaultBodyFor(nb, type)` — returns scaffold markdown for WHO.CT and WHAT.PJ
- WHO.CT template: `## Role / Relationship`, `## Communication`, `## Notes`
- WHAT.PJ template: `## Initial Request`, `## Tasks`, `## Status`
- Applied only when `body.trim().length < 10` (custom bodies used as-is)

### FIX 3 — Near-Duplicate Prevention (`core/memory/write.ts`)
- `computeNameSimilarity(a, b)` — Jaccard word-overlap + substring bonus
  - `wa !== wb` guard prevents exact-match words from double-counting in substring bonus
- `DEDUP_SIMILARITY_TYPES = new Set(['WHAT.KN'])` — scoped to KN only (WHO.CT has its own dedup)
- `APPEND_ONLY_TYPES = new Set(['NOW.LOG', 'WHEN.EV', 'WHEN.RF', 'PLAN.EX', 'WHEN.HX', 'NOW.RP'])` — never similarity-checked
- Pre-upsert similarity check fires before `createEntry` for eligible types

### FIX 4 — PLAN.EX Terminal Status (`core/memory/plan-ex.ts`, `core/memory/unit-search.ts`)
- `loadActivePlanEX()` excludes entries with `status: 'complete'` or `status: 'failed'`
- `type_scan` fast-path uses `status='active'` filter — terminal PLAN.EX entries excluded automatically

### FIX 5 — NOW.LOG Status Default (`core/memory/write.ts`, `core/memory/index.ts`)
- `resolvedStatus` logic: NOW.LOG entries default to `status: 'logged'` (not `'active'`)
- Migration in `initDatabase()`: `UPDATE ... SET status='logged' WHERE nb='NOW' AND type='LOG' AND status='active'`
- Prevents log entries from appearing in active-item scans and todo queries

### Test Results
- 16 new tests in `tests/phase18g/phase18g.test.ts` — all pass
- 1016/1016 total tests pass (zero regressions)
- Build: zero TypeScript errors
- Tag: `phase-18G-complete`

---

## Phase 19c — Quick-Resolve: Pre-Decomposition Memory Retrieval (COMPLETE)

1099 tests pass (1081 existing + 18 new). Build clean. Tag: `phase-19c-quick-resolve`.

### Overview

Quick-resolve adds a deterministic early-exit path in `processMessage` for two structurally obvious memory queries that do not need an LLM decomposition call:
1. **Code lookup** — "Show me WHO.CT-000001" — the code is in the text; fetch directly
2. **Name search** — "Tell me about Tennis 3D Game" — proper noun matches entry name; query by name

This saves 2-5 seconds per query by skipping the decomposition LLM call entirely. Listing queries ("show all contacts") remain handled by Phase 19's `detectListIntent()` inside `unit-search.ts`. Relationship queries ("what does X own?") fall through to normal routing to preserve intent classification.

### Implementation

**New module: `core/memory/quick-resolve.ts`**
- `extractCodes(message)` — regex finds memory codes (WHO.CT-XXXXXX, WHAT.PJ-XXXXXX, etc.)
- `extractSearchTerms(message)` — extracts quoted strings, capitalized phrases, longest non-stopword tokens
- `quickResolve(message)` — main entry: tries code lookup → name search → returns `{ resolved: false }` if no match

**Integration: `core/agent.ts`**
- Quick-resolve inserted AFTER fast-paths (/log, /meeting, code fetch) but BEFORE intake/decomposition
- Skips for relationship queries (preserves `relationship_query` intent routing)
- Falls through to normal pipeline if `resolved: false` or `entries.length === 0`
- Single LLM call answers user when results found (no decomposition needed)

**Tests: `tests/phase19/quick-resolve.test.ts`**
- 5 tests for `extractCodes` — single code, multiple codes, dedup, empty array, incomplete codes
- 6 tests for `extractSearchTerms` — quoted strings, capitalized phrases, stopword filtering, dedup
- 7 integration tests — code lookup, name search, greetings, agentic requests, missing codes

### Design Rules Followed

- ✅ **Deterministic**: Runs before any LLM call — pure regex + SQLite name query
- ✅ **Non-blocking**: Returns `resolved: false` for unmatched queries; doesn't disrupt pipeline
- ✅ **Composable**: Works alongside Phase 19's listing detection (different fast-paths)
- ✅ **Type-safe**: Respects relationship query routing; skips if relation detected
- ✅ **Backward compatible**: All 1081 existing tests pass; zero regressions

### Execution Flow

**Example 1: Code lookup**
```
Input: "Show me WHO.CT-000001"
→ extractCodes() finds WHO.CT-000001
→ getEntryByCode() retrieves entry
→ fetchByCode() loads markdown body
→ buildQuickResolvePrompt() + single LLM call
→ User gets answer in ~1 second (instead of 3-5 seconds)
```

**Example 2: Name search**
```
Input: "Tell me about Tennis 3D Game"
→ extractSearchTerms() finds "Tennis 3D Game"
→ queryEntries({ name: "Tennis 3D Game" }) finds match
→ Single LLM call with resolved memory
→ User gets answer in ~1 second
```

**Example 3: No match (falls through)**
```
Input: "What is photosynthesis?"
→ extractCodes() finds nothing
→ extractSearchTerms() finds "photosynthesis" but queryEntries() returns empty
→ quickResolve() returns { resolved: false }
→ Normal decomposition + search pipeline executes (unchanged)
```

### Test Results

- 18/18 new tests pass
- 1099/1099 total tests pass (zero regressions)
- Build: zero TypeScript errors
- Tag: `phase-19c-quick-resolve`

---

## Phase 19e — WHO.CT-000076 Audit Response Sprint (COMPLETE)

34 tests in `tests/phase19e/who-ct-audit.test.ts`. Build clean. Tag: `phase-19e-who-ct-audit`.

Three manual tests on 2026-04-07 revealed six bugs not covered by Phase 19c/19d:

### FIX A — Code Normalization for Suffixed Codes (`core/memory/quick-resolve.ts`)

- `extractCodes()` regex no longer requires `\b` word boundary after digits
- Uses `exec` loop with capture groups to reconstruct canonical code
- Handles patterns like `WHO.CT-000076_zaraban` → extracts `WHO.CT-000076`
- Signature: `export function extractCodes(message: string): string[]`

### FIX B — Identity-First Routing (`core/memory/quick-resolve.ts`)

- New function `extractIdentityTarget(message)` detects "who is X", "what is X", "tell me about X", "what does X do"
- Strips embedded memory codes: `"who is WHO.CT-000076_zaraban"` → target is `"zaraban"`
- `quickResolve()` runs identity routing (Strategy 1.5) between code lookup and general name search
- Queries WHO notebook first via `queryEntries({ nb: 'WHO', name: identityTarget })`
- Signature: `export function extractIdentityTarget(message: string): string | null`

### FIX C — Notebook Scoping for Code-Derived Queries (`core/memory/unit-search.ts`)

- New function `extractNotebookHint(query)` detects notebook prefix in query (e.g., `WHO.CT-000076` → "WHO")
- Applied in `searchFallback()` post-filter: when a notebook hint is found and unscoped BM25 results exist, tries scoped results first
- Prevents HOW.PR entries from polluting WHO.CT queries
- Signature: `export function extractNotebookHint(query: string): string | null`

### FIX D — Output Sanitization (`core/llm.ts`, `core/agent.ts`)

- New function `sanitizeFinalOutput(text)` strips:
  - Model control tokens: `<|tool_call|>`, `<|tool_response|>`, `<|channel>`, `<|im_start|>`, `<|im_end|>`, `<|endoftext|>`, `<|pad|>`
  - Pseudo-tool narratives: "Calling tool", "Using function", "Executing"
  - Thinking preambles: "Let me search", "I need to", "I should"
  - Multiple blank lines (collapses to max 2)
- Applied via `cleanReply()` in agent.ts (all LLM response return paths already use cleanReply)
- Signature: `export function sanitizeFinalOutput(text: string): string`

### FIX E — Grounding Guard (`core/agent.ts`)

- System prompt for quick-resolve query response now includes:
  ```
  ## Grounding Rule
  The memory entries provided above are confirmed to exist in the database. 
  You MUST NOT claim that any of these entries do not exist, are missing, or 
  could not be found. Base your answer on the content of these entries.
  ```
- Prevents LLM from contradicting known retrieved state

### FIX F — Agentic Signal Tightening (`prompts/intake.md`)

- Intake classifier prompt now explicitly lists identity patterns as QUERY, not AGENTIC:
  ```
  "who is X" → query: true, agentic: false
  "what is X" → query: true, agentic: false
  "tell me about X" → query: true, agentic: false
  "what does X do" → query: true, agentic: false
  ```
- Added guidance: "agentic should ONLY be true when requesting CREATE/MODIFY/DELETE/BUILD/IMPLEMENT/EXECUTE/RUN — not for information retrieval"

### Test Results

- 34/34 new tests pass (organized into 7 test groups)
- 1153/1153 total tests pass (zero regressions)
- Build: zero TypeScript errors

### Files Modified

1. `core/memory/quick-resolve.ts` — Fixes A + B
2. `core/memory/unit-search.ts` — Fix C
3. `core/llm.ts` — Fix D
4. `core/agent.ts` — Fixes D + E
5. `prompts/intake.md` — Fix F
6. `tests/phase19e/who-ct-audit.test.ts` — 34 new tests

---

## Phase 20 — Simplify: Pre-Fetch Gate (COMPLETE)

27 tests in `tests/phase20/pre-fetch-gate.test.ts`. Build clean. Tag: `phase-20-simplify`.

### Design Philosophy

Replace 4-LLM-call pipeline (intake → decomposition → search → synthesis) with deterministic pre-fetch gate
that handles 80% of real messages in **zero or one LLM call**:

**Old path:** intake (LLM) → decomposition (LLM) → unit-search → synthesis (LLM) = 3 LLM calls
**New path:** regex/SQLite extraction → pre-fetch bodies → synthesis (LLM) = **1 LLM call**

Full decomposition → router → planner pipeline **preserved as fallback** for genuinely complex/agentic messages.

### Pre-Fetch Gate Strategies (in `core/memory/quick-resolve.ts`)

1. **Code lookup** — regex extracts memory codes (including suffixed like `WHO.CT-000076_zaraban`)
2. **Identity question** — detects "who/what is X", "tell me about X" → WHO-first then all notebooks
3. **Listing query** — detects "show all contacts", "list projects" → type scan via `queryEntries` (NEW in Phase 20)
4. **Name search** — proper nouns and quoted strings → `queryEntries` by name

### Listing Query Detection (`detectListingQuery` — NEW)

- Moved from `unit-search.ts` into `quick-resolve.ts` for pre-decomposition gate
- Detects listing language: `['all ', 'list ', 'show ', 'every ', 'what are my', 'tell me all', ...]`
- Matches vocabulary: contacts, projects, todos, procedures, events, deadlines, etc.
- Returns `{ nb: string; type: string }` for direct type-scan via `queryEntries`
- Even zero results valid resolution ("you have no contacts" is a real answer)

### Output Sanitization (Already Complete in Phase 19e)

- `sanitizeFinalOutput()` strips control tokens, pseudo-tool narratives, thinking preambles
- Applied to **all** LLM response return paths via `cleanReply()` in agent.ts

### Grounding (Already Wired)

- Pre-fetch synthesis prompt includes grounding instruction: retrieved entries are confirmed to exist
- Prevents LLM from claiming entries are missing when data is right in the prompt

### Pipeline Architecture After This Sprint

```text
User message
  ↓
[0] Plan confirmation intercept
  ↓
[1] Fast-path bypasses (/log, /meeting)
  ↓
[2] Pre-fetch gate (quickResolve) ← WIDENED in Phase 20
  → Code lookup
  → Identity question
  → Listing query (NEW)
  → Name search
  ↓ resolved? → single LLM synthesis → sanitize → return
  ↓ not resolved? ↓
[3] Full pipeline: intake → decomposition → search → router
  ↓
[4] Sanitize → return
```

### Modified Files

1. `core/memory/quick-resolve.ts`:
   - Updated `QuickResolveResult.strategy` to include `'type_scan'`
   - Added `detectListingQuery(message)` function with VOCABULARY map
   - Expanded `quickResolve()` to handle Strategy 3 (listing queries)

### New Files

- `tests/phase20/pre-fetch-gate.test.ts` — 27 comprehensive tests:
  - 6 tests for `extractCodes` (suffix handling)
  - 6 tests for `extractIdentityTarget` (identity detection)
  - 5 tests for `detectListingQuery` (listing detection)
  - 5 tests for `quickResolve` integration
  - 3 tests for `sanitizeFinalOutput`
  - 2 tests for `extractSearchTerms`

### Test Results

- 27/27 new tests pass
- 1180/1180 total tests pass (1153 → 1180, +27 new, zero regressions)
- Build: zero TypeScript errors
- Tag: `phase-20-simplify`

---

## Phase 20b — Intent-Aware Gate Fix (COMPLETE)

20 tests in `tests/phase20b/intent-gate.test.ts`. Build clean. Tag: `phase-20b-intent-gate`.

### The Bug

"Write a Tetris game" was trapped by the pre-fetch gate. Name search matched "workspace" against
15+ entries (in real usage, 126+). The retrieval-only prompt told the LLM to use ONLY those entries.
The LLM refused to write the game: "Not found in memory. Cannot proceed."

### FIX 1 — Command detection (`core/memory/quick-resolve.ts`)

- `isCommandIntent(message)` detects command verbs (write, create, build, run, fix, etc.)
- Commands bypass the name-search gate entirely — return `{ resolved: false }` → fall through to full pipeline
- Code lookup **still works** for commands (e.g., "update WHO.CT-000076" resolves the code)
- `QuickResolveResult.isCommand` flag: true if original message was a command

**Pattern matching:**
- Direct commands: `^(write|create|build|make|run|...)\b`
- Polite commands: `^(can you|please|would you|...)\s+(write|create|...)\b`

### FIX 2 — Context cap (`core/memory/quick-resolve.ts`)

- Name search (Strategy 4) skips terms that match **>10 entries**
- Prevents broad terms like "workspace" from flooding the context (126 entries → 0 results)
- Listings (Strategy 3) are **NOT affected** — type_scan can return many entries by design
- Loop continues to next term if current term is too broad: `if (byName.length > 10) { continue; }`

### FIX 3 — Intent-aware synthesis prompt (`core/agent.ts`)

Two different prompts based on message intent:

**For commands** (isCommand=true):
```
Use memory as BACKGROUND CONTEXT. Then EXECUTE the request using your full capabilities.
Do not refuse because the task is "not in memory" — memory is context, not a constraint.
```

**For queries** (isCommand=false):
```
Answer based on the retrieved data. Be concise and direct.
Do not claim entries are missing — everything relevant has been retrieved.
```

**Modification commands** (update/delete/rename with codes):
- Detected via pattern: `/^(?:update|change|modify|edit|rename|delete|remove|move|merge)\b/i`
- Fall through to full pipeline (not handled via single-LLM synthesis path)
- Reason: These need skill access (memory_write, etc.), not just LLM generation

### Pipeline After This Fix

```text
User: "write a Tetris game"
  → isCommandIntent: true
  → quickResolve returns EMPTY (command bypasses gate)
  → full pipeline: decomposition → planner → executor
  → Tetris game gets written ✓

User: "who is Zaraban"
  → isCommandIntent: false
  → quickResolve: identity question resolves
  → synthesis LLM call with retrieval prompt
  → answer in <2s ✓

User: "update WHO.CT-000076"
  → isCommandIntent: true
  → quickResolve: code lookup resolves, isCommand=true
  → modification verb detected → fall through to full pipeline
  → planner routes to memory_write skill ✓
```

### Modified Files

1. `core/memory/quick-resolve.ts`:
   - Added `isCommandIntent()` function
   - Modified `quickResolve()`:
     - Check `isCommandIntent` at start
     - Code lookup still fires, propagates `isCommand` flag
     - Skip remaining strategies if isCommand is true
     - Cap name search at 10 results per term
   - Updated `QuickResolveResult` type with optional `isCommand` field

2. `core/agent.ts`:
   - Intent-aware synthesis prompt (command vs query)
   - Modification command detection + full pipeline fall-through
   - Both code-lookup and name-search strategies respect intent flag

### Test Results

- 20/20 new tests pass (10 isCommandIntent, 5 command bypass, 3 context cap, 2 regression)
- 1200/1200 total tests pass (1180 → 1200, +20 new, zero new regressions)
- Build: zero TypeScript errors
- Tag: `phase-20b-intent-gate`
