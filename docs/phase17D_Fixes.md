# Zaraban — Log Analysis Fix Sprint #2 (Revised)
### For: Claude Code (single session)
### Tag on completion: `log2-fixes-complete`

---

## Context

This prompt is derived from TWO transparency logs (2026-04-05 00:10 and 2026-04-05 01:02) plus
an independent Gemini analysis. The logs record the same task class (Street-of-Rage HTML game).
The first log-fixes sprint (`log-fixes-complete`, 858/858 tests) fixed token budgets, grounded
verification, reactive revision, post-flight merging, content_writer minimum lengths, HOW.PR
gating, working memory wiring, and the single-file HTML planner rule.

**This sprint addresses 8 remaining gaps.** One is a showstopper (fake execution via
conversational hallucination). The rest are structural issues that cause silent failure.

Read `CLAUDE.md` fully before touching any file. 858 tests pass at `log-fixes-complete`.

**Do not change the overall architecture. All fixes are surgical edits within existing files.**
**Do not break the 858 existing tests. Add new tests only.**
**After each batch: `pnpm build && pnpm test`**

---

## Root Causes Found in Logs (Post-Sprint-1)

### SHOWSTOPPER — Plan Confirmation Hallucination

The agent generated a plan with `needsConfirmation: true`, showed it to the user, and the user
replied "Confirmed execute the plan." The system then:

1. Ran the confirmation message through intake → decomposition → routing as if it were new
2. Decomposition returned garbage JSON: `{"units": [2], "units": [1]}`
3. Heuristic repair classified it as `[conversational]`
4. The conversational LLM read the chat history, saw a pending plan, and **fabricated** a
   completion response: *"I have created the game files and saved them to your workspace"*
5. **Zero skills were fired. Zero files were created. The agent lied to the user.**

There is no state machine tracking that a plan is pending confirmation. The pending plan is
not persisted anywhere. When the next message arrives, the system has completely forgotten
that it asked for confirmation.

### Other Root Causes

1. **Intake still truncating** — even after sprint 1's token raise, intake truncates at
   ~1650-1770ms. The second intake (for "Confirmed") produced only `"The"` before cutoff.

2. **Decomposition returns total garbage** — not just stringified-JSON-in-JSON (log 1), but
   bare strings (`"route"`) and bare numbers (`[2]`, `[1]`) with duplicate keys. The heuristic
   repair fires but misclassifies the intent.

3. **content_writer cannot modify existing files** — step 7 says "Modify the existing game.js"
   but content_writer is stateless.

4. **`plain` format system prompt says "just prose"** — used for JavaScript and CSS generation.

5. **Duplicate intake transparency events** — fires twice with identical payload.

6. **Session cache stores and serves terminal PLAN.EX** — both logs show completed PLAN.EX
   entries served from cache and polluting memory search results.

7. **Decomposition never retries on garbage output** — returns a heuristic fallback
   immediately instead of retrying once with a stricter prompt.

---

## Files You Will Touch

```
core/agent.ts                           ← FIX 0: plan-pending state, FIX 3: dedup intake,
                                           FIX 7: decomposition retry
core/executor.ts                        ← FIX 0: plan persistence on confirmation-required
core/decomposition.ts                   ← FIX 5: stringified unit normalization,
                                           FIX 7: retry on garbage
core/skills/tools/content_writer.ts     ← FIX 1: context input, FIX 2: code format
core/planner.ts                         ← FIX 1: planner prompt for context injection,
                                           FIX 2: code format examples
core/memory/session-cache.ts            ← FIX 6: terminal PLAN.EX gate on store
tests/log2-fixes/fixes.test.ts          ← NEW: your tests
```

**Do NOT touch:**
- `core/router.ts` (routing logic is not the problem)
- `core/query-loop.ts` (already fixed in prior sprints)
- `core/structured.ts` (extraction logic is fine)
- Any test file outside `tests/log2-fixes/`
- `CLAUDE.md` (update at the very end)

---

## Batch 0 — P-CRITICAL: Plan Confirmation State Machine

This batch must be completed first. It fixes the fake-execution hallucination.

### FIX 0 — Stateful Plan Confirmation Interceptor

