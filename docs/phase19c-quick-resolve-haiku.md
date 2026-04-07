# Phase 19c — Quick-Resolve: Pre-Decomposition Memory Retrieval
### For: Claude Haiku (implementation only — design is final, do not deviate)
### Prerequisite: Phase 19 (intake fix + list-intent) and Phase 19b (status filter) are COMPLETE
### Tag on completion: `phase-19c-quick-resolve`

---

## WHAT PHASE 19 AND 19b ALREADY FIXED

Phase 19 fixed two things:
1. **Intake classifier** — rewrote the system prompt to suppress thinking blocks, raised maxTokens, added `extractFirstJsonObject` + `stripThinkingTags` to intake parsing.
2. **List-intent fast-path** — added `detectListIntent()` with `NOTEBOOK_VOCABULARY` map inside `core/memory/unit-search.ts`. Listing queries like "show all contacts" now hit `queryEntries()` directly instead of falling through to BM25.

Phase 19b fixed:
3. **Status filter** — removed `status: 'active'` hardcoding from both listing fast-paths so entries with any status are returned.

**These fixes work INSIDE the existing decomposition pipeline.** The user message still goes through an LLM decomposition call before the list-intent fast-path fires.

---

## WHAT THIS SPRINT ADDS

This sprint adds a **pre-decomposition early exit** for two cases that are structurally obvious and do not need an LLM call at all:

| Case | Example | Why no LLM needed |
|------|---------|-------------------|
| **Code lookup** | "Show me WHO.CT-000001" | The code is right there in the text. Regex extracts it. |
| **Name search** | "tell me about Tennis 3D Game" | The proper noun is right there. Query by name. |

These two cases currently waste 2-5 seconds on a decomposition LLM call that adds zero value — the system already knows exactly what to fetch.

**This sprint does NOT add listing detection.** That is already handled by Phase 19 inside `unit-search.ts`. We do not duplicate it.

---

## RULES — READ BEFORE WRITING ANY CODE

1. You are implementing a finished design. Do NOT redesign, rename, restructure, or "improve" anything. Copy the exact function names, exact parameter names, exact return types, exact regex patterns shown below.
2. Do NOT modify any existing test files.
3. Do NOT modify `core/router.ts`, `core/decomposition.ts`, `core/query-loop.ts`, `core/planner.ts`, `core/executor.ts`, `core/memory/unit-search.ts`.
4. After EVERY batch: run `pnpm build && pnpm test`. If anything fails, fix it before moving to the next batch. Do not proceed with failing tests.
5. All new code is TypeScript ESM (`import`/`export`, no `require`).
6. All new files use `.ts` extension.
7. Every function you write must have explicit return types — no inferred returns.
8. Use `import type` for type-only imports.

---

## FILES YOU WILL CREATE

```
core/memory/quick-resolve.ts          ← NEW (Batch 1)
tests/phase19/quick-resolve.test.ts   ← NEW (Batch 2)
```

## FILES YOU WILL EDIT

```
core/agent.ts                         ← Batch 3 (wire quick-resolve into processMessage)
```

---

## BATCH 0 — Read Before You Write

Before writing any code, you MUST open and read these files. Do not skip this step. You need to know the real function signatures, not guess them.

```bash
# Read these files and note the exact function signatures and type names:
cat core/memory/index.ts       # find: queryEntries signature, getEntryByCode signature
cat core/memory/fetch.ts       # find: fetchByCode signature and return type
cat core/memory/search.ts      # find: hybridSearch signature and return type
cat core/memory/types.ts       # find: IndexEntry type (or whatever it's actually called)
cat core/memory/mod.ts         # find: what is re-exported
cat core/agent.ts              # find: processMessage function, where fast-paths are, how it returns
```

Write down (in your working memory) these exact answers:
- What is the type name for a memory entry? (IndexEntry? MemoryEntry? Entry?)
- What is the signature of `queryEntries`? What params does it accept?
- What is the signature of `getEntryByCode`? Does it return `undefined` or `null` on miss?
- What is the signature of `fetchByCode`? Does it return a string? Can it throw?
- What is the signature of `hybridSearch`? What does it return?
- What does `processMessage` return? What is the `AgentResponse` type shape?
- Where are the fast-path bypasses in `processMessage`? (Look for `/log`, `/meeting`, direct code fetch)
- How is the LLM called? (`llmHandler.chat(...)` or `callLLM(...)` or something else?)
- How is conversation history accessed inside `processMessage`?

