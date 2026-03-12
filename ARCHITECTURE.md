# AgenticAGI — Architecture Deep Dive

> Based on actual source code as of the Phase 13 decomposition-first runtime and subsequent routing hardening.

---

## 1. What This System Is

AgenticAGI is a **local-first AI agent platform** with a structured, persistent memory system. It is not a chatbot that forgets between sessions. It is not a RAG pipeline that dumps documents into context. It is a system designed to behave like a knowledgeable human assistant: it remembers across sessions, fetches only what it needs, connects knowledge meaningfully, and thinks in the background when idle.

The codebase is TypeScript/Node.js (ESM), uses `better-sqlite3` for its index, writes memory as Markdown files on disk, and is tested with Vitest.

---

## 2. Core Design Principles (from `CLAUDE.md`)

| Principle | What It Means in Code |
|-----------|----------------------|
| **Files are truth, SQLite is the map** | All content lives in `.md` files. SQLite holds only metadata + search indexes. Never duplicate content. |
| **Index first, fetch second, search last** | Resolver tries direct code lookup → filter query → relationship traversal → only then calls `hybridSearch()`. |
| **Codes are the universal language** | Every entry has a code like `WHO.CT-000001`. Codes encode notebook + type + sequence number. |
| **Simplicity over cleverness** | Each layer must earn its place. No speculative abstractions. |

---

## 3. Top-Level Request Lifecycle

A user message enters `processMessage()` in `core/agent.ts` and now flows through a decomposition-first pipeline:

```
User Message
    │
    ▼
[1] Fast-path bypasses        ← core/agent.ts
    ├── /log ...     → immediate NOW.LOG write
    ├── /meeting     → Meeting Mode
    └── direct code  → direct memory fetch
    │
    ▼
[2] decomposeMessage()        ← core/decomposition.ts
    │  LLM-first structured decomposition
    │  Returns: DecompositionResult { units[] }
    │  unit.route ∈ { conversational | agentic | query }
    │
    ▼
[3] searchMemoryForUnits()    ← core/memory/unit-search.ts
    │  Runs one search per unit in parallel
    │  BM25 first, vector only as fallback
    │
    ▼
[4] routeDecomposedUnits()    ← core/router.ts
    │
    ├── conversational units → one batched LLM response
    ├── query units          → direct retrieval / hybrid fallback
    └── agentic units        → multi-goal planner + executor
         ▲
         └── resolved query units are injected into planning context
    │
    ▼
[5] Merge route outputs by original unit order
    │
    ▼
[6] AgentResponse
    { reply, intent, resolved, created?, error?, retries? }
```

Legacy exported intent labels still exist for compatibility, but they are no longer the primary runtime router.

---

## 4. Decomposition + Legacy Compatibility

`core/decomposition.ts` is now the primary understanding layer.

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

- If the initial decomposition under-splits an obviously compound message, the system retries with a stricter compound prompt.
- If that still fails, a narrow heuristic repair pass splits only on strong clause boundaries.
- The heuristic layer exists to protect the decomposition architecture, not to replace it.

### `core/intent.ts` status

`classifyIntent()` still exists, but it is now a compatibility shim for legacy tests, metadata, and a few older call paths. It is not the primary runtime router.

### What still uses the compatibility shim

- direct/simple `file_writer`
- direct/simple `run_bash`
- direct/simple `web_search`
- direct/simple `calculator`
- deterministic memory writes

Those paths are only allowed for single-unit, non-compound messages.

### Compatibility extraction shape

```typescript
interface Classification {
  intent: Intent;
  codes: string[];      // e.g. ["WHO.CT-000001"]
  nb?: string;          // "WHO" | "WHAT" | "WHEN" | "HOW" | "WHY" | "NOW" | "PLAN"
  type?: string;        // "CT" | "PJ" | "PR" | ...
  status?: string;      // "active" | "open" | "upcoming"
  name?: string;        // extracted entity name
  relation?: string;    // "owns" | "works_for" | "supplies" | "blocks" | "refers"
  skill?: string;       // "calculator" | "web_search" | ...
  skillInput?: Record<string, unknown>;
  due_date?: string;    // ISO date string
}
```

---

