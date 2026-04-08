# Zaraban — JSON Structural Integrity Sprint
### For: Claude Code (single session)
### Tag on completion: `json-integrity-complete`
### Source: Gemini audit cross-referenced with Claude analysis

---

## Context

An external audit (Gemini) analyzed Zaraban's transparency logs and identified three JSON
failure modes affecting local model execution. This sprint addresses the gaps that are NOT
already covered by existing hardening.

**Already implemented (DO NOT re-implement):**
- `stripThinkingTags()` handles all model families (Qwen, Gemma 4, Gemini, generic `<think>`)
  — rewritten in log-fixes sprint. Solution 3 from the audit is already done.
- `extractFirstJsonObject()` with bracket-depth counting exists in `core/structured.ts`
- `safeParseJson()` pipeline exists and is applied to some call sites
- `response_format: { type: 'json_schema' }` is passed to LM Studio for memory writes (Phase 7)
- Zod schemas exist for plan, decomposition, post-flight, revision, and write paths

**NOT yet implemented (this sprint covers these):**
1. Several LLM call sites still rely on prompt-level "output ONLY JSON" instead of
   engine-level `responseSchema` — these need the schema parameter added
2. No referential integrity check between steps array and milestone steps (orphaned steps)
3. No runtime newline/escaping validation before JSON parse attempts
4. Planner prompt lacks explicit escaping and array sync rules

Read `CLAUDE.md` fully before touching any file.

**Do not change the architecture. All fixes are surgical edits within existing files.**
**Do not break existing tests. Add new tests only.**
**After each fix: `pnpm build && pnpm test`**

---

## Root Causes From Audit (Mapped to Zaraban)

### 1. Schema Key Hallucination (Audit Failure Mode A)

**Observed:** Model outputs `"descriptron"` or `"descr000001"` instead of `"description"`.
Engine-level structured outputs prevent this entirely — but only if `responseSchema` is
passed to the LLM call. Several call sites in Zaraban do NOT pass the schema.

### 2. String Escaping & Truncation (Audit Failure Mode B)

**Observed:** Model outputs literal `\n` inside JSON string values. Truncation mid-string
breaks closing brackets. `extractFirstJsonObject` handles the bracket issue but cannot
fix invalid escape sequences inside strings.

### 3. Orphaned Steps / Array Asymmetry (Audit Failure Mode C)

**Observed:** Model creates a step in the root `steps` array but forgets to place it
in the corresponding `milestones[].steps` array. The executor hits a dependency that
doesn't exist in the milestone tree and crashes.

---

## Files You Will Touch

```
core/llm.ts                                 ← FIX 1: audit which calls lack responseSchema
core/planner.ts                              ← FIX 1 + FIX 3: add responseSchema + referential check
core/executor.ts                             ← FIX 1: add responseSchema to revision/post-flight
core/decomposition.ts                        ← FIX 1: verify responseSchema is passed
core/structured.ts                           ← FIX 2: add JSON string escape pre-validator
core/schemas.ts                              ← FIX 3: add plan referential integrity validator
prompts/planner.md OR core/planner.ts        ← FIX 4: add escaping + sync rules to prompt
tests/json-integrity/fixes.test.ts           ← NEW: all tests for this sprint
```

**Do NOT touch:**
- `core/router.ts`
- `core/query-loop.ts`
- `core/skills/runner.ts`
- Any test file outside `tests/json-integrity/`
- `CLAUDE.md` (will be updated after tag)

---

## FIX 1 — Audit and Add `responseSchema` to All JSON-Expecting LLM Calls (P0)

The `callLLM` function in `core/llm.ts` already supports an optional `responseSchema`
parameter that passes `response_format: { type: 'json_schema', json_schema: { ... } }`
to LM Studio. This is the engine-level enforcement from the audit's Solution 1.

**Currently uses `responseSchema`:**
- Memory write path (Phase 7)

**Must be audited — add `responseSchema` if missing:**

### Step 1: Find all LLM call sites that expect JSON

```bash
rg -n "safeParseJson|JSON\.parse|extractFirstJsonObject" core/
```

This will show every place where the code expects JSON from the LLM. For each match,
check whether the corresponding LLM call passes `responseSchema`.

### Step 2: For each call site missing `responseSchema`, add it

The pattern for adding schema enforcement:

