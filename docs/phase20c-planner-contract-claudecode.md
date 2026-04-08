# Phase 20C — Planner Contract Fix (Schema Loop, Stale Runtime, Image Acquisition)

**Date:** 2026-04-08  
**Priority:** P0 — Blocks all agentic task execution  
**Source:** Cross-model diagnosis (Grok, ChatGPT, Gemini) of transparency log 2026-04-08 13:43–13:55; Codex repo-level analysis  
**Prerequisite:** None — independent of tetris-session-fixes and json-integrity sprints  

---

## Problem Statement

The planner is stuck in an infinite schema repair loop. The plan JSON is **structurally and logically correct** (5 steps, 2 milestones, valid skill routing) but fails Zod validation because the LLM never emits fields that only exist in the schema, not in the prompt instructions. The repair error message is too vague to guide the model, so it regenerates the same output 3× at ~40s each, burning ~80k tokens and 2+ minutes before failing.

Additionally, prompt changes made in prior sprints may not be reaching the live runtime because the prompt loader caches on first read in the long-lived UI server process. And the planner does not distinguish research-only web searches from tasks that need actual image URL acquisition.

**Exact failure chain from the log:**

1. Planner emits valid plan JSON (48s) — missing `createdAt`, `confidence_score`, `risk_level` on each step
2. Schema validation rejects it
3. Repair message says: `"Schema validation failed. Expected: 5 steps, 2 milestones. Ensure all fields match required types and return corrected JSON only."`
4. Model sees step/milestone counts are already correct → regenerates identical output
5. Repeat 2 more times → agent gives up

**Root causes (six layers):**

| Layer | Cause | Fix |
|-------|-------|-----|
| Immediate | Repair error message doesn't name the missing fields | FIX 1 |
| Structural | Schema requires fields (`createdAt`, per-step `confidence_score`/`risk_level`) that the planner prompt never mentions or demonstrates | FIX 2 |
| Efficiency | Zero-confidence memory matches leak into planner context, adding noise | FIX 3 |
| Semantic | "plan first" is treated as "build internally" not "show user the plan" | FIX 4 |
| Runtime | Prompt loader may cache planner prompt at startup — prompt file changes don't take effect without restart | FIX 5 |
| Completeness | Plans for "use internet images" tasks include only vague web_search, no actual image URL acquisition steps | FIX 6 |

---

## Pre-Implementation: Read These Files First

Before making any changes, read all of these to understand the current state:

```bash
cat core/planner.ts
cat core/schemas.ts
cat core/structured.ts
cat core/prompt-loader.ts
cat core/router.ts
cat core/memory/unit-search.ts
cat prompts/planner.md
cat server/ui-bootstrap.mjs
cat scripts/ui-app-launcher.mjs
cat tests/json-integrity/fixes.test.ts
cat tests/log-fixes/fixes.test.ts
```

Only begin implementation after reading all files. The fixes below assume knowledge of the actual code, not assumptions.

---

## Files You Will Touch

```
core/planner.ts                              ← FIX 1 + FIX 2 + FIX 4 + FIX 6
core/structured.ts                           ← FIX 1 (if repair message is built here)
core/memory/unit-search.ts                   ← FIX 3
core/prompt-loader.ts                        ← FIX 5
prompts/planner.md                           ← FIX 6 (prompt update AFTER code is correct)
tests/phase20c-planner-contract/fixes.test.ts ← NEW: all tests for this sprint
```

