# Phase 19d — Audit Response Sprint: Determinism & Retrieval Fixes
### For: Claude Haiku (implementation only — design is final, do not deviate)
### Prerequisite: Phase 19 (intake fix) and Phase 19b (status filter) are COMPLETE
### Tag on completion: `phase-19d-audit-fixes`

---

## CONTEXT — READ THIS FIRST

On 2026-04-07, five manual tests were run against the live agent. Three failed, one partially passed, one passed with weakness. A full audit document (`zaraban_audit_session_2026-04-07.md`) was produced.

This sprint fixes the four bugs the audit discovered that are NOT yet addressed by Phase 19 or 19b. Each bug has exact log evidence and a specific fix.

**Phase 19 already fixed:** intake classifier thinking suppression, list-intent fast-path.
**Phase 19b already fixed:** status filter on listing queries.
**This sprint fixes:** everything else the audit found.

---

## THE FOUR BUGS — IN PRIORITY ORDER

### Bug A — Direct code fast-path does not fire (CRITICAL)

**Audit evidence (Test 1):** User entered `WHO.CT-000001`. The system routed it to QueryLoop LOW instead of the existing direct code fast-path. Log shows:
```
[15:34:43.436] route — QueryLoop [LOW] No complexity signals
```

**Root cause:** There IS a fast-path in `core/agent.ts` for direct code lookup. But it's not matching the input. Either:
- The regex is wrong (too strict, requires surrounding text, etc.)
- There's a guard condition that excludes bare code input
- The fast-path runs AFTER something else consumes the message first

**Fix:** Diagnose the existing fast-path, then fix it so bare memory codes are intercepted.

---

### Bug B — Session cache hit but fetch returns "not found" (CRITICAL)

**Audit evidence (Test 1):** In the same run, the log shows:
```
[15:35:30.783] session_cache_hit — Cache hit: WHO.CT-000001
[15:35:30.785] query_loop_skill_result — [memory_read] Memory entry not found: WHO.CT-000001
```

A cache hit means the system believes the entry exists. A fetch miss immediately after means the backing data is unreachable. This is a data integrity contradiction.

**Root cause:** One of:
- Session cache stores metadata but the markdown file path is wrong or missing
- `memory_read` skill uses a different lookup path than the cache
- Code/path mismatch after entry was moved or renamed

**Fix:** Add a cache-fetch consistency check. If cache says "exists" but fetch says "not found", invalidate the cache entry and log a warning.

---

### Bug C — BM25 cross-notebook contamination (HIGH)

**Audit evidence (Test 4):** User asked `what does Farzad Hamedi do?`. The `unit_memory_search` result returned BM25 confidence 0.4 with mixed notebooks: `WHEN.EV-000089`, `WHEN.EV-000010`, `WHEN.RF-000005` alongside the correct `WHO.CT-000015`.

Person queries should strongly prefer WHO entries. WHEN entries about events mentioning the person's name should not rank equally.

**Root cause:** BM25 searches across ALL notebooks with no notebook prior. The person's name appears in event descriptions, so BM25 returns everything.

**Fix:** When a person name is detected in the query, scope the FIRST BM25 pass to `WHO` notebook only. Fall back to unscoped search only if the scoped pass returns nothing.

---

### Bug D — Decomposition emits fenced JSON (MEDIUM)

**Audit evidence (Test 5):** The decomposition model wrapped its JSON output in ` ```json ``` ` markdown fences, even though the prompt says "output only JSON." The downstream parser tolerates this but it wastes tokens and signals poor format compliance.

**Root cause:** Local models frequently emit fences despite instructions. The decomposition parser does not strip them before JSON extraction.

**Fix:** Apply `stripThinkingTags` (which already strips fences) to the decomposition response before JSON extraction, if it's not already applied there.

---

## RULES — READ BEFORE WRITING ANY CODE

1. You are implementing a finished design. Do NOT redesign, rename, restructure, or "improve" anything beyond what is specified.
2. Do NOT modify any existing test files.
3. Do NOT modify `core/router.ts`, `core/query-loop.ts`, `core/planner.ts`, `core/executor.ts`.
4. After EVERY batch: run `pnpm build && pnpm test`. Fix failures before proceeding.
5. All new code is TypeScript ESM (`import`/`export`, no `require`).
6. Every function you write must have explicit return types.
7. Use `import type` for type-only imports.

---

## BATCH 0 — Read Before You Write (NO CODE CHANGES)

Open and read every file listed below. Write down the answers to every question. Do not skip this step.

