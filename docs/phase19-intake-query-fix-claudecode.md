# Zaraban — Intake Classifier + Query Memory Fix Sprint
### For: Claude Code (single session)
### Tag on completion: `phase-19-intake-query-fix`

---

## Context

This prompt is derived from a transparency log analysis (Claude + Gemini independent reads,
findings merged and cross-validated). The log captured a real agent run where the user asked
"tell me a list of all your contacts." The agent returned nothing. Two distinct failure chains
were identified and confirmed against the actual log data.

Read `CLAUDE.md` and `ARCHITECTURE.md` fully before touching any file.
**Do not change the architecture. All fixes are surgical edits within existing files.**
**Do not break existing tests. Add new tests only.**
**After each batch: `pnpm build && pnpm test`**

---

## What the Log Showed: The Two Failure Chains

### Chain A — Intake Classifier Truncation (Gemini finding, validated against log)

At `[10:13:19.838]` the intake LLM call consumed **13,296ms** and returned:
```
{ "stripped": "```json" }
```

The model generated ~300 tokens of `<|channel>thought` internal reasoning, exhausted its
output budget, and was **cut off immediately after the opening markdown fence** — before
writing a single byte of JSON. The intake system received nothing parseable and silently
defaulted all signals to `false` / `null`.

Crucially, the model's own thinking block concluded `query: true` — the correct answer —
but it never made it into the output. This is confirmed by the log entry:
```
"signals": {
  "querySignal": false,   ← wrong, because JSON never arrived
  ...
}
```

**Why 13 seconds?** Confirmed by Gemini's latency analysis: at ~25 tok/s on a 26B model,
300 tokens of internal thought = ~12 seconds before the model even starts JSON output.
The system prompt's "Questions to answer" section is prompting an essay, not a classifier.

**Additional Gemini finding (validated):** The model's thinking block contains a hallucinated
claim that the word "proceduure" is a typo in the system prompt. The system prompt spells it
correctly as `procedure`. The model is inventing errors and reasoning about them, wasting
cycles. This is a symptom of the over-verbose prompt and the thinking-tag pathology, not a
real prompt bug — **do not "fix" the prompt spelling, it is already correct.**

### Chain B — BM25 Vocabulary Miss on Query Path (Claude finding)

Even though the decomposer correctly routed `query` at `[10:13:26.723]`, the memory search
at `[10:13:26.724]` returned:
```
{ "strategy": "bm25", "confidence": 0, "entries": [] }
```

BM25 matched the raw query text "tell me a list of all your contacts" against memory entry
content. WHO notebook entries are stored as names, summaries, and role descriptions — none
of which contain the word "contacts." This is a vocabulary mismatch, not a missing entry.

The 5-step escalating lookup (ARCHITECTURE.md §8) defines Step 2 as "filter query by
nb/type/status/name" but it was never reached, because the system had no mechanism to
recognize "contacts" → `{ nb: 'WHO', type: 'CT' }` and skip straight to `queryEntries()`.

---

## Root Causes Summary

| # | Cause | Source |
|---|-------|--------|
| 1 | Intake system prompt triggers 300-token thinking block before JSON | Gemini + log |
| 2 | Intake `maxTokens` too low to survive thinking block + JSON output | Gemini + log |
| 3 | Intake JSON extracted with naive regex, `\`\`\`json` fence breaks parse | Gemini + log |
| 4 | No notebook vocabulary map → BM25 used on "list all X" queries | Claude + log |
| 5 | "List all X" queries never reach Step 2 (queryEntries) of escalation | Claude + log |

---

## Files You Will Touch

```
core/agent.ts                    ← FIX 1: intake prompt rewrite + maxTokens
core/memory/resolver.ts          ← FIX 2: notebook vocabulary fast-path
core/memory/unit-search.ts       ← FIX 2: list-intent detection before BM25
tests/phase19/intake-query.test.ts  ← NEW: your tests
```

**Do NOT touch:**
- `core/decomposition.ts` (decomposer worked correctly in this log)
- `core/router.ts`
- `core/query-loop.ts`
- `core/structured.ts` (`extractFirstJsonObject` already exists — import it)
- `core/llm.ts` (`stripThinkingTags` already exists — import it)
- Any test file outside `tests/phase19/`
- `CLAUDE.md`

---

## Batch 1 — P0: Fix the Intake Classifier

### FIX 1a — Rewrite the Intake System Prompt to Suppress Thinking

**Problem:** The current intake system prompt includes a "Questions to answer" preamble that
reads like a task list. On Gemma 4 (a reasoning model), this triggers a full internal
reasoning chain before JSON output. The thinking block alone consumes 10–13 seconds. The
JSON arrives too late and gets truncated.

**File:** `core/agent.ts`

