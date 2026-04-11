# README Diff Report — Docs vs Code

Discrepancies between `README.clean.md` (what CLAUDE.md claims) and `README.actual.md` (what the code does).

---

## Summary

| Category | Count |
|----------|-------|
| Documented but not in code | 4 |
| In code but not documented | 14 |
| Schema mismatches | 3 |
| Skills list discrepancies | 3 |
| Route/strategy discrepancies | 5 |
| Behavior mismatches | 6 |

---

## Discrepancies

| # | Item | In Docs (README.clean.md) | In Code (README.actual.md) | Status |
|---|------|--------------------------|---------------------------|--------|
| 1 | **`runSimplePlan` vs `runQueryLoop`** | Docs say LOW/MEDIUM → QueryLoop | Code has two separate paths: LOW/MEDIUM → `runSimplePlan()` (sequential planner steps) OR directly → `runQueryLoop()` (while-loop). `runSimplePlan` is the planner path for simple plans; `runQueryLoop` is the while-loop engine. They are not the same. | **Mismatch** |
| 2 | **Quick complexity pre-check** | Not mentioned in docs | `agent.ts` has an additional early fast-path (step [3]) that calls `assessComplexity()` BEFORE intake/decomposition for clearly-agentic non-compound messages, and routes LOW/MEDIUM directly to `runQueryLoop`. Saves ~15s. | **Undocumented** |
| 3 | **Pre-decomposition action skill fast-path** | Not mentioned in docs | `agent.ts` has a `PRE_DECOMP_ACTION_SKILLS` path that handles `file_writer` and `run_bash` patterns before intake runs (step [5]). | **Undocumented** |
| 4 | **Compatibility shim exists after decomposition** | Docs say "narrow shim for simple cases" with no detail on when it runs | Shim runs AFTER decomposition (not instead of it), uses `buildSingleUnitCompatibilityClassification()`, handles 5 intent types (skill, memory_write, memory_query, relationship_query, code_fetch). Present-tense behavior not clearly described. | **Under-documented** |
| 5 | **`runSimplePlan` emits route event before loop** | Not documented | Route event now emits at the TOP of `runSimplePlan`, before any steps execute (fixed in this sprint). Docs don't describe where the event fires. | **Undocumented** |
| 6 | **FORCE_HIGH patterns (4 specific domains)** | Docs say "FORCE_HIGH signals" exist but don't list the 4 domains | Code has exactly 4 named patterns: `gameDev`, `appDev`, `scaffolding`, `rendering` — each with precise regex. | **Under-documented** |
| 7 | **Complexity thresholds from signal count** | Docs say "0 signals → LOW, 1-2 → MEDIUM, 3-4 → HIGH, 5+ → MAX" | Code: `0 → LOW`, `1-2 → MEDIUM`, `3-4 → HIGH`, `5+ → MAX`. Matches. But `derivePlanComplexity(stepCount)` also exists as fallback (≤2→LOW, ≤4→MEDIUM, ≤6→HIGH, 7+→MAX) — not mentioned in docs. | **Partially undocumented** |
| 8 | **History trimmed to 2 turns in QueryLoop** | Not mentioned in docs | `query-loop.ts` trims history to last 2 turns (not 6). Comment says "task state anchor replaces need for deep history." | **Undocumented** |
| 9 | **Active loop files extraction** | Docs describe format but not extraction method | Files in active loop entries are extracted from step outputs via regex `workspace/\S+\.\w+`, capped at 6. Not described in docs. | **Undocumented** |
| 10 | **`relationships` table has `strength` and `last_active` columns** | Not listed in schema | `ALTER TABLE relationships ADD COLUMN strength REAL DEFAULT 1.0` and `last_active TEXT` added in Phase 15 migrations. | **Schema omission** |
| 11 | **`index_entries` — `ttl_days`, `fingerprint`, `project_brain_cache` columns** | Listed in clean docs | Present in code as Phase 15 migration-added columns. Match. | **OK** |
| 12 | **`settings` table purpose** | Docs say "embedding model hash and other singleton values" | Code uses it for embedding model string storage (not a hash — full model name string). Also used by heartbeat. | **Minor mismatch** |
| 13 | **20 registered skills** | Docs list 20 skills | Code registers exactly 20 skills. Match — but docs list `generate_and_save_file` as `workspace-write` and that is correct. However: docs categorize `content_writer` as read-only, code confirms this. | **OK** |
| 14 | **Docs list 15 skills in Phase 17A annotation** | CLAUDE.md says "All 15 skills annotated with permissionLevel" | Code now has 20 skills. The claim "15 skills" reflects an old count — current is 20. README.clean.md corrects this by listing all 20 but the number "15" appears in the architecture description that was cleaned up. | **Stale count removed in clean** |
| 15 | **`confirm_plan` permission level** | Docs: `workspace-write` | Code: `workspace-write`. Match. | **OK** |
| 16 | **`glob` skill** | Not mentioned in docs at all | Registered in `registry.ts` as `read-only`. Separate `glob.ts` skill file exists. | **Undocumented skill** |
| 17 | **Session cache dedup guard** | Not mentioned in clean docs | `session-cache.ts` `set()` skips write if code already cached with same `updated` timestamp. Dedup guard prevents churn-stores on warm cache hits. | **Undocumented** |
| 18 | **BM25 relevance gate in unit-search** | Not mentioned in clean docs | `hasMeaningfulOverlap()` gates the generic BM25 fallback path. If all results are filtered, returns confidence: 0. Emits `unit_search_filtered` event. | **Undocumented** |
| 19 | **`extractRelation()` skip for quickResolve** | Docs say "modification commands fall through to full pipeline" | Code actually skips quickResolve entirely if `extractRelation(message) !== undefined` — a broader condition than just modification commands. | **Behavioral mismatch** |
| 20 | **Performance targets** | Docs give targets: <1s greeting, <50ms code fetch, etc. | No enforcement in code. Targets are aspirational, not asserted. `getTimeoutForModel` timeouts are actual limits. | **Aspirational, not enforced** |
| 21 | **`NOW.LOG` status = 'logged'** | Mentioned in clean docs | Code has both DDL default (`status NOT NULL`) and a startup migration that updates existing `status='active'` rows to `status='logged'`. | **OK** |
| 22 | **`WHAT.PJ` type** | Docs note it as "legacy; new projects use PLAN.PJ" | `TYPE_MAP` in `agent.config.ts` still includes `WHAT.PJ`. `router.ts` still writes WHAT.PJ entries via `persistFactualAssertions`. Not fully retired. | **Mismatch — WHAT.PJ still active in code** |
| 23 | **Heartbeat AutoDream threshold** | Docs: "idle >10 min" | Code: `AUTO_DREAM_IDLE_MS = 10 * 60 * 1000` (10 min). Match. | **OK** |
| 24 | **`query_loop_narration` transparency event** | Not in documented event list | `query_loop_narration` exists in `transparency.ts` but not mentioned in README.clean.md event list. | **Undocumented event** |
| 25 | **`continuation_context_loaded` transparency event** | Not in documented event list | Present in `transparency.ts`. Emitted from `router.ts` when resumable PLAN.EX context is injected. | **Undocumented event** |
| 26 | **`list_intent_detected` transparency event** | Not in documented event list | Present in `transparency.ts`. | **Undocumented event** |
| 27 | **`startup_prefetch`, `startup_prefetch_error`, `context_lazy_loaded` events** | Not in documented event list | Present in `transparency.ts`. | **Undocumented events** |
| 28 | **Auto-read step milestone sync** | Not documented | After `enforceFileReaderPrerequisite()` inserts auto-read steps, code now syncs them into the correct milestone's `steps[]` array (fixes orphan warning). This behavior is new and not in clean docs. | **Undocumented (new fix)** |