If any function name or type name below does not match what you find in the codebase, **use what exists in the codebase**, not what this prompt says. The codebase is truth.

---

## BATCH 1 — Create `core/memory/quick-resolve.ts`

Create this file. Every function is specified completely. Do not add functions. Do not add logging. Do not add transparency events.

### Complete file content

```typescript
/**
 * quick-resolve.ts — Pre-decomposition memory retrieval
 *
 * Pattern-matches user messages to resolve memory queries WITHOUT any LLM call.
 * Runs BEFORE decomposition in agent.ts. If it finds results, the agent can
 * respond directly without spending 2-5 seconds on a decomposition call.
 *
 * This module handles two strategies:
 * 1. Code lookup — message contains WHO.CT-000001 etc.
 * 2. Name search — message contains a proper noun that matches an entry name.
 *
 * Listing queries ("show all contacts") are NOT handled here — they are
 * handled by detectListIntent() in core/memory/unit-search.ts (Phase 19).
 */

import { queryEntries, getEntryByCode } from './index.js';
import { fetchByCode } from './fetch.js';
import type { IndexEntry } from './types.js';
```

**IMPORTANT:** After reading Batch 0, you may find that:
- The type is not called `IndexEntry` — use the real name.
- `queryEntries` is not in `./index.js` — use the real import path.
- `getEntryByCode` does not exist by that name — use the real function name.
- `fetchByCode` is not in `./fetch.js` — use the real import path.

Adapt all imports to match reality. Do NOT create stub functions.

### Type definition

```typescript
export interface QuickResolveResult {
  /** Whether quick-resolve found anything useful. */
  resolved: boolean;
  /** The memory entries found. Empty array if resolved is false. */
  entries: IndexEntry[];
  /** Which strategy succeeded. 'none' if resolved is false. */
  strategy: 'code_lookup' | 'name_search' | 'none';
  /** Full markdown body for each entry (parallel array with entries). Populated only when entries.length <= 5. */
  bodies: string[];
}
```

Again: if the type is not called `IndexEntry`, use the real name.

### Function 1: `extractCodes`

```typescript
/**
 * Extracts memory codes like WHO.CT-000001 from a message.
 * Returns an array of unique codes found. Empty array if none.
 */
export function extractCodes(message: string): string[] {
  const CODE_PATTERN = /\b(WHO|WHAT|WHEN|HOW|WHY|NOW|PLAN)\.(CT|ORG|PJ|KN|CA|DL|EV|RF|HX|PR|SK|MT|QU|TD|RP|LOG|PL|EX|MS|PJ)-\d{6}\b/g;
  const matches = message.match(CODE_PATTERN);
  if (!matches) return [];
  return [...new Set(matches)];
}
```

### Function 2: `extractSearchTerms`

```typescript
/**
 * Extracts searchable terms from a message:
 * 1. Quoted strings ("tennis game", 'my project')
 * 2. Capitalized multi-word phrases (Tennis 3D Game)
 * 3. Fallback: longest non-stopword tokens
 *
 * Returns empty array if nothing useful is found.
 */
export function extractSearchTerms(message: string): string[] {
  const terms: string[] = [];

  // 1. Quoted strings — highest quality signal
  const QUOTE_PATTERN = /["'\u201C\u201D]([^"'\u201C\u201D]{2,})["'\u201C\u201D]/g;
  let match: RegExpExecArray | null;
  while ((match = QUOTE_PATTERN.exec(message)) !== null) {
    terms.push(match[1].trim());
  }

  // 2. Capitalized multi-word phrases (skip first word of each sentence)
  const sentenceBodies = message.replace(/^[A-Z][a-z]+\s/gm, '');
  const CAP_PATTERN = /\b([A-Z][a-z]+(?:\s+[A-Z0-9][a-z0-9]*)+)\b/g;
  while ((match = CAP_PATTERN.exec(sentenceBodies)) !== null) {
    terms.push(match[1].trim());
  }

  // 3. Stopword list — common English words that carry no search value
  const STOPWORDS = new Set([
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'must', 'need',
    'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'for', 'at', 'by',
    'in', 'on', 'to', 'of', 'with', 'from', 'up', 'out', 'off', 'over',
    'into', 'about', 'after', 'before', 'between', 'under', 'above',
    'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how',
    'all', 'each', 'every', 'both', 'few', 'more', 'most', 'some', 'any',
    'no', 'other', 'such', 'only', 'same', 'than', 'too', 'very',
    'just', 'also', 'now', 'then', 'here', 'there', 'still', 'already',
    'show', 'tell', 'find', 'get', 'give', 'make', 'know', 'think',
    'see', 'come', 'go', 'take', 'want', 'look', 'use', 'say', 'let',
    'this', 'that', 'these', 'those', 'if', 'as', 'while', 'because',
    'since', 'until', 'unless', 'although', 'though', 'even',
    'please', 'thanks', 'thank', 'hello', 'hi', 'hey',
    'remember', 'recall', 'memory', 'memories', 'everything',
    'list', 'display', 'regarding', 'related',
  ]);

  // If no quoted or capitalized phrases found, extract non-stopword tokens
  if (terms.length === 0) {
    const tokens = message
      .replace(/[^\w\s-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2 && !STOPWORDS.has(t.toLowerCase()));

    // Take at most the 4 longest tokens as search terms
    tokens.sort((a, b) => b.length - a.length);
    terms.push(...tokens.slice(0, 4));
  }

  return [...new Set(terms)];
}
```