Find the intake classifier LLM call and its system prompt. It will look something like:
```typescript
const intakeSystem = `You are a message intake classifier. Analyze the message and return ONLY a JSON object.
...
Questions to answer:
1. One-sentence summary: what is this message about?
...
`;
```

**Replace the system prompt with this leaner version:**

```
You are a message intake classifier. Analyze the user message and immediately output a single
JSON object. Do not explain. Do not reason. Output only the JSON.

Output shape:
{
  "summary": "one sentence describing what the message is about",
  "person": { "name": "...", "confidence": 0.0-1.0 } or null,
  "project": { "name": "...", "confidence": 0.0-1.0 } or null,
  "time": { "description": "..." } or null,
  "agentic": true or false,
  "procedure": true or false,
  "query": true or false
}

Rules:
- person: set if a specific named person is mentioned or clearly implied (confidence > 0.7 = certain)
- project: set if a specific project is referenced by name or pronoun (confidence > 0.7 = certain)
- time: set if a deadline, date, or scheduling element is present
- agentic: true if the message requests an action that requires planning or execution
- procedure: true if the message describes a method or workflow
- query: true if the message asks to retrieve or recall information

Output ONLY the JSON. No preamble. No markdown fences. No explanation.
```

Key changes:
- "Do not reason" + "Output only the JSON" at the top suppresses the thinking block on Gemma 4
- "Questions to answer" section removed — it was the trigger for the reasoning essay
- Instructions condensed to one-line rules — same coverage, far fewer tokens
- Explicit "No markdown fences" prevents the ` ```json ` truncation
- Word "procedure" is spelled correctly (it was correct before too — do not change it)

---

### FIX 1b — Raise maxTokens and Timeout on Intake Call

**Problem:** Even with a shorter system prompt, if `maxTokens` is below ~400 the model may
still truncate on edge cases. The intake JSON object is ~150 tokens; add headroom.

**File:** `core/agent.ts`

Find the intake LLM call parameters. Set:
```typescript
maxTokens: 400,   // intake JSON is ~150 tokens; 400 gives 2.5x headroom
timeout: 20000,   // 20 seconds; with suppressed thinking this should complete in <3s
```

If these are pulled from a config or default, override them explicitly at the call site.

---

### FIX 1c — Apply `extractFirstJsonObject` + `stripThinkingTags` to Intake Parsing

**Problem:** If the model still emits a ` ```json ` fence (or a stray `<think>` block
in a fallback scenario), the current naive regex parse will return `null` and silently
default all signals.

**File:** `core/agent.ts`

Find where the intake LLM response is parsed into signals. Replace any bare `JSON.parse()`
or `match(/\{[\s\S]*\}/)` with:

```typescript
import { extractFirstJsonObject } from '../structured.js';
import { stripThinkingTags } from '../llm.js';

// Inside intake parsing:
const clean = stripThinkingTags(rawIntakeResponse);
const block = extractFirstJsonObject(clean);
if (!block) {
  console.warn('[zaraban][intake] No JSON found in intake response. Defaulting all signals. Raw length:', rawIntakeResponse.length);
  // existing fallback logic continues here
  return defaultSignals;
}
const parsed = JSON.parse(block);
// validate with existing Zod schema...
```

The `extractFirstJsonObject` function uses bracket-depth counting and handles:
- ` ```json\n{...}\n``` ` fences
- Preamble text before the JSON object
- `<think>` blocks containing `{` characters

**Do not rewrite these functions.** They already exist in `core/structured.ts` and
`core/llm.ts`. Import and use them.

---

## Batch 2 — P1: Fix the Query Memory Miss

Run `pnpm build && pnpm test` after Batch 1 before starting Batch 2.

---

### FIX 2a — Add Notebook Vocabulary Map

**Problem:** When a user asks "list all my contacts" / "show me my projects" / "what are
my todos", the query contains no memory codes, no person signals, no project signals. The
system falls through to BM25, which matches the raw query text against entry content.
Entry content contains names, summaries, and roles — not the word "contacts." BM25 returns
zero results.

The fix is a vocabulary map that recognises listing-intent queries before BM25 runs.

**File:** `core/memory/unit-search.ts` (or `core/memory/resolver.ts` — check which one
orchestrates the 5-step escalation for query units)

Add this map near the top of the file:

```typescript
/**
 * Vocabulary map: user-facing terms → notebook query parameters.
 * Used to fast-path "list all X" queries before BM25.
 */
const NOTEBOOK_VOCABULARY: Record<string, { nb: string; type?: string }> = {
  // WHO notebook
  contacts:      { nb: 'WHO', type: 'CT' },
  contact:       { nb: 'WHO', type: 'CT' },
  people:        { nb: 'WHO' },
  person:        { nb: 'WHO' },
  organizations: { nb: 'WHO', type: 'ORG' },
  companies:     { nb: 'WHO', type: 'ORG' },
  // WHAT notebook
  projects:      { nb: 'WHAT', type: 'PJ' },
  project:       { nb: 'WHAT', type: 'PJ' },
  // NOW notebook
  todos:         { nb: 'NOW' },
  tasks:         { nb: 'NOW' },
  // HOW notebook
  procedures:    { nb: 'HOW', type: 'PR' },
  skills:        { nb: 'HOW', type: 'SK' },
  // WHEN notebook
  events:        { nb: 'WHEN', type: 'EV' },
  deadlines:     { nb: 'WHEN', type: 'EV' },
  reminders:     { nb: 'WHEN', type: 'EV' },
};

/**
 * Listing intent: query wants ALL entries of a type, not a specific one.
 * Detected by presence of these words + a vocabulary keyword.
 */
const LIST_INTENT_TOKENS = ['all', 'list', 'every', 'show', 'give me'];
```

---

### FIX 2b — List-Intent Fast-Path Before BM25

**Problem:** BM25 runs unconditionally on query units with no signals. It should be
the last resort, not the first attempt — as CLAUDE.md states: "Index first, fetch second,
search last."

**File:** `core/memory/unit-search.ts` (the function that runs memory search for a query unit)

Before the BM25 call, add a list-intent detection step:

```typescript
function detectListIntent(content: string): { nb: string; type?: string } | null {
  const lower = content.toLowerCase();

  // Must have a listing intent token
  const hasListIntent = LIST_INTENT_TOKENS.some(token => lower.includes(token));
  if (!hasListIntent) return null;

  // Must have a vocabulary match
  for (const [term, params] of Object.entries(NOTEBOOK_VOCABULARY)) {
    if (lower.includes(term)) {
      return params;
    }
  }
  return null;
}
```

In the memory search function for query units, insert this check BEFORE the BM25 path:

```typescript
// Step 2 fast-path: "list all X" queries → direct queryEntries, skip BM25
const listParams = detectListIntent(unit.content);
if (listParams) {
  const entries = db.queryEntries(listParams);   // adjust to your actual queryEntries signature
  if (entries.length > 0) {
    emit('unit_memory_search', {
      unit,
      result: {
        strategy: 'list_intent',
        confidence: 1,
        entries,
        unitId: unit.id,
      }
    });
    return { strategy: 'list_intent', confidence: 1, entries, unitId: unit.id };
  }
  // If queryEntries returns nothing (empty notebook), fall through to BM25 as normal
}
```

This directly maps to **Step 2 of the 5-step escalating lookup** defined in ARCHITECTURE.md §8:
"Filter query by nb/type/status/name." It was always supposed to handle this case — it just
had no vocabulary bridge to get there.

Adjust the `queryEntries` call to match whatever signature it actually has in your codebase.
If it's on a `MemoryDB` or `SQLiteDB` instance, look it up and use the correct method name.
Do not invent a new interface.

---

### FIX 2c — Emit `list_intent_detected` Transparency Event

Add a transparency event so the list-intent fast-path is visible in logs:

```typescript
emit('list_intent_detected', {
  unitContent: unit.content,
  matched: listParams,
  resultCount: entries.length,
});
```

This makes it easy to confirm the fast-path fired when reading future transparency logs.

---

## Tests to Write

Create `tests/phase19/intake-query.test.ts`.

### Test group: Intake prompt suppression (FIX 1a)

```typescript
// 1. Intake system prompt does NOT contain the phrase "Questions to answer"
// 2. Intake system prompt contains "Do not reason" or equivalent suppression instruction
// 3. Intake system prompt contains "No markdown fences" or equivalent
// 4. Intake maxTokens is >= 400
// 5. Intake timeout is >= 15000ms
```

### Test group: Intake JSON parsing resilience (FIX 1c)