```bash
cat core/agent.ts
```
Find and answer:
- Where is the direct code fast-path? Search for a regex that matches memory codes like `WHO.CT-000001`.
- What is the EXACT regex used? Copy it character-by-character.
- What guard conditions surround it? (if-else chains, early returns, etc.)
- Does the fast-path call `fetchByCode` or `getEntryByCode` or something else?
- WHERE in processMessage does this fast-path sit? Before or after what other checks?

```bash
cat core/memory/session-cache.ts
```
Find and answer:
- How are entries stored in the cache? What data does a cache entry contain?
- Is there an invalidation function? What is it called?
- When a cache hit occurs, what is returned? Full entry object or just metadata?

```bash
cat core/skills/tools/memory_read.ts
```
Find and answer:
- How does `memory_read` resolve a code? Does it call `fetchByCode`, `getEntryByCode`, or query SQLite directly?
- Why might it return "not found" when the session cache says the entry exists?

```bash
cat core/memory/unit-search.ts
```
Find and answer:
- Where does BM25 search run? What function calls `hybridSearch` or equivalent?
- Does the BM25 call accept a notebook scope parameter?
- Is there any existing logic that scopes search by detected entity type?
- Where is `detectListIntent` (from Phase 19)? Confirm it exists.

```bash
cat core/decomposition.ts
```
Find and answer:
- Where is the LLM response parsed into DecompositionResult?
- Is `stripThinkingTags` already applied to the response before JSON extraction?
- Is `extractFirstJsonObject` used, or does it use a different JSON extraction method?

```bash
cat core/memory/fetch.ts
cat core/memory/index.ts
cat core/memory/types.ts
```
Find and answer:
- `fetchByCode` signature and return type
- `getEntryByCode` signature and return type (null or undefined on miss?)
- `queryEntries` signature — does it accept `{ name: string }` for name matching?
- The actual type name for memory entries (IndexEntry? Entry? MemoryEntry?)

Save all these answers. You will need them in every batch.

---

## BATCH 1 — Fix the Direct Code Fast-Path (Bug A)

**File:** `core/agent.ts`

### Step 1: Find the existing fast-path

Search for the regex that matches memory codes. It should look something like:
```typescript
/^(WHO|WHAT|WHEN|HOW|WHY|NOW|PLAN)\.\w+-\d+$/
```
or similar. Find the exact code block.

### Step 2: Diagnose why it doesn't fire

The most likely reasons:

**Reason 1 — Regex too strict.** The regex might require the ENTIRE message to be a code (using `^` and `$` anchors). If the user types `WHO.CT-000001` with a trailing space or newline, the anchored regex won't match.

**Fix if this is the cause:** Change the regex to trim the input first:
```typescript
const trimmed = message.trim();
```
And ensure the regex matches the trimmed version.

**Reason 2 — Fast-path sits AFTER something that consumes the message first.** The plan confirmation intercept or another check might be eating the message before the code fast-path runs.

**Fix if this is the cause:** Move the code fast-path check to run EARLIER in `processMessage`, right after the plan confirmation intercept and before any other processing.

**Reason 3 — The fast-path calls a function that fails.** It might call `fetchByCode` which fails because the file path in SQLite doesn't match the actual file location.

**Fix if this is the cause:** This is Bug B — handled in Batch 2.

### Step 3: Apply the fix

After diagnosing the exact cause, apply the minimal fix. The goal: when the user's trimmed message matches the pattern `NOTEBOOK.TYPE-DIGITS`, the system MUST:
1. Call `getEntryByCode(code)` or `fetchByCode(code)` directly
2. If found: return the entry content immediately, no decomposition, no QueryLoop
3. If not found: fall through to normal pipeline (do NOT return an error — let the pipeline try)

### Step 4: Verify the regex pattern

The regex must match ALL valid code formats. Here is the complete list of valid notebook.type combinations from ARCHITECTURE.md:

```
WHO.CT  WHO.ORG
WHAT.PJ  WHAT.KN
WHEN.CA  WHEN.DL  WHEN.EV  WHEN.RF  WHEN.HX
HOW.PR  HOW.SK
WHY.MT  WHY.QU
NOW.TD  NOW.RP  NOW.LOG
PLAN.PL  PLAN.EX  PLAN.CT  PLAN.MS  PLAN.PJ
```

The regex must match: `NOTEBOOK.TYPE-DIGITS` where DIGITS is exactly 6 digits.

Recommended pattern:
```typescript
/^(WHO|WHAT|WHEN|HOW|WHY|NOW|PLAN)\.(CT|ORG|PJ|KN|CA|DL|EV|RF|HX|PR|SK|MT|QU|TD|RP|LOG|PL|EX|MS)-\d{6}$/
```

Apply this to `trimmed` (the message after `.trim()`).

### After Batch 1

```bash
pnpm build && pnpm test
```

