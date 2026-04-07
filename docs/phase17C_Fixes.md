# Zaraban — Log Analysis Fix Sprint #2
### For: Claude Code (single session)
### Tag on completion: `log2-fixes-complete`

---

## Context

This prompt is derived from a transparency log captured 2026-04-05 at 00:10–00:12 UTC. The log
records the same class of task (Street-of-Rage HTML game) that drove the first log-fixes sprint.
The first sprint (`log-fixes-complete`, 858/858 tests) fixed token budgets, grounded verification,
reactive milestone revision, post-flight merging, content_writer minimum lengths, HOW.PR gating,
working memory wiring, and the single-file HTML planner rule.

**This sprint addresses 6 remaining gaps that the first sprint did not cover.** These are
structural issues, not parameter tweaks. They cause silent task failure even when all steps
report `success: true`.

Read `CLAUDE.md` fully before touching any file. 858 tests pass at `log-fixes-complete`.

**Do not change the architecture. All fixes are surgical edits within existing files.**
**Do not break the 858 existing tests. Add new tests only.**
**After each batch: `pnpm build && pnpm test`**

---

## Root Causes Found in Log (Post-Sprint-1)

The first sprint's fixes were in place conceptually but the log predates their deployment.
These 6 issues would persist even after sprint 1:

1. **content_writer cannot modify existing files** — step 7 prompt says "Modify the existing
   game.js content" but content_writer is stateless. It generates from scratch with zero
   knowledge of what step 5 produced. The `dependsOn` wiring gives execution ordering but
   does NOT inject prior step output into the content_writer prompt.

2. **`plain` format system prompt says "just prose"** — content_writer's `plain` format prompt
   says "No headers, no bullets, just prose" but is used for JavaScript and CSS generation.
   The model is told to write prose when it should write code.

3. **Duplicate intake transparency events** — intake event at `[00:11:06.573]` fires twice
   with identical payload. Two code paths both emit the same event.

4. **Planner generates cross-file references without shared context** — HTML has
   `id="gameCanvas"` but game.js uses `document.createElement('canvas')` because the
   content_writer steps have no shared element/variable reference. When the single-file HTML
   rule (FIX 10 from sprint 1) cannot apply (e.g. multi-file projects), cross-file coherence
   breaks.

5. **Decomposition returns stringified JSON inside JSON array** — Qwen emits
   `{"units": ["{\"route\":\"agentic\",...}"]}` — a string where an object should be.
   The parser handles it via heuristic repair, but this is fragile and wastes a repair cycle.

6. **Session cache stores and serves terminal PLAN.EX entries** — sprint 1's
   `filterTerminalPlanEx` filters them out of unit-search results, but the session cache
   itself stores completed PLAN.EX entries on write and serves them on hit, wasting a cache
   slot and requiring downstream filtering every time.

---

## Files You Will Touch

```
core/skills/tools/content_writer.ts     ← FIX 1: context input, FIX 2: code format
core/planner.ts                         ← FIX 1: planner prompt for context injection
core/agent.ts                           ← FIX 3: deduplicate intake emit
core/decomposition.ts                   ← FIX 5: stringified unit normalization
core/memory/session-cache.ts            ← FIX 6: terminal PLAN.EX gate on store
core/transparency.ts                    ← FIX 3: if intake emit lives here
tests/log2-fixes/fixes.test.ts          ← NEW: your tests
```

**Do NOT touch:**
- `core/router.ts` (routing logic is not the problem)
- `core/query-loop.ts` (already fixed in prior sprints)
- `core/executor.ts` (sprint 1 fixes are sufficient)
- `core/structured.ts` (extraction logic is fine)
- Any test file outside `tests/log2-fixes/`
- `CLAUDE.md` (update it at the very end, after all tests pass)

---

## Batch 1 — P0: content_writer Can't Modify Files (Task-Breaking)

### FIX 1 — Add `context` Input to content_writer + Planner Wiring

**Problem:** The planner generates multi-step sequences like:
```
step5: content_writer → generate game.js            storeResultAs: "initial_js"
step6: file_writer   → write game.js
step7: content_writer → "Modify the existing game.js"  dependsOn: [step6]
step8: file_writer   → write game.js (overwrite)
```

Step 7 depends on step 6 for ordering, but the content_writer prompt contains no reference to
`{{initial_js}}`. The content_writer skill has no `context` input parameter. So step 7 generates
from scratch, producing a completely different (and truncated) file.

This is the #1 reason multi-step file creation tasks silently produce broken output.

**File:** `core/skills/tools/content_writer.ts`

**What to do — Part A (skill side):**

Find the `inputSchema` for content_writer. Add an optional `context` field:

```typescript
// In the inputSchema object:
context: {
  type: 'string',
  description: 'Existing content to modify or extend. When provided, the prompt should describe what changes to make to this content.',
}
```

Find where the content_writer builds its LLM messages array. When `input.context` is provided
and non-empty, prepend the context as a user message before the main prompt:

```typescript
const messages: ChatMessage[] = [];

if (input.context && input.context.trim().length > 0) {
  messages.push({
    role: 'user',
    content: `Here is the existing content to modify:\n\n${input.context}`,
  });
  messages.push({
    role: 'assistant',
    content: 'I have the existing content. What changes should I make?',
  });
}

messages.push({
  role: 'user',
  content: input.prompt,
});
```

When `context` is provided, adjust the system prompt to say "modify" not "generate":

```typescript
const systemPrompt = input.context
  ? `You are a content modification assistant. You will receive existing content and instructions for changes. Output ONLY the complete modified content. Do not include explanations, diffs, or commentary. Output the full updated file.`
  : existingSystemPrompt; // keep current behavior when no context
```

**Important constraints:**
- `context` is optional. When absent, content_writer behaves exactly as before.
- The output must be the COMPLETE modified file, not a diff or patch.
- The `context` value will come from `{{stepN_result}}` template resolution — the executor
  already handles this for other input fields.

**File:** `core/planner.ts`

**What to do — Part B (planner prompt side):**

Find the planner system prompt where skills are described. Locate the content_writer schema
description. Add this rule block after the existing content_writer description:

```
CONTENT MODIFICATION RULES:
When a plan needs to modify content that was generated by an earlier step:
- The modifying content_writer step MUST include "context": "{{earlier_step_result}}" in its input
- The "prompt" field describes WHAT TO CHANGE, not the full content to generate
- CORRECT pattern:
  step5: content_writer { prompt: "Generate a game.js with...", format: "plain" }
         storeResultAs: "initial_js"
  step7: content_writer { prompt: "Add keyboard input handling for left/right movement...",
                          context: "{{initial_js}}", format: "plain" }
         storeResultAs: "updated_js"
- WRONG pattern (generates from scratch, loses all prior work):
  step7: content_writer { prompt: "Modify the existing game.js to add keyboard input..." }
         ← no context field, content_writer has no idea what "existing" means
- If the content needs NO modification, skip the modification step entirely.
  Do NOT generate content only to overwrite it unchanged.
```

Also add `context` to the content_writer schema line in the planner prompt:

```
content_writer: Generate long-form text or code from instructions. Use this before file_writer when output content is large.
Schema: {"action":"content_writer","input":{"prompt":"<string>"}}
Optional fields: format, style, maxTokens, context
```

And add to the correct examples block:

```
- content_writer (modify existing): { "prompt": "Add error handling to the fetch calls", "context": "{{step3_result}}", "format": "plain", "maxTokens": 2000 }
```

---

### FIX 2 — Add `code` Format to content_writer

**Problem:** The `plain` format system prompt says:

> "Output ONLY plain text. No markdown. No HTML. No preamble. No headers, no bullets, just prose."

This is actively harmful for code generation. "Just prose" tells the model NOT to write
structured code. CSS, JavaScript, TypeScript, Python — none of these are prose.

The planner uses `format: "plain"` for all code generation because there is no `code` format.

**File:** `core/skills/tools/content_writer.ts`

**What to do:**

Find where format-specific system prompts are defined. There will be a map or switch for
`html`, `markdown`, and `plain`. Add a `code` format:

```typescript
// Add to the format system prompt map:
code: `You are a code generation assistant. Output ONLY source code. No markdown fences. No backticks. No explanations before or after the code. No comments unless they directly aid comprehension. Start with the first line of code. End with the last line of code.`,
```

Find the `FORMAT_FLOORS` minimum output length map. Add:

```typescript
code: 80, // A real code file has at least a few statements
```

Find `MIN_OUTPUT_LENGTHS` if it is separate from `FORMAT_FLOORS`. Add the `code` entry there too.

Find the balanced-brace check (added in sprint 1 FIX 7). Currently it fires when `format: "plain"`
AND the prompt contains code keywords. Change it to ALWAYS fire when `format: "code"`, and keep
the heuristic detection for `format: "plain"`:

```typescript
const isCodeFormat = format === 'code';
const looksLikeCode = isCodeFormat || (
  format === 'plain' &&
  /\b(css|javascript|typescript|python|function|class|const|let|var)\b/i.test(input.prompt)
);

if (looksLikeCode && hasUnbalancedBraces(output)) {
  return {
    success: false,
    output: '',
    error: `content_writer output has unbalanced braces — likely truncated mid-block.`,
  };
}
```