```typescript
// BEFORE (prompt-only enforcement):
const raw = await llmHandler.chat(messages);
const parsed = safeParseJson(raw, SomeSchema, 'call-site-name', fallback);

// AFTER (engine-level enforcement):
const raw = await llmHandler.chat(messages, {
  responseSchema: someJsonSchema,  // from z.toJSONSchema() or pre-built
});
const parsed = safeParseJson(raw, SomeSchema, 'call-site-name', fallback);
```

### Priority call sites (check these first):

1. **Planner** (`core/planner.ts`) — `decomposeTask()` / `buildPlan()` / `parsePlan()`
   - Schema: The plan JSON schema (milestones, steps, etc.)
   - This is the highest-value target because plan JSON is the most complex

2. **Decomposition** (`core/decomposition.ts`) — decomposition LLM call
   - Schema: `{ units: [{ route, content }] }`
   - Should already have it from Phase 17C hardening — verify

3. **Milestone revision** (`core/executor.ts`) — revision prompt response
   - Schema: `MilestoneRevisionSchema` from `core/schemas.ts`

4. **Post-flight synthesis** (`core/executor.ts`) — `runPostFlightSynthesis`
   - Schema: `PostFlightSchema` from `core/schemas.ts`

5. **Intake classifier** (`core/intake.ts` or `core/agent.ts`)
   - Schema: whatever the intake classification schema is

### Step 3: Generate JSON schemas from existing Zod schemas

For each call site, check if a JSON schema version already exists. If the Zod schema
exists but the JSON schema doesn't:

```typescript
import { z } from 'zod';
import { SomeSchema } from './schemas.js';

// Convert Zod → JSON Schema (Zod v4 built-in)
const someJsonSchema = z.toJSONSchema(SomeSchema);
```

If the call site uses `z.toJSONSchema()` already (like the memory write path), just
pass the result as `responseSchema`.

### Key requirements:

1. **Keep `safeParseJson` as defense-in-depth.** Engine-level enforcement reduces errors
   but does not eliminate them (model can still truncate). The `safeParseJson` fallback
   chain must remain.
2. **Do not add `responseSchema` to free-form text calls.** Only JSON-expecting calls.
3. **Check LM Studio compatibility.** The `response_format` parameter works with LM Studio's
   OpenAI-compatible API. Verify the schema format matches what LM Studio expects. If the
   schema is too complex for LM Studio's grammar engine, simplify it (flatten nested objects).
4. **Log when engine enforcement is active.** Add to the LLM call logging:
   ```typescript
   console.debug(`[zaraban][llm] Call to ${callSite} with responseSchema: ${!!responseSchema}`);
   ```

---

## FIX 2 — JSON String Escape Pre-Validator (P1)

Before attempting `JSON.parse()`, add a pre-validation step that catches the most common
escape errors and attempts repair.

### Step 1: Add `repairJsonEscapes` to `core/structured.ts`

```typescript
/**
 * Attempt to repair common JSON string escape errors from LLM output.
 * Fixes:
 * - Literal newlines inside JSON strings (should be \\n)
 * - Literal tabs inside JSON strings (should be \\t)
 * - Unescaped quotes inside JSON strings
 *
 * This is best-effort — not a full JSON parser. It handles the 80% case
 * where the model outputs a literal newline inside a string value.
 */
export function repairJsonEscapes(raw: string): string {
  // Strategy: walk character by character, track whether we're inside a JSON string.
  // If we encounter a literal newline/tab while inside a string, escape it.
  let result = '';
  let inString = false;
  let escape = false;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];

    if (escape) {
      result += char;
      escape = false;
      continue;
    }

    if (char === '\\' && inString) {
      result += char;
      escape = true;
      continue;
    }

    if (char === '"' && !escape) {
      inString = !inString;
      result += char;
      continue;
    }

    if (inString) {
      if (char === '\n') {
        result += '\\n';
        continue;
      }
      if (char === '\t') {
        result += '\\t';
        continue;
      }
      if (char === '\r') {
        result += '\\r';
        continue;
      }
    }

    result += char;
  }

  return result;
}
```

### Step 2: Integrate into `extractFirstJsonObject`

In `core/structured.ts`, modify `extractFirstJsonObject` to attempt repair on parse failure:

```typescript
export function extractFirstJsonObject(text: string): string | null {
  // ... existing bracket-depth extraction logic ...
  const candidate = /* existing extraction result */;
  if (!candidate) return null;

  // First try: parse as-is
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    // Second try: repair escapes and try again
    const repaired = repairJsonEscapes(candidate);
    try {
      JSON.parse(repaired);
      console.debug('[zaraban][json-repair] Escape repair succeeded');
      return repaired;
    } catch {
      // Return original candidate — let caller handle the error
      return candidate;
    }
  }
}
```

### Key requirements:

1. **Never modify the original text before extraction.** Extract first, then repair.
2. **Log when repair succeeds** — this measures how often the model produces bad escapes.
3. **Don't over-engineer.** This handles literal newlines in strings (the 80% case from
   the audit). Full JSON repair (e.g., trailing commas, missing quotes on keys) is out
   of scope — those are better handled by engine-level enforcement (FIX 1).

---

## FIX 3 — Plan Referential Integrity Validator (P0)

After the planner produces a valid JSON plan (passes Zod schema validation), verify that
every step referenced in `milestones[].steps` exists in the root `steps` array, and vice
versa.

### Step 1: Add `validatePlanIntegrity` to `core/schemas.ts`

```typescript
export interface PlanIntegrityResult {
  valid: boolean;
  orphanedSteps: string[];     // in root steps but not in any milestone
  missingSteps: string[];      // referenced in milestones but not in root steps
  brokenDependencies: string[]; // dependsOn references that don't exist
}

export function validatePlanIntegrity(plan: TaskPlan): PlanIntegrityResult {
  const rootStepIds = new Set(plan.steps.map(s => s.id));

  // Collect all step IDs referenced inside milestones
  const milestoneStepIds = new Set<string>();
  for (const milestone of plan.milestones) {
    if (milestone.steps) {
      for (const stepId of milestone.steps) {
        milestoneStepIds.add(stepId);
      }
    }
  }

  // Orphaned: in root but not in any milestone
  const orphanedSteps = [...rootStepIds].filter(id => !milestoneStepIds.has(id));

  // Missing: referenced in milestone but not in root
  const missingSteps = [...milestoneStepIds].filter(id => !rootStepIds.has(id));

  // Broken dependencies: step.dependsOn references a step that doesn't exist
  const brokenDependencies: string[] = [];
  for (const step of plan.steps) {
    if (step.dependsOn) {
      for (const dep of step.dependsOn) {
        if (!rootStepIds.has(dep)) {
          brokenDependencies.push(`${step.id} → ${dep}`);
        }
      }
    }
  }

  return {
    valid: orphanedSteps.length === 0 && missingSteps.length === 0 && brokenDependencies.length === 0,
    orphanedSteps,
    missingSteps,
    brokenDependencies,
  };
}
```

**Important:** Check the actual `TaskPlan` type in the codebase. The shape above
(`plan.steps`, `plan.milestones`, `milestone.steps`) is illustrative. Adapt to the
real type. Use `grep -rn "TaskPlan\|milestones\|steps" core/planner.ts core/schemas.ts`
to find the actual structure.

### Step 2: Apply the validator after plan parsing in `core/planner.ts`

After the plan passes Zod validation, run the integrity check:

```typescript
const integrity = validatePlanIntegrity(parsedPlan);
if (!integrity.valid) {
  console.warn(
    `[zaraban][planner] Plan has referential integrity issues:`,
    {
      orphaned: integrity.orphanedSteps,
      missing: integrity.missingSteps,
      brokenDeps: integrity.brokenDependencies,
    }
  );
  emit('plan_integrity_warning', integrity);

  // Attempt auto-repair for orphaned steps:
  // If a step exists in root but not in any milestone, assign it to the
  // most logical milestone (the one whose existing steps have the closest
  // dependency chain, or the last milestone as a catch-all).
  if (integrity.orphanedSteps.length > 0 && integrity.missingSteps.length === 0) {
    for (const orphanId of integrity.orphanedSteps) {
      // Find the step's dependencies
      const step = parsedPlan.steps.find(s => s.id === orphanId);
      if (!step) continue;

      // Find which milestone contains the step this one depends on
      let targetMilestone = parsedPlan.milestones[parsedPlan.milestones.length - 1];
      if (step.dependsOn?.length) {
        for (const milestone of parsedPlan.milestones) {
          if (milestone.steps?.some(sid => step.dependsOn!.includes(sid))) {
            targetMilestone = milestone;
            break;
          }
        }
      }

      // Add the orphaned step to the target milestone
      if (!targetMilestone.steps) targetMilestone.steps = [];
      targetMilestone.steps.push(orphanId);
      console.warn(
        `[zaraban][planner] Auto-assigned orphaned step ${orphanId} to milestone ${targetMilestone.id}`
      );
    }
  }

  // If steps are missing from root (referenced in milestones but don't exist),
  // that's a more serious error — log loudly but don't crash
  if (integrity.missingSteps.length > 0) {
    console.error(
      `[zaraban][planner] CRITICAL: Milestone references non-existent steps: ` +
      integrity.missingSteps.join(', ')
    );
  }
}
```