**Problem:** When a plan has `needsConfirmation: true`, the system shows the plan summary
and asks for confirmation. But when the user responds, the response goes through the full
intake → decomposition → routing pipeline. Because "Confirmed execute the plan" doesn't
match any agentic pattern, it gets classified as conversational. The conversational LLM then
reads the chat history, sees that work was pending, and **hallucinates having done the work**.

The user sees "I have created the game files" when zero files were created.

There is no state tracking that a plan is pending. The pending plan is not persisted.

**Files:** `core/agent.ts`, `core/executor.ts` (or wherever plans are generated and
confirmation is requested)

**What to do — Part A: Persist the pending plan**

Find where `needsConfirmation: true` triggers the confirmation prompt to the user. At that
point, store the plan in a module-level or session-scoped variable:

```typescript
// In core/agent.ts or wherever processMessage lives:

let pendingConfirmationPlan: Plan | null = null;

// After planner generates a plan with needsConfirmation: true:
if (plan.needsConfirmation) {
  pendingConfirmationPlan = plan;
  // Show confirmation prompt to user...
  return confirmationResponse;
}
```

**What to do — Part B: Intercept the next message**

At the TOP of `processMessage` (before intake, before decomposition, before everything),
add a pending-plan check:

```typescript
async function processMessage(userMessage: string, ...): Promise<string> {
  // === PLAN CONFIRMATION INTERCEPT ===
  // Must be the FIRST check, before intake/decomposition
  if (pendingConfirmationPlan) {
    const plan = pendingConfirmationPlan;

    // Check if user confirms or rejects
    const isConfirmation = isUserConfirmation(userMessage);
    const isRejection = isUserRejection(userMessage);

    if (isConfirmation) {
      pendingConfirmationPlan = null; // Clear state
      emit('plan_confirmed', { goal: plan.goal, stepCount: plan.steps.length });
      // Execute the plan — call the same executor path used for non-confirmation plans
      const result = await executePlan(plan, ...);
      return result;
    } else if (isRejection) {
      pendingConfirmationPlan = null; // Clear state
      emit('plan_rejected', { goal: plan.goal });
      return "Plan cancelled. What would you like me to do instead?";
    } else {
      // Ambiguous response — ask again, do NOT fall through to normal routing
      return "I have a plan ready to execute. Please confirm with 'yes' or cancel with 'no'.\n\n"
        + formatPlanSummary(plan);
    }
  }

  // === Normal routing continues below ===
  // intake, decomposition, etc.
}
```

**What to do — Part C: Implement confirmation/rejection detection**

Create two simple, deterministic functions. Do NOT use an LLM for this — it's a regex check:

```typescript
function isUserConfirmation(message: string): boolean {
  const normalized = message.toLowerCase().trim();
  const confirmPatterns = [
    /^(yes|yep|yeah|yup|sure|ok|okay|go|do it|proceed|confirm|confirmed|execute|run it|go ahead|let's go|let's do it|approved|approve)$/,
    /\b(confirm|execute|proceed|go ahead|approved?)\b.*\b(plan|it)\b/,
    /\b(yes|sure|ok)\b.*\b(execute|run|do|go)\b/,
  ];
  return confirmPatterns.some(p => p.test(normalized));
}

function isUserRejection(message: string): boolean {
  const normalized = message.toLowerCase().trim();
  const rejectPatterns = [
    /^(no|nope|nah|cancel|stop|abort|don't|nevermind|never mind)$/,
    /\b(cancel|abort|stop|don't)\b.*\b(plan|it)\b/,
    /\b(no|nope)\b/,
  ];
  return rejectPatterns.some(p => p.test(normalized));
}
```

**CRITICAL:** The `pendingConfirmationPlan` variable must survive across message turns within
the same session. If your agent processes messages in separate function calls that don't share
module state, you need to persist this to the session store (e.g., a JSON file in the workspace
or a session-level Map).

**What to do — Part D: Handle session restart edge case**

If the user closes the UI and reopens, the pending plan should NOT persist across sessions.
On session start, initialize `pendingConfirmationPlan = null`. If the plan was important,
the user can re-request it.

**Emit transparency events:**

```typescript
emit('plan_confirmation_pending', { goal: plan.goal, stepCount: plan.steps.length });
emit('plan_confirmed', { goal: plan.goal });
emit('plan_rejected', { goal: plan.goal });
emit('plan_confirmation_ambiguous', { userMessage: message });
```