## 5. Memory System

### 5a. The 7-Notebook Schema

Every memory entry belongs to exactly one notebook. The notebook + type combination determines where the file lives and what the entry represents.

| Notebook | Purpose | Types |
|----------|---------|-------|
| **WHO** | People and organizations | CT (contact), ORG (organization) |
| **WHAT** | Projects and knowledge | PJ (project), KN (knowledge) |
| **WHEN** | Time-anchored entries | CA (calendar), DL (deadline), EV (episodic event), RF (reflection), HX (history) |
| **HOW** | Procedures and skills | PR (procedure), SK (skill) |
| **WHY** | Goals, questions, meta | MT (meta), QU (question) |
| **NOW** | Actionable current items | TD (todo), RP (report), LOG (log entry) |
| **PLAN** | Plans and constraints | PL (planning), EX (execution state), CT (constraint), MS (milestone), PJ (project brain) |

### 5b. Entry Code Format

`{NOTEBOOK}.{TYPE}-{SEQUENCE}`
Example: `WHO.CT-000042`

Codes are generated by `core/memory/codegen.ts` using an atomic SQLite counter increment (`nextCounter()` in `core/memory/index.ts`). The counter prevents race conditions.

### 5c. Dual Storage: Files + SQLite

**Markdown files** (canonical truth):
```
memory/WHO/contacts/WHO.CT-000001_john-smith.md
```
Each file has YAML frontmatter (`code`, `nb`, `type`, `name`, `status`, `updated`, `summary`) followed by the body content.

**SQLite** (`agent.db`, the map):
- `index_entries` — metadata only (code, nb, type, name, status, updated, summary, path, due_date, importance_score, etc.)
- `relationships` — directed graph edges between entries
- `counters` — atomic sequence numbers per type key
- `fts_content` — FTS5 full-text search index
- `chunks` — vector embedding chunks (BLOB storage)
- `heartbeat_queue` — notifications generated during background scans
- `settings` — key/value store (e.g., `embedding_model` for migration detection)

**Write order** (`core/memory/write.ts`): File write FIRST, SQLite transaction SECOND. If the file write fails, SQLite is never touched (no partial commit). If SQLite fails after the file write, the file is cleaned up. Files are the canonical store — SQLite is rebuilt from disk on bootstrap.

### 5d. Create / Upsert Flow

`upsertEntry()` is the primary write path:
1. Check if active entry with same (nb, type, name) exists in SQLite
2. **If yes** → update SQLite row + rewrite markdown file body (atomic transaction) → re-index FTS → git commit
3. **If no** → `createEntry()`: generate code → SQLite transaction (insert row + FTS index + chunk store) → write markdown file → schedule embedding (fire-and-forget) → git commit (fire-and-forget)

### 5e. Bootstrapping

On first startup with an empty SQLite (`index_entries` count = 0), `bootstrapIndexFromMemoryFiles()` scans all `.md` files under `memory/`, parses frontmatter, and rebuilds the entire index. This means you can delete `agent.db` and it will reconstruct from disk.

---

## 6. Memory Query Pipeline (`core/resolver.ts` + `core/memory/search.ts`)

When intent is `memory_query`, `code_fetch`, or `relationship_query`, the resolver runs a **5-step escalating lookup**:

```
Step 1: Direct code lookup (if codes[] non-empty)
    → getEntryByCode() + fetchByCode() for full content

Step 2: Filter query by nb/type/status/name
    → queryEntries({ nb, type, status, name })

Step 3: Relationship traversal (if relation verb found)
    → traverse graph from resolved entries

Step 4: Name fuzzy match
    → queryEntries({ name: extractedName })

Step 5: Hybrid search fallback (in agent.ts, after resolveQuery returns null)
    → hybridSearch(message, { nb })
```

Only if all steps fail does the agent return "No matching entries found."

### Hybrid Search (`core/memory/search.ts`)

```
hybridSearch(query)
    ├── BM25 via FTS5 (always available) → searchBM25()
    └── Vector cosine similarity (optional, when EMBEDDING_CONFIG set) → searchVectors()
         │
         └── Reciprocal Rank Fusion (RRF k=60)
              → merges both ranked lists
              → returns top-N SearchResult[]
```