**File:** `core/planner.ts`

Update the planner prompt's content_writer examples to prefer `code` format for code generation:

```
- content_writer (code): { "prompt": "Write a JavaScript module that...", "format": "code", "maxTokens": 2000 }
- content_writer (html page): { "prompt": "Write an HTML page...", "format": "html", "maxTokens": 2800 }
- content_writer (markdown report): { "prompt": "Write a status report...", "format": "markdown", "maxTokens": 1500 }
- content_writer (plain text): { "prompt": "Write a plain-text email...", "format": "plain", "maxTokens": 500 }
IMPORTANT: content_writer MUST always include "format" field. Use "code" for JavaScript, CSS, TypeScript, Python, or any programming language. Use "html" for web pages. Use "markdown" for reports/docs. Use "plain" for prose text only.
```

**Update `resolveMaxTokens`** — if a `code` format entry is needed in the floor map there,
set it to at least `4000` (code files tend to be substantial):

```typescript
FORMAT_FLOORS: Record<ContentFormat, number> = {
  html: 6000,
  markdown: 4000,
  plain: 4000,
  code: 4000,
};
```

Run `pnpm build && pnpm test` after Batch 1.

---

## Batch 2 — P1: Noise Reduction (Duplicate Events, Cache Hygiene)

### FIX 3 — Deduplicate Intake Transparency Event

**Problem:** The intake event fires twice with identical payload at the same timestamp. This
creates noise in the transparency panel and doubles the log size for intake entries.

The likely cause: the intake classifier result is being emitted from two code paths — once
from the intake function itself and once from the caller (agent.ts or processMessage).

**Files:** `core/agent.ts`, and wherever `emit('intake', ...)` is called.

**What to do:**

Search the entire codebase for `emit('intake'` or `emit("intake"`. You will find two call sites.
Remove the duplicate. Keep the one that is closer to where the intake result is actually produced
(inside the intake function), not the one in the caller.

If both are in the same file at different points in the flow, keep the first one (the earlier
emit is the authoritative one) and remove the second.

Verify by grepping:
```bash
grep -rn "emit.*intake" core/
```

There should be exactly ONE `emit('intake', ...)` call after this fix.

---

### FIX 4 — (Deferred — No Code Change)

Cross-file reference coherence (the HTML `id="gameCanvas"` vs JS `createElement` mismatch)
is structurally solved by FIX 10 from sprint 1 (single-file HTML rule) for browser games.
For multi-file projects, this will require a shared-context registry in the planner — that
is a Phase 18+ feature, not a surgical fix.

**No code change. Log this as a known limitation in CLAUDE.md at the end.**

Add to CLAUDE.md under a new section:

```markdown
## Known Limitations (Tracked)

### Multi-file cross-reference coherence
When the planner generates multiple content_writer steps that produce separate files (e.g.
HTML + JS + CSS), element IDs, class names, and variable names are not shared between steps.
Each content_writer call is stateless. Mitigated by the single-file HTML rule for browser
deliverables. Full fix requires a shared-context registry in the planner — deferred to a
future phase.
```

---

### FIX 5 — Normalize Stringified Units in Decomposition Parser

**Problem:** Qwen sometimes emits decomposition results as stringified JSON inside the array:
```json
{"units": ["{\"route\": \"agentic\", \"content\": \"Create a...\"}"]}
```

The parser currently handles this via heuristic repair, but:
- It increments the repair counter
- It emits a `decomposition_repair` transparency event (noise)
- If the repair counter hits 3+, it logs a warning about frequent repairs

A simple normalization pass before validation would catch this silently and avoid the repair
path entirely.

**File:** `core/decomposition.ts`

**What to do:**

Find where the decomposition response is parsed — after `extractFirstJsonObject` and before
the units are validated/mapped. Add a normalization pass:

```typescript
// After parsing the top-level JSON object but before validating units:
if (parsed.units && Array.isArray(parsed.units)) {
  parsed.units = parsed.units.map((unit: unknown) => {
    if (typeof unit === 'string') {
      try {
        return JSON.parse(unit);
      } catch {
        return unit; // leave as-is, let validation handle it
      }
    }
    return unit;
  });
}
```

This must run BEFORE the Zod/schema validation and BEFORE the heuristic repair check. It is a
pre-processing normalization, not a repair.

**Do NOT emit a transparency event for this normalization** — it is expected behavior from
Qwen's structured output, not a repair. If you want observability, use a `console.debug`:

```typescript
console.debug(`[decomposition] normalized ${stringifiedCount} stringified unit(s)`);
```