### Key requirements:

1. **Run after Zod validation, before execution.** The schema validates shape; this
   validates referential integrity.
2. **Auto-repair orphaned steps** by assigning them to the correct milestone. This
   directly fixes the audit's Failure Mode C.
3. **Never silently drop steps.** If a step exists, it must be in a milestone. If a
   milestone references a step that doesn't exist, log an error.
4. **Emit `plan_integrity_warning`** transparency event with the full integrity result.

---

## FIX 4 — Planner Prompt Hardening (P1)

Add explicit rules to the planner prompt addressing the audit's specific failure patterns.
These are defense-in-depth — FIX 1 (engine enforcement) and FIX 3 (runtime validation)
are the primary defenses.

### Step 1: Locate the planner prompt

Check whether the prompt is in `core/planner.ts` (inline) or `prompts/planner.md`
(externalized template):

```bash
grep -rn "JSON\|CRITICAL\|RULES" core/planner.ts prompts/planner.md 2>/dev/null | head -30
```

### Step 2: Add the following rules

Append these to the existing CRITICAL INPUT RULES section (or create one if it doesn't
exist):

```
STRUCTURAL INTEGRITY RULES:
1. Every step defined in the root "steps" array MUST appear in exactly ONE
   milestone's "steps" array. No orphaned steps. No missing steps.
2. Every "dependsOn" reference MUST point to a step ID that exists in the
   root "steps" array.
3. All string values inside JSON fields MUST have newlines escaped as \\n,
   tabs escaped as \\t, and internal quotes escaped as \\". Do NOT output
   literal newlines inside JSON string values.
4. Use the EXACT key names from the schema. Do not rename, abbreviate, or
   "correct" key names. If the schema says "description", output "description"
   — not "desc", "descrption", or "descriptron".
5. Before outputting the closing bracket of the plan JSON, mentally verify:
   - The number of milestones matches what you planned
   - Every step appears in both the root array AND a milestone
   - All brackets and braces are balanced
```

### Key requirements:

1. **Keep the rules concise.** The planner prompt is already large. These rules should
   be < 200 words total.
2. **Place them AFTER the JSON schema description** but BEFORE the user's task. The model
   pays more attention to rules placed close to the schema definition.
3. **Do not duplicate existing rules.** Check what's already in the prompt first.

---

## Tests to Write

Create `tests/json-integrity/fixes.test.ts`.

### Test group: responseSchema audit (FIX 1)

```typescript
// 1. Planner LLM call includes responseSchema parameter
// 2. Decomposition LLM call includes responseSchema parameter
// 3. Milestone revision LLM call includes responseSchema parameter
// 4. Post-flight synthesis LLM call includes responseSchema parameter
// 5. Intake classifier LLM call includes responseSchema parameter (if it expects JSON)
// 6. Memory write LLM call includes responseSchema parameter (regression check — Phase 7)
```

### Test group: JSON escape repair (FIX 2)

```typescript
// 7. repairJsonEscapes fixes literal newline inside JSON string
// 8. repairJsonEscapes fixes literal tab inside JSON string
// 9. repairJsonEscapes does NOT modify correctly escaped \\n
// 10. repairJsonEscapes does NOT modify text outside JSON strings
// 11. repairJsonEscapes handles nested quotes correctly
// 12. extractFirstJsonObject returns repaired JSON when original has literal newlines
// 13. extractFirstJsonObject returns original when no repair needed (regression check)
```

