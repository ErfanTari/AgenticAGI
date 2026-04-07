# Zaraban — Listing Fast-Path Wiring + Memory Template Quality Sprint
### For: Claude Code (single session)
### Tag on completion: `phase-18G-complete`
### Baseline: 999 tests passing (phase-18F-complete)

---

## Context

Phase 18F fixed signal parsing. The `querySignal: true` is now correctly set. But
`unit_memory_search` still shows `strategy: bm25, conf: 0` on every listing query.
Additionally, examining real memory files reveals that entries are written with nearly
empty bodies, duplicate entries are not being caught by conflict resolution, and
completed PLAN.EX entries are still persisted with `status: active`.

Two problems, one sprint. Both must be fixed before tagging.

Read `CLAUDE.md` fully before touching any file.
**Do not change architecture. All fixes are surgical.**
**Do not break existing 999 tests. Add new tests only.**
**After each batch: `pnpm build && pnpm test`**

---

## Root Causes

1. **`detectListingQuery()` unreachable** — Either the function exists but is only called
   after a guard that never passes, OR `searchMemoryForUnits()` is being called without
   the `options` argument so the listing path never activates. Either way, every listing
   query falls through to BM25 with zero keywords and returns nothing.

2. **Memory entries written with empty bodies** — `WHO.CT`, `WHAT.PJ`, `NOW.LOG` entries
   are created with only a heading and no content. The body template is not enforcing
   minimum required sections.

3. **Duplicate `WHAT.KN` entries not caught** — Two entries for "Favorite Color" and
   "Favorite Vericolor" exist simultaneously with `status: active`. `resolveConflict()`
   is supposed to fire at name similarity > 0.6 but isn't triggering.

4. **Completed `PLAN.EX` entries still `status: active`** — Plans with all milestones
   `done: true` are persisted as `active`. The terminal status write at plan close is
   broken or missing.

5. **`NOW.LOG` status pollutes active scans** — Logs use `status: active` which makes
   them appear in active item scans alongside actionable todos. Logs are historical
   records, not actionable items.

---

## Files You Will Touch

```
core/memory/unit-search.ts          ← FIX 1: listing fast-path wiring
core/agent.ts OR core/router.ts     ← FIX 1: options passthrough call site
core/memory/write.ts                ← FIX 2: body template enforcement
core/memory/project.ts              ← FIX 2: WHAT.PJ + PLAN.PJ templates
core/memory/plan-ex.ts              ← FIX 4: terminal status write
core/executor.ts                    ← FIX 4: status update on plan complete
tests/phase18g/phase18g.test.ts     ← NEW: your tests
```

**Do NOT touch:**
- `core/router.ts` routing logic
- `core/decomposition.ts`
- `core/query-loop.ts`
- Any existing test file

---

## Batch 0 — P0: Wire the Listing Fast-Path (One Bug, Must Fix First)

### FIX 1 — Connect `detectListingQuery()` to the Execution Path

**Step 1: Find the call site.**

Search for where `searchMemoryForUnits()` is called in the codebase. It will be in
`core/agent.ts` or `core/router.ts`. Look at the call:

```typescript
// What it probably looks like now (broken):
const searchResults = await searchMemoryForUnits(units, db);

// What it should look like:
const searchResults = await searchMemoryForUnits(units, db, {
  projectSignal: intake.signals.projectSignal ?? undefined,
  personSignal: intake.signals.personSignal ?? undefined,
  timeSignal: intake.signals.timeSignal ?? undefined,
});
```

If the third argument is missing → that is the wiring bug. Add it. The `intake.signals`
object is available at the call site (it was built in the intake step just before).

**Step 2: Verify `detectListingQuery()` placement inside `unit-search.ts`.**

Open `core/memory/unit-search.ts`. Find the main search function body. The execution
order MUST be:

```
1. Direct code lookup (if codes[] present)
2. detectListingQuery(unit.content)   ← MUST be here, before any signal checks
3. options?.projectSignal → project search
4. options?.personSignal  → person search
5. options?.timeSignal    → time search
6. BM25 fallback
```

If `detectListingQuery()` is called AFTER step 3 or 4, or is inside a block that
requires `options` to be non-null, move it to position 2. Listing detection is
**content-only** — it does not depend on signals and must work even when options
is undefined.

**Step 3: Verify the detection patterns cover the test cases.**

The following phrases must ALL trigger `type_scan`:
- "tell me a list of all your contacts" → `WHO.CT`
- "tell me all contacts" → `WHO.CT`
- "list all projects" → `WHAT.PJ`
- "show me all my todos" → `NOW.TD`
- "what are all my deadlines" → `WHEN.DL`
- "show me all skills" → `HOW.PR` or `HOW.SK`

