# Zaraban — Tetris Session Fix Sprint
### For: Claude Code (single session)
### Tag on completion: `tetris-session-fixes-complete`

---

## Context

This prompt is derived from a transparency log captured during a Tetris game creation task.
The user asked Zaraban to write a Tetris game with combos, overlay text, and 3D objects.
Three failures and three inefficiencies were identified through post-mortem analysis.

This sprint targets the three root causes: plan repair integrity, continuation-intent
memory retrieval, and decomposition over-splitting of action+qualifier commands.

Read `CLAUDE.md` fully before touching any file.

**Do not change the architecture. All fixes are surgical edits within existing files.**
**Do not break existing tests. Add new tests only.**
**After each fix: `pnpm build && pnpm test`**

---

## Root Causes Found in Log

### 1. Plan Repair Drops Milestones (Catastrophic)

**Log evidence (18:43:28 → 18:44:26):**
The LLM misspelled `"description"` as `"descriptron"` in three places in the plan JSON.
Schema validation caught it and forced a retry. During the retry, the model fixed the typo
but silently dropped `milestone_2` (the actual game implementation phase) from the milestones
array. The plan "completed" by writing a spec to memory — the code was never generated.

```
18:43:28.384 — schema_validation_failed: "descriptron" not in schema
18:44:26.300 — plan accepted: milestone_1 (spec), milestone_3 (finalize) — milestone_2 MISSING
18:44:51.450 — task "complete" without any code written
```

**Root cause:** The planner retry path validates that the repaired JSON matches the Zod
schema, but does NOT validate that the repaired output preserves structural completeness
relative to the failed attempt. The model truncated during repair and no guard caught it.

### 2. Memory Amnesia on Continuation (Wasteful)

**Log evidence (18:45:18 → 18:46:23):**
After the truncated plan, the user manually said "proceed and implement the game, write in
html in your workspace." The model recognized it needed to generate the game but ignored
the detailed specification it had JUST written (PLAN.EX-000067) two minutes prior. Instead,
it created a brand new redundant specification before finally calling `generate_and_save_file`.

```
18:45:18.151 — user follow-up: "proceed and implement the game"
18:46:23.427 — model writes NEW spec instead of reading PLAN.EX-000067
```

**Root cause:** The continuation path has no mechanism to retrieve the most recent active
PLAN.EX entry. When the user says "proceed" or "continue," the system should first check
for an active PLAN.EX in session cache or memory before allowing the planner to create a
new one.

### 3. Decomposition Over-Splits Action + Format Qualifier (Inefficient)

**Log evidence (18:45:49):**
The decomposer split "proceed and implement the game, write in html in your workspace"
into two separate agentic units: (1) "proceed" and (2) "write in html." These are not
two tasks — "write in html" is a format constraint on the implementation, not a separate
goal. This forced the planner to generate two arbitrary goals.

```
18:45:49.216 — decomposition: 2 agentic units from single command
  unit_1: "proceed and implement the game"
  unit_2: "write in html in your workspace"
```

**Root cause:** The decomposition few-shot examples (added in Phase 17C) do not include
an example of a single command with a format/medium qualifier. The model treats the comma
as a clause boundary and splits.

---

## Files You Will Touch

```
core/planner.ts                              ← FIX 1: post-repair milestone count validation
core/agent.ts                                ← FIX 2: continuation-intent PLAN.EX retrieval
core/decomposition.ts                        ← FIX 3: action+qualifier few-shot example
  OR prompts/decomposition.md                ← FIX 3: if templates are externalized
tests/tetris-session-fixes/fixes.test.ts     ← NEW: all tests for this sprint
```

**Do NOT touch:**
- `core/router.ts`
- `core/query-loop.ts`
- `core/executor.ts` (unless the repair validation naturally lives there — see FIX 1 notes)
- `core/skills/runner.ts`
- Any test file outside `tests/tetris-session-fixes/`
- `CLAUDE.md` (will be updated after tag)

---