RRF formula: `score += 1 / (60 + rank)` for each list. Vector results get a 1.01x weight multiplier for semantic tie-breaking. When embedding API is unavailable, falls back to BM25-only transparently.

### Relevance Ranking in Context (`core/context.ts`)

Before injecting memory into the LLM prompt, entries are re-ranked by `rankByLightRAG()`:

```
Score = (BM25F_field_weighted + recency_decay + importance_boost + utility_boost)
         × page_boost × pinned_boost
```

- **BM25F**: Term frequency weighted by field (name weight=5, summary weight=3)
- **Recency**: `e^(-0.05 * age_in_days)` — recent entries score higher
- **Importance**: `importance_score * 0.1` (set by LLM via `extractMemoryMetadata()`)
- **Active page**: `1.2x` if `active_page=1`, `0.8x` otherwise
- **Pinned**: `2.0x` boost

---

## 7. Planner/Executor Pipeline

### 7a. Task Planning (`core/planner.ts`)

Agentic units are grouped into one planning request. The planner receives:

- agentic goals only
- decomposition summary
- memory context from unit search
- prior query results resolved earlier in the same message
- skill catalog

`decomposeTask(message, context, llmHandler)` returns a milestone-aware `TaskPlan`:

```typescript
interface TaskPlan {
  goal: string;
  goals?: TaskGoal[];
  milestones?: TaskMilestone[];
  steps: TaskStep[];
  complexity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'MAX';
  needsConfirmation?: boolean;
  estimatedDuration?: string;
  createdAt: string;
}

interface TaskStep {
  id: string;           // unique step identifier
  skill: string;        // must match a registered skill name
  description: string;
  input: Record<string, unknown>;   // may contain {{template_tokens}}
  dependsOn: string[];  // step IDs that must complete first
  storeResultAs?: string;           // key to store output for downstream steps
  optional?: boolean;
  confidence_score?: number;
  risk_level?: string;
}
```

The LLM response is validated against `TaskPlanSchema` (Zod v4). If validation fails, a retry is attempted with the schema sent directly as a structured output hint.

Current rule: all plans use milestones. `LOW` complexity gets exactly one milestone; higher-complexity plans must use explicit milestone boundaries.

Template tokens (`{{step_id_result}}`) still allow one step's output to flow into later inputs.

### 7b. Execution (`core/executor.ts`)

`executePlan()` now executes by milestone, then by step:

```
For each milestone in plan.milestones:
    1. Emit milestone_start
    2. Execute steps sequentially with dependency / timeout / risk guards
    3. On failure: persist PLAN.EX as failed and abort
    4. On success: run post-milestone memory cycle
    5. Emit milestone_result
    6. Reevaluate remaining milestones conservatively
```

Required step failure → plan aborts. Optional step failure → continue with remaining steps.

### 7c. Post-milestone memory cycle

After each completed milestone:

1. write `WHEN.EV`
2. optionally write `HOW.PR`
3. update `PLAN.EX`
4. infer/write relationships where possible

After full completion:

1. write `WHEN.RF`
2. update matching `PLAN.PJ` summary when relevant
3. extract durable facts into `WHAT` / `WHO` where justified

### 7d. PLAN.EX state machine (`core/memory/plan-ex.ts`)

`PLAN.EX` is the persisted execution-state notebook for planned work.

- `active` / `in_progress` → resumable
- `complete` / `failed` → terminal
- Active-plan loading only returns resumable states
- Status is updated in both SQLite and markdown frontmatter

This was hardened after a real bug where completed plans remained `active` and accumulated false startup resume prompts.

### 7e. Verification (`core/executor.ts`)

`verifyExecution()` sends plan goal + completed/failed summaries to the LLM and asks:
```json
{"verified": true/false, "confidence": 0.0-1.0, "issues": [...], "suggestion": "..."}
```
Verification is advisory — never blocks execution.

### 7f. Completion memory

Final plan completion still writes episodic and reflective memory. Failures also produce `WHEN.EV` entries to avoid survivorship bias.

---

## 8. Skills Registry (`core/skills/registry.ts`)

