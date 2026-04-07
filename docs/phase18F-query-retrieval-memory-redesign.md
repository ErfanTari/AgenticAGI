# Zaraban — Query Retrieval & Memory Redesign Sprint
### For: Claude Code (single session)
### Tag on completion: `phase-18-retrieval-memory-complete`

---

## Context

This prompt is derived from three transparency logs captured on 2026-04-07. Three consecutive
user queries — "tell me all your plans about the tennis 3d game", "tell me all contacts in your
memory", "tell me all projects you're working on" — all returned zero results despite the agent
having memory. The failure chain is identical in every case.

Read `CLAUDE.md` fully before touching any file. The architecture is decomposition-first (Phase 13),
QueryLoop for LOW/MEDIUM, milestone planner for HIGH/MAX. All previous fix sprints are complete.

**Do not change the architecture. All fixes are surgical edits within existing files.**
**Do not break existing tests. Add new tests only.**
**After each batch: `pnpm build && pnpm test`**

---

## Root Causes Found Across All Three Logs

Before reading the fix list, understand the shared failure chain:

1. **Intake signal parser broken** — LLM correctly classifies `query: true` and `project: {...}`,
   but the signal parser maps nothing. Every signal arrives as `null`/`false` regardless of LLM output.
2. **`querySignal: false` on clearly memory-query messages** — "tell me all contacts in your memory"
   gets `querySignal: false`. The signal parser is not reading the `query` boolean field from the LLM JSON.
3. **Unit-search uses `time` strategy for "previously"** — temporal language triggers WHEN notebook
   search even when a project name is present. Project signal must take priority over temporal language.
4. **Listing queries hit BM25 with zero keywords** — "all contacts", "all projects" have no BM25
   keywords to match. These are type-scoped scan queries that should hit `queryEntries({ nb, type })`
   directly, not FTS5.
5. **Intake signals not passed to unit-search** — even when intake correctly identifies a project,
   those signals are disconnected from `unit-search.ts`. They never scope the search.
6. **Memory entries have thin bodies** — PLAN.PJ, WHAT.PJ entries exist but carry insufficient
   narrative to answer "tell me your plans about X" even when found.

Every fix below maps to one or more of these root causes.

---

## Files You Will Touch

```
core/agent.ts                          ← FIX 1: signal parser
core/memory/unit-search.ts             ← FIX 2: strategy selection, FIX 3: listing fast-path,
                                          FIX 4: intake signal passthrough
core/memory/write.ts                   ← FIX 5: richer memory body format
config/agent.config.ts                 ← FIX 5: TYPE_MAP additions if needed
tests/retrieval-fixes/retrieval.test.ts ← NEW: your tests
```

**Do NOT touch:**
- `core/router.ts`
- `core/decomposition.ts`
- `core/query-loop.ts`
- Any existing test files
- `CLAUDE.md`

---

## Batch 0 — P0: Signal Parser (Everything Else Depends On This)

Run `pnpm build && pnpm test` after this batch before proceeding.

---

### FIX 1 — Intake Signal Parser: Read What the LLM Actually Returns

**Problem:**

In `core/agent.ts`, the intake classifier sends this prompt to the LLM and gets back a JSON like:

```json
{
  "summary": "...",
  "person": { "name": "tennis 3d game", "confidence": 0.95 },
  "project": { "name": "tennis 3d game", "confidence": 0.95 },
  "time": null,
  "agentic": false,
  "procedure": false,
  "query": true
}
```

But the resulting `signals` object always has:
```json
{
  "personSignal": null,
  "projectSignal": null,
  "querySignal": false
}
```

The parser is not mapping LLM output fields to signal fields. Find the code in `core/agent.ts`
that parses the intake LLM response into the `signals` object. It will look something like:

```typescript
const signals = {
  summary: parsed.summary ?? message,
  personSignal: /* something wrong here */,
  projectSignal: /* something wrong here */,
  querySignal: /* something wrong here */,
  ...
};
```

**What to do:**

Fix the mapping to read the actual LLM response fields:

```typescript
const signals = {
  summary: parsed.summary ?? message,
  personSignal: parsed.person?.confidence > 0.7 ? parsed.person.name : null,
  projectSignal: parsed.project?.confidence > 0.7 ? parsed.project.name : null,
  timeSignal: parsed.time?.description ?? null,
  agenticSignal: parsed.agentic === true,
  procedureSignal: parsed.procedure === true,
  querySignal: parsed.query === true,
};
```

Key rules:
- `personSignal` is the name string when confidence > 0.7, otherwise null
- `projectSignal` is the name string when confidence > 0.7, otherwise null
- `querySignal` maps directly from the `query` boolean — no threshold
- If `parsed` is null/undefined (LLM parse failure), all signals default to safe values:
  `agenticSignal: false`, `querySignal: false`, nulls for the rest. Do NOT default
  `agenticSignal: true` — that causes unwanted plan spawning.

Also add a transparency emit after signals are built:

```typescript
emitTransparency('intake_signals', {
  personSignal: signals.personSignal,
  projectSignal: signals.projectSignal,
  querySignal: signals.querySignal,
  agenticSignal: signals.agenticSignal,
});
```

This makes signal extraction visible in the transparency panel.

---

## Batch 1 — P1: Unit-Search Strategy + Fast Paths

Run `pnpm build && pnpm test` after Batch 0 before starting here.

---

### FIX 2 — Unit-Search Strategy Selection: Project Signal Beats Temporal Language

**Problem:**

In `core/memory/unit-search.ts`, the strategy selector chose `time` for the query
"you had planned previously for a tennis 3d game" because "previously" triggered a
temporal heuristic. The actual subject is a project, not a time event.

Find `unit-search.ts` where the strategy is selected from the unit content. It will
look something like a series of `if (content.includes(...))` checks for signals, with
a final fallback to `bm25`. The `time` strategy is probably triggered by words like:
"previously", "before", "last time", "earlier", "yesterday", "last week".

**What to do:**

Add signal priority ordering. The check order must be:

1. **Codes present** → `direct` (already correct)
2. **Project signal present (from intake OR content keywords)** → `project` strategy
3. **Person signal present** → `person` strategy  
4. **Time language present AND no project/person signal** → `time` strategy
5. **Content mentions notebook type keywords** (contacts, projects, tasks, notes) → `type_scan`
6. **Fallback** → `bm25`

For the `project` strategy: search `WHAT.PJ`, `PLAN.PJ` by name similarity using the
project name from `signals.projectSignal` OR extracted from the content with a simple
keyword extraction (words after "about", "for", "regarding", "the" that are capitalized
or quoted).

When `strategy = 'project'` and a name is extracted, call:
```typescript
const entries = await queryEntries({
  nb: 'WHAT',
  type: 'PJ',
  name: extractedProjectName,
});
// Also search PLAN.PJ
const planEntries = await queryEntries({
  nb: 'PLAN',
  type: 'PJ',
  name: extractedProjectName,
});
```

If direct name match returns zero results, fall through to BM25 scoped to `WHAT` and `PLAN`
notebooks only. Do not search all notebooks for project queries.

Add a transparency emit:
```typescript
emitTransparency('unit_memory_search', {
  strategy,
  projectName: extractedProjectName ?? null,
  confidence: entries.length > 0 ? 1 : 0,
  entries: entries.map(e => e.code),
});
```

---

### FIX 3 — Listing Queries: Type-Scan Fast Path Before BM25

**Problem:**

Queries like "tell me all contacts in your memory", "tell me all projects", "list all todos"
have no BM25 keywords. They are **type-listing requests** — the user wants all entries of a
given type. BM25 returns zero because there is nothing to match against.

**What to do:**

In `unit-search.ts`, before the BM25 path, add a `detectListingQuery()` function:

```typescript
function detectListingQuery(content: string): { nb: string; type: string } | null {
  const lower = content.toLowerCase();
  const patterns: Array<{ keywords: string[]; nb: string; type: string }> = [
    { keywords: ['contact', 'contacts', 'people', 'person'], nb: 'WHO', type: 'CT' },
    { keywords: ['project', 'projects', 'working on'], nb: 'WHAT', type: 'PJ' },
    { keywords: ['todo', 'todos', 'task', 'tasks', 'to-do'], nb: 'NOW', type: 'TD' },
    { keywords: ['note', 'notes', 'knowledge'], nb: 'WHAT', type: 'KN' },
    { keywords: ['procedure', 'procedures', 'skill', 'skills', 'how to'], nb: 'HOW', type: 'PR' },
    { keywords: ['deadline', 'deadlines', 'due'], nb: 'WHEN', type: 'DL' },
    { keywords: ['plan', 'plans', 'planning'], nb: 'PLAN', type: 'PL' },
    { keywords: ['goal', 'goals', 'objective'], nb: 'WHY', type: 'MT' },
  ];

  // Only trigger on listing language
  const listingLanguage = ['all ', 'list', 'show me', 'tell me', 'every ', 'what are my'];
  const hasListingLanguage = listingLanguage.some(l => lower.includes(l));
  if (!hasListingLanguage) return null;

  for (const pattern of patterns) {
    if (pattern.keywords.some(k => lower.includes(k))) {
      return { nb: pattern.nb, type: pattern.type };
    }
  }
  return null;
}
```

In the strategy selector, call `detectListingQuery()` BEFORE the BM25 path. If it matches:

```typescript
const listingMatch = detectListingQuery(unit.content);
if (listingMatch) {
  const entries = await queryEntries({
    nb: listingMatch.nb,
    type: listingMatch.type,
    status: 'active',  // only active entries
  });
  return {
    unitId: unit.id,
    strategy: 'type_scan',
    confidence: entries.length > 0 ? 1 : 0,
    entries,
    contents: entries.map(e => e.summary ?? e.name),
  };
}
```

If `type_scan` returns zero results (empty notebook), the response should still be meaningful —
the agent will say "you have no active contacts" not "I couldn't find anything".

---

### FIX 4 — Pass Intake Signals Into Unit-Search as Scope Constraints

**Problem:**

`unit-search.ts` operates only on the unit content string. It does not receive the intake
signals even though those signals already contain pre-classified information (project name,
person name, time description). This is duplicate work and causes divergence — intake says
"project: tennis 3d game, confidence 0.95" but unit-search rediscovers nothing.

**What to do:**

Update the `UnitMemoryResult` call signature in `unit-search.ts` to accept optional signals:

```typescript
interface UnitSearchOptions {
  projectSignal?: string | null;
  personSignal?: string | null;
  timeSignal?: string | null;
}

async function searchUnitMemory(
  unit: DecomposedUnit,
  db: Database,
  options?: UnitSearchOptions,
): Promise<UnitMemoryResult>
```

In the strategy selector, check `options.projectSignal` FIRST:

```typescript
if (options?.projectSignal) {
  // Use projectSignal as primary search term for WHAT.PJ + PLAN.PJ
  // This short-circuits the content heuristics
  strategy = 'project';
  projectName = options.projectSignal;
}
```

In `core/router.ts` or wherever `searchMemoryForUnits()` is called, pass the signals
from the intake result:

```typescript
const searchResults = await searchMemoryForUnits(units, db, {
  projectSignal: intake.signals.projectSignal,
  personSignal: intake.signals.personSignal,
  timeSignal: intake.signals.timeSignal,
});
```

Find the call site — it may be in `router.ts` or `agent.ts`. Make the options parameter
optional so no existing tests break if they don't pass it.

---

## Batch 2 — P2: Memory Body Format Improvements

Run `pnpm build && pnpm test` after Batch 1 before starting here.

These changes make memory entries worth finding once retrieval works.

---

### FIX 5 — Richer PLAN.PJ and WHAT.PJ Entry Bodies

**Problem:**

When a user asks "tell me all your plans about the tennis 3d game", even if we find the
PLAN.PJ entry, the body is a thin stub — `vision`, `phase`, `blocked_by`. It cannot answer
"what were the plans" or "what was the original request". The agent has to hallucinate.

**What to do:**

In `core/memory/write.ts`, find the function that writes `PLAN.PJ` entries
(also check `core/memory/project.ts` for `createProjectEntry()`).

Update the markdown body template to include these required sections:

```typescript
function buildProjectBody(entry: {
  name: string;
  initialPrompt: string;
  goal: string;
  phase: string;
  vision?: string;
  blockedBy?: string[];
  decisions?: string[];
  conclusions?: string;
}): string {
  return `## Initial Request