---

## Batch 1 — P0: content_writer Structural Fixes

Run `pnpm build && pnpm test` after Batch 0 before starting Batch 1.

### FIX 1 — Add `context` Input to content_writer + Planner Wiring

**Problem:** The planner generates multi-step sequences where step N says "Modify the existing
file" but content_writer is stateless — it has no access to what earlier steps produced.

**File:** `core/skills/tools/content_writer.ts`

**What to do — Part A (skill side):**

Add an optional `context` field to the inputSchema:

```typescript
context: {
  type: 'string',
  description: 'Existing content to modify or extend. When provided, the prompt should describe what changes to make to this content.',
}
```

When `input.context` is provided and non-empty, prepend it into the LLM messages:

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

messages.push({ role: 'user', content: input.prompt });
```

When `context` is provided, use a modification-specific system prompt:

```typescript
const systemPrompt = input.context
  ? `You are a content modification assistant. You will receive existing content and instructions for changes. Output ONLY the complete modified content. Do not include explanations, diffs, or commentary. Output the full updated file.`
  : existingSystemPrompt;
```

**Important:** `context` is optional. Without it, content_writer behaves exactly as before.

**File:** `core/planner.ts`

**What to do — Part B (planner prompt):**

Add to content_writer schema line: `Optional fields: format, style, maxTokens, context`

Add this rule block after the content_writer description:

```
CONTENT MODIFICATION RULES:
When a plan needs to modify content generated by an earlier step:
- The modifying content_writer step MUST include "context": "{{earlier_step_result}}" in input
- The "prompt" field describes WHAT TO CHANGE, not the full content
- CORRECT: step7: content_writer { "prompt": "Add keyboard input handling...",
            "context": "{{initial_js}}", "format": "code" }
- WRONG:   step7: content_writer { "prompt": "Modify the existing game.js to add..." }
           ← no context field, content_writer generates from scratch