Skills are **MCP-compatible** (Model Context Protocol). Each skill is an `MCPSkill`:

```typescript
interface MCPSkill {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;   // JSON Schema
  execute(input: Record<string, unknown>): Promise<SkillResult>;
}
```

### Registered Skills (14 total)

| Skill | Purpose |
|-------|---------|
| `calculator` | Math evaluation via `mathjs` |
| `file_reader` | Read files from workspace |
| `web_search` | Web search (Brave/SerpAPI/fallback) |
| `file_writer` | Write files to workspace |
| `run_bash` | Execute shell commands |
| `memory_read` | Query the agent's own memory |
| `memory_write` | Write to the agent's memory |
| `content_writer` | LLM-based content generation |
| `web_fetch` | Fetch URL content |
| `url_extract` | Extract structured data from URL |
| `relationship_write` | Create memory relationships |
| `implement_and_test` | Write code + run tests |
| `memory_history` | Query git history of a memory entry |
| `verify_state` | Verify filesystem/process state |

### ReAct Retry (`core/react.ts`)

`runWithRetry(skill, input, llmHandler)` wraps skill execution:
- On failure, sends the error to the LLM and asks it to propose a corrected input
- Retries up to a configured limit
- Returns `{ success, output, error, retries }`

---

## 9. Context Assembly (`core/context.ts`)

`buildContext()` assembles the final message array sent to the LLM. Order of assembly:

```
System Prompt (SYSTEM_PROMPT constant)
    + Owner Persona (WHO.CT first active contact, cached 60s)
    + Notebook Counts (only for summary/overview intent)
    + Resolved Memory (entries ranked by rankByLightRAG, full content if available)
    + Active Constraints (PLAN.CT entries — injected into EVERY step)
    + Skill Output (if skill ran)
    + Previous Conversation Summary (if history compacted)
    ─────────────────────────────
    [system message]
    [history messages]
    [user message]
```

### Token Budget Management

- **Soft limit**: 1500 tokens
- **Hard ceiling**: 2000 tokens
- **Warning**: 1200 tokens (80%)

When budget is exceeded, four progressive strategies run:
1. Token-budget-aware history trim (keep as many recent turns as fit in 40% of budget)
2. Trim memory to summaries only + truncate skill output to 2000 chars
3. Drop all history, keep system + user only
4. Truncate user input (if still over ceiling)

### Rolling Summarization

When history > 12 turns, `buildRollingContext()` runs:
- Old turns → 2-3 sentence summary (5s timeout, graceful fallback)
- Recent 3 turns → kept verbatim
- Summary appended to system message (not as a separate message — LLM template compatibility)

---

## 10. Heartbeat (`core/heartbeat.ts`)

The heartbeat runs every 30 minutes while the agent is idle (skips if `isProcessingMessage = true`):

```
checkDeadlines()         — WHEN entries due within 24h
checkOverdueTodos()      — NOW.TD / PLAN.PL past due_date → marks 'overdue'
checkStaleQuestions()    — WHY.QU open for 3+ days
checkPlanCalibration()   — PLAN.PL active for 7+ days without update
checkStaleProjects()     — WHAT.PJ active for 7+ days
checkVisionAlignment()   — Plans/projects with no keyword overlap with North Star vision
checkStalePlanPJ()       — PLAN.PJ project brains not updated in 3+ days
```

Each check runs in isolation — one failure does not stop others.

Findings are:
1. Written as `WHY.MT` entries in memory
2. Queued in `heartbeat_queue` table
3. Surfaced to user at next `processMessage()` call as a prefix ("📋 While you were away: ...")

---

## 11. Memory Versioning (`core/memory/versioning.ts`)

Every `createEntry()` and `upsertEntry()` call triggers `commitMemoryWrite()`:
- Initializes a git repo in the memory directory if needed
- Stages the changed `.md` file
- Creates a commit: `"memory: update {code} ({name}) by {actor}"`
- Fire-and-forget — never blocks the write path

The `memory_history` skill lets the agent query git log for any entry, providing full change history.

---

## 12. Memory Lifecycle (`core/memory/lifecycle.ts`)

