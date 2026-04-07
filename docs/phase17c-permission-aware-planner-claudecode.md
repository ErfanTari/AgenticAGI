# Zaraban — Permission-Aware Planner Sprint
### For: Claude Code (single session)
### Tag on completion: `permission-aware-planner-complete`

---

## Context

This prompt is derived from a real transparency log captured AFTER the Phase 17A permission
layer and log-fixes sprint both landed. The user asked Zaraban to create a Street-of-Rage
HTML game. Phase 17A's runtime enforcement correctly blocked `implement_and_test` (requires
`full-access`, agent is in `workspace-write`). But the planner didn't know this — it planned
a skill that would always fail, then the revision system couldn't recover because it never
saw the failure.

Three architectural gaps were exposed. All three are surgical fixes.

Read `CLAUDE.md` fully before touching any file. 858 tests pass at `log-fixes-complete`.

**Do not change the architecture. All fixes are surgical edits within existing files.**
**Do not break the 858 existing tests. Add new tests only.**
**After each fix: `pnpm build && pnpm test`**

---

## Root Causes Found in Log

### 1. Permission-Blind Planner

The planner's system prompt lists ALL skills including `implement_and_test` and `run_bash`.
The agent is running in `workspace-write` mode. Phase 17A correctly blocks these at runtime
(`core/permission.ts` + `core/skills/runner.ts`), but the planner doesn't know that. So it
confidently plans a 7-step task using `implement_and_test` as step 3 — the critical step —
which instantly fails with a permission error. The entire task collapses.

**The log proof:**

```
[02:02:05.227] llm_request  ← planner prompt lists implement_and_test as available
[02:02:57.311] plan         ← planner uses implement_and_test as step 3
[02:03:21.674] step_result  ← Permission denied: skill 'implement_and_test' requires 'full-access'
```

### 2. Failure-Blind Plan Revision

When step 3 failed, the executor called the plan revision LLM. But the revision prompt
completely omitted the failure. It only included completed milestones and remaining milestones,
skipping milestone 2 (the one that failed) entirely. The LLM responded `{"revised": false}`
because it had no idea anything went wrong.

**The log proof:**

```
[02:03:21.676] llm_request (Revision prompt)
  "Completed milestones:
  - milestone_1: Initial Web Structure...
  Remaining milestones to validate:
  - milestone_3: Finalization and Documentation..."
  ← milestone_2 is missing! The LLM doesn't know step 3 failed.

[02:03:34.677] llm_raw
  {"revised": false}  ← Of course — it doesn't know there's a problem.
```

### 3. Decomposition Schema Hallucination (Recurring)

The decomposition LLM returned a flat array of strings instead of an array of objects.
The heuristic repair caught it (good — Phase 13 hardening), but this is the same failure
pattern seen in previous logs. The model keeps ignoring the JSON schema for this specific
call.

**The log proof:**

```
[02:02:05.220] llm_raw
{"units": ["route", "agentic", "content", "Create a street-of-rage..."]}
← Should be: {"units": [{"route": "agentic", "content": "Create a street-of-rage..."}]}
```

---

## Files You Will Touch

```
core/planner.ts                         ← FIX 1: inject permission context + filtered skill list
core/executor.ts                        ← FIX 2: inject failure context into revision prompt
core/decomposition.ts                   ← FIX 3: add few-shot example to decomposition prompt
core/permission.ts                      ← FIX 1: add getAllowedSkills() helper
core/skills/registry.ts                 ← FIX 1: add getSkillsByPermission() helper
tests/permission-planner/fixes.test.ts  ← NEW: your tests
```