### Function 3: `quickResolve` — the main entry point

```typescript
/**
 * Attempts to resolve a user message deterministically without any LLM call.
 *
 * Strategy priority:
 * 1. Code lookup — if the message contains a memory code like WHO.CT-000001
 * 2. Name search — if extractSearchTerms finds proper nouns or quoted strings,
 *    try queryEntries({ name: term }) before giving up
 *
 * Returns { resolved: false } if no strategy produced results.
 * The caller should then fall through to the normal decomposition pipeline.
 *
 * NOTE: Listing queries ("show all contacts") are NOT handled here.
 * They are handled by detectListIntent() in unit-search.ts (Phase 19).
 */
export async function quickResolve(message: string): Promise<QuickResolveResult> {
  const EMPTY: QuickResolveResult = { resolved: false, entries: [], strategy: 'none', bodies: [] };

  // ── Strategy 1: Code lookup ──
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

  // ── Strategy 2: Name search ──
  const terms = extractSearchTerms(message);
  if (terms.length > 0) {
    for (const term of terms) {
      // queryEntries({ name: ... }) does a name-match lookup in SQLite
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

### CRITICAL NOTES FOR BATCH 1

1. `getEntryByCode` may return `null` instead of `undefined`. If so, use `!= null` checks. Read the real source to know.

2. `fetchByCode` may return an object instead of a plain string. If so, extract the string field (e.g., `result.body` or `result.content`). Read the real source to know.

3. `queryEntries({ name: term })` — verify that `queryEntries` supports a `name` filter. If it does not, you must use a different approach. Check whether queryEntries accepts `{ name: string }` and what kind of match it does (exact, LIKE, case-insensitive). If `name` is not a supported filter field, use this SQL fallback instead:

```typescript
// Only use this if queryEntries does not support name filtering:
import Database from 'better-sqlite3';
// Get the db instance from wherever it's exposed in the codebase
const stmt = db.prepare(`SELECT * FROM index_entries WHERE LOWER(name) LIKE ? LIMIT 10`);
const byName = stmt.all(`%${term.toLowerCase()}%`) as IndexEntry[];
```

But first, check if queryEntries already supports `{ name: ... }`. It very likely does — ARCHITECTURE.md §8 Step 4 says "Can index tags/names find it? → queryEntries({ name: extractedName })".

4. The function is `async` even though all current operations are synchronous. This is intentional — it leaves room for future strategies that may need async operations (like hybridSearch) without changing the interface.

5. Do NOT add a hybridSearch fallback in this function. The normal decomposition pipeline already does that. quickResolve should only handle cases that are 100% certain — code lookups and exact name matches.

### After Batch 1

```bash
pnpm build
```

Fix any TypeScript errors. The file must compile cleanly. Do not run tests yet.

---

## BATCH 2 — Create `tests/phase19/quick-resolve.test.ts`

### Setup pattern

Before writing tests, look at how existing Phase 19 tests are structured:

```bash
cat tests/phase19/intake-query.test.ts | head -40
# OR
cat tests/phase19/status-filter.test.ts | head -40
```

Copy their exact setup/teardown pattern for:
- Creating a temporary directory
- Initializing the database
- Setting PATHS overrides
- Cleaning up after tests

If no Phase 19 tests exist yet, look at any test file in `tests/phase10/` or `tests/phase11/` and copy their pattern.

### Test file structure

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { extractCodes, extractSearchTerms, quickResolve } from '../../core/memory/quick-resolve.js';
import type { QuickResolveResult } from '../../core/memory/quick-resolve.js';
// Import database init, entry creation, and PATHS from wherever they live.
// Check existing tests for the exact import paths.
```