Check that "contacts" is in the keyword list (not just "contact" without the plural).
Check that "list of all your" matches because "list" is a listing trigger word.

**Step 4: Verify `queryEntries()` is being called correctly for type_scan.**

When `detectListingQuery()` returns `{ nb: 'WHO', type: 'CT' }`, the search must call:

```typescript
const entries = await queryEntries(db, {
  nb: 'WHO',
  type: 'CT',
  status: 'active',
});
```

Check that `queryEntries` accepts these parameters and that the SQL filter uses
`status = 'active'` so archived/completed entries don't appear in listings.

Add a transparency emit for the type_scan path:
```typescript
emitTransparency('unit_memory_search', {
  unitId: unit.id,
  strategy: 'type_scan',
  nb: match.nb,
  type: match.type,
  confidence: entries.length > 0 ? 1 : 0,
  count: entries.length,
});
```

---

## Batch 1 — P1: Memory Entry Quality

Run `pnpm build && pnpm test` after Batch 0 before starting here.

---

### FIX 2 — Enforce Minimum Body Sections for WHO.CT and WHAT.PJ

**Problem:** Real memory entries have empty bodies. The contact for the system owner
(`WHO.CT-000001`) contains only a heading. Project entries (`WHAT.PJ-000014`) are
completely blank after the frontmatter.

**File:** `core/memory/write.ts` and `core/memory/project.ts`

**WHO.CT body template** — update `createEntry()` for `nb: 'WHO', type: 'CT'` to
generate this body when no body is provided:

```markdown
## Role / Relationship
_Not specified_

## Background
_Not specified_

## Notes
_No notes yet_
```

When a body IS provided (non-empty string), use it as-is — do not overwrite. The
template only fires when body is empty or missing.

**WHAT.PJ body template** — when `createEntry()` or `createProjectEntry()` writes a
`WHAT.PJ` entry with an empty body, use:

```markdown
## Description
_Not specified_

## Initial Request
_Not specified_

## Status
Active

## Tasks
_No tasks recorded yet_

## Notes
_No notes yet_
```

**PLAN.PJ body template** — same pattern, add required sections if body is empty:

```markdown
## Initial Request
_Not specified_

## Goal
_Not specified_

## Phase
_Not specified_

## Key Decisions
_None recorded yet_

## Progress Notes
_Updated as milestones complete_

## Conclusions
_Project ongoing_
```

**Rule:** These templates are fallbacks. If the caller provides a body string with
any content > 10 chars, the provided body is used unchanged. The templates exist so
entries are never written with a completely blank body.

---

### FIX 3 — Fix Duplicate Entry Prevention for WHAT.KN

**Problem:** Two entries exist for nearly identical concepts:
- `WHAT.KN-000013` — "Favorite Color"
- `WHAT.KN-000014` — "Favorite Vericolor"

The `resolveConflict()` function is supposed to trigger at name similarity > 0.6 but
these two names have high semantic similarity and "vericolor" is likely a typo of
"color". The function is either not being called or the similarity threshold is not
catching it.

**File:** `core/memory/lifecycle.ts` (or wherever `resolveConflict` lives)

**What to do:**

1. Check whether `resolveConflict()` is actually called during `upsertEntry()`. If
   it is only called on exact name matches and not on fuzzy matches, it will never
   catch near-duplicates. Add a pre-upsert check:

```typescript
// Before creating a new KN or CT entry, check for near-duplicates
const existing = await queryEntries(db, { nb: entry.nb, type: entry.type, status: 'active' });
for (const candidate of existing) {
  const similarity = nameSimiliarity(candidate.name, entry.name);
  if (similarity > 0.6) {
    // Trigger resolveConflict — do not create duplicate
    return await resolveConflict(candidate, entry, llm);
  }
}
```

2. Make `nameSimilarity()` compare lowercased, stripped strings. "Favorite Color" vs
   "Favorite Vericolor" should score above 0.6 since they share "Favorite" and the
   second word shares phonetic/character overlap.

3. This check only applies to `WHAT.KN`, `WHO.CT`, and `WHO.ORG` types where
   duplicates are a real problem. Do NOT apply to `NOW.LOG`, `WHEN.EV`, `PLAN.EX`,
   or `WHEN.RF` — those are append-only time-series types.

---

### FIX 4 — PLAN.EX Status Must Be `complete` When All Milestones Done