---

### FIX 6 — Session Cache: Don't Store Terminal PLAN.EX Entries

**Problem:** The session cache stores `PLAN.EX-000001` with `status: "complete"` on session
warm-up. Sprint 1's `filterTerminalPlanEx` removes it from unit-search results downstream,
but the cache still:
- Wastes a slot storing a terminal entry
- Returns it on cache hit (requiring the filter to clean it up every time)
- Creates misleading transparency events (`session_cache_hit` for a dead plan)

The fix is simple: don't store terminal PLAN.EX entries in the first place.

**File:** `core/memory/session-cache.ts` (or wherever `session_cache_store` is emitted)

**What to do:**

Find the function that stores entries in the session cache. It will look something like:

```typescript
function storeInSessionCache(entry: IndexEntry) {
  // or: sessionCache.set(entry.code, entry);
```

Add a gate at the top:

```typescript
// Never cache terminal PLAN.EX entries — they cannot be resumed and should not
// appear in context. Sprint 1's filterTerminalPlanEx handles the read side,
// but we should not store them at all.
if (
  entry.nb === 'PLAN' &&
  entry.type === 'EX' &&
  (entry.status === 'complete' || entry.status === 'failed')
) {
  console.debug(`[session-cache] skipping terminal PLAN.EX: ${entry.code} (${entry.status})`);
  return; // do not store
}
```

Also find the session cache warm-up/load path (where entries are loaded from SQLite or disk
into the cache at session start). Apply the same filter there:

```typescript
// During warm-up, skip terminal PLAN.EX entries
const entries = loadEntriesForCache().filter(e => {
  if (e.nb === 'PLAN' && e.type === 'EX' && (e.status === 'complete' || e.status === 'failed')) {
    return false;
  }
  return true;
});
```

Emit a transparency event on skip so you can verify it's working:

```typescript
emit('session_cache_skip', {
  code: entry.code,
  reason: 'terminal_plan_ex',
  status: entry.status,
});
```

Run `pnpm build && pnpm test` after Batch 2.

---

## Tests

All tests go in `tests/log2-fixes/fixes.test.ts`.

### FIX 1 Tests — content_writer context input

```
1. content_writer with context input includes context in LLM messages
   - Call content_writer with { prompt: "Add error handling", context: "const x = 1;", format: "code" }
   - Assert LLM messages array contains a message with "existing content" and "const x = 1;"
   - Assert system prompt contains "modification" (not "generation")

2. content_writer without context behaves as before
   - Call content_writer with { prompt: "Write a hello world", format: "code" }
   - Assert LLM messages do NOT contain "existing content"
   - Assert system prompt matches existing generation prompt

3. content_writer context input appears in skill inputSchema
   - Import content_writer skill definition
   - Assert inputSchema.properties has "context" key
   - Assert context is optional (not in required array)
```

### FIX 2 Tests — code format

```
4. content_writer accepts format "code"
   - Call content_writer with { prompt: "Write a JS function", format: "code" }
   - Assert no error about invalid format

5. code format system prompt does not say "prose"
   - Extract system prompt for format "code"
   - Assert it does NOT contain "prose"
   - Assert it contains "source code"

6. code format has balanced-brace check enabled
   - Mock LLM to return "function foo() {"  (unbalanced)
   - Call content_writer with format "code"
   - Assert result.success === false
   - Assert error message mentions "unbalanced braces"

7. code format has minimum output length of 80
   - Mock LLM to return "x=1" (3 chars, below floor)
   - Call content_writer with format "code"
   - Assert result.success === false
   - Assert error message mentions "too short"

8. FORMAT_FLOORS includes code entry >= 4000
   - Import FORMAT_FLOORS (or resolveMaxTokens)
   - Assert code floor is at least 4000
```

### FIX 3 Tests — duplicate intake event

```
9. intake event is emitted exactly once per message
   - Set up a transparency event listener/spy
   - Process a test message through the intake path
   - Assert 'intake' event count === 1
```

### FIX 5 Tests — decomposition stringified unit normalization

```
10. stringified unit in array is normalized to object
    - Feed decomposition parser: { units: ['{"route":"agentic","content":"test"}'] }
    - Assert output unit has route === "agentic" (object, not string)
    - Assert decomposition repair counter was NOT incremented

11. already-object units pass through unchanged
    - Feed decomposition parser: { units: [{ route: "agentic", content: "test" }] }
    - Assert output unit has route === "agentic"

12. mixed stringified and object units are both handled
    - Feed: { units: ['{"route":"agentic","content":"a"}', { route: "query", content: "b" }] }
    - Assert both units are objects in output
```