### Test group: Plan referential integrity (FIX 3)

```typescript
// 14. validatePlanIntegrity returns valid:true when all steps are in milestones
// 15. validatePlanIntegrity detects orphaned steps (in root, not in milestone)
// 16. validatePlanIntegrity detects missing steps (in milestone, not in root)
// 17. validatePlanIntegrity detects broken dependencies
// 18. Auto-repair assigns orphaned step to milestone containing its dependency
// 19. Auto-repair assigns orphaned step to last milestone when no dependency match
// 20. Missing steps (in milestone, not in root) log error but don't crash
// 21. plan_integrity_warning event is emitted with correct fields
```

### Test group: Planner prompt hardening (FIX 4)

```typescript
// 22. Planner prompt contains "STRUCTURAL INTEGRITY RULES" section
// 23. Planner prompt contains orphaned steps warning
// 24. Planner prompt contains escaping rule (\\n)
// 25. Planner prompt contains "EXACT key names" rule
// 26. Existing SINGLE-FILE HTML RULE is preserved (regression check)
// 27. Existing COMPARISON TASK RULES are preserved (regression check)
```

**Minimum: 27 tests. All must pass before tagging.**

---

## Completion Checklist

### FIX 1 (responseSchema Audit)
- [ ] All JSON-expecting LLM call sites identified via `rg`
- [ ] `responseSchema` added to planner, decomposition, revision, post-flight calls
- [ ] JSON schemas generated from existing Zod schemas via `z.toJSONSchema()`
- [ ] `safeParseJson` fallback chain preserved at every call site
- [ ] Debug logging added for schema enforcement status
- [ ] `pnpm build` clean, `pnpm test` all pass

### FIX 2 (JSON Escape Pre-Validator)
- [ ] `repairJsonEscapes()` exported from `core/structured.ts`
- [ ] Handles literal newlines, tabs, carriage returns inside JSON strings
- [ ] Does not modify correctly escaped sequences
- [ ] Integrated into `extractFirstJsonObject` as second-chance parse
- [ ] Debug log on successful repair
- [ ] `pnpm build` clean, `pnpm test` all pass

### FIX 3 (Plan Referential Integrity)
- [ ] `validatePlanIntegrity()` exported from `core/schemas.ts`
- [ ] Detects orphaned steps, missing steps, broken dependencies
- [ ] Auto-repair assigns orphaned steps to correct milestone
- [ ] Missing-from-root steps logged as error (no crash)
- [ ] `plan_integrity_warning` transparency event emitted
- [ ] Applied in `core/planner.ts` after Zod validation, before execution
- [ ] `pnpm build` clean, `pnpm test` all pass

### FIX 4 (Planner Prompt Hardening)
- [ ] STRUCTURAL INTEGRITY RULES block added to planner prompt
- [ ] Rules placed after schema description, before user task
- [ ] Existing prompt rules preserved (no regressions)
- [ ] Rules under 200 words total
- [ ] `pnpm build` clean, `pnpm test` all pass

### Final
- [ ] 27 new tests in `tests/json-integrity/fixes.test.ts` all pass
- [ ] No existing test regressions
- [ ] `pnpm stress:critical` passes (run if stress runner is available)
- [ ] `git tag json-integrity-complete`

---

## Expected Outcomes After This Sprint

| Metric | Before | After |
|---|---|---|
| Key name hallucination ("descriptron") | Possible | Blocked by engine-level schema |
| Literal newlines break JSON parse | Fatal error | Auto-repaired before parse |
| Orphaned steps crash executor | Fatal dependency error | Auto-assigned to correct milestone |
| Schema enforcement coverage | ~30% of call sites | ~90% of JSON-expecting calls |
| Plan structural errors | Silent until execution | Caught at plan validation time |

### Interaction with Tetris Session Fixes Sprint

This sprint is **independent** of the Tetris session fixes (`tetris-session-fixes-claudecode.md`).
They can run in either order. However, the post-repair milestone count validation from the
Tetris sprint and the referential integrity validator from this sprint are complementary —
together they catch both truncation (lost milestones) and asymmetry (orphaned steps).

If running both sprints, run this one first — the `responseSchema` additions will reduce
the frequency of JSON errors that the Tetris sprint's repair logic needs to handle.