### Test Group 1: `extractCodes` — 5 tests

```typescript
describe('extractCodes', () => {
  it('extracts a single code from a message', () => {
    expect(extractCodes('Show me WHO.CT-000001')).toEqual(['WHO.CT-000001']);
  });

  it('extracts multiple distinct codes', () => {
    const result = extractCodes('Compare WHO.CT-000001 with WHAT.PJ-000003');
    expect(result).toHaveLength(2);
    expect(result).toContain('WHO.CT-000001');
    expect(result).toContain('WHAT.PJ-000003');
  });

  it('deduplicates repeated codes', () => {
    expect(extractCodes('WHO.CT-000001 and WHO.CT-000001 again')).toEqual(['WHO.CT-000001']);
  });

  it('returns empty array when no codes present', () => {
    expect(extractCodes('Hello, how are you?')).toEqual([]);
  });

  it('does not match incomplete codes', () => {
    expect(extractCodes('WHO.CT without a number')).toEqual([]);
    expect(extractCodes('WHO.CT-12')).toEqual([]);
  });
});
```

### Test Group 2: `extractSearchTerms` — 6 tests

```typescript
describe('extractSearchTerms', () => {
  it('extracts double-quoted strings', () => {
    const result = extractSearchTerms('find "tennis 3d game" in memory');
    expect(result).toContain('tennis 3d game');
  });

  it('extracts single-quoted strings', () => {
    const result = extractSearchTerms("show me 'activation x-ray' details");
    expect(result).toContain('activation x-ray');
  });

  it('extracts capitalized multi-word phrases', () => {
    const result = extractSearchTerms('tell me about Tennis 3D Game');
    expect(result.some(t => t.includes('Tennis'))).toBe(true);
  });

  it('falls back to non-stopword tokens', () => {
    const result = extractSearchTerms('find the ceramic color work');
    expect(result.length).toBeGreaterThan(0);
    expect(result.some(t => t.toLowerCase() === 'ceramic' || t.toLowerCase() === 'color')).toBe(true);
  });

  it('returns empty for very short stopword-only messages', () => {
    expect(extractSearchTerms('hi')).toEqual([]);
  });

  it('deduplicates identical terms', () => {
    const result = extractSearchTerms('"tennis" and "tennis"');
    const count = result.filter(t => t === 'tennis').length;
    expect(count).toBeLessThanOrEqual(1);
  });
});
```

### Test Group 3: `quickResolve` integration — 7 tests

These tests need a real temporary database with seeded entries. Copy the setup/teardown pattern from existing tests exactly.

**Seed these entries before each test** (using whatever entry creation function the codebase uses — `createEntry`, `upsertEntry`, etc.):

| Code (will be auto-generated) | nb | type | name | status | summary |
|---|---|---|---|---|---|
| auto | WHO | CT | John Smith | active | A test contact |
| auto | WHAT | PJ | Tennis 3D Game | active | A 3D tennis game project |
| auto | NOW | TD | Buy groceries | active | Weekly grocery shopping |

You do NOT manually assign codes. The code system auto-generates them. After creating each entry, capture the returned code so you can reference it in assertions.

```typescript
describe('quickResolve', () => {
  // ... your setup/teardown with tmpDir, initDatabase, seed 3 entries ...
  // Capture the created codes in variables: contactCode, projectCode, todoCode

  it('resolves direct code lookup — single code', async () => {
    const result = await quickResolve(`Show me ${contactCode}`);
    expect(result.resolved).toBe(true);
    expect(result.strategy).toBe('code_lookup');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].code).toBe(contactCode);
  });

  it('resolves direct code lookup — fetches body', async () => {
    const result = await quickResolve(`Show me ${contactCode}`);
    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0].length).toBeGreaterThan(0);
  });

  it('resolves direct code lookup — multiple codes', async () => {
    const result = await quickResolve(`Compare ${contactCode} and ${projectCode}`);
    expect(result.resolved).toBe(true);
    expect(result.strategy).toBe('code_lookup');
    expect(result.entries).toHaveLength(2);
  });

  it('resolves name search for known entry', async () => {
    const result = await quickResolve('tell me about Tennis 3D Game');
    expect(result.resolved).toBe(true);
    expect(result.strategy).toBe('name_search');
    expect(result.entries.length).toBeGreaterThanOrEqual(1);
    // The matched entry should be the Tennis 3D Game project
    expect(result.entries.some(e => e.name === 'Tennis 3D Game')).toBe(true);
  });

  it('returns resolved:false for greetings', async () => {
    const result = await quickResolve('hello, how are you?');
    expect(result.resolved).toBe(false);
    expect(result.strategy).toBe('none');
    expect(result.entries).toHaveLength(0);
  });

  it('returns resolved:false for agentic requests with no known names', async () => {
    const result = await quickResolve('build me a website with a login page');
    expect(result.resolved).toBe(false);
    expect(result.strategy).toBe('none');
  });

  it('returns resolved:false for code that does not exist in database', async () => {
    const result = await quickResolve('Show me WHO.CT-999999');
    expect(result.resolved).toBe(false);
  });
});
```