**Do NOT touch:**
- `core/router.ts`
- `core/query-loop.ts`
- `core/skills/runner.ts` (enforcement already works — don't change it)
- `core/skills/types.ts` (PermissionLevel already defined — don't change it)
- Any test file outside `tests/permission-planner/`
- `CLAUDE.md` (will be updated after tag)

---

## FIX 1 — Permission-Aware Planner (P0)

This is the highest-priority fix. The planner must know what skills are available at the
current permission level BEFORE it creates a plan. Two changes required.

### Step 1A: Add helper to `core/skills/registry.ts`

Add an exported function that returns only skills allowed at a given permission level:

```typescript
import type { PermissionLevel } from './types.js';

const LEVEL_RANK: Record<PermissionLevel, number> = {
  'read-only': 0,
  'workspace-write': 1,
  'full-access': 2,
};

export function getSkillsByPermission(mode: PermissionLevel): MCPSkill[] {
  const allowed: MCPSkill[] = [];
  for (const skill of registry.values()) {
    if (LEVEL_RANK[skill.permissionLevel] <= LEVEL_RANK[mode]) {
      allowed.push(skill);
    }
  }
  return allowed;
}
```

Note: `LEVEL_RANK` already exists in `core/permission.ts`. You can either import it from
there or duplicate the small map — use your judgment on which is cleaner. If `permission.ts`
doesn't export it, add the export.

### Step 1B: Modify `core/planner.ts` to inject permission context

Find where the planner system prompt is constructed. It currently builds a skill list
like this (or similar):

```
Each step uses one skill. Available skills:
calculator: Calculate mathematical expressions...
file_reader: Read a file from disk...
...
implement_and_test: Write or reuse code, run tests...
run_bash: Run a bash command...
```

**Change 1:** Import `getSkillsByPermission` from registry and `getActivePermissionMode`
from `core/permission.ts`. Before building the skill list, filter:

```typescript
import { getSkillsByPermission } from './skills/registry.js';
import { getActivePermissionMode } from './permission.js';

// Inside the prompt builder function:
const mode = getActivePermissionMode();
const allowedSkills = getSkillsByPermission(mode);
```

Build the skill list from `allowedSkills` instead of the full registry. Skills that exceed
the current permission level simply don't appear in the prompt.

**Change 2:** Add a runtime context block AFTER the skill list in the system prompt:

```
RUNTIME CONTEXT:
- Permission mode: ${mode}
- Skills available: ${allowedSkills.length} of ${totalSkillCount}
${mode !== 'full-access' ? `- BLOCKED skills (require higher permission): ${blockedSkillNames.join(', ')}` : ''}
- If the user's task requires a blocked skill, explain the limitation and suggest what CAN be done with available skills.
```

Where `blockedSkillNames` is the list of skills filtered out. Build it from the full
registry minus `allowedSkills`.

**Why both changes?** Filtering the skill list prevents the model from using blocked skills.
The RUNTIME CONTEXT block tells the model WHY certain skills are missing, so it can adapt
its plan (e.g., use `content_writer` + `file_writer` instead of `implement_and_test`).

### Step 1C: Also filter in QueryLoop system prompt

Find where `core/query-loop.ts` builds its tool/skill list for the model. Apply the same
filter. The QueryLoop prompt should also only show allowed skills.

**Important:** Check whether `query-loop.ts` gets its skill list from the same function as
the planner or builds it independently. Apply the filter at whatever the source is.

**Do NOT change the runtime enforcement in `runner.ts`.** It stays as a safety net in case
the model hallucinates a skill name despite filtering. Defense in depth.

---

## FIX 2 — Failure-Aware Plan Revision (P0)

When a milestone fails, the revision prompt must include what failed and why. Without
this context, the revision LLM cannot make a meaningful decision.

### Find the revision prompt builder

In `core/executor.ts`, find where the milestone revision prompt is constructed. Based on
the log, it currently builds something like:

```
Completed milestones:
- milestone_1: ...

Remaining milestones to validate:
- milestone_3: ...

Are the remaining milestones still valid given what was completed?
```

It is skipping the current (failed) milestone entirely.

### Fix the prompt builder

The revision prompt must include THREE sections, not two:

```typescript
const revisionPrompt = `
Completed milestones:
${completedMilestones.map(m => `- ${m.id}: ${m.title} — ${m.completionCriteria}`).join('\n')}

FAILED in current milestone (${currentMilestone.id}: ${currentMilestone.title}):
${failedSteps.map(s => `- Step ${s.id} [${s.skill}]: ${s.error}`).join('\n')}

Remaining milestones to validate:
${remainingMilestones.map(m => `- ${m.id}: ${m.title} — ${m.description}`).join('\n')}

Given the failures above, should the remaining milestones be revised, reordered, or
should the task be aborted? Consider whether alternative approaches using available
skills could achieve the same goal.

Return ONLY a JSON object: {"revised": false} if no changes needed,
OR {"revised": true, "milestones": [...], "reason": "why"}
OR {"abort": true, "reason": "why the task cannot be completed"}
`;
```

### Key requirements:

1. **Never omit the failed milestone.** If the current milestone had failures, they MUST
   appear in the prompt under a "FAILED" section.

2. **Include the specific error message** from each failed step. In this case:
   `"Permission denied: skill 'implement_and_test' requires 'full-access' but active mode is 'workspace-write'"`
   — the revision LLM needs to see this to suggest alternatives.

3. **Add abort option.** Currently the revision schema only supports `revised: true/false`.
   The LLM should also be able to recommend aborting if the task is unrecoverable.

4. **Update the Zod schema** for the revision response to accept `abort` as an optional
   boolean field with an optional `reason` string. If `abort: true`, the executor should
   stop execution and report the reason to the user.

### Also check: is the revision call happening at all?

FIX 5 from the log-fixes sprint made revision skip on happy path (good). Verify that when
a milestone HAS failures, the revision call still fires. The condition should be:

```typescript
if (milestoneHadFailures || milestoneHadSuspiciousOutput) {
  // Call revision with full failure context
} else {
  // Skip revision, emit milestone_revision_skipped
}
```

If the revision call isn't firing on failure, fix the condition. The log shows it DID fire
but with an empty prompt — so the call site is correct but the prompt builder is wrong.

---

## FIX 3 — Decomposition Few-Shot Hardening (P1)

The decomposition prompt uses a JSON schema but no concrete example. Small/fast models
(Gemma 4, Qwen 3.5) frequently return malformed JSON when given only a schema. Adding a
single few-shot example dramatically improves compliance.

### Find the decomposition system prompt

In `core/decomposition.ts`, find the system prompt. It currently says something like:

```
You decompose one user message into semantic intent units.
Return ONLY JSON with this shape: {"units":[{"route":"conversational|agentic|query","content":"exact original meaning for that unit"}]}.
```

### Add a few-shot example

Insert a concrete example AFTER the rules section and BEFORE the user message. Use the
assistant-prefill pattern (add it as a user/assistant exchange in the messages array, or
append it to the system prompt — whichever the current call structure supports):

```
EXAMPLE:
User: "Create a calculator app and also remind me to call Sara tomorrow"
Output: {"units":[{"route":"agentic","content":"Create a calculator app"},{"route":"agentic","content":"remind me to call Sara tomorrow"}]}

EXAMPLE:
User: "What is the capital of France?"
Output: {"units":[{"route":"conversational","content":"What is the capital of France?"}]}

EXAMPLE:
User: "How's the Zaraban project going?"
Output: {"units":[{"route":"query","content":"How's the Zaraban project going?"}]}
```

### Also add format enforcement

After the examples, add:

```
CRITICAL: Each unit MUST be an object with "route" and "content" keys.
WRONG: {"units": ["route", "agentic", "content", "..."]}
RIGHT: {"units": [{"route": "agentic", "content": "..."}]}
```

This negative example directly addresses the exact failure pattern from the log.

### Keep the heuristic repair

The existing heuristic repair in `decomposition.ts` that catches flat arrays and rebuilds
them as objects — keep it. It's a valid safety net. But the few-shot example should reduce
how often it fires. The `_decompositionRepairCount` counter (added in the five-fixes sprint)
will track whether this improvement actually reduces repair frequency.

---

## Tests to Write

Create `tests/permission-planner/fixes.test.ts`.

### Test group: Permission-aware planner (FIX 1)

```typescript
// 1. getSkillsByPermission('read-only') returns only read-only skills
// 2. getSkillsByPermission('workspace-write') returns read-only + workspace-write skills
// 3. getSkillsByPermission('full-access') returns all skills
// 4. getSkillsByPermission('workspace-write') does NOT include implement_and_test
// 5. getSkillsByPermission('workspace-write') does NOT include run_bash
// 6. Planner prompt in workspace-write mode does NOT contain "implement_and_test" in skill list
// 7. Planner prompt in workspace-write mode DOES contain RUNTIME CONTEXT block
// 8. Planner prompt in workspace-write mode lists blocked skills in RUNTIME CONTEXT
// 9. Planner prompt in full-access mode contains implement_and_test in skill list
// 10. Planner prompt in full-access mode does NOT list any blocked skills
```

### Test group: Failure-aware revision (FIX 2)

```typescript
// 11. Revision prompt includes FAILED section when milestone has failed steps
// 12. Revision prompt includes the specific error message from failed step
// 13. Revision prompt does NOT include FAILED section when all steps succeeded
// 14. Revision response with abort:true causes executor to stop and return reason
// 15. Revision response with revised:true + new milestones replaces remaining milestones
// 16. Revision schema accepts {abort: true, reason: "..."} as valid
// 17. Revision schema accepts {revised: false} as valid (regression check)
```

### Test group: Decomposition few-shot (FIX 3)

```typescript
// 18. Decomposition prompt contains at least one EXAMPLE block
// 19. Decomposition prompt contains WRONG/RIGHT format enforcement block
// 20. Decomposition heuristic repair still fires on flat array input (regression check)
// 21. Decomposition counter increments on heuristic repair (regression check)
```

**Minimum: 21 tests. All must pass before tagging.**

---

## Completion Checklist

### FIX 1 (Permission-Aware Planner)
- [ ] `getSkillsByPermission()` exported from `core/skills/registry.ts`
- [ ] Planner prompt built from filtered skill list (not full registry)
- [ ] RUNTIME CONTEXT block injected into planner system prompt
- [ ] Blocked skill names listed when permission mode < full-access
- [ ] QueryLoop skill list also filtered by permission mode
- [ ] Runtime enforcement in `runner.ts` unchanged (defense in depth)
- [ ] `pnpm build` clean, `pnpm test` 858+ pass

### FIX 2 (Failure-Aware Revision)
- [ ] Revision prompt includes FAILED section with step errors on failure
- [ ] Failed milestone is never omitted from revision prompt
- [ ] Revision schema extended with optional `abort` + `reason` fields
- [ ] Executor stops and reports reason when revision returns `abort: true`
- [ ] Revision still skipped on happy path (FIX 5 from log-fixes preserved)
- [ ] `pnpm build` clean, `pnpm test` 858+ pass

### FIX 3 (Decomposition Few-Shot)
- [ ] Three few-shot examples added to decomposition system prompt
- [ ] WRONG/RIGHT format enforcement block added
- [ ] Heuristic repair preserved as safety net
- [ ] `pnpm build` clean, `pnpm test` 858+ pass

### Final
- [ ] 21 new tests in `tests/permission-planner/fixes.test.ts` all pass
- [ ] No existing test regressions
- [ ] `pnpm stress:critical` passes (run if stress runner is available)
- [ ] `git tag permission-aware-planner-complete`

---

## Expected Outcomes After This Sprint

| Metric | Before | After |
|---|---|---|
| Planner uses blocked skills | Yes (plans always fail) | No (blocked skills hidden from prompt) |
| Revision knows about failures | No (failed milestone omitted) | Yes (error messages in prompt) |
| Decomposition schema hallucination | ~30% of calls need repair | <10% with few-shot examples |
| Permission error → user sees cryptic failure | Yes | No (planner adapts or revision suggests alternatives) |
| Task abort on unrecoverable constraint | Not possible | Supported via revision abort |

The Street-of-Rage game task should now either:
- **Succeed** in `workspace-write` mode by using `content_writer` + `file_writer` (planner
  adapts because it can't see `implement_and_test`)
- **Clearly explain** the limitation if the task truly requires `full-access` (revision
  returns `abort: true` with reason)

Either outcome is better than silently failing at step 3 and producing incomplete output.

---

## Notes for Claude Code

- `LEVEL_RANK` may need to be exported from `core/permission.ts` — check before duplicating.
- The planner prompt is large (~4000 chars of system prompt). Adding RUNTIME CONTEXT adds
  ~200 chars — well within budget.
- `getSkillsByPermission` should be a pure function with no side effects. It reads from the
  registry Map and filters. No caching needed (registry is frozen after init).
- For FIX 2, find the exact variable names used in `executor.ts` for completed/remaining
  milestones. The log shows the prompt builder is already iterating milestones — it just
  skips the current one. The fix is to include it under a "FAILED" heading.
- The revision schema is likely in `core/schemas.ts` (added in log-fixes sprint). Extend it
  there, don't inline it in executor.ts.
- For FIX 3, check whether the decomposition call uses `messages` array or just a system
  prompt. If it uses messages, add the examples as user/assistant pairs. If it uses a single
  system prompt string, append the examples to the string.
- The `_decompositionRepairCount` counter from the five-fixes sprint should NOT be reset by
  these changes — it continues tracking across the session.