---

## BATCH 2 — Fix Session Cache / Fetch Inconsistency (Bug B)

**Files:** `core/memory/session-cache.ts`, `core/skills/tools/memory_read.ts`

### Step 1: Understand the inconsistency

The log shows:
```
session_cache_hit: WHO.CT-000001
memory_read skill result: Memory entry not found: WHO.CT-000001
```

This means `session-cache.ts` stored something for code `WHO.CT-000001`, but when `memory_read` tried to fetch the actual content, it failed.

### Step 2: Find where `memory_read` fetches content

Open `core/skills/tools/memory_read.ts`. Find the line where it resolves a code to content. It likely calls `fetchByCode(code)` or `getEntryByCode(code)` and then reads the markdown file.

Check: does `memory_read` use the session cache at all? Or does it go directly to SQLite + file system? If it bypasses the cache entirely, the cache hit in the log is from a DIFFERENT code path (probably `unit-search.ts`), and the "not found" is because the SQLite row or the markdown file doesn't exist.

### Step 3: Add cache-fetch consistency check

In `core/memory/session-cache.ts`, find the function that handles cache hits (the function that stores or retrieves entries). Add a consistency check:

```typescript
// After a cache hit, verify the backing entry still exists
// If it doesn't, invalidate the cache entry and log a warning
```

The implementation depends on the cache API. Here is the pattern:

```typescript
// In the cache retrieval function (wherever cache hits are returned):
const cached = cache.get(code);
if (cached) {
  // Verify the backing entry exists in SQLite
  const dbEntry = getEntryByCode(code);
  if (!dbEntry) {
    // Cache is stale — entry was deleted or code changed
    cache.delete(code);
    console.warn(`[session-cache] Stale cache entry removed: ${code} (no backing DB entry)`);
    // Return null/undefined so the caller falls through to normal lookup
    return null;  // or undefined, matching the function's miss return value
  }
}
```

**IMPORTANT:** Read the actual cache API before writing this. The cache might use `.get()/.set()/.delete()` or it might use a Map, or it might be a plain object. Match the existing API exactly.

### Step 4: Also check that the file exists

If `getEntryByCode` returns a row but the markdown file at `entry.path` doesn't exist, that's ALSO an inconsistency. Add:

```typescript
import { existsSync } from 'fs';

// After confirming DB entry exists:
if (dbEntry && dbEntry.path && !existsSync(dbEntry.path)) {
  cache.delete(code);
  console.warn(`[session-cache] Stale cache entry removed: ${code} (file missing: ${dbEntry.path})`);
  return null;
}
```

### After Batch 2

```bash
pnpm build && pnpm test
```

---

## BATCH 3 — Add Notebook Scoping for Named Entity Queries (Bug C)

**File:** `core/memory/unit-search.ts`

### The Problem

When a user asks `what does Farzad Hamedi do?`, the BM25 search runs across ALL notebooks and returns:
- `WHO.CT-000015` (correct — the person)
- `WHEN.EV-000089` (wrong — an event that mentions the name)
- `WHEN.EV-000010` (wrong)
- `WHEN.RF-000005` (wrong)

The correct behavior: for queries that are obviously about a PERSON, search WHO first. Only search other notebooks if WHO returns nothing.

### Step 1: Find where BM25 search is called for query units

In `core/memory/unit-search.ts`, find the function that runs memory search for a single decomposition unit. It will call `hybridSearch()` or a similar function. Find the exact call site.

### Step 2: Add person-name detection BEFORE the BM25 call

Insert this detection block BEFORE the existing BM25/hybridSearch call, but AFTER the `detectListIntent` fast-path (added by Phase 19):

```typescript
// ── Person-name scoping: if query looks like a person query, search WHO first ──
const personMatch = detectPersonQuery(unit.content);
if (personMatch) {
  // Try WHO-scoped search first
  const whoResults = await hybridSearch(personMatch.name, { nb: 'WHO' });
  // ^^^ Adapt this call to match the ACTUAL hybridSearch signature.
  // It might be hybridSearch(query, nb) or hybridSearch(query, { nb }) or something else.
  
  if (whoResults && whoResults.length > 0) {
    return {
      strategy: 'person_scoped',
      confidence: 1,
      entries: whoResults,
      unitId: unit.id,
    };
  }
  // If WHO search found nothing, fall through to unscoped search below
}
```

### Step 3: Implement `detectPersonQuery`

Add this function in `core/memory/unit-search.ts`, near the top of the file (alongside `detectListIntent`):