### IMPORTANT: About the name search test

Test "resolves name search for known entry" depends on `queryEntries({ name: 'Tennis 3D Game' })` returning the seeded entry. If `queryEntries` does not support name filtering, or if it does exact match only and the search term extracted by `extractSearchTerms` does not exactly match, this test may fail.

**If it fails**, read the `extractSearchTerms` output for `'tell me about Tennis 3D Game'` and check what term it extracts. Then check what `queryEntries({ name: ... })` actually matches against. Adjust the test input message so the extracted term matches the seeded entry name. Do NOT change `extractSearchTerms` or `queryEntries` — change the test input.

### After Batch 2

```bash
pnpm build && pnpm test
```

All existing tests PLUS all 18 new tests must pass.

---

## BATCH 3 — Wire `quickResolve` into `core/agent.ts`

This is the most sensitive batch. You are editing the main agent loop.

### Step 1: Read before you edit

```bash
cat core/agent.ts
```

Find the `processMessage` function. Identify:
- Where the fast-path bypasses end (after `/log`, `/meeting`, direct code fetch)
- Where decomposition starts (the call to `decomposeMessage`)
- How the function returns its result (the `AgentResponse` type shape)
- How the LLM is called (the handler variable name and method)
- How conversation history is accessed

### Step 2: Add the import

At the top of `core/agent.ts`, add:

```typescript
import { quickResolve } from './memory/quick-resolve.js';
```

### Step 3: Find the insertion point

Look for the gap between the LAST fast-path bypass and the FIRST line of decomposition logic. The code structure looks roughly like:

```typescript
// ... fast-path: /log, /meeting, direct code fetch ...

// <<< INSERT HERE >>>

// Decomposition
const decomposition = await decomposeMessage(message, ...);
```

### Step 4: Insert the quick-resolve block

Insert this block at the insertion point:

```typescript
// ── Quick-resolve: deterministic retrieval, no LLM call ──
const quickResult = await quickResolve(message);
if (quickResult.resolved && quickResult.entries.length > 0) {
  // Build memory context from resolved entries
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

  // Single LLM call with resolved memory — skip decomposition entirely
  const systemPrompt = `You are Zaraban, a personal AI assistant with persistent memory.
The user asked a question and your memory system already found the relevant entries.
Answer using ONLY the retrieved data below. Be concise and direct. Do not invent information.

## Retrieved Memory (${quickResult.strategy}, ${quickResult.entries.length} entries)

${memoryContext}`;

  // >>> ADAPT THIS SECTION TO MATCH YOUR CODEBASE <<<
  // Use whatever LLM call pattern processMessage already uses.
  // Below is a TEMPLATE — replace with the real variable names and method calls.
  const reply = await llmHandler.chat([
    { role: 'system', content: systemPrompt },
    // Include recent conversation history — copy however the codebase does it
    { role: 'user', content: message }
  ]);

  // Return in the same shape as other early exits in processMessage
  return {
    reply: typeof reply === 'string' ? reply : (reply?.content || reply?.text || String(reply)),
    intent: 'query',
    resolved: quickResult.entries,
  };
}
// ── End quick-resolve ──
```

### CRITICAL ADAPTATION NOTES

The template above uses `llmHandler.chat(...)` and returns `{ reply, intent, resolved }`. **These are placeholders.** You MUST adapt them:

1. **LLM call**: Find how other parts of `processMessage` call the LLM. It might be:
   - `llmHandler.chat(messages)`
   - `llmHandler(messages)`
   - `callLLM(messages, llmHandler)`
   - `handler.generate({ system, messages })`
   - Something else entirely

   Copy the exact pattern used by the conversational path or the fast-path responses.