## FIX 1 — Post-Repair Milestone Count Validation (P0)

When schema validation fails on a plan JSON and the system retries, the repaired output
must be structurally compared against the failed attempt before acceptance.

### Step 1: Locate the plan retry path

In `core/planner.ts`, find where the plan JSON is parsed and validated. There will be a
retry loop that fires when Zod validation fails. It currently looks something like:

```typescript
// Pseudocode of existing flow:
const raw = await llmHandler.chat(planMessages);
const parsed = safeParseJson(raw, PlanSchema, 'planner', null);
if (!parsed) {
  // retry with error feedback
  const retryRaw = await llmHandler.chat(retryMessages);
  const retryParsed = safeParseJson(retryRaw, PlanSchema, 'planner-retry', null);
  // ... use retryParsed
}
```

### Step 2: Extract milestone count from failed attempt

Before the retry, extract whatever structural information is available from the failed
attempt. Even if the JSON didn't pass schema validation, it may have been parseable enough
to count milestones. Use `extractFirstJsonObject` + a permissive parse:

```typescript
// After first attempt fails schema validation but before retry:
let expectedMilestoneCount: number | null = null;
try {
  const failedBlock = extractFirstJsonObject(stripThinkingTags(raw));
  if (failedBlock) {
    const failedJson = JSON.parse(failedBlock);
    // Look for milestones array at any depth
    const milestones = failedJson.milestones
      ?? failedJson.plan?.milestones
      ?? failedJson.steps;
    if (Array.isArray(milestones)) {
      expectedMilestoneCount = milestones.length;
    }
  }
} catch {
  // Failed attempt wasn't parseable at all — can't compare
  expectedMilestoneCount = null;
}
```

### Step 3: Validate repaired output against expected count

After the retry succeeds schema validation, compare milestone counts:

```typescript
if (retryParsed && expectedMilestoneCount !== null) {
  const repairedCount = retryParsed.milestones?.length ?? 0;
  if (repairedCount < expectedMilestoneCount) {
    console.warn(
      `[zaraban][planner-repair] Milestone count dropped: ${expectedMilestoneCount} → ${repairedCount}. ` +
      `Repair may have truncated the plan.`
    );
    emit('plan_repair_truncation', {
      expected: expectedMilestoneCount,
      received: repairedCount,
      delta: expectedMilestoneCount - repairedCount,
    });

    // Option A: Retry once more with explicit instruction
    if (repairAttempt < 2) {
      const rescueMessages = [
        ...retryMessages,
        {
          role: 'user' as const,
          content:
            `Your repaired plan has ${repairedCount} milestones but the original had ` +
            `${expectedMilestoneCount}. You dropped ${expectedMilestoneCount - repairedCount} ` +
            `milestone(s) during repair. Regenerate the COMPLETE plan with ALL milestones.`,
        },
      ];
      const rescueRaw = await llmHandler.chat(rescueMessages);
      const rescueParsed = safeParseJson(rescueRaw, PlanSchema, 'planner-rescue', null);
      if (rescueParsed) {
        retryParsed = rescueParsed;
      }
      repairAttempt++;
    }
    // If rescue also fails, use the truncated plan but log loudly
  }
}
```

### Step 4: Add transparency event

Emit `plan_repair_truncation` with the counts. This makes the failure visible in logs
even if the rescue attempt succeeds.

### Key requirements:

1. **Never silently accept a plan with fewer milestones than the failed attempt.**
   At minimum, log a warning. At best, retry once with the explicit count feedback.
2. **The comparison is best-effort.** If the failed attempt is completely unparseable,
   skip the comparison — don't block the retry path.