```typescript
/**
 * Detects if a query is asking about a specific person.
 * Returns the person's name if detected, null otherwise.
 *
 * Matches patterns like:
 * - "what does Farzad Hamedi do"
 * - "tell me about John Smith"
 * - "who is Sarah Connor"
 * - "find contact Erfan Tari"
 */
function detectPersonQuery(content: string): { name: string } | null {
  const patterns: RegExp[] = [
    // "what does X do" / "what did X do" / "what is X doing"
    /\bwhat\s+(?:does|did|is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+do/i,
    // "who is X" / "who's X"
    /\bwho(?:'s|\s+is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i,
    // "tell me about X" where X is a capitalized name (2+ words)
    /\btell\s+me\s+about\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i,
    // "find contact X" / "show contact X"
    /\b(?:find|show|get)\s+(?:contact|person)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i,
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match && match[1]) {
      return { name: match[1].trim() };
    }
  }

  return null;
}
```

### Step 4: Also add project-name scoping

Same principle: if the query mentions a project by name, search WHAT and PLAN first.

```typescript
/**
 * Detects if a query is asking about a specific project.
 * Returns the project name if detected, null otherwise.
 */
function detectProjectQuery(content: string): { name: string } | null {
  const patterns: RegExp[] = [
    // "status of project X" / "about project X"
    /\bproject\s+([A-Z][a-zA-Z0-9]+(?:\s+[A-Z0-9][a-zA-Z0-9]*)*)/i,
    // "tell me about X" where X is capitalized and not matched by person patterns
    // This is handled by the name search in quick-resolve, so we only catch explicit "project" keyword
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match && match[1]) {
      return { name: match[1].trim() };
    }
  }

  return null;
}
```

Insert the project scoping AFTER the person scoping and BEFORE the unscoped BM25 call:

```typescript
const projectMatch = detectProjectQuery(unit.content);
if (projectMatch) {
  // Try WHAT+PLAN scoped search first
  const whatResults = await hybridSearch(projectMatch.name, { nb: 'WHAT' });
  if (whatResults && whatResults.length > 0) {
    return {
      strategy: 'project_scoped',
      confidence: 1,
      entries: whatResults,
      unitId: unit.id,
    };
  }
  // Also try PLAN
  const planResults = await hybridSearch(projectMatch.name, { nb: 'PLAN' });
  if (planResults && planResults.length > 0) {
    return {
      strategy: 'project_scoped',
      confidence: 1,
      entries: planResults,
      unitId: unit.id,
    };
  }
  // Fall through to unscoped search
}
```

### CRITICAL: Adapt hybridSearch calls

The `hybridSearch` function may have a different signature than shown above. Before writing this code:

```bash
grep -n "function hybridSearch\|export.*hybridSearch" core/memory/search.ts
```

Check the actual signature. It might be:
- `hybridSearch(query: string, scope?: { nb?: string })`
- `hybridSearch(query: string, nb?: string)`
- `hybridSearch(query: string, options?: SearchOptions)`

Adapt ALL calls to match the real signature.

### CRITICAL: Return type

The return value from the search function for a unit must match whatever type the existing BM25 path returns. Look at what the existing `return` statements look like in that function and copy the exact shape. If they return `{ strategy, confidence, entries, unitId }`, use that shape. If they return something different, match it.

### After Batch 3

```bash
pnpm build && pnpm test
```

---

## BATCH 4 — Strip Fences from Decomposition Output (Bug D)

**File:** `core/decomposition.ts`

### Step 1: Check if stripThinkingTags is already applied

```bash
grep -n "stripThinkingTags\|extractFirstJsonObject" core/decomposition.ts
```

If `stripThinkingTags` is already called on the LLM response before JSON extraction, this batch is already done. Skip to Batch 5.

If it is NOT applied:

### Step 2: Add stripping before JSON extraction

Find the line where the decomposition LLM response is parsed into JSON. It will look something like:

```typescript
const raw = await llmHandler.chat(messages);
// ... some JSON extraction here ...
```

Insert `stripThinkingTags` before JSON extraction:

```typescript
import { stripThinkingTags } from './llm.js';

// Inside the decomposition parsing:
const raw = await llmHandler.chat(messages);
const cleaned = stripThinkingTags(typeof raw === 'string' ? raw : raw.content || '');
// Now use 'cleaned' instead of 'raw' for JSON extraction
```

Check that `stripThinkingTags` is importable from `core/llm.ts`. If it's not exported, find where it IS exported and import from there.

### Step 3: Verify extractFirstJsonObject is used

If the decomposition parser uses a naive regex like `match(/\{[\s\S]*\}/)` instead of `extractFirstJsonObject`, replace it:

```typescript
import { extractFirstJsonObject } from './structured.js';

const jsonStr = extractFirstJsonObject(cleaned);
if (!jsonStr) {
  // handle parse failure — existing fallback logic
}
const parsed = JSON.parse(jsonStr);
```