**Do NOT touch:**
- `core/router.ts`
- `core/query-loop.ts`
- `core/executor.ts`
- `core/skills/runner.ts`
- `core/decomposition.ts`
- `server/ui-bootstrap.mjs` (read-only — understand it, don't change it unless FIX 5 requires it)
- Any test file outside `tests/phase20c-planner-contract/`
- `CLAUDE.md` (will be updated after tag)

---

## Execution Order

1. **FIX 2 first** (programmatic defaults) — immediately breaks the infinite loop
2. **FIX 1 second** (specific error messages) — prevents future loops from other causes
3. **FIX 5 third** (prompt cache staleness) — ensures all prompt changes are live
4. **FIX 3 fourth** (memory filtering) — reduces planner prompt noise
5. **FIX 4 fifth** (plan-first intent) — correctness improvement
6. **FIX 6 last** (image acquisition) — planner quality improvement + prompt update

Run `pnpm build && pnpm test` after each fix before moving to the next.

---

## FIX 1 — Specific Schema Error Feedback in Repair Messages (P0)

The repair message currently says something generic like:
```
Schema validation failed. Expected: 5 steps, 2 milestones. 
Ensure all fields match required types and return corrected JSON only.
```

This tells the model nothing about WHAT failed. The model sees its step/milestone counts are correct and regenerates the same output.

### Step 1: Locate the repair message builder

```bash
rg -n "Schema validation failed\|Ensure all fields\|return corrected JSON" core/
```

Also check:
```bash
rg -n "repair\|retry\|retryMessages\|rescueMessages" core/planner.ts core/structured.ts
```

### Step 2: Extract the actual Zod error details

When `safeParseJson` or the Zod schema `.safeParse()` fails, it returns a `ZodError` with `error.issues[]`. Each issue has `path`, `code`, `message`, and `expected`/`received`. The repair prompt MUST include these specifics.

Change the repair message builder to something like:

```typescript
// BEFORE (vague):
const repairMessage = `Schema validation failed. Expected: ${stepCount} steps, ${milestoneCount} milestones. Ensure all fields match required types and return corrected JSON only.`;

// AFTER (specific):
function buildRepairMessage(zodError: ZodError, rawJson: unknown): string {
  const issues = zodError.issues.map(issue => {
    const path = issue.path.join('.');
    const msg = issue.message;
    // For missing required fields, be explicit
    if (issue.code === 'invalid_type' && issue.received === 'undefined') {
      return `Missing required field "${path}": expected ${issue.expected}`;
    }
    return `Field "${path}": ${msg}`;
  });

  return [
    `Schema validation failed with ${issues.length} issue(s):`,
    ...issues.map((iss, i) => `  ${i + 1}. ${iss}`),
    '',
    'Fix ONLY the listed issues. Do not change the plan logic. Return corrected JSON only.'
  ].join('\n');
}
```

### Step 3: Apply at the call site

Wherever the planner catches a schema validation failure and constructs a retry prompt, replace the generic message with the specific one. The Zod error object must be passed through — if `safeParseJson` currently swallows it and returns `null`, modify `safeParseJson` to also return the error:

```typescript
// Option A: Add a variant that returns the error
function safeParseJsonWithError<T>(
  raw: string,
  schema: ZodSchema<T>,
  callSite: string,
): { data: T; error: null } | { data: null; error: ZodError } {
  // ... parse logic ...
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { data: null, error: result.error };
  }
  return { data: result.data, error: null };
}
```

### Key requirements:

1. **The repair message MUST list every missing/invalid field by path.** Generic messages cause infinite loops.
2. **Include the expected type for each field.** e.g., `Missing required field "createdAt": expected string`
3. **Cap repair attempts at 2** (1 retry + 1 rescue). If both fail, fall back to programmatic field injection (see FIX 2).
4. **Never repeat the full system prompt in the repair message.** Just reference the issues.

---

## FIX 2 — Programmatic Default Injection for Schema-Only Fields (P0)

The schema requires `createdAt` (on the plan), `confidence_score` (on each step), and `risk_level` (on each step). The planner prompt doesn't mention or demonstrate these fields. The model will never emit them unprompted — especially a local model.

**Solution: inject defaults programmatically after parsing, before Zod validation.**

### Step 1: Add a plan normalizer function

```typescript
function normalizePlanDefaults(raw: Record<string, unknown>): Record<string, unknown> {
  // Inject createdAt if missing
  if (!raw.createdAt) {
    raw.createdAt = new Date().toISOString();
  }

  // Inject per-step defaults
  const normalizeStep = (step: Record<string, unknown>) => {
    if (step.confidence_score === undefined) step.confidence_score = 0.8;
    if (step.risk_level === undefined) step.risk_level = 'LOW';
    return step;
  };

  if (Array.isArray(raw.steps)) {
    raw.steps = raw.steps.map((s: any) => normalizeStep(s));
  }
  if (Array.isArray(raw.milestones)) {
    raw.milestones = raw.milestones.map((m: any) => {
      if (Array.isArray(m.steps)) {
        m.steps = m.steps.map((s: any) => normalizeStep(s));
      }
      return m;
    });
  }

  return raw;
}
```

### Step 2: Apply BEFORE Zod validation in the planner

```typescript
// In the planner parse path:
const block = extractFirstJsonObject(stripThinkingTags(raw));
if (!block) return null;

let parsed = JSON.parse(block);
parsed = normalizePlanDefaults(parsed);  // ← inject defaults BEFORE schema check

const result = PlanSchema.safeParse(parsed);
```

### Step 3: Also apply in the repair path

If the first attempt fails and goes through repair, the repair output should ALSO be normalized before validation. This catches cases where the model fixes some issues but still omits the metadata fields.

### Key requirements:

1. **This is the primary fix.** The LLM should NOT be responsible for emitting metadata fields that are runtime concerns (timestamps, default confidence scores). These are the runtime's job.
2. **The normalizer must be idempotent.** If the model does emit `createdAt`, don't overwrite it.
3. **Apply to both root-level steps AND milestone-nested steps.** The schema requires these fields in both locations.
4. **Log when defaults are injected** at debug level: `[zaraban][planner] Injected default createdAt, confidence_score on 5 steps`

---

## FIX 3 — Suppress Zero-Confidence Memory Matches from Planner Context (P1)

The unit memory search returned confidence 0 and injected three irrelevant entries:
- `PLAN.PL-000002` (Finish Phase 9 of AgenticAGI)
- `HOW.PR-000016` (Neolith Catalog Download Procedure)
- `WHEN.EV-000090` (Calculator website)

None of these help plan an interior architecture website. They add ~500 tokens of noise to an already overloaded planner prompt.

### Step 1: Find the confidence filter

```bash
rg -n "confidence\|unit_memory_search\|searchMemoryForUnits\|RELEVANT MEMORY" core/memory/unit-search.ts core/planner.ts
```

### Step 2: Add a confidence threshold

In the function that prepares memory context for the planner (likely `searchMemoryForUnits` or similar in `core/memory/unit-search.ts`):

```typescript
// After retrieving memory matches for a unit:
const MINIMUM_RELEVANCE_CONFIDENCE = 0.3;

// Filter out matches below threshold
const relevantEntries = result.entries.filter(entry => {
  // If the search strategy reported a confidence score, use it
  if (result.confidence !== undefined && result.confidence < MINIMUM_RELEVANCE_CONFIDENCE) {
    return false;  // Entire result set is low-confidence — skip all
  }
  return true;
});

// If no entries pass the filter, inject nothing into planner context
if (relevantEntries.length === 0) {
  return { ...result, entries: [], contents: [] };
}
```

### Step 3: Also filter in the planner prompt builder

If filtering at the search level is too aggressive (other consumers need low-confidence results), add the filter where the planner prompt assembles the "RELEVANT MEMORY CONTEXT" section:

```typescript
// When building the planner system prompt:
const memorySection = unitResults
  .filter(r => r.result.confidence > 0)  // Skip zero-confidence results entirely
  .map(r => formatMemoryContext(r))
  .join('\n');
```

### Key requirements:

1. **Zero-confidence results MUST NOT appear in the planner prompt.** They are noise.
2. **The filter applies to the planner context injection path only.** The `memory_read` skill and session cache must still access all entries.
3. **Log when entries are filtered out:** `[zaraban][planner] Filtered 3 zero-confidence memory entries from planner context for unit_1`
4. **Threshold of 0.3 is a starting point.** Can be tuned later. Zero is the hard floor.
5. **Do not break legitimate continuation flows.** If a user is continuing work on a known project, that project's memory should still appear even if bm25 scored it low — but only if confidence > 0. True zero-confidence means "retrieval found nothing relevant."

---

## FIX 4 — "Plan First" Intent Detection (P1)

When the user says "plan first," the system should present the plan for user review before execution, not silently build and execute. Currently `needsConfirmation` is set to `false` by the LLM.

### Step 1: Detect "plan first" in the intake or planner

```bash
rg -n "needsConfirmation\|shouldRequireConfirmation\|plan first\|show.*plan" core/planner.ts core/agent.ts core/router.ts
```

### Step 2: Force confirmation when user says "plan first"

In the planner or agent, after the plan is generated:

```typescript
// Check if the original user message contains "plan first" intent
const planFirstPatterns = /\bplan\s+first\b|\bshow\s+(me\s+)?the\s+plan\b|\breview\s+(the\s+)?plan\b/i;
if (planFirstPatterns.test(originalMessage)) {
  plan.needsConfirmation = true;
}
```

### Step 3: Override the LLM's needsConfirmation value

The `shouldRequireConfirmation()` function (referenced in ARCHITECTURE.md) should include this pattern check. The LLM's value for `needsConfirmation` should never be trusted for "plan first" requests — this is a deterministic signal.

### Step 4: Ensure the confirmation gate works through the router contract

Check how `needsConfirmation` is consumed downstream:

```bash
rg -n "needsConfirmation\|confirm_plan\|plan_pending" core/router.ts core/executor.ts core/agent.ts
```

The plan must be surfaced to the user as a readable summary (milestones, steps, estimated duration) — not raw JSON — and execution must wait for explicit approval.

### Key requirements:

1. **"plan first" = forced confirmation.** The user explicitly asked to see the plan before execution.
2. **The detection is regex-based, not LLM-based.** Don't rely on the model to set `needsConfirmation` correctly — it doesn't.
3. **The confirmation gate must show the plan structure** (milestones, steps, estimated duration) in a human-readable format, not raw JSON.
4. **This works through the real planner/router contract.** Don't just patch the planner output — verify the downstream path honors `needsConfirmation=true`.

---

## FIX 5 — Prompt Loader Cache Staleness in Long-Lived UI Runtime (P1)

Prior sprint prompt changes to `prompts/planner.md` (structural integrity rules, skill routing rules, etc.) may not be reaching the live runtime if the prompt loader caches on first read.

### Step 1: Understand the current prompt loading mechanism

```bash
cat core/prompt-loader.ts
rg -n "loadPrompt\|readFileSync\|promptCache\|plannerPrompt" core/prompt-loader.ts core/planner.ts
```

Also check how the UI server bootstraps:
```bash
cat server/ui-bootstrap.mjs
cat scripts/ui-app-launcher.mjs
```

### Step 2: Determine if prompts are cached

Look for patterns like:
- Module-level `const prompt = fs.readFileSync(...)` — cached at import time
- Singleton cache objects that load once and never invalidate
- `require()` or top-level `import` of prompt text files

### Step 3: Add safe prompt reload behavior

The fix depends on what you find. Preferred approaches in order:

**Option A — File mtime check (preferred):**
If prompts are cached, add a mtime-based invalidation. On each planner call, check if the prompt file's mtime has changed since last load. If so, reload.

```typescript
let cachedPrompt: string | null = null;
let cachedMtime: number = 0;

function loadPlannerPrompt(): string {
  const promptPath = path.resolve(__dirname, '../prompts/planner.md');
  const stat = fs.statSync(promptPath);
  if (!cachedPrompt || stat.mtimeMs > cachedMtime) {
    cachedPrompt = fs.readFileSync(promptPath, 'utf-8');
    cachedMtime = stat.mtimeMs;
    console.log(`[zaraban][prompt-loader] Reloaded planner prompt (mtime: ${new Date(stat.mtimeMs).toISOString()})`);
  }
  return cachedPrompt;
}
```

**Option B — Read on every call (acceptable if prompts are small):**
If the prompt file is <50KB, reading on every planner call is acceptable. The planner already spends 40–50s on LLM inference — an extra 1ms file read is negligible.

**Option C — Export a cache-clear function:**
If the prompt loader is shared infrastructure, add an exported `clearPromptCache()` function that the UI bootstrap can call on file change or on demand.

### Key requirements:

1. **Prompt changes must take effect without restarting the UI server.** This is the core requirement.
2. **Do NOT introduce a file watcher with chokidar or similar** — that's overkill. Mtime check on read is sufficient.
3. **The fix must be in `core/prompt-loader.ts`** (or wherever prompts are loaded), not in the UI server layer.
4. **Log when a prompt is reloaded** so you can verify in transparency logs that fresh content is being used.
5. **If prompts are NOT cached** (i.e., already re-read on every call), document this finding and skip to the next fix. Don't add caching where none exists.

---

## FIX 6 — Image Acquisition Steps for "Use Internet Images" Tasks (P2)

When the user says "use images on internet" or "use images from the web," the planner generates only vague `web_search` steps with no mechanism to actually obtain stable image URLs. The generated HTML will either omit images entirely or use placeholder text.

### Step 1: Understand the current browsing/download workflow

The planner prompt already contains a WEB BROWSING / DOWNLOAD WORKFLOW section that specifies:
```
web_search → url_extract → web_fetch → url_extract → run_bash
```

But the planner skips this for image acquisition and treats raw `web_search` as sufficient. The planner needs to be aware that when a task requires actual external assets in the final artifact, the full browsing workflow is required.

### Step 2: Add an image acquisition detection rule to the planner prompt

In `prompts/planner.md`, add a rule in the SKILL ROUTING section (after the existing WEB BROWSING RULES):

```
IMAGE ACQUISITION RULE:
When the user's request includes using images from the internet in the final artifact
(e.g., "use images on internet", "include pictures from the web", "use real photos"):
- The plan MUST include actual image URL acquisition steps, not just web_search
- Use the WEB BROWSING WORKFLOW: web_search → url_extract → web_fetch (to find image URLs)
- The spec or description passed to generate_and_save_file MUST reference the acquired
  image URLs via {{template_tokens}} from prior steps
- A plan that only does web_search and then says "include image suggestions" does NOT
  satisfy a request for actual internet images
- If run_bash is blocked (workspace-write mode), the plan should use web_fetch to find
  stable image URLs (e.g., from Unsplash, Pexels, or Wikimedia Commons) and embed them
  directly as <img src="..."> in the generated HTML
- CORRECT pattern:
  step1: web_search { "query": "free interior architecture photos unsplash" }
  step2: url_extract { "text": "{{step1_result}}", "filter": "unsplash" }
  step3: web_fetch { "url": "{{step2_result}}", "extract_links_matching": ".jpg" }
  step4: memory_write { "nb": "PLAN", "type": "EX", "name": "...", "body": "... use images: {{step3_result}} ..." }
  step5: generate_and_save_file { "path": "site.html", "spec_code": "{{step4_result}}" }
- WRONG pattern:
  step1: web_search { "query": "interior architecture images" }
  step2: content_writer { "prompt": "suggest images for..." }
  step3: generate_and_save_file { ... }  ← no actual image URLs acquired
```

### Step 3: Also add a runtime detection heuristic

In `core/planner.ts`, after the plan is generated, add a post-plan validation check:

```typescript
function validateImageAcquisition(plan: TaskPlan, originalMessage: string): void {
  const imageIntentPatterns = /\buse\s+(images?|pictures?|photos?)\s+(on|from)\s+(the\s+)?(internet|web|online)\b/i;
  if (!imageIntentPatterns.test(originalMessage)) return;  // Not an image task

  // Check if the plan includes actual URL acquisition steps
  const hasUrlExtract = plan.steps.some(s => s.skill === 'url_extract');
  const hasWebFetch = plan.steps.some(s => s.skill === 'web_fetch');

  if (!hasUrlExtract && !hasWebFetch) {
    console.warn(
      `[zaraban][planner] Plan for image-acquisition task has no url_extract or web_fetch steps. ` +
      `The generated artifact will likely lack actual images.`
    );
    // Emit transparency event
    emit('plan_image_warning', {
      message: 'Plan does not include image URL acquisition steps despite user requesting internet images',
      steps: plan.steps.map(s => s.skill),
    });
  }
}
```

### Step 4: Update the prompt ONLY AFTER the code fixes are verified

The prompt change in Step 2 should be the LAST thing applied, after FIX 1–5 are verified with tests. This ensures the prompt matches the actual runtime contract.

### Key requirements:

1. **The prompt update goes in `prompts/planner.md`** in the skill routing section, near the existing WEB BROWSING RULES.
2. **The runtime validator is a warning, not a blocker.** Don't reject the plan — just log and emit a transparency event. The planner might have a valid reason for omitting these steps (e.g., the 8-step limit forces a tradeoff).
3. **Do not invent new tools.** Use only existing skills: `web_search`, `url_extract`, `web_fetch`, `generate_and_save_file`.
4. **The pattern uses free image sources** (Unsplash, Pexels, Wikimedia Commons) as the recommended targets. These provide stable, hotlinkable image URLs.

---

## Tests to Write

Create `tests/phase20c-planner-contract/fixes.test.ts`.

### Test group: Specific error feedback (FIX 1)

```typescript
// 1. buildRepairMessage includes missing field paths from ZodError
// 2. buildRepairMessage includes expected types for missing fields
// 3. buildRepairMessage handles multiple simultaneous issues
// 4. Repair message does NOT include generic "Expected: N steps" when field-level errors exist
// 5. safeParseJsonWithError returns ZodError when validation fails
// 6. safeParseJsonWithError returns data when validation succeeds
```

### Test group: Programmatic default injection (FIX 2)

```typescript
// 7. normalizePlanDefaults injects createdAt when missing
// 8. normalizePlanDefaults does NOT overwrite existing createdAt
// 9. normalizePlanDefaults injects confidence_score=0.8 on steps missing it
// 10. normalizePlanDefaults injects risk_level='LOW' on steps missing it
// 11. normalizePlanDefaults handles both root steps AND milestone-nested steps
// 12. normalizePlanDefaults is idempotent (running twice produces same result)
// 13. Plan with injected defaults passes PlanSchema validation
// 14. Plan WITHOUT injected defaults fails PlanSchema validation (confirms the bug)
```

### Test group: Zero-confidence memory filtering (FIX 3)

```typescript
// 15. Zero-confidence memory results are excluded from planner context
// 16. Positive-confidence memory results are preserved in planner context
// 17. When all results are zero-confidence, planner context memory section is empty
// 18. Filter does NOT affect memory_read skill results (only planner context)
```

### Test group: "Plan first" detection (FIX 4)

```typescript
// 19. "plan first" in message forces needsConfirmation=true
// 20. "Plan First" (case variation) forces needsConfirmation=true
// 21. "show me the plan" forces needsConfirmation=true
// 22. "review the plan before building" forces needsConfirmation=true
// 23. Normal message without plan-first intent does NOT force confirmation
// 24. LLM's needsConfirmation=false is overridden when plan-first detected
```

### Test group: Prompt loader freshness (FIX 5)

```typescript
// 25. loadPlannerPrompt returns current file content (not stale cache)
// 26. After prompt file mtime changes, loadPlannerPrompt returns updated content
// 27. When mtime is unchanged, loadPlannerPrompt returns cached content (efficiency)
// 28. If prompt-loader has no cache, test documents this (skip with note)
```

### Test group: Image acquisition validation (FIX 6)

```typescript
// 29. validateImageAcquisition warns when "use images on internet" task has no url_extract/web_fetch
// 30. validateImageAcquisition does NOT warn for normal tasks without image intent
// 31. validateImageAcquisition does NOT warn when plan includes url_extract step
// 32. validateImageAcquisition does NOT warn when plan includes web_fetch step
// 33. Planner prompt contains IMAGE ACQUISITION RULE section
// 34. Planner prompt IMAGE ACQUISITION RULE references url_extract and web_fetch
```

**Minimum: 34 tests. All must pass before tagging.**

---

## Completion Checklist

### FIX 1 (Specific Error Feedback)
- [ ] `buildRepairMessage()` or equivalent extracts field-level Zod errors
- [ ] Repair message lists every missing/invalid field by dot-path
- [ ] `safeParseJsonWithError()` variant returns ZodError to caller
- [ ] Repair attempts capped at 2
- [ ] `pnpm build` clean, `pnpm test` all pass

### FIX 2 (Programmatic Defaults)
- [ ] `normalizePlanDefaults()` exported from `core/planner.ts` or `core/schemas.ts`
- [ ] Injects `createdAt`, `confidence_score`, `risk_level` when missing
- [ ] Applied BEFORE Zod validation in both initial parse and repair parse
- [ ] Idempotent — does not overwrite existing values
- [ ] Debug log when defaults are injected
- [ ] `pnpm build` clean, `pnpm test` all pass

### FIX 3 (Zero-Confidence Filter)
- [ ] Confidence threshold (≥0.3 or >0) applied to planner context injection
- [ ] Zero-confidence entries excluded from "RELEVANT MEMORY CONTEXT" section
- [ ] Filter does NOT affect `memory_read` skill or session cache
- [ ] Debug log lists filtered entry codes
- [ ] `pnpm build` clean, `pnpm test` all pass

### FIX 4 (Plan-First Intent)
- [ ] Regex-based detection of "plan first" / "show the plan" / "review plan"
- [ ] Forces `needsConfirmation = true` on the plan
- [ ] Overrides LLM's value — deterministic, not model-dependent
- [ ] Works through the real planner/router contract (verified downstream)
- [ ] `pnpm build` clean, `pnpm test` all pass

### FIX 5 (Prompt Cache Staleness)
- [ ] Investigated `core/prompt-loader.ts` and UI bootstrap files
- [ ] If cached: mtime-based invalidation added, log on reload
- [ ] If not cached: documented finding, no change needed
- [ ] `pnpm build` clean, `pnpm test` all pass

### FIX 6 (Image Acquisition)
- [ ] `validateImageAcquisition()` added to `core/planner.ts` as post-plan check
- [ ] IMAGE ACQUISITION RULE added to `prompts/planner.md` in skill routing section
- [ ] Warning + transparency event emitted, not a hard block
- [ ] Prompt update is the LAST change applied (after code fixes verified)
- [ ] `pnpm build` clean, `pnpm test` all pass

### Final
- [ ] 34 new tests in `tests/phase20c-planner-contract/fixes.test.ts` all pass
- [ ] No existing test regressions
- [ ] `git tag phase-20c-planner-contract-complete`

---

## Expected Outcomes After This Sprint

| Metric | Before | After |
|---|---|---|
| Planner schema loop on simple HTML task | 3 retries → fail (2+ min, ~80k tokens) | 0 retries — defaults injected pre-validation |
| Repair error message specificity | Generic step/milestone count | Field-level paths + expected types |
| Irrelevant memory in planner context | 3 zero-confidence entries (~500 tokens) | 0 entries — filtered |
| "plan first" user intent | Ignored — auto-executes | Confirmation gate triggered |
| Prompt changes reaching live runtime | Unknown — possibly stale | Verified fresh on every planner call |
| "Use internet images" task quality | Plan has no image URL steps | Warning emitted + prompt guides URL acquisition |
| Total planner latency for this task | 2+ min (3 × 40s) | ~50s (1 call, no retries) |

---

## Interaction with Other Sprints

- **json-integrity-claudecode.md**: That sprint adds `responseSchema` to LLM calls and `validatePlanIntegrity()`. This sprint is complementary — FIX 2 here prevents the loop from ever starting; json-integrity's FIX 1 adds engine-level schema enforcement as defense-in-depth.
- **tetris-session-fixes-claudecode.md**: Independent. That sprint fixes post-repair milestone count comparison and continuation-intent detection. Can run in any order.
- **Codex_implemented_solutions_on_Clone.md**: The Codex clone fixed thinking tag stripping and generation budgets. This sprint is independent but benefits from those fixes being present.
- **phase19d-audit-fixes-haiku.md**: If that sprint already addressed some memory filtering, verify FIX 3 here doesn't conflict. Check the unit-search.ts diff before applying.