```

Add example: `- content_writer (modify existing): { "prompt": "Add error handling to the fetch calls", "context": "{{step3_result}}", "format": "code", "maxTokens": 2000 }`

---

### FIX 2 — Add `code` Format to content_writer

**Problem:** `plain` format says "just prose" but is used for JavaScript and CSS generation.

**File:** `core/skills/tools/content_writer.ts`

Add `code` format to the system prompt map:

```typescript
code: `You are a code generation assistant. Output ONLY source code. No markdown fences. No backticks. No explanations before or after the code. No comments unless they directly aid comprehension. Start with the first line of code. End with the last line of code.`,
```

Add to `FORMAT_FLOORS`: `code: 4000`
Add to `MIN_OUTPUT_LENGTHS`: `code: 80`

Make balanced-brace check always fire for `format: "code"`:

```typescript
const isCodeFormat = format === 'code';
const looksLikeCode = isCodeFormat || (
  format === 'plain' &&
  /\b(css|javascript|typescript|python|function|class|const|let|var)\b/i.test(input.prompt)
);
```

**File:** `core/planner.ts`

Update format guidance:
```
Use "code" for JavaScript, CSS, TypeScript, Python, or any programming language.
Use "html" for web pages. Use "markdown" for reports/docs. Use "plain" for prose text only.
```

Run `pnpm build && pnpm test` after Batch 1.

---

## Batch 2 — P1: Noise Reduction + Reliability

### FIX 3 — Deduplicate Intake Transparency Event

**Problem:** Intake event fires twice with identical payload at same timestamp. Both logs
confirm this — the duplicate is consistent.

**What to do:** `grep -rn "emit.*intake" core/` — find two call sites, remove the duplicate.
Keep the one closest to where the intake result is produced.

---

### FIX 4 — (Deferred — No Code Change)

Multi-file cross-reference coherence logged as known limitation in CLAUDE.md.

---

### FIX 5 — Normalize Stringified Units in Decomposition Parser

**Problem:** Qwen emits `{"units": ["route"]}` or `{"units": [2]}` — not just stringified
objects but also bare primitives. The current normalization (if any) only handles stringified
JSON objects.

**File:** `core/decomposition.ts`

Add normalization BEFORE schema validation:

```typescript
if (parsed.units && Array.isArray(parsed.units)) {
  parsed.units = parsed.units.map((unit: unknown) => {
    if (typeof unit === 'string') {
      try {
        return JSON.parse(unit);
      } catch {
        // Not valid JSON string — drop it, let validation handle
        return null;
      }
    }
    if (typeof unit === 'number' || typeof unit === 'boolean') {
      // Bare primitive — garbage, drop it
      return null;
    }
    return unit;
  }).filter((u): u is NonNullable<typeof u> => u !== null);
}
```

Note: this handles the broader case from log 2 where units are bare numbers, not just
stringified objects.

---

### FIX 6 — Session Cache: Don't Store Terminal PLAN.EX Entries

**Problem:** Both logs show completed PLAN.EX entries served from session cache. Sprint 1's
`filterTerminalPlanEx` is either not deployed or only filters on the read path of unit-search,
not on the cache store/warm-up path.

**File:** `core/memory/session-cache.ts`

Gate the store function:

```typescript
if (
  entry.nb === 'PLAN' && entry.type === 'EX' &&
  (entry.status === 'complete' || entry.status === 'failed')
) {
  console.debug(`[session-cache] skipping terminal PLAN.EX: ${entry.code}`);
  return;
}
```

Apply the same filter during warm-up.

Emit: `session_cache_skip` transparency event.

---

### FIX 7 — Decomposition Retry on Garbage Output

**Problem:** When decomposition returns total garbage (bare primitives, empty array after
normalization), the system falls back to heuristic repair immediately. A single retry with
an explicit few-shot example would likely produce valid output.

**File:** `core/decomposition.ts`

After normalization (FIX 5), if the units array is empty or all units failed validation,
retry ONCE with a stricter prompt that includes 2 few-shot examples:

```typescript
// After first attempt fails validation:
if (parsedUnits.length === 0 && retryCount === 0) {
  console.warn(`[decomposition] first attempt returned no valid units, retrying with examples`);
  emit('decomposition_retry', { reason: 'no_valid_units', attempt: 1 });

  const retryMessages = [
    { role: 'system', content: decompositionSystemPrompt },
    // Few-shot example 1
    { role: 'user', content: 'Save John\'s phone number and remind me to call him tomorrow' },
    { role: 'assistant', content: '{"units":[{"route":"agentic","content":"Save John\'s phone number"},{"route":"agentic","content":"remind me to call him tomorrow"}]}' },
    // Few-shot example 2
    { role: 'user', content: 'What is my todo list?' },
    { role: 'assistant', content: '{"units":[{"route":"query","content":"What is my todo list?"}]}' },
    // Actual user message
    { role: 'user', content: userMessage },
  ];

  const retryResponse = await callLLM(retryMessages, { schema: decompositionSchema });
  retryCount++;
  // Re-parse and validate...
}
```

Only retry once. If the retry also fails, fall back to heuristic repair as before.

Run `pnpm build && pnpm test` after Batch 2.

---

## Tests

All tests go in `tests/log2-fixes/fixes.test.ts`.

### FIX 0 Tests — Plan confirmation state machine

```
1. pendingConfirmationPlan is set when plan has needsConfirmation: true
   - Generate a plan with needsConfirmation: true
   - Assert pendingConfirmationPlan is not null

2. "yes" confirmation triggers plan execution, not conversational routing
   - Set pendingConfirmationPlan to a test plan
   - Call processMessage("yes")
   - Assert executor was called with the pending plan
   - Assert pendingConfirmationPlan is null after execution

3. "Confirmed execute the plan" triggers plan execution
   - Set pendingConfirmationPlan to a test plan
   - Call processMessage("Confirmed execute the plan")
   - Assert executor was called

4. "no" rejection clears pending plan
   - Set pendingConfirmationPlan to a test plan
   - Call processMessage("no")
   - Assert pendingConfirmationPlan is null
   - Assert executor was NOT called

5. Ambiguous response re-prompts without clearing plan
   - Set pendingConfirmationPlan to a test plan
   - Call processMessage("tell me more about it")
   - Assert pendingConfirmationPlan is still set
   - Assert response contains re-prompt text