3. **Only compare milestone count, not content.** The model is expected to change content
   during repair (that's the point). But losing entire milestones is a structural error.
4. **Cap rescue attempts at 1.** First attempt → schema failure → repair attempt → count
   check → rescue attempt (if count dropped) → accept whatever comes back. Maximum 3
   total LLM calls for plan generation.

---

## FIX 2 — Continuation-Intent PLAN.EX Auto-Retrieval (P0)

When the user says "proceed," "continue," or similar continuation phrases, the system
should automatically retrieve the most recent active PLAN.EX entry and inject it as
context for the planner — rather than creating a new specification from scratch.

### Step 1: Identify continuation intent

In `core/agent.ts`, find where the message enters the processing pipeline — after
decomposition but before planning. This is where quick-resolve already runs (if Phase 19c
is landed). Add a continuation-intent detector at the same level:

```typescript
/**
 * Detect continuation intent in user message.
 * Returns true if the message signals continuation of a previous task.
 */
function isContinuationIntent(message: string): boolean {
  const normalized = message.toLowerCase().trim();

  // Strong continuation signals
  const strongPatterns = [
    /^(proceed|continue|go ahead|keep going|carry on)/,
    /^(do it|make it|build it|implement it|create it)/,
    /^yes,?\s*(proceed|continue|go|do)/,
  ];

  // Weak signals — only match if message is short (< 80 chars)
  const weakPatterns = [
    /implement/,
    /proceed/,
    /continue/,
  ];

  for (const p of strongPatterns) {
    if (p.test(normalized)) return true;
  }

  if (normalized.length < 80) {
    for (const p of weakPatterns) {
      if (p.test(normalized)) return true;
    }
  }

  return false;
}
```

### Step 2: Retrieve most recent active PLAN.EX

When continuation intent is detected, query for the most recent PLAN.EX entry that is
NOT terminal (not `complete`, not `failed`):

```typescript
import { queryEntries } from './memory/index.js';  // adjust import path

async function getActivePlanEx(): Promise<IndexEntry | null> {
  // First check session cache for any active PLAN.EX
  // If session cache doesn't have one, query the index
  const entries = await queryEntries({
    nb: 'PLAN',
    type: 'EX',
    limit: 1,
    orderBy: 'created DESC',
    // Exclude terminal entries
    whereNot: { status: ['complete', 'failed'] },
  });

  return entries.length > 0 ? entries[0] : null;
}
```

**Important:** Check how `queryEntries` actually works in the codebase. The signature
above is illustrative — adapt to the real API. You may need to use raw SQL via
`better-sqlite3` if `queryEntries` doesn't support `whereNot`. In that case:

```typescript
const db = getDatabase();  // or however the db handle is obtained
const row = db.prepare(`
  SELECT * FROM index_entries
  WHERE nb = 'PLAN' AND type = 'EX'
  AND status NOT IN ('complete', 'failed')
  ORDER BY created DESC
  LIMIT 1
`).get();
```

### Step 3: Inject into planner context

If an active PLAN.EX is found, fetch its full content and inject it into the planner
prompt as prior context:

```typescript
// In the message processing pipeline, after decomposition:
if (isContinuationIntent(userMessage)) {
  const activePlan = await getActivePlanEx();
  if (activePlan) {
    const planContent = await fetchByCode(activePlan.code);  // adjust to real API
    if (planContent) {
      emit('continuation_context_loaded', {
        code: activePlan.code,
        name: activePlan.name,
      });

      // Inject as prior context for the planner
      // The exact injection point depends on how planner context is built.
      // Look for where {{prior_context}} or relevant_memory is assembled.
      priorContext = `\n\nCONTINUATION CONTEXT — Previous specification:\n` +
        `Code: ${activePlan.code}\n` +
        `Name: ${activePlan.name}\n` +
        `Content:\n${planContent}\n\n` +
        `The user is asking to continue this task. Use this specification directly — ` +
        `do NOT create a new one.\n`;
    }
  }
}
```

### Step 4: Add planner instruction for continuation

When continuation context is present, add a rule to the planner prompt:

```
CONTINUATION RULE: A previous specification exists (see CONTINUATION CONTEXT above).
Use it directly as your implementation spec. Do NOT call memory_write to create a new
specification. Your first milestone should begin implementation immediately.
```

### Key requirements:

1. **Only fire on continuation intent.** Do not retrieve PLAN.EX for fresh tasks.
2. **Only retrieve non-terminal entries.** Complete/failed PLAN.EX entries must never
   be injected (this aligns with the existing terminal PLAN.EX filter from FIX 3 of
   the log-fixes sprint).
3. **Fetch the full content, not just the index entry.** The planner needs the spec text.
4. **If no active PLAN.EX exists, proceed normally.** This is a best-effort optimization,
   not a hard gate.
5. **Emit a transparency event** when continuation context is loaded, so the log shows
   that the system reused a previous spec rather than creating a new one.

---

## FIX 3 — Decomposition: Action + Format Qualifier Few-Shot (P0)

The decomposition system already has three few-shot examples (added in Phase 17C) and
WRONG/RIGHT format enforcement. This fix adds a fourth example that specifically addresses
the "single command with format constraint" pattern.

### Step 1: Locate the few-shot examples

Check whether the decomposition prompt is in `core/decomposition.ts` (inline) or in
`prompts/decomposition.md` (externalized template). Search for the existing examples:

```bash
grep -rn "EXAMPLE" core/decomposition.ts prompts/decomposition.md
```

### Step 2: Add the action+qualifier example

After the existing examples, add:

```
EXAMPLE:
User: "Build the calculator and make it in HTML"
Output: {"units":[{"route":"agentic","content":"Build the calculator and make it in HTML"}]}

EXAMPLE:
User: "Proceed and implement the game, write in html in your workspace"
Output: {"units":[{"route":"agentic","content":"Proceed and implement the game, write in html in your workspace"}]}
```

### Step 3: Add the corresponding WRONG/RIGHT block

After the existing WRONG/RIGHT format enforcement, add:

```
WRONG: splitting "build X, use format Y" into two units — the format is a constraint, not a separate task
WRONG: splitting "proceed and implement X" into "proceed" + "implement X" — these are one intent
RIGHT: keeping action + format/medium/location qualifier as a single unit
```

### Step 4: Verify existing examples are preserved

After your edit, confirm the decomposition prompt contains ALL of the following:
- The original 3 EXAMPLE blocks from Phase 17C (agentic, conversational, query)
- The new 2 EXAMPLE blocks (action+qualifier)
- The original WRONG/RIGHT format enforcement (flat array vs object array)
- The new WRONG/RIGHT format enforcement (action+qualifier splitting)

### Key requirements:

1. **Do not remove existing examples.** Only append.
2. **Place the new examples AFTER the existing ones** — the model sees the most recent
   examples last, which is the strongest position for influencing output.
3. **Keep the heuristic repair.** The existing repair in `decomposition.ts` that catches
   flat arrays and rebuilds them as objects must remain as a safety net.
4. **The `_decompositionRepairCount` counter must continue to work** — don't break the
   session-wide repair tracking.

---

## Tests to Write

Create `tests/tetris-session-fixes/fixes.test.ts`.

### Test group: Post-repair milestone count validation (FIX 1)

```typescript
// 1. When repair produces same milestone count as failed attempt, no warning is logged
// 2. When repair drops milestones, plan_repair_truncation event is emitted
// 3. plan_repair_truncation event includes expected, received, and delta fields
// 4. When repair drops milestones, rescue attempt fires with count feedback
// 5. Rescue attempt message includes the expected and received milestone counts
// 6. Maximum 3 total LLM calls for plan generation (original + repair + rescue)
// 7. When failed attempt is completely unparseable, count comparison is skipped (no crash)
// 8. When failed attempt has no milestones array, count comparison is skipped
```

### Test group: Continuation-intent detection (FIX 2)

```typescript
// 9. "proceed" matches continuation intent
// 10. "continue" matches continuation intent
// 11. "go ahead and build it" matches continuation intent
// 12. "yes, proceed" matches continuation intent
// 13. "What is the capital of France?" does NOT match continuation intent
// 14. "Create a new app for me" does NOT match continuation intent
// 15. Short message with "implement" matches continuation intent
// 16. Long message (>80 chars) with weak signal does NOT match continuation intent
```

### Test group: Continuation PLAN.EX retrieval (FIX 2)

```typescript
// 17. When continuation intent is detected AND active PLAN.EX exists,
//     continuation_context_loaded event is emitted with correct code
// 18. When continuation intent is detected AND no active PLAN.EX exists,
//     processing continues normally (no crash, no event)
// 19. Terminal PLAN.EX (status: complete) is NOT retrieved by continuation check
// 20. Terminal PLAN.EX (status: failed) is NOT retrieved by continuation check
// 21. Most recent active PLAN.EX is retrieved (not an older one)
```

### Test group: Decomposition action+qualifier (FIX 3)

```typescript
// 22. Decomposition prompt contains "Build the calculator and make it in HTML" example
// 23. Decomposition prompt contains "proceed and implement" example
// 24. Decomposition prompt contains WRONG block about "format is a constraint"
// 25. Original 3 EXAMPLE blocks from Phase 17C are still present (regression check)
// 26. Heuristic repair still fires on flat array input (regression check)
// 27. _decompositionRepairCount counter still increments on repair (regression check)
```

**Minimum: 27 tests. All must pass before tagging.**

---

## Completion Checklist

### FIX 1 (Post-Repair Milestone Count Validation)
- [ ] Failed attempt milestone count extracted before retry
- [ ] Repaired output compared against expected count
- [ ] `plan_repair_truncation` transparency event emitted on count drop
- [ ] Rescue attempt fires with count feedback in prompt
- [ ] Maximum 3 LLM calls enforced (original + repair + rescue)
- [ ] Unparseable failed attempts skip count comparison gracefully
- [ ] `pnpm build` clean, `pnpm test` all pass

### FIX 2 (Continuation-Intent PLAN.EX Retrieval)
- [ ] `isContinuationIntent()` function detects proceed/continue/go-ahead patterns
- [ ] `getActivePlanEx()` queries for most recent non-terminal PLAN.EX
- [ ] Full PLAN.EX content fetched and injected as prior context
- [ ] CONTINUATION RULE added to planner prompt when context present
- [ ] `continuation_context_loaded` transparency event emitted
- [ ] No crash when no active PLAN.EX exists
- [ ] Terminal PLAN.EX entries excluded from retrieval
- [ ] `pnpm build` clean, `pnpm test` all pass

### FIX 3 (Decomposition Action+Qualifier Example)
- [ ] Two new EXAMPLE blocks added after existing examples
- [ ] WRONG/RIGHT block for action+qualifier splitting added
- [ ] Original examples and format enforcement preserved
- [ ] Heuristic repair preserved as safety net
- [ ] `_decompositionRepairCount` counter still works
- [ ] `pnpm build` clean, `pnpm test` all pass

### Final
- [ ] 27 new tests in `tests/tetris-session-fixes/fixes.test.ts` all pass
- [ ] No existing test regressions
- [ ] `pnpm stress:critical` passes (run if stress runner is available)
- [ ] `git tag tetris-session-fixes-complete`

---

## Expected Outcomes After This Sprint

| Metric | Before | After |
|---|---|---|
| Plan repair drops milestones silently | Yes (catastrophic) | No (count validated, rescue attempt fires) |
| Continuation task ignores previous spec | Yes (creates redundant spec) | No (retrieves active PLAN.EX) |
| "Build X in format Y" split into 2 units | ~50% of cases | <10% with new few-shot example |
| User must manually re-prompt after truncated plan | Always | Only if rescue also fails |
| Wasted LLM calls on continuation tasks | 2-3 extra calls | 0 (direct context injection) |

The Tetris game task should now:
1. **Not lose the implementation milestone** during plan repair (FIX 1)
2. **Reuse the spec it already wrote** when the user says "proceed" (FIX 2)
3. **Treat "implement the game, write in html" as one task** (FIX 3)