**Problem:** `PLAN.EX-000003` and `PLAN.EX-000004` both have all milestones
`done: true` but `status: active`. Completed plans are still appearing in active
memory scans, polluting planner context.

**File:** `core/executor.ts` and/or `core/memory/plan-ex.ts`

**What to do:**

In `executePlan()` or the post-execution handler, find where the final `savePlanEX()`
call happens after a plan completes successfully. Ensure the status is set to `'complete'`:

```typescript
await savePlanEX(planEx.code, {
  ...planEx,
  status: 'complete',    // ← This must be explicitly set
  next_action: 'Complete plan',
});
```

Also check `loadActivePlanEX()` — it should filter to only return entries where
`status = 'active'`. If it's returning all PLAN.EX entries regardless of status,
that's a secondary bug.

Additionally, in `unit-search.ts`, the existing filter for terminal PLAN.EX entries
(added in a previous sprint) should catch this — verify that the filter
`NOT (nb = 'PLAN' AND type = 'EX' AND status IN ('complete', 'failed'))` is actually
in the SQL query and not being bypassed.

---

### FIX 5 — NOW.LOG Status Should Be `logged`, Not `active`

**Problem:** `NOW.LOG-000002` and `NOW.LOG-000003` have `status: active`. When the
type-scan fast-path runs a query for active NOW entries, it will include log lines
alongside real todos. Logs are historical records — they should never appear in
actionable item scans.

**File:** `core/memory/write.ts` and `config/agent.config.ts`

**What to do:**

1. In `TYPE_MAP` or wherever default status is set per type, add:
```typescript
'NOW.LOG': 'logged',   // not 'active'
```

2. In `createEntry()`, when `nb === 'NOW' && type === 'LOG'`, default `status` to
   `'logged'` unless the caller explicitly overrides it.

3. In `detectListingQuery()` type-scan for `NOW.TD`, the SQL filter must be
   `status = 'active'` — not `status != 'archived'`. This ensures logs with
   `status: 'logged'` are excluded from todo listings.

4. Existing `NOW.LOG` entries with `status: active` will need a migration. Add a
   one-time migration in `initDatabase()` or `bootstrapIndexFromMemoryFiles()`:
```typescript
db.prepare(`
  UPDATE index_entries SET status = 'logged'
  WHERE nb = 'NOW' AND type = 'LOG' AND status = 'active'
`).run();
```

---

## Tests to Write

Create `tests/phase18g/phase18g.test.ts`. Target: **16 tests minimum**.

### Listing Fast-Path Wiring (5 tests)
1. `searchMemoryForUnits()` called without options → `detectListingQuery()` still runs, returns `type_scan` for "tell me all contacts"
2. `searchMemoryForUnits()` called with options → listing fast-path still runs for listing content
3. "tell me a list of all your contacts" → strategy `type_scan`, nb=WHO, type=CT
4. "list all active projects" → strategy `type_scan`, nb=WHAT, type=PJ
5. Mock `queryEntries` returning 2 entries → `type_scan` result has `confidence: 1`, `count: 2`

### Memory Body Templates (3 tests)
6. `createEntry({ nb: 'WHO', type: 'CT', name: 'X', body: '' })` → written body contains `## Role / Relationship`
7. `createEntry({ nb: 'WHAT', type: 'PJ', name: 'X', body: '' })` → written body contains `## Initial Request`
8. `createEntry({ nb: 'WHO', type: 'CT', name: 'X', body: 'custom content' })` → written body is `custom content` (template NOT applied)

### Duplicate Prevention (3 tests)
9. `upsertEntry` with name "Favorite Color" when "Favorite Color" already exists → `resolveConflict()` called, no duplicate created
10. `upsertEntry` with name "Studio Temp Log" when no similar entry exists → creates normally without triggering conflict
11. Duplicate check only applies to `WHAT.KN`, `WHO.CT` — `NOW.LOG` with same name creates a new entry without conflict check

### PLAN.EX Terminal Status (3 tests)
12. `executePlan()` completes successfully → `savePlanEX()` called with `status: 'complete'`
13. `loadActivePlanEX()` → does NOT return entries with `status: 'complete'`
14. `unit-search.ts` type_scan for PLAN entries → excludes `status: 'complete'` PLAN.EX entries

### NOW.LOG Status (2 tests)
15. `createEntry({ nb: 'NOW', type: 'LOG', ... })` → persisted with `status: 'logged'`
16. Type-scan for NOW.TD → does NOT return entries with `status: 'logged'`

---

## Memory File Quality Reference

The following real entries were examined and represent the current quality problems.
Use these as the baseline for what the fixes must improve:

**Before (WHO.CT — broken):**
```markdown
---
code: WHO.CT-000001
name: Erfan Tari
status: active
summary: Contact entry for Erfan Tari
---
# Erfan Tari Contact Details
[blank]
```

**After (WHO.CT — target):**
```markdown
---
code: WHO.CT-000001
name: Erfan Tari
status: active
summary: Owner and primary user of Zaraban
---
# Erfan Tari

## Role / Relationship
Owner — primary user of this agent system

## Background
_To be filled in_

## Notes
_No notes yet_
```

**Before (WHAT.PJ — broken):**
```markdown
---
code: WHAT.PJ-000014
name: AgenticAGI Project
status: active
summary: Working on the AgenticAGI project
---
# AgenticAGI Project
[blank]
```

**After (WHAT.PJ — target):**
```markdown
---
code: WHAT.PJ-000014
name: AgenticAGI Project
status: active
summary: Working on the AgenticAGI project
---
# AgenticAGI Project

## Description
_Not specified_

## Initial Request
_Not specified_

## Status
Active

## Tasks
_No tasks recorded yet_

## Notes
_No notes yet_
```

---

## Completion Checklist

- [ ] FIX 1: `searchMemoryForUnits()` call site passes intake signals as options
- [ ] FIX 1: `detectListingQuery()` runs BEFORE signal guards, works without options
- [ ] FIX 1: "tell me a list of all your contacts" → `strategy: type_scan` in transparency log
- [ ] FIX 2: WHO.CT empty body gets `## Role / Relationship` template
- [ ] FIX 2: WHAT.PJ empty body gets `## Initial Request` template
- [ ] FIX 2: PLAN.PJ empty body gets `## Initial Request` + `## Goal` template
- [ ] FIX 2: Non-empty bodies are never overwritten by templates
- [ ] FIX 3: Near-duplicate check fires for WHAT.KN and WHO.CT before create
- [ ] FIX 3: Does NOT fire for NOW.LOG, WHEN.EV, PLAN.EX
- [ ] FIX 4: `executePlan()` writes `status: 'complete'` on successful plan finish
- [ ] FIX 4: `loadActivePlanEX()` filters out `status: 'complete'`
- [ ] FIX 5: `createEntry` for NOW.LOG defaults to `status: 'logged'`
- [ ] FIX 5: Migration updates existing `NOW.LOG status: active` → `logged`
- [ ] FIX 5: Type-scan for NOW.TD excludes `status: 'logged'` entries
- [ ] All 16 tests pass
- [ ] `pnpm build` clean
- [ ] All 999 prior tests still pass
- [ ] `CLAUDE.md` updated with Phase 18G section
- [ ] Tag: `phase-18G-complete`

---

## CLAUDE.md Section to Add After Completion

```markdown
## Phase 18G — Listing Fast-Path Wiring + Memory Quality (COMPLETE)

### Root Causes Fixed
`detectListingQuery()` unreachable due to missing options passthrough at call site.
Memory entries written with empty bodies. Duplicate KN entries not caught by conflict
resolution. Completed PLAN.EX entries persisted as active. NOW.LOG using active status
polluting actionable item scans.

### FIX 1 — Listing Fast-Path Wired (`core/agent.ts`, `core/memory/unit-search.ts`)
- `searchMemoryForUnits()` now receives intake signals as third argument at call site
- `detectListingQuery()` moved before all signal guards — runs on content alone
- "tell me all contacts" → `strategy: type_scan` → `queryEntries({ nb: 'WHO', type: 'CT', status: 'active' })`

### FIX 2 — Body Templates (`core/memory/write.ts`, `core/memory/project.ts`)
- WHO.CT, WHAT.PJ, PLAN.PJ empty bodies now get section scaffolding
- Non-empty bodies never overwritten

### FIX 3 — Duplicate Prevention (`core/memory/lifecycle.ts`)
- Pre-upsert similarity check for WHAT.KN and WHO.CT types
- Routes to `resolveConflict()` at similarity > 0.6
- Append-only types (LOG, EV, RF, EX) excluded

### FIX 4 — PLAN.EX Terminal Status (`core/executor.ts`, `core/memory/plan-ex.ts`)
- `executePlan()` writes `status: 'complete'` on successful finish
- `loadActivePlanEX()` filters to active-only

### FIX 5 — NOW.LOG Status (`core/memory/write.ts`, `config/agent.config.ts`)
- NOW.LOG entries default to `status: 'logged'`
- Migration applied to existing active LOG entries
- Type-scan for NOW.TD excludes logged entries
```