6. isUserConfirmation matches expected patterns
   - Assert true for: "yes", "confirmed", "go ahead", "execute the plan", "sure do it"
   - Assert false for: "what is this", "tell me more", "maybe"

7. isUserRejection matches expected patterns
   - Assert true for: "no", "cancel", "don't do it", "abort"
   - Assert false for: "yes", "do it", "proceed"
```

### FIX 1 Tests — content_writer context input

```
8.  content_writer with context includes context in LLM messages
9.  content_writer without context behaves as before
10. content_writer context appears in skill inputSchema
```

### FIX 2 Tests — code format

```
11. content_writer accepts format "code" without error
12. code format system prompt contains "source code", not "prose"
13. code format with unbalanced braces returns success: false
14. code format with too-short output returns success: false
15. FORMAT_FLOORS includes code >= 4000
```

### FIX 3 Tests — duplicate intake event

```
16. intake event emitted exactly once per message
```

### FIX 5 Tests — decomposition normalization

```
17. bare number in units array is filtered out (not parsed as unit)
18. stringified JSON object in units array is normalized to object
19. already-object units pass through unchanged
20. mixed garbage and valid units: garbage filtered, valid preserved
```

### FIX 6 Tests — session cache terminal PLAN.EX gate

```
21. terminal PLAN.EX (complete) is not stored in session cache
22. active PLAN.EX IS stored in session cache
23. failed PLAN.EX is not stored in session cache
24. non-PLAN entries are always stored regardless of status
```

### FIX 7 Tests — decomposition retry

```
25. garbage decomposition triggers one retry with few-shot examples
26. successful retry returns valid units (no heuristic repair)
27. failed retry still falls back to heuristic repair
28. retry count never exceeds 1
```

---

## CLAUDE.md Update

After all tests pass, append to CLAUDE.md:

```markdown
---

## Log Analysis Fix Sprint #2 (COMPLETE)

8 fixes derived from two transparency log analyses plus independent Gemini review. Addresses
the "fake execution" hallucination bug and 7 structural gaps. [N]/[N] tests pass. Build clean.
Tag: `log2-fixes-complete`.

### FIX 0 — Plan Confirmation State Machine (`core/agent.ts`)

- `pendingConfirmationPlan` module-level variable stores plan when `needsConfirmation: true`
- Top-of-`processMessage` intercept: checks pending plan BEFORE intake/decomposition
- `isUserConfirmation()` / `isUserRejection()` — deterministic regex, no LLM
- Confirmation → execute plan immediately, clear state
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
- Warm-up applies same filter

### FIX 7 — Decomposition retry with few-shot examples (`core/decomposition.ts`)

- On garbage output (no valid units after normalization), retry once with 2 few-shot examples
- Single retry only; failed retry falls back to heuristic repair

### New Transparency Events

`plan_confirmation_pending`, `plan_confirmed`, `plan_rejected`,
`plan_confirmation_ambiguous`, `session_cache_skip`, `decomposition_retry`

### Known Limitations (Tracked)

Multi-file cross-reference coherence — element IDs and variable names not shared between
independent content_writer steps. Mitigated by single-file HTML rule. Full fix deferred.

### Test Results

- [N]/[N] tests pass ([28] new in `tests/log2-fixes/fixes.test.ts`)
- Build: zero TypeScript errors
- Tag: `log2-fixes-complete`
```

---

## Execution Checklist

```
[ ] Read CLAUDE.md fully
[ ] pnpm build && pnpm test   (858/858 baseline)
[ ] Batch 0: FIX 0 (plan confirmation state machine) — THE SHOWSTOPPER
[ ] pnpm build && pnpm test
[ ] Batch 1: FIX 1 (context input) + FIX 2 (code format)
[ ] pnpm build && pnpm test
[ ] Batch 2: FIX 3 + FIX 5 + FIX 6 + FIX 7
[ ] pnpm build && pnpm test
[ ] Write tests/log2-fixes/fixes.test.ts (28 tests)
[ ] pnpm build && pnpm test   (all pass)
[ ] pnpm stress:critical       (all pass)
[ ] Update CLAUDE.md
[ ] git add -A && git commit -m "log2-fixes: plan confirmation state machine, content_writer context+code, decomp retry+normalization, cache gate, intake dedup"
[ ] git tag log2-fixes-complete
```