${entry.initialPrompt}

## Goal
${entry.goal}

## Phase
${entry.phase}

## Vision
${entry.vision ?? '_Not specified_'}

## Key Decisions
${entry.decisions?.map(d => `- ${d}`).join('\n') ?? '_None recorded yet_'}

## Progress Notes
_Updated as milestones complete_

## Conclusions
${entry.conclusions ?? '_Project ongoing_'}

## Blocked By
${entry.blockedBy?.map(b => `- ${b}`).join('\n') ?? '_Nothing_'}
`;
}
```

The `initialPrompt` field is critical — it stores the verbatim (or near-verbatim) user
request that started the project. This is what makes "tell me your plans about X" answerable
from the stored entry rather than from LLM hallucination.

Update the `ProjectEntry` interface in `core/memory/project.ts` to add:
```typescript
initialPrompt: string;   // verbatim or near-verbatim user request
goal: string;            // outcome description (not step list)
decisions: string[];     // fork-in-road decisions recorded during execution
conclusions: string;     // post-completion: what worked, what didn't
```

Update `createProjectEntry()` to accept and persist these fields.

In `core/memory/memory-agent.ts`, in the `task_complete` handler that calls
`update_project_brain`, pass the original user goal from working memory as `initialPrompt`
if not already set (check `existingEntry.initialPrompt` before overwriting).

---

### FIX 6 — WHAT.PJ Entries Also Get Initial Prompt and Task List

**Problem:**

Your redesign (Proposal 3) is correct: WHAT.PJ should cover tasks, not just project names.
Currently WHAT.PJ only stores a project stub. Tasks (NOW.TD) have no navigable link back
to their parent project, making project queries return incomplete pictures.

**What to do:**

Add a `tasks` section to the WHAT.PJ markdown body template:

```typescript
function buildWhatPJBody(entry: {
  name: string;
  initialPrompt: string;
  description: string;
  status: string;
  taskCodes?: string[];   // links to NOW.TD entries
}): string {
  return `## Description
${entry.description}

## Initial Request
${entry.initialPrompt}

## Tasks
${entry.taskCodes?.map(c => `- ${c}`).join('\n') ?? '_No tasks recorded yet_'}

## Status
${entry.status}
`;
}
```

When `memory-agent.ts` writes `conversational_facts` that creates a new WHAT.PJ entry,
pass the triggering user message as `initialPrompt`.

When `executePlan()` creates NOW.TD entries during a plan, write a `contains` relationship:
```typescript
await writeRelationship({
  from_code: whatPjCode,
  relation: 'contains',
  to_code: nowTdCode,
  note: 'task spawned from this project',
});
```

This makes "tell me tasks for project X" traversable via the relationship graph (Step 3
of the 5-step lookup) without needing a search.

---

## Tests to Write

Create `tests/retrieval-fixes/retrieval.test.ts`.

Target: **18 tests minimum**, all must pass before tagging.

### Signal Parser (4 tests)
1. LLM returns `{ query: true, project: { name: "X", confidence: 0.9 } }` → `querySignal: true`, `projectSignal: "X"`
2. LLM returns `{ query: false, project: null }` → `querySignal: false`, `projectSignal: null`
3. LLM returns `{ person: { name: "Sara", confidence: 0.8 } }` → `personSignal: "Sara"`
4. LLM parse failure (malformed JSON) → all signals default to safe values, no throw

### Strategy Selection (4 tests)
5. Content "tennis 3d game plans" + `projectSignal: "tennis 3d game"` → strategy `project`, searches WHAT.PJ + PLAN.PJ
6. Content "you had planned previously for X" + `projectSignal: "X"` → strategy `project` (NOT `time`)
7. Content "what happened last Tuesday" + no project signal → strategy `time`
8. Content "who is Sara" + `personSignal: "Sara"` → strategy `person`, searches WHO

### Listing Fast Path (5 tests)
9. "tell me all contacts in your memory" → strategy `type_scan`, nb=WHO, type=CT
10. "list all projects" → strategy `type_scan`, nb=WHAT, type=PJ
11. "show me my todos" → strategy `type_scan`, nb=NOW, type=TD
12. "what are my deadlines" → strategy `type_scan`, nb=WHEN, type=DL
13. "what is the capital of France" → NOT detected as listing (no listing language)