```typescript
// 6. Intake parser extracts correct signals when response is bare JSON (happy path)
// 7. Intake parser extracts correct signals when response has ```json fence
// 8. Intake parser extracts correct signals when response has <think> block before JSON
// 9. Intake parser returns default signals + logs warning when no JSON found
// 10. Intake parser returns default signals + logs warning when JSON is truncated (no closing })
// 11. querySignal defaults to false (not true) on parse failure — safe default
```

### Test group: NOTEBOOK_VOCABULARY map (FIX 2a)

```typescript
// 12. "contacts" maps to { nb: 'WHO', type: 'CT' }
// 13. "people" maps to { nb: 'WHO' }
// 14. "projects" maps to { nb: 'WHAT', type: 'PJ' }
// 15. "todos" maps to { nb: 'NOW' }
// 16. "procedures" maps to { nb: 'HOW', type: 'PR' }
// 17. "events" maps to { nb: 'WHEN', type: 'EV' }
```

### Test group: List-intent detection (FIX 2b)

```typescript
// 18. detectListIntent("tell me a list of all your contacts") → { nb: 'WHO', type: 'CT' }
// 19. detectListIntent("show me all my projects") → { nb: 'WHAT', type: 'PJ' }
// 20. detectListIntent("what are my todos") → { nb: 'NOW' }
// 21. detectListIntent("every contact I have") → { nb: 'WHO', type: 'CT' }
// 22. detectListIntent("who is John?") → null (no list intent token)
// 23. detectListIntent("tell me about the Zaraban project") → null (specific, not list)
// 24. detectListIntent("list something random") → null (no vocabulary match)
```

### Test group: List-intent fast-path integration (FIX 2b + 2c)

```typescript
// 25. List-intent query bypasses BM25 entirely when entries found
// 26. List-intent query emits strategy: 'list_intent' in unit_memory_search event
// 27. List-intent query emits 'list_intent_detected' transparency event with matched params
// 28. List-intent query with empty notebook falls through to BM25 (no entries → continue)
// 29. Non-list query with no signals still uses BM25 (existing behavior unchanged)
// 30. List-intent result has confidence: 1 (not 0)
```

**Minimum: 30 tests. All must pass. No existing test regressions.**

---

## Completion Checklist

### Batch 1
- [ ] FIX 1a: Intake system prompt rewritten — no "Questions to answer" section, explicit
  "Do not reason / Output only JSON / No markdown fences" instructions
- [ ] FIX 1b: Intake `maxTokens` ≥ 400, `timeout` ≥ 15000ms set explicitly at call site
- [ ] FIX 1c: `extractFirstJsonObject` + `stripThinkingTags` used for intake response parsing
- [ ] FIX 1c: Warning logged when no JSON found, fallback fires explicitly (not silently)
- [ ] `pnpm build` clean, `pnpm test` passes (all existing tests)

### Batch 2
- [ ] FIX 2a: `NOTEBOOK_VOCABULARY` map defined with WHO/WHAT/NOW/HOW/WHEN entries
- [ ] FIX 2a: `LIST_INTENT_TOKENS` list defined
- [ ] FIX 2b: `detectListIntent()` function implemented and unit-tested
- [ ] FIX 2b: List-intent fast-path runs BEFORE BM25 in query unit search
- [ ] FIX 2b: Empty-notebook edge case falls through to BM25 correctly
- [ ] FIX 2c: `list_intent_detected` transparency event emitted on fast-path hit
- [ ] `pnpm build` clean, `pnpm test` passes (all existing tests)

### Final
- [ ] 30 new tests in `tests/phase19/intake-query.test.ts` all pass
- [ ] No existing test regressions
- [ ] `git tag phase-19-intake-query-fix`

---

## Expected Outcomes After This Sprint

| Metric | Before | After |
|---|---|---|
| Intake LLM latency | 13,296ms | ~1–2s (thinking suppressed) |
| Intake JSON parse success on fence-wrapped output | Fails | Succeeds |
| `querySignal` correctness on "list contacts" | `false` (wrong) | `true` (correct) |
| "list all contacts" memory result | `confidence: 0, entries: []` | `confidence: 1, entries: [...]` |
| BM25 calls on listing-intent queries | Always (pointless) | Bypassed |
| Transparency visibility on list fast-path | None | `list_intent_detected` event |

The query "tell me a list of all your contacts" should complete the full pipeline and
return actual WHO.CT entries without hitting BM25 at all.

---

## Notes for Claude Code

- `extractFirstJsonObject` is in `core/structured.ts` — import, do not rewrite.
- `stripThinkingTags` is in `core/llm.ts` — import, do not rewrite.
- `queryEntries` may be named differently in your codebase. Read the actual
  `core/memory/` files before assuming the method name. The ARCHITECTURE.md §8 describes
  the 5-step escalation — find where Step 2 lives and insert the list-intent check there.
- The `emit()` transparency function is available throughout — new event types require no
  schema registration.
- Gemini's suggestion to "use a smaller model for intake" is architecturally valid but out
  of scope for this sprint. The prompt rewrite alone should drop latency from 13s to ~2s.
  Model-swapping is a separate infrastructure decision.
- The hallucinated "proceduure typo" the model invented in its thinking block is not a real
  bug. Do not change any spelling in the system prompt. The word "procedure" is correct.
- If the intake prompt rewrite causes any existing intent-classification tests to fail,
  read those tests first and adjust the new prompt wording to preserve the tested behavior.
  The goal is suppressing the thinking block, not changing the semantic coverage.
