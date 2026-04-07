# Phase 17B Instance B — Testing Infrastructure & Session Persistence
## Completion Report

**Status:** ✅ COMPLETE  
**Date:** 2026-04-03  
**Test Results:** 17/17 tests pass  

---

## Summary

Phase 17B Instance B implements four key infrastructure components for Zaraban:

1. **Task 3 — Mock LLM Handler** — Deterministic LLM responses for end-to-end testing
2. **Task 5 — Auto-Compact Threshold** — 100K token limit compaction trigger
3. **Task 7 — Session JSONL Persistence** — Conversation logging with rotation
4. **Task 9 — Sandbox Detection** — Runtime isolation status detection

---

## Deliverables

### Task 3: Mock LLM Handler

**File:** `tests/mocks/MockLLMHandler.ts`

- `MockLLMHandler` class with scenario-based matching
- Stores call history for assertions
- `reset()` method for test isolation

**Scenario Files:**
- `tests/mocks/scenarios/decompose-simple.ts` — Single agentic unit decomposition
- `tests/mocks/scenarios/plan-file-write.ts` — Multi-step file write plan (JSON)
- `tests/mocks/scenarios/conversational.ts` — Plain text conversational responses

**Test Coverage (4 tests):**
- ✅ Trigger matches → returns correct response
- ✅ No match → throws with clear error
- ✅ Multiple scenarios → first match wins
- ✅ `reset()` clears call history

### Task 5: Auto-Compact Token Threshold

**File:** `core/context.ts`

**Implementation:**
- `AUTO_COMPACT_THRESHOLD = 100_000` constant added
- Compaction triggered when `tokens > 100K` AND circuit is closed AND not already compacted
- Uses same compaction logic as 70% trigger (LLM-based summarization)
- `alreadyCompacted` flag prevents double-compaction

**Test Coverage (2 tests):**
- ✅ Constant defined in context.ts
- ✅ Threshold guard uses circuit breaker + alreadyCompacted flag

### Task 7: Session JSONL Persistence

**File:** `core/session/session-log.ts`

**Features:**
- `SessionLog` class writes conversation turns to JSONL
- Automatic file rotation at 256 KB (keeps 3 backups)
- `append(turn)` — fire-and-forget (never throws)
- `loadLast(n)` — read last N turns in order
- Singleton via `currentSession()`
- `_resetSession()` for test isolation

**Wire-up:** `chat.ts`
- Imported `currentSession` from `session-log.js`
- Calls `append()` after user input (with ISO timestamp)
- Calls `append()` after assistant reply (with ISO timestamp)

**Test Coverage (4 tests):**
- ✅ `append()` creates file and writes valid JSON
- ✅ `loadLast(3)` returns correct last 3 turns
- ✅ File > 256 KB triggers rotation to `.1` backup
- ✅ `append()` failure (unwritable dir) does not throw

### Task 9: Sandbox Detection

**File:** `core/skills/tools/run_bash.ts`

**Implementation:**
- `detectSandbox()` — cached detection using `execSync('unshare --user --pid echo ok')`
- 2-second timeout (non-blocking, never crashes)
- Returns `'full'` (sandboxed) or `'none'` (unsandboxed)
- `_setSandboxStatus(s)` — test injection for mocking

**Warning Prefix:**
- When `sandbox === 'none'` AND `PERMISSION_MODE === 'full-access'`
- Prepends `[warning: no sandbox — running without isolation]\n` to output

**Test Coverage (2 tests):**
- ✅ Mocked success → `detectSandbox()` returns `'full'`
- ✅ Mocked failure → `detectSandbox()` returns `'none'` + warning in full-access mode

---

## Test File

**File:** `tests/phase17/instance-b.test.ts`

**Total Tests:** 17 (all passing)

```
Task 3: MockLLMHandler        4 tests ✓
Task 5: Auto-Compact         2 tests ✓
Task 7: Session JSONL        4 tests ✓
Task 9: Sandbox Detection    2 tests ✓
Task 7b: Chat.ts Wiring      2 tests ✓
Task 3b: Scenario Files      3 tests ✓
────────────────────────────────────
Total                        17 tests ✓
```

### Running Tests

```bash
cd /Users/erfantari/Claude_Code/Projects/AgenticAGI
pnpm test tests/phase17/instance-b.test.ts
```

---

## Architecture Notes

### Session JSONL Lifecycle

1. User types message → `append()` with role=user
2. Agent replies → `append()` with role=assistant
3. Each turn timestamped in ISO format
4. File at `~/.zaraban/sessions/{YYYY-MM-DD}_{sessionId}.jsonl`
5. Auto-rotation at 256 KB (max 3 rotations kept)

### Sandbox Detection Caching

- First call: runs `execSync` with 2s timeout
- Subsequent calls: returns cached value
- For testing: `_setSandboxStatus(null)` clears cache

### Auto-Compact Threshold

- Second compaction trigger (first is 70% of MAX_TOKENS)
- Fires independently: requires circuit closed + not already compacted
- Uses same LLM-based summarization as 70% trigger
- Emission: `context_compacted` transparency event

---

## File Manifest

**New Files:**
- `tests/mocks/MockLLMHandler.ts` (42 lines)
- `tests/mocks/scenarios/decompose-simple.ts` (15 lines)
- `tests/mocks/scenarios/plan-file-write.ts` (28 lines)
- `tests/mocks/scenarios/conversational.ts` (17 lines)
- `core/session/session-log.ts` (89 lines)
- `tests/phase17/instance-b.test.ts` (275 lines)

**Modified Files:**
- `core/context.ts` — Added auto-compact threshold trigger (~30 lines)
- `core/skills/tools/run_bash.ts` — Added sandbox detection (~25 lines, 2 exports)
- `chat.ts` — Wired session logging (4 lines added)

---

## Verification Checklist

- [x] Task 3: `MockLLMHandler.ts` created
- [x] Task 3: 3 scenario files in `tests/mocks/scenarios/`
- [x] Task 3: Used in 2+ integration test patterns
- [x] Task 5: `core/context.ts` has 100K threshold trigger
- [x] Task 5: Threshold only fires when circuit is closed (alreadyCompacted guard)
- [x] Task 7: `core/session/session-log.ts` created
- [x] Task 7: `chat.ts` calls `append()` after user input + after assistant reply
- [x] Task 9: `run_bash.ts` has cached `detectSandbox()` with 2s timeout
- [x] Task 9: Warning prefix added when `sandbox=none` + `PERMISSION_MODE=full-access`
- [x] Tests: `tests/phase17/instance-b.test.ts` with ≥12 tests (17 total)
- [x] All tests pass (17/17)

---

## Ready for Full Test Suite

When combined with Phase 17A (Instance A) work:

```bash
# Full test suite
pnpm test
pnpm build
pnpm stress:p15:codex

# Then one instance updates CLAUDE.md and creates tag
```

Both instance B deliverables are stable, isolated, and ready for integration.