Again: check where `extractFirstJsonObject` lives. It might be in `core/structured.ts` or somewhere else.

### After Batch 4

```bash
pnpm build && pnpm test
```

---

## BATCH 5 — Create `core/memory/quick-resolve.ts` (Pre-Decomposition Early Exit)

This is the code lookup + name search early exit. It runs BEFORE decomposition for two structurally obvious cases.

**This is the same module specified in the Phase 19c prompt. It is reproduced here for completeness so you have one self-contained document.**

### Complete file to create

Create file `core/memory/quick-resolve.ts`:

```typescript
/**
 * quick-resolve.ts — Pre-decomposition memory retrieval
 *
 * Pattern-matches user messages to resolve memory queries WITHOUT any LLM call.
 * Runs BEFORE decomposition in agent.ts.
 *
 * Two strategies:
 * 1. Code lookup — message contains WHO.CT-000001 etc.
 * 2. Name search — message contains a proper noun matching an entry name.
 *
 * Listing queries ("show all contacts") are NOT handled here.
 * They are handled by detectListIntent() in unit-search.ts (Phase 19).
 */
```

**BEFORE writing this file, read:**
```bash
cat core/memory/index.ts    # queryEntries, getEntryByCode signatures
cat core/memory/fetch.ts    # fetchByCode signature
cat core/memory/types.ts    # IndexEntry type name
```

Adapt all imports and type names to match reality.

### Imports

```typescript
import { queryEntries, getEntryByCode } from './index.js';
import { fetchByCode } from './fetch.js';
import type { IndexEntry } from './types.js';
// ^^^ Use the REAL function names and type names from the codebase
```

### Type

```typescript
export interface QuickResolveResult {
  resolved: boolean;
  entries: IndexEntry[];   // use real type name
  strategy: 'code_lookup' | 'name_search' | 'none';
  bodies: string[];
}
```

### Function: extractCodes

```typescript
export function extractCodes(message: string): string[] {
  const CODE_PATTERN = /\b(WHO|WHAT|WHEN|HOW|WHY|NOW|PLAN)\.(CT|ORG|PJ|KN|CA|DL|EV|RF|HX|PR|SK|MT|QU|TD|RP|LOG|PL|EX|MS|PJ)-\d{6}\b/g;
  const matches = message.match(CODE_PATTERN);
  if (!matches) return [];
  return [...new Set(matches)];
}
```

### Function: extractSearchTerms

```typescript
export function extractSearchTerms(message: string): string[] {
  const terms: string[] = [];

  // 1. Quoted strings
  const QUOTE_PATTERN = /["'\u201C\u201D]([^"'\u201C\u201D]{2,})["'\u201C\u201D]/g;
  let match: RegExpExecArray | null;
  while ((match = QUOTE_PATTERN.exec(message)) !== null) {
    terms.push(match[1].trim());
  }

  // 2. Capitalized multi-word phrases (skip sentence-initial word)
  const sentenceBodies = message.replace(/^[A-Z][a-z]+\s/gm, '');
  const CAP_PATTERN = /\b([A-Z][a-z]+(?:\s+[A-Z0-9][a-z0-9]*)+)\b/g;
  while ((match = CAP_PATTERN.exec(sentenceBodies)) !== null) {
    terms.push(match[1].trim());
  }

  // 3. Fallback: non-stopword tokens
  const STOPWORDS = new Set([
    'i','me','my','we','our','you','your','he','she','it','they',
    'the','a','an','is','are','was','were','be','been','being',
    'have','has','had','do','does','did','will','would','could',
    'should','may','might','can','shall','must','need',
    'and','but','or','nor','not','so','yet','for','at','by',
    'in','on','to','of','with','from','up','out','off','over',
    'into','about','after','before','between','under','above',
    'what','which','who','whom','when','where','why','how',
    'all','each','every','both','few','more','most','some','any',
    'no','other','such','only','same','than','too','very',
    'just','also','now','then','here','there','still','already',
    'show','tell','find','get','give','make','know','think',
    'see','come','go','take','want','look','use','say','let',
    'this','that','these','those','if','as','while','because',
    'since','until','unless','although','though','even',
    'please','thanks','thank','hello','hi','hey',
    'remember','recall','memory','memories','everything',
    'list','display','regarding','related',
  ]);

  if (terms.length === 0) {
    const tokens = message
      .replace(/[^\w\s-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2 && !STOPWORDS.has(t.toLowerCase()));
    tokens.sort((a, b) => b.length - a.length);
    terms.push(...tokens.slice(0, 4));
  }

  return [...new Set(terms)];
}
```

### Function: quickResolve

