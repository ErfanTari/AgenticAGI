# Claw-Parity Adoptions — Master Plan

Source project: `claw-code-parity-main` (Rust CLI harness for Claude Code)
Target project: Zaraban / AgenticAGI
Analysis date: 2026-04-03

---

## What We Adopted and Why

`claw-code-parity-main` is a production Rust rewrite of the Claude Code CLI with
deterministic parity testing, explicit permission enforcement, and sandbox-aware
execution. Zaraban shares architectural goals but is missing several safety,
testing, and persistence primitives that claw takes for granted. This plan
adopts only the ideas — not the Rust code.

---

## 9 Adoptions — Priority Order

### P0 — Do These First (Safety, Zero Risk)

| # | Adoption | Files | Instance |
|---|---|---|---|
| 1 | **Workspace boundary validation** | `tools/file_reader.ts`, `tools/file_writer.ts` | A |
| 2 | **Binary file detection** | `tools/file_reader.ts` | A |
| 3 | **Mock LLM harness** | new `tests/mocks/` | B |

### P1 — High Value, Low Disruption

| # | Adoption | Files | Instance |
|---|---|---|---|
| 4 | **Permission enforcement layer** | new `core/permission.ts`, `skills/types.ts`, `runner.ts` | A |
| 5 | **Auto-compact threshold trigger** | `core/context.ts` (~5 lines) | B |

### P2 — Medium Priority, Isolated Modules

| # | Adoption | Files | Instance |
|---|---|---|---|
| 6 | **Config Zod validation on startup** | new `core/config.ts`, `chat.ts` | A |
| 7 | **Session JSONL persistence** | new `core/session/session-log.ts`, `chat.ts` | B |

### P3 — Lower Priority, Nice to Have

| # | Adoption | Files | Instance |
|---|---|---|---|
| 8 | **Skill registry singleton freeze** | `core/skills/registry.ts` | A |
| 9 | **Sandbox detection for run_bash** | `tools/run_bash.ts` | B |

---

## Phase Mapping

These adoptions become Phase 17 of Zaraban.

```
Phase 17A — Security & Permission Layer    (Instance A)
Phase 17B — Testing & Session Persistence  (Instance B)
```

Both tracks run in parallel. They have no overlapping files.

---

## File Ownership by Instance

### Instance A owns:
```
core/skills/tools/file_reader.ts    ← boundary check + binary detection
core/skills/tools/file_writer.ts    ← boundary check
core/permission.ts                  ← NEW: permission level definitions + enforcer
core/skills/types.ts                ← add permissionLevel field to MCPSkill
core/skills/runner.ts               ← call enforcer before runSkill()
core/config.ts                      ← NEW: Zod config validation
core/skills/registry.ts             ← freeze map after init
chat.ts                             ← call validateConfig() on startup
```

### Instance B owns:
```
tests/mocks/MockLLMHandler.ts       ← NEW: deterministic LLM mock
tests/mocks/scenarios/              ← NEW: scripted response scenarios
core/context.ts                     ← add ~5-line threshold trigger
core/session/session-log.ts         ← NEW: JSONL session persistence
core/skills/tools/run_bash.ts       ← add sandbox detection
```

**Zero overlap.** If both instances run simultaneously neither will conflict.

---

## Acceptance Criteria per Adoption

### 1. Workspace Boundary Validation
- `file_reader` and `file_writer` resolve the real path via `fs.realpathSync`
- If resolved path does not start with `PATHS.workspace`, return `{ success: false, error: 'Path escapes workspace boundary' }`
- Symlink traversal produces the same error
- Tests: attempt `../../../etc/passwd` → blocked; normal workspace path → allowed

### 2. Binary File Detection
- Read first 8 KB of file, check for NUL byte (0x00)
- If binary: return `{ success: false, error: 'Binary file — cannot read as text' }`
- Does not throw; does not crash on large files
- Tests: pass a compiled binary → blocked; pass a UTF-8 text file → allowed

### 3. Mock LLM Handler
- `MockLLMHandler` implements the same `LLMHandler` interface used by `core/llm.ts`
- Constructor accepts `{ triggerPhrase: string; response: string }[]`
- Matches on `includes()` of last user message content
- Throws a clear error if no scenario matched (prevents silent empty replies)
- Used in at least 3 new integration tests: planner, executor, decomposition