2. **Conversation history**: Find how other parts of `processMessage` include conversation history. It might be:
   - A `history` parameter passed into `processMessage`
   - `getHistory()` function call
   - `sessionLog.getRecent(6)` or similar
   - The history might be in `messages` array passed to the function

   Include the last 6 turns (or however many the codebase normally includes) between the system message and the user message.

3. **Return type**: Find the exact return type of `processMessage`. Look at other `return` statements in the function. The return object likely has more fields than just `reply`, `intent`, `resolved`. Match all required fields. Set optional fields to appropriate defaults.

   For example, if other returns include `{ reply, intent, resolved, created, error, retries }`, add:
   ```typescript
   return {
     reply: '...',
     intent: 'query',
     resolved: quickResult.entries,
     created: undefined,
     error: undefined,
     retries: 0,
   };
   ```

4. **Intent type**: The `intent` field may require a specific type value from an enum or union type. Check `core/types.ts` for what values are valid. Use `'query'` if it exists, or the closest equivalent.

5. **The LLM reply extraction**: The LLM may return a string directly, or an object like `{ content: string }`, or `{ choices: [{ message: { content: string } }] }`. Check how other code paths extract the text from LLM responses and copy that pattern.

### What NOT to do in Batch 3

- ❌ Do NOT remove or modify the existing decomposition pipeline. Quick-resolve is an early exit. If `quickResult.resolved` is false OR `quickResult.entries.length === 0`, the code falls straight through to the existing pipeline.
- ❌ Do NOT add a new function for building the system prompt — inline it in the block above.
- ❌ Do NOT call `decomposeMessage` inside the quick-resolve block.
- ❌ Do NOT add transparency events (defer to a later sprint).

### After Batch 3

```bash
pnpm build && pnpm test
```

Every single test — old and new — must pass.

---

## BATCH 4 — Final Verification

Run the full test suite one final time:

```bash
pnpm build && pnpm test
```

Report:
1. Total test count
2. Pass/fail count
3. Build status (zero TypeScript errors required)

If everything passes, tag:
```bash
git tag phase-19c-quick-resolve
```

---

## WHAT YOU MUST NOT DO — EXPLICIT PROHIBITIONS

1. ❌ Do NOT create new TypeScript types for things that already exist (IndexEntry, SearchResult, AgentResponse, etc.)
2. ❌ Do NOT add `console.log` or `console.debug` debugging statements
3. ❌ Do NOT add transparency events (defer to a later sprint)
4. ❌ Do NOT modify `core/router.ts`, `core/decomposition.ts`, `core/query-loop.ts`, `core/planner.ts`, `core/executor.ts`, `core/memory/unit-search.ts`
5. ❌ Do NOT modify any existing test file
6. ❌ Do NOT change the signatures of `queryEntries`, `getEntryByCode`, `fetchByCode`, or any existing function
7. ❌ Do NOT install new npm packages
8. ❌ Do NOT add new columns or tables to the SQLite schema
9. ❌ Do NOT create "utility" or "helper" files beyond what is specified
10. ❌ Do NOT refactor existing code while you're in there
11. ❌ Do NOT skip `pnpm build && pnpm test` between batches
12. ❌ Do NOT proceed to the next batch if the current batch has failures
13. ❌ Do NOT add listing/vocabulary detection — that is already done by Phase 19 in `unit-search.ts`
14. ❌ Do NOT add hybridSearch calls — the normal pipeline already handles that as a fallback

---

## SUMMARY

| Batch | Action | Files | New Tests |
|-------|--------|-------|-----------|
| 0 | Read codebase (no code changes) | 0 | 0 |
| 1 | Create `core/memory/quick-resolve.ts` | 1 new | 0 |
| 2 | Create `tests/phase19/quick-resolve.test.ts` | 1 new | 18 |
| 3 | Wire into `core/agent.ts` | 1 edit | 0 |
| 4 | Final verification + tag | 0 | 0 |

**New code**: ~150 lines in `quick-resolve.ts`, ~180 lines in tests, ~35 lines in `agent.ts`.
**New tests**: 18 (5 extractCodes + 6 extractSearchTerms + 7 quickResolve integration).
**Risk**: Low. Quick-resolve is an early exit. If it returns `resolved: false`, the existing pipeline runs unchanged. Phase 19 list-intent detection is untouched and continues to work inside the pipeline.