---

## Schema: Columns present in code but missing from CLAUDE.md documentation

| Column | Table | Present in Code | In CLAUDE.md docs |
|--------|-------|----------------|-------------------|
| `strength` | relationships | YES (Phase 15 migration) | NO |
| `last_active` | relationships | YES (Phase 15 migration) | NO |
| `ttl_days` | index_entries | YES (Phase 15 migration) | YES (mentioned in lifecycle) |
| `fingerprint` | index_entries | YES (Phase 15 migration) | NO (not in schema docs) |
| `project_brain_cache` | index_entries | YES (Phase 15 migration) | NO (not in schema docs) |

---

## Skills: Documented vs Registered

| Skill | In CLAUDE.md docs | In registry.ts | Permission |
|-------|------------------|---------------|------------|
| `calculator` | YES (Phase 6) | YES | read-only |
| `file_reader` | YES | YES | read-only |
| `web_search` | YES | YES | read-only |
| `file_writer` | YES | YES | workspace-write |
| `run_bash` | YES | YES | full-access |
| `memory_read` | YES | YES | read-only |
| `memory_write` | YES | YES | workspace-write |
| `content_writer` | YES | YES | read-only |
| `web_fetch` | YES | YES | read-only |
| `url_extract` | YES | YES | read-only |
| `relationship_write` | YES | YES | workspace-write |
| `implement_and_test` | YES | YES | full-access |
| `memory_history` | YES | YES | read-only |
| `verify_state` | YES | YES | read-only |
| `generate_and_save_file` | YES (deprecated note) | YES (deprecation removed in code) | workspace-write |
| `patch_file` | YES (Phase 18) | YES | workspace-write |
| `grep_workspace` | YES (Phase 18) | YES | read-only |
| `list_dir` | YES (Phase 18) | YES | read-only |
| `glob` | **NO** | **YES** | read-only |
| `confirm_plan` | YES | YES | workspace-write |

**`glob` skill registered but not documented anywhere in CLAUDE.md.**

---

## Routes/Strategies: Documented vs Implemented

| Item | In Docs | In Code | Notes |
|------|---------|---------|-------|
| LOW/MEDIUM → QueryLoop | YES | PARTIAL — only true for the pre-complexity path and coding route; planner path uses `runSimplePlan` for LOW/MEDIUM | **Misleading** |
| HIGH/MAX → Planner+Executor | YES | YES | Correct |
| `taskType=coding` → QueryLoop | YES | YES | Correct |
| Pre-decomposition quick-complexity check | NO | YES — in `agent.ts` step [3] | **Undocumented** |
| Pre-decomposition action skill fast-path | NO | YES — `PRE_DECOMP_ACTION_SKILLS` in `agent.ts` step [5] | **Undocumented** |
| Relationship intent skips quickResolve entirely | NO | YES — `extractRelation() !== undefined` check in agent.ts | **Undocumented** |
| `UnitSearchStrategy: list_intent` | Listed in types | Present in `types.ts` `UnitSearchStrategy` union | **OK** |
| `UnitSearchStrategy: bm25_person_scoped`, `bm25_project_scoped` | Not mentioned | Present in `types.ts` | **Undocumented** |