After a memory write, `extractMemoryMetadata()` fires asynchronously:
- Calls the LLM with the entry's content
- Extracts `importance_score` (0.0–1.0) and `atomic_facts` (key facts as JSON array)
- Stores back in SQLite
- These values feed into `rankByLightRAG()` scoring

---

## 13. Transparency System (`core/transparency.ts`)

An event emitter that publishes internal agent events without coupling subsystems:

```typescript
type TransparencyEvent =
  | { type: 'decomposition'; data: DecompositionResult }
  | { type: 'unit_memory_search'; data: { unit: DecomposedUnit; result: UnitMemoryResult } }
  | { type: 'plan'; data: TaskPlan }
  | { type: 'step_start'; data: { step: TaskStep } }
  | { type: 'step_result'; data: { step, result, ms } }
  | { type: 'milestone_start'; data: { id, title, index, total } }
  | { type: 'milestone_result'; data: { id, title, success, index, total } }
  | { type: 'milestone_revised'; data: { fromId, remaining } }
  | { type: 'milestone_memory_cycle'; data: { milestoneId, writes } }
  | { type: 'failure_classified'; data: { error, class: FailureClass } }
  | { type: 'context_built'; data: { tokens, sections } }
  | { type: 'context_compacted'; data: { before, after } }
```

The renderer (`core/transparency-renderer.ts`) subscribes and renders these as human-readable output.

---

## 14. Data Flow Diagram

```
User Input
    │
    ▼
Fast-path bypass check    [/log, /meeting, direct code]
    │
    ▼
decomposeMessage()        [structured LLM output]
    │
searchMemoryForUnits()    [parallel per-unit search]
    │
    ▼
routeDecomposedUnits()    [router.ts]
    │
    ├── conversational → buildContext() → callLLM()
    ├── query          → direct retrieval / hybrid fallback
    └── agentic        → decomposeTask()
                         → executePlan() by milestone
                         → verifyExecution()
                         → buildUserReport()
                         → milestone/final memory writes
    │
    ▼
merge by unit order
    │
    ▼
AgentResponse
```

---

## 15. Key Files Reference

| File | Role |
|------|------|
| `core/agent.ts` | Main request handler, fast paths, compatibility shim |
| `core/decomposition.ts` | Structured message decomposition + compound hardening |
| `core/router.ts` | Route execution for conversational / query / agentic units |
| `core/intent.ts` | Legacy compatibility classifier, no longer primary router |
| `core/planner.ts` | Multi-goal, milestone-aware task planning |
| `core/executor.ts` | Milestone execution loop, verification, reporting |
| `core/context.ts` | Context assembly, token budget, rolling summarization |
| `core/react.ts` | ReAct retry wrapper for skills |
| `core/resolver.ts` | 5-step memory query escalation |
| `core/llm.ts` | LLM endpoint adapter |
| `core/heartbeat.ts` | Background memory health checks |
| `core/transparency.ts` | Internal event bus |
| `core/memory/unit-search.ts` | Parallel per-unit memory search with BM25/vector fallback |
| `core/memory/index.ts` | SQLite init, schema, bootstrap from disk |
| `core/memory/write.ts` | createEntry, upsertEntry, updateEntry |
| `core/memory/plan-ex.ts` | PLAN.EX persistence, active-plan loading, terminal status handling |
| `core/memory/search.ts` | hybridSearch, BM25+vector+RRF |
| `core/memory/fts.ts` | FTS5 full-text search |
| `core/memory/embeddings.ts` | Vector embeddings, cosine similarity |
| `core/memory/codegen.ts` | Entry code generation |
| `core/memory/versioning.ts` | Git-backed memory commits |
| `core/memory/lifecycle.ts` | Async importance scoring + atomic fact extraction |
| `core/memory/episodic.ts` | WHEN.EV and WHEN.RF write helpers |
| `core/skills/registry.ts` | MCP skill registry |
| `core/skills/runner.ts` | Skill execution |
| `core/skills/tools/` | Individual skill implementations |
| `core/structured.ts` | Generic structured LLM output pipeline |
| `core/agent-card.ts` | A2A agent card (capability advertisement) |
| `config/agent.config.ts` | Paths, type map, embedding config |
| `chat.ts` | CLI entry point |