```typescript
export async function quickResolve(message: string): Promise<QuickResolveResult> {
  const EMPTY: QuickResolveResult = { resolved: false, entries: [], strategy: 'none', bodies: [] };

  // Strategy 1: Code lookup
  const codes = extractCodes(message);
  if (codes.length > 0) {
    const entries: IndexEntry[] = [];
    const bodies: string[] = [];
    for (const code of codes) {
      const entry = getEntryByCode(code);
      if (entry) {
        entries.push(entry);
        try {
          const body = fetchByCode(code);
          bodies.push(typeof body === 'string' ? body : '');
        } catch {
          bodies.push('');
        }
      }
    }
    if (entries.length > 0) {
      return { resolved: true, entries, strategy: 'code_lookup', bodies };
    }
  }

  // Strategy 2: Name search
  const terms = extractSearchTerms(message);
  if (terms.length > 0) {
    for (const term of terms) {
      const byName = queryEntries({ name: term });
      if (byName.length > 0) {
        const bodies: string[] = [];
        if (byName.length <= 5) {
          for (const entry of byName) {
            try {
              const body = fetchByCode(entry.code);
              bodies.push(typeof body === 'string' ? body : '');
            } catch {
              bodies.push('');
            }
          }
        }
        return { resolved: true, entries: byName, strategy: 'name_search', bodies };
      }
    }
  }

  return EMPTY;
}
```

### CRITICAL adaptation notes

1. If `getEntryByCode` returns `null` (not `undefined`), use `!= null` checks.
2. If `fetchByCode` returns an object (not a string), extract the string field.
3. If `queryEntries` does NOT support `{ name: string }`, use direct SQL:
   ```typescript
   // Fallback if queryEntries doesn't support name filter
   const db = getDb(); // or however the DB instance is accessed
   const stmt = db.prepare('SELECT * FROM index_entries WHERE LOWER(name) LIKE ? LIMIT 10');
   const byName = stmt.all(`%${term.toLowerCase()}%`);
   ```
4. The function is `async` intentionally — do not make it sync.

### After Batch 5

```bash
pnpm build
```

---

## BATCH 6 — Wire `quickResolve` into `core/agent.ts`

**File:** `core/agent.ts`

### Step 1: Add import

```typescript
import { quickResolve } from './memory/quick-resolve.js';
```

### Step 2: Find insertion point

Find the gap between the LAST fast-path bypass (the one you fixed in Batch 1) and the FIRST line of decomposition/intake logic. Insert the quick-resolve block there.

### Step 3: Insert quick-resolve block