### Signal Passthrough (2 tests)
14. `searchMemoryForUnits()` called with `projectSignal: "tennis"` → unit-search receives signal, uses it
15. `searchMemoryForUnits()` called without options → works identically to before (no regression)

### PLAN.PJ Body Format (3 tests)
16. `createProjectEntry()` with `initialPrompt` → markdown body contains `## Initial Request` section
17. `createProjectEntry()` without `initialPrompt` → body still writes, section shows placeholder
18. `fetchByCode(planPjCode)` on a newly created entry → returns body containing original prompt text

---

## Completion Checklist

- [x] FIX 1: Signal parser reads `query`, `project`, `person` fields from LLM output correctly
- [x] FIX 1: `intake_signals` transparency event emitted with signal values
- [x] FIX 2: Project signal takes priority over temporal language in strategy selection
- [x] FIX 2: `project` strategy searches WHAT.PJ + PLAN.PJ by name
- [x] FIX 3: `detectListingQuery()` added, triggers before BM25
- [x] FIX 3: Type-scan returns active entries for listing queries
- [x] FIX 4: `searchMemoryForUnits()` accepts optional signals parameter
- [x] FIX 4: Intake signals passed from agent/router into unit-search
- [x] FIX 5: PLAN.PJ body template includes `initialPrompt`, `goal`, `decisions`, `conclusions`
- [x] FIX 6: WHAT.PJ body template includes `initialPrompt`, `tasks` section
- [x] FIX 6: `contains` relationship written from WHAT.PJ to NOW.TD on plan execution
- [x] All 18 tests pass
- [x] `pnpm build` clean
- [x] All prior tests still pass (no regressions)
- [x] `CLAUDE.md` updated with Phase 18F section
- [ ] Tag: `phase-18-retrieval-memory-complete`

---

## CLAUDE.md Section to Add After Completion

```markdown
## Phase 18 — Query Retrieval Fixes + Memory Body Format (COMPLETE)

### Root Causes Fixed
Three consecutive user queries returned zero results despite entries existing in memory.
Root causes: intake signal parser broken (all signals null), unit-search strategy wrong
(temporal beats project), listing queries hitting BM25 with no keywords, intake signals
not passed to unit-search.

### FIX 1 — Intake Signal Parser (`core/agent.ts`)
- `personSignal`: mapped from `parsed.person.name` when `confidence > 0.7`
- `projectSignal`: mapped from `parsed.project.name` when `confidence > 0.7`
- `querySignal`: mapped directly from `parsed.query` boolean
- `intake_signals` transparency event emitted with resolved values

### FIX 2 — Strategy Priority (`core/memory/unit-search.ts`)
- Priority order: direct codes → project signal → person signal → time → type_scan → bm25
- `project` strategy searches WHAT.PJ + PLAN.PJ by name
- Temporal language no longer overrides project signal

### FIX 3 — Listing Fast Path (`core/memory/unit-search.ts`)
- `detectListingQuery()` — detects "all contacts / projects / tasks / etc" patterns
- Returns `strategy: 'type_scan'` → `queryEntries({ nb, type, status: 'active' })`
- Fires before BM25, no keyword matching needed

### FIX 4 — Signal Passthrough (`core/memory/unit-search.ts`, `core/router.ts`)
- `searchMemoryForUnits()` accepts optional `{ projectSignal, personSignal, timeSignal }`
- Intake signals from `core/agent.ts` passed through to scoping in unit-search

### FIX 5 — PLAN.PJ Body Format (`core/memory/project.ts`)
- Added required fields: `initialPrompt`, `goal`, `decisions[]`, `conclusions`
- Body template now includes `## Initial Request`, `## Key Decisions`, `## Conclusions`

### FIX 6 — WHAT.PJ Body + Task Relationships (`core/memory/write.ts`)
- WHAT.PJ body includes `initialPrompt`, `## Tasks` section
- `contains` relationship written from WHAT.PJ → NOW.TD on plan execution

### Test Results
- 18 new tests in `tests/retrieval-fixes/retrieval.test.ts` — all pass
- All prior tests pass
- Build: zero TypeScript errors
```