### 4. Permission Enforcement Layer
- `MCPSkill` interface gains `permissionLevel: 'read-only' | 'workspace-write' | 'full-access'`
- All 15 skills annotated (see mapping in Instance A doc)
- `PERMISSION_MODE` env var (default: `workspace-write`) read in `core/config.ts`
- `enforcePermission(skill, mode)` called in `runner.ts` before every skill execution
- Returns `{ success: false, error: 'Permission denied: ...' }` instead of throwing
- Tests: `run_bash` called in `read-only` mode → denied; `web_search` in `read-only` → allowed

### 5. Auto-Compact Threshold
- `buildContext()` checks estimated token count before returning
- If tokens > 100,000 and circuit is closed: call `compactContext()` inline
- Does not double-compact (guard: skip if already compacted this call)
- Tests: mock history with 110K tokens → compaction triggered; 90K → not triggered

### 6. Config Zod Validation
- `validateConfig()` called at the very start of `chat.ts` / `startAgent()`
- Schema validates: `LLM_ENDPOINT` (URL), `LLM_MODEL` (non-empty string), optional fields with sensible defaults
- On failure: prints human-readable error per field, calls `process.exit(1)`
- On success: exports a typed `Config` object used everywhere instead of raw `process.env`
- Tests: missing `LLM_ENDPOINT` → exit 1; valid config → no error

### 7. Session JSONL Persistence
- Each conversation turn `{ role, content, ts }` appended to `~/.zaraban/sessions/<YYYY-MM-DD>_<id>.jsonl`
- File rotated at 256 KB; max 3 rotations kept
- `loadLastSession(n?)` returns last N turns for context on resume
- `chat.ts` calls `sessionLog.append()` after every user message and every assistant reply
- Tests: write 3 turns → file exists → `loadLastSession(3)` returns all 3

### 8. Skill Registry Singleton
- `registry` Map sealed with `Object.freeze` or a boolean `_initialized` guard after all `registerSkill()` calls
- Calling `registerSkill()` after freeze logs a warning and no-ops (does not throw)
- `_resetRegistry()` exported for test isolation only
- Tests: register skill → freeze → try register another → warning, count unchanged

### 9. Sandbox Detection for run_bash
- `detectSandboxSupport()` tries `unshare --user --pid echo ok` on first call; caches result
- Result surfaced in `run_bash` output header: `[sandbox: full]` or `[sandbox: none]`
- When `PERMISSION_MODE=full-access` + sandbox=none: prepend a one-line warning to output
- Tests: mock `execSync` to throw → returns `'none'`; mock to succeed → returns `'full'`

---

## Definition of Done — Phase 17

- [ ] All 9 adoptions implemented
- [ ] All existing 770 tests still pass
- [ ] At least 25 new tests covering the new code (split ~15 Instance A, ~10 Instance B)
- [ ] `pnpm build` clean (zero TypeScript errors)
- [ ] `pnpm stress:p15:codex` still 8/8
- [ ] CLAUDE.md updated with Phase 17 section
- [ ] Git tag: `phase-17-complete`

---

## What We Explicitly Did NOT Adopt

These were considered and rejected for now:

| Claw feature | Why not |
|---|---|
| LSP integration | No IDE use case in current Zaraban scope |
| Session forking / branching | Adds complexity without clear user benefit yet |
| OAuth credential management | Not relevant (local-first, no cloud auth) |
| Team/Cron registries | Zaraban already has heartbeat; cron not needed yet |
| Structured patch hunks | Would require rewriting `file_writer`; deferred to Phase 18+ |
| Plugin lifecycle system | MCP skills already serve this role |
| Streaming SSE UI events | Future work — UI not primary interface |

---

## Next Phase After 17 (Preview)

Phase 18 will address the internal gaps identified during Zaraban exploration:
- Multi-turn collaborative planning (pause mid-milestone → ask user)
- Cross-project dependency tracking in heartbeat
- Episodic memory used during planning (feed similar past tasks to planner)
- Hierarchical milestones (epic → story → task)
- Skill composition (steps can reference other steps as sub-steps)