```typescript
// ── Quick-resolve: deterministic retrieval, no LLM ──
const quickResult = await quickResolve(message);
if (quickResult.resolved && quickResult.entries.length > 0) {
  let memoryContext: string;
  if (quickResult.bodies.length > 0 && quickResult.bodies.some(b => b.length > 0)) {
    memoryContext = quickResult.entries.map((entry, i) => {
      const body = quickResult.bodies[i] || '';
      return `### ${entry.code}: ${entry.name}\n${body || entry.summary || '(no content)'}`;
    }).join('\n\n');
  } else {
    memoryContext = quickResult.entries.map(entry =>
      `- **${entry.code}**: ${entry.name} — ${entry.summary || 'no summary'} [${entry.status}]`
    ).join('\n');
  }

  const systemPrompt = `You are Zaraban, a personal AI assistant with persistent memory.
The user asked a question and your memory system already found the relevant entries.
Answer using ONLY the retrieved data below. Be concise and direct. Do not invent information.

## Retrieved Memory (${quickResult.strategy}, ${quickResult.entries.length} entries)

${memoryContext}`;

  // >>> ADAPT: use the same LLM call pattern as the rest of processMessage <<<
  const reply = await llmHandler.chat([
    { role: 'system', content: systemPrompt },
    // >>> ADAPT: include conversation history the same way other paths do <<<
    { role: 'user', content: message }
  ]);

  // >>> ADAPT: return the same type shape as other early exits in processMessage <<<
  return {
    reply: typeof reply === 'string' ? reply : (reply?.content || reply?.text || String(reply)),
    intent: 'query',
    resolved: quickResult.entries,
  };
}
// ── End quick-resolve ──
```

### CRITICAL ADAPTATION NOTES

1. **LLM call method:** Look at how other parts of processMessage call the LLM. Copy that exact pattern. The variable might not be `llmHandler` — it might be `handler`, `llm`, or the LLM might be called via `callLLM(messages, handler)`.

2. **Conversation history:** Find how other paths include history. Include the last 6 turns between system and user messages.

3. **Return type:** Look at other `return` statements in processMessage. Match ALL required fields. Add default values for optional fields (e.g., `retries: 0`, `created: undefined`).

4. **Intent type:** Check `core/types.ts` for valid intent values. Use `'query'` or the closest equivalent.

5. **Do NOT remove the existing decomposition pipeline.** The quick-resolve block is an early exit. If `quickResult.resolved` is false or entries is empty, the code falls through unchanged.

### After Batch 6

```bash
pnpm build && pnpm test
```

---

## BATCH 7 — Create Tests

**File:** `tests/phase19/audit-fixes.test.ts`

Copy the setup/teardown pattern from existing Phase 19 test files. If no Phase 19 tests exist, look at `tests/phase10/` or `tests/phase11/`.

### Test Group 1: extractCodes (5 tests)

```typescript
describe('extractCodes', () => {
  it('extracts a single code', () => {
    expect(extractCodes('Show me WHO.CT-000001')).toEqual(['WHO.CT-000001']);
  });

  it('extracts multiple codes', () => {
    const r = extractCodes('Compare WHO.CT-000001 with WHAT.PJ-000003');
    expect(r).toHaveLength(2);
    expect(r).toContain('WHO.CT-000001');
    expect(r).toContain('WHAT.PJ-000003');
  });

  it('deduplicates', () => {
    expect(extractCodes('WHO.CT-000001 and WHO.CT-000001')).toEqual(['WHO.CT-000001']);
  });

  it('returns empty for no codes', () => {
    expect(extractCodes('hello world')).toEqual([]);
  });

  it('rejects incomplete codes', () => {
    expect(extractCodes('WHO.CT-12')).toEqual([]);
  });
});
```

### Test Group 2: extractSearchTerms (5 tests)

```typescript
describe('extractSearchTerms', () => {
  it('extracts double-quoted strings', () => {
    expect(extractSearchTerms('find "tennis game"')).toContain('tennis game');
  });

  it('extracts capitalized phrases', () => {
    const r = extractSearchTerms('tell me about Tennis 3D Game');
    expect(r.some(t => t.includes('Tennis'))).toBe(true);
  });

  it('falls back to non-stopword tokens', () => {
    const r = extractSearchTerms('find the ceramic color work');
    expect(r.some(t => /ceramic|color/i.test(t))).toBe(true);
  });

  it('returns empty for stopword-only input', () => {
    expect(extractSearchTerms('hi')).toEqual([]);
  });

  it('deduplicates', () => {
    const r = extractSearchTerms('"tennis" and "tennis"');
    expect(r.filter(t => t === 'tennis').length).toBeLessThanOrEqual(1);
  });
});
```

### Test Group 3: detectPersonQuery (4 tests)

```typescript
describe('detectPersonQuery', () => {
  it('matches "what does X do" pattern', () => {
    const r = detectPersonQuery('what does Farzad Hamedi do?');
    expect(r).not.toBeNull();
    expect(r!.name).toBe('Farzad Hamedi');
  });

  it('matches "who is X" pattern', () => {
    const r = detectPersonQuery('who is John Smith');
    expect(r).not.toBeNull();
    expect(r!.name).toBe('John Smith');
  });

  it('matches "tell me about X" pattern', () => {
    const r = detectPersonQuery('tell me about Sarah Connor');
    expect(r).not.toBeNull();
    expect(r!.name).toBe('Sarah Connor');
  });

  it('returns null for non-person queries', () => {
    expect(detectPersonQuery('list all contacts')).toBeNull();
    expect(detectPersonQuery('build a website')).toBeNull();
  });
});
```

**Note:** `detectPersonQuery` is defined inside `core/memory/unit-search.ts`. To test it, you need to either:
- Export it from `unit-search.ts` (add `export` keyword)
- Or test it indirectly through the search function

Preferred: add `export` to the function declaration so tests can import it directly:
```typescript
export function detectPersonQuery(content: string): { name: string } | null {
```

### Test Group 4: quickResolve integration (6 tests)

These need a real temp database with seeded entries. Seed:
- WHO.CT entry named "John Smith"
- WHAT.PJ entry named "Tennis 3D Game"
- NOW.TD entry named "Buy groceries"

```typescript
describe('quickResolve', () => {
  // setup/teardown with tmpDir, initDatabase, create 3 entries
  // capture auto-generated codes in variables

  it('resolves direct code lookup', async () => {
    const r = await quickResolve(`Show me ${contactCode}`);
    expect(r.resolved).toBe(true);
    expect(r.strategy).toBe('code_lookup');
    expect(r.entries[0].code).toBe(contactCode);
  });

  it('resolves code lookup with body', async () => {
    const r = await quickResolve(`Show me ${contactCode}`);
    expect(r.bodies[0].length).toBeGreaterThan(0);
  });

  it('resolves name search', async () => {
    const r = await quickResolve('tell me about Tennis 3D Game');
    expect(r.resolved).toBe(true);
    expect(r.entries.some(e => e.name === 'Tennis 3D Game')).toBe(true);
  });

  it('returns resolved:false for greetings', async () => {
    const r = await quickResolve('hello how are you');
    expect(r.resolved).toBe(false);
  });

  it('returns resolved:false for agentic requests', async () => {
    const r = await quickResolve('build me a website');
    expect(r.resolved).toBe(false);
  });

  it('returns resolved:false for nonexistent code', async () => {
    const r = await quickResolve('WHO.CT-999999');
    expect(r.resolved).toBe(false);
  });
});
```

### Test Group 5: Direct code fast-path in agent.ts (2 tests)

These test that the fast-path regex in agent.ts works correctly. They do NOT need a live LLM — they test the regex matching only.

```typescript
describe('direct code fast-path regex', () => {
  // Test the regex pattern itself
  const CODE_REGEX = /^(WHO|WHAT|WHEN|HOW|WHY|NOW|PLAN)\.(CT|ORG|PJ|KN|CA|DL|EV|RF|HX|PR|SK|MT|QU|TD|RP|LOG|PL|EX|MS|PJ)-\d{6}$/;

  it('matches bare memory code', () => {
    expect(CODE_REGEX.test('WHO.CT-000001')).toBe(true);
    expect(CODE_REGEX.test('WHAT.PJ-000003')).toBe(true);
    expect(CODE_REGEX.test('PLAN.EX-000042')).toBe(true);
  });

  it('does not match partial or invalid codes', () => {
    expect(CODE_REGEX.test('WHO.CT-12')).toBe(false);
    expect(CODE_REGEX.test('hello WHO.CT-000001')).toBe(false);
    expect(CODE_REGEX.test('WHO.XX-000001')).toBe(false);
  });
});
```

### After Batch 7

```bash
pnpm build && pnpm test
```

All existing tests plus 22 new tests must pass.

---

## BATCH 8 — Final Verification

```bash
pnpm build && pnpm test
```

Report:
1. Total test count
2. Pass/fail count
3. Build status

If everything passes:
```bash
git tag phase-19d-audit-fixes
```

---

## WHAT YOU MUST NOT DO

1. ❌ Do NOT create new types for things that already exist
2. ❌ Do NOT add `console.log` debugging (only the `console.warn` statements specified above)
3. ❌ Do NOT modify `core/router.ts`, `core/query-loop.ts`, `core/planner.ts`, `core/executor.ts`
4. ❌ Do NOT modify any existing test file
5. ❌ Do NOT change existing function signatures
6. ❌ Do NOT install new npm packages
7. ❌ Do NOT add SQLite schema changes
8. ❌ Do NOT create files beyond what is specified
9. ❌ Do NOT skip `pnpm build && pnpm test` between batches
10. ❌ Do NOT proceed to next batch if current batch has failures
11. ❌ Do NOT add listing detection — Phase 19 already did that
12. ❌ Do NOT add hybridSearch fallback to quick-resolve — the normal pipeline handles that
13. ❌ Do NOT restructure processMessage — only add early exits and fix the existing fast-path

---

## SUMMARY

| Batch | Bug | Action | Files |
|-------|-----|--------|-------|
| 0 | — | Read codebase | 0 changes |
| 1 | A | Fix direct code fast-path regex | agent.ts edit |
| 2 | B | Fix cache/fetch inconsistency | session-cache.ts edit |
| 3 | C | Add person/project notebook scoping | unit-search.ts edit |
| 4 | D | Strip fences from decomposition output | decomposition.ts edit |
| 5 | — | Create quick-resolve.ts | 1 new file |
| 6 | — | Wire quick-resolve into agent.ts | agent.ts edit |
| 7 | — | Create tests | 1 new file, 22 tests |
| 8 | — | Final verification + tag | 0 |

**Audit test coverage after this sprint:**

| Audit Test | Expected Result |
|---|---|
| Test 1: `WHO.CT-000001` | ✅ Fast-path fires (Batch 1), cache consistent (Batch 2), OR quick-resolve catches it (Batch 5+6) |
| Test 2: `tell me all contacts` | ✅ Already fixed by Phase 19 + 19b |
| Test 3: `tell me about Tennis 3D Game` | ✅ Quick-resolve name search (Batch 5+6) |
| Test 4: `what does Farzad Hamedi do?` | ✅ Person-scoped search (Batch 3) |
| Test 5: compound query + action | ✅ Fence stripping (Batch 4), project scoping (Batch 3) |
