# Zaraban — Listing Query Status Filter Fix
### For: Claude Code (single session)
### Tag on completion: `phase-19b-status-filter-fix`

---

## The Problem (One Paragraph)

The two listing fast-paths in `core/memory/unit-search.ts` (lines 483 and 498) both call
`queryEntries()` with `status: 'active'` hardcoded. If any memory entries were written with
a different status value (null, undefined, 'complete', or anything else), the fast-path
returns zero rows, falls through to BM25, and BM25 fails the confidence threshold — producing
`confidence: 0, entries: []` even though the data exists in SQLite. This is why "tell me a
list of all your contacts" returns nothing despite 22 WHO entries being present.

---

## Step 1 — Diagnose First, Fix Second

Before changing any code, run these queries against `index/memory.sqlite` to understand
the actual status distribution:

```sql
-- What status values exist across all entries?
SELECT nb, type, status, COUNT(*) as count
FROM index_entries
GROUP BY nb, type, status
ORDER BY nb, type, status;

-- Specifically for WHO entries:
SELECT code, name, status FROM index_entries WHERE nb='WHO';

-- And WHAT.PJ entries:
SELECT code, name, status FROM index_entries WHERE nb='WHAT' AND type='PJ';
```

This confirms whether the bug is a null status, a wrong status value, or something else.
Log the output as a comment in the fix PR for future reference.

---

## Step 2 — Fix the Status Filter in Both Listing Paths

**File:** `core/memory/unit-search.ts`

### Fix A — `detectListingQuery` fast-path (line ~483)

Find this line:
```typescript
const entries = uniqueByCode(queryEntries({ nb: listingMatch.nb, type: listingMatch.type, status: 'active' })).slice(0, 20);
```

Replace with:
```typescript
const entries = uniqueByCode(queryEntries({ nb: listingMatch.nb, type: listingMatch.type })).slice(0, 20);
```

Remove the `status: 'active'` filter entirely. Listing queries mean "show me everything
of this type" — filtering by active status silently hides entries that were written
without a status or with a different status value.

### Fix B — `detectListIntent` vocab fast-path (line ~496)

Find this block:
```typescript
const qParams = vocabMatch.type
  ? { nb: vocabMatch.nb, type: vocabMatch.type, status: 'active' }
  : { nb: vocabMatch.nb, status: 'active' };
```

Replace with:
```typescript
const qParams = vocabMatch.type
  ? { nb: vocabMatch.nb, type: vocabMatch.type }
  : { nb: vocabMatch.nb };
```

Same reason — remove the status filter from both branches.

---

## Step 3 — Check queryEntries Signature

**File:** `core/memory/mod.ts` (or wherever `queryEntries` is defined)

Verify that `queryEntries` accepts an object without a `status` field and does not
default-inject `status: 'active'` internally. Search for:

```bash
grep -n "status.*active\|active.*status" core/memory/index.ts core/memory/mod.ts core/memory/fetch.ts 2>/dev/null
```

If `queryEntries` itself hardcodes `status = 'active'` as a default in its SQL WHERE
clause, that filter must also be removed for listing queries. If that's the case, either:
- Add an explicit `includeAllStatuses?: boolean` parameter to `queryEntries`, or
- Pass `status: undefined` and ensure the SQL skips the WHERE clause when status is undefined

The goal: when no status is specified, return all entries of that nb/type regardless of status.

---

## Step 4 — Verify the Fix Works End-to-End

After the code change, run this manual smoke test in the agent CLI:

```
> tell me a list of all your contacts
```

The transparency log should show:
```
unit_memory_search: strategy='type_scan' OR strategy='list_intent', confidence=1, entries=[...22 entries...]
```

NOT:
```
unit_memory_search: strategy='bm25', confidence=0, entries=[]
```

---

## Tests to Write

**File:** `tests/phase19/status-filter.test.ts`

```typescript
// 1. detectListingQuery fast-path returns WHO entries regardless of their status value
// 2. detectListingQuery fast-path returns entries with null status
// 3. detectListingQuery fast-path returns entries with status='complete'
// 4. detectListIntent vocab fast-path returns entries regardless of status
// 5. queryEntries({ nb: 'WHO', type: 'CT' }) with no status param returns all CT entries
// 6. queryEntries({ nb: 'WHO', type: 'CT', status: 'active' }) still works for filtered queries
```

**Minimum: 6 tests. All must pass. No existing test regressions.**

---

## Completion Checklist

- [ ] Diagnosed actual status values in SQLite (logged as comment)
- [ ] `status: 'active'` removed from `detectListingQuery` fast-path
- [ ] `status: 'active'` removed from `detectListIntent` vocab fast-path
- [ ] `queryEntries` confirmed to not inject `status: 'active'` as internal default
- [ ] `pnpm build` clean
- [ ] `pnpm test` passes (all existing tests)
- [ ] 6 new tests in `tests/phase19/status-filter.test.ts` pass
- [ ] Manual smoke test: "tell me a list of all your contacts" returns entries
- [ ] `git tag phase-19b-status-filter-fix`