### FIX 6 Tests — session cache terminal PLAN.EX gate

```
13. terminal PLAN.EX is not stored in session cache
    - Call storeInSessionCache with { code: "PLAN.EX-000001", nb: "PLAN", type: "EX", status: "complete" }
    - Assert cache does NOT contain "PLAN.EX-000001"

14. active PLAN.EX IS stored in session cache
    - Call storeInSessionCache with { code: "PLAN.EX-000002", nb: "PLAN", type: "EX", status: "active" }
    - Assert cache DOES contain "PLAN.EX-000002"

15. failed PLAN.EX is not stored in session cache
    - Call storeInSessionCache with { code: "PLAN.EX-000003", nb: "PLAN", type: "EX", status: "failed" }
    - Assert cache does NOT contain "PLAN.EX-000003"

16. non-PLAN entries are always stored regardless of status
    - Call storeInSessionCache with { code: "WHAT.PJ-000001", nb: "WHAT", type: "PJ", status: "complete" }
    - Assert cache DOES contain "WHAT.PJ-000001"
```

---

## CLAUDE.md Update

After all tests pass, append this section to CLAUDE.md:

```markdown
---

## Log Analysis Fix Sprint #2 (COMPLETE)

6 fixes derived from second transparency log analysis. Addresses structural gaps not covered
by sprint 1. [N]/[N] tests pass. Build clean. Tag: `log2-fixes-complete`.

### FIX 1 — content_writer `context` input for file modification (`core/skills/tools/content_writer.ts`, `core/planner.ts`)

- New optional `context` input parameter on content_writer skill
- When provided, prepends existing content into LLM messages and switches system prompt to modification mode
- Planner prompt updated with CONTENT MODIFICATION RULES block and correct/wrong pattern examples
- Enables multi-step plans where step N modifies output of step N-2 without losing prior work

### FIX 2 — `code` format for content_writer (`core/skills/tools/content_writer.ts`, `core/planner.ts`)

- New `code` format with system prompt: "Output ONLY source code"
- `FORMAT_FLOORS.code = 4000` tokens; `MIN_OUTPUT_LENGTHS.code = 80` chars
- Balanced-brace check always fires for `code` format
- Planner prompt updated: `code` preferred for JS/CSS/TS/Python; `plain` reserved for prose

### FIX 3 — Deduplicate intake transparency event (`core/agent.ts`)

- Removed duplicate `emit('intake', ...)` call — exactly one emit per intake classification

### FIX 4 — Multi-file cross-reference coherence (DEFERRED)

- Logged as known limitation in CLAUDE.md
- Single-file HTML rule mitigates for browser deliverables
- Full fix (shared-context registry in planner) deferred to future phase

### FIX 5 — Decomposition stringified unit normalization (`core/decomposition.ts`)

- Pre-validation pass: `typeof unit === 'string'` → `JSON.parse(unit)` before schema validation
- Prevents false positive repair counter increments from Qwen's stringified-JSON-in-JSON output

### FIX 6 — Session cache terminal PLAN.EX gate (`core/memory/session-cache.ts`)

- `storeInSessionCache` rejects entries with `nb=PLAN, type=EX, status∈{complete,failed}`
- Session warm-up filters terminal PLAN.EX entries before cache population
- Emits `session_cache_skip` transparency event on rejection

### New Transparency Events

`session_cache_skip`

### Known Limitations (Tracked)

Multi-file cross-reference coherence — element IDs, class names, and variable names are not
shared between independent content_writer steps. Mitigated by single-file HTML rule. Full fix
deferred.

### Test Results

- [N]/[N] tests pass ([16] new in `tests/log2-fixes/fixes.test.ts`)
- Build: zero TypeScript errors
- Tag: `log2-fixes-complete`
```

Replace `[N]` with actual test counts after running.

---

## Execution Checklist

```
[ ] Read CLAUDE.md fully
[ ] pnpm build && pnpm test   (858/858 baseline)
[ ] Batch 1: FIX 1 (context input) + FIX 2 (code format)
[ ] pnpm build && pnpm test
[ ] Batch 2: FIX 3 (dedup intake) + FIX 5 (decomp normalization) + FIX 6 (cache gate)
[ ] pnpm build && pnpm test
[ ] Write tests/log2-fixes/fixes.test.ts (16 tests)
[ ] pnpm build && pnpm test   (all pass)
[ ] pnpm stress:critical       (all pass)
[ ] Update CLAUDE.md with sprint summary
[ ] git add -A && git commit -m "log2-fixes: content_writer context+code format, intake dedup, decomp normalization, cache gate"
[ ] git tag log2-fixes-complete
```
