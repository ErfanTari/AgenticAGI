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
→ Agent classifies intent (takes <100ms with small local model or simple rules)
→ Loads only skills relevant to that intent
→ Injects only those skill descriptions into the prompt

"hello"            → no skills loaded
"search the web"   → load: web_search only
"read this file"   → load: file_read only
"update project"   → load: memory_write only
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
- Classify intent
- Follow memory query flow (5 steps above, in order)
- Load only relevant skills
- Call LLM with lean context
- Write any new memory entries
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

*This document is the source of truth for this project.
Update it when architecture decisions change.
Do not let implementation drift from it silently.*
