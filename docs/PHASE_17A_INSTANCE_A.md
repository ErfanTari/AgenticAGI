# Phase 17A — Security & Permission Layer
### For: Claude Code Instance A (this session)

**Track:** Safety primitives + permission enforcement + config hardening  
**Parallel track:** Instance B handles `docs/PHASE_17B_INSTANCE_B.md`  
**No file overlap between the two tracks.**

Read `docs/CLAW_ADOPTIONS_PLAN.md` first for full context.

---

## Files You Own

```
core/skills/tools/file_reader.ts    ← task 1 + task 2
core/skills/tools/file_writer.ts    ← task 1
core/permission.ts                  ← NEW (task 4)
core/skills/types.ts                ← add permissionLevel (task 4)
core/skills/runner.ts               ← call enforcer (task 4)
core/config.ts                      ← NEW (task 6)
core/skills/registry.ts             ← freeze after init (task 8)
chat.ts                             ← validateConfig() call (task 6)
tests/phase17/instance-a.test.ts    ← NEW: your tests
```

Do NOT touch: `core/context.ts`, `tests/mocks/`, `core/session/`, `tools/run_bash.ts`

---

## Task 1 — Workspace Boundary Validation

**Files:** `tools/file_reader.ts`, `tools/file_writer.ts`

Both skills must resolve the real path and verify it stays inside `PATHS.workspace`.

```typescript
import fs from 'fs';
import path from 'path';
import { PATHS } from '../../../config/agent.config.js';

function assertWorkspaceBoundary(inputPath: string): void {
  const workspace = fs.realpathSync(PATHS.workspace);
  let resolved: string;
  try {
    resolved = fs.realpathSync(inputPath);
  } catch {
    // Path doesn't exist yet (file_writer creating new files) — check the dir instead
    resolved = fs.realpathSync(path.dirname(inputPath));
  }
  if (!resolved.startsWith(workspace + path.sep) && resolved !== workspace) {
    throw new Error(`Path escapes workspace boundary: ${inputPath}`);
  }
}
```

Call this at the very start of each skill's `execute()`, before any read/write.
Catch the thrown error and return `{ success: false, error: err.message }`.

**Note on `PATHS.workspace`:** Check `config/agent.config.ts` — it was added in Phase 11.
If it is undefined in tests, default to `process.cwd()`.

---

## Task 2 — Binary File Detection

**File:** `tools/file_reader.ts` only

After the boundary check, before reading the full file:

```typescript
function isBinaryFile(filePath: string): boolean {
  const SAMPLE_SIZE = 8192;
  const buf = Buffer.allocUnsafe(SAMPLE_SIZE);
  const fd = fs.openSync(filePath, 'r');
  const bytesRead = fs.readSync(fd, buf, 0, SAMPLE_SIZE, 0);
  fs.closeSync(fd);
  return buf.slice(0, bytesRead).includes(0x00);
}
```

If binary: return `{ success: false, output: '', error: 'Binary file — cannot read as text' }`.

Edge cases:
- File is < 8 KB: `bytesRead` will be smaller — `slice(0, bytesRead)` handles this correctly
- File does not exist: boundary check already returned an error before reaching here
- File is empty: `bytesRead === 0`, `includes(0x00)` on empty buffer → false (correct)

---

## Task 3 — (Skipped in this track — owned by Instance B)

---

## Task 4 — Permission Enforcement Layer

### Step 4a: Extend `core/skills/types.ts`

Add `permissionLevel` to `MCPSkill`:

```typescript
export type PermissionLevel = 'read-only' | 'workspace-write' | 'full-access';

export interface MCPSkill {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  permissionLevel: PermissionLevel;   // ← ADD THIS
  execute(input: Record<string, unknown>): Promise<SkillResult>;
}
```

### Step 4b: Annotate all 15 skills

Edit each skill file in `tools/` to add the `permissionLevel` field:

| Skill | Level |
|---|---|
| `calculator` | `'read-only'` |
| `file_reader` | `'read-only'` |
| `memory_read` | `'read-only'` |
| `web_search` | `'read-only'` |
| `web_fetch` | `'read-only'` |
| `url_extract` | `'read-only'` |
| `memory_history` | `'read-only'` |
| `content_writer` | `'read-only'` |
| `file_writer` | `'workspace-write'` |
| `memory_write` | `'workspace-write'` |
| `relationship_write` | `'workspace-write'` |
| `generate_and_save_file` | `'workspace-write'` |
| `verify_state` | `'workspace-write'` |
| `run_bash` | `'full-access'` |
| `implement_and_test` | `'full-access'` |

### Step 4c: Create `core/permission.ts`

```typescript
import type { PermissionLevel } from './skills/types.js';

const LEVEL_RANK: Record<PermissionLevel, number> = {
  'read-only': 0,
  'workspace-write': 1,
  'full-access': 2,
};

export function enforcePermission(
  skillName: string,
  requiredLevel: PermissionLevel,
  activeMode: PermissionLevel,
): { allowed: boolean; error?: string } {
  if (LEVEL_RANK[requiredLevel] <= LEVEL_RANK[activeMode]) {
    return { allowed: true };
  }
  return {
    allowed: false,
    error: `Permission denied: skill '${skillName}' requires '${requiredLevel}' but active mode is '${activeMode}'`,
  };
}

export function getActivePermissionMode(): PermissionLevel {
  const mode = process.env.PERMISSION_MODE ?? 'workspace-write';
  if (mode === 'read-only' || mode === 'workspace-write' || mode === 'full-access') {
    return mode;
  }
  console.warn(`[permission] Unknown PERMISSION_MODE '${mode}', defaulting to workspace-write`);
  return 'workspace-write';
}
```

### Step 4d: Call enforcer in `core/skills/runner.ts`

In `runSkill()` (or equivalent), before executing the skill:

```typescript
import { enforcePermission, getActivePermissionMode } from '../permission.js';

const mode = getActivePermissionMode();
const check = enforcePermission(skill.name, skill.permissionLevel, mode);
if (!check.allowed) {
  return { success: false, output: '', error: check.error };
}
```

This must run **before** `runWithRetry()` or any execution attempt.

---

## Task 5 — (Skipped in this track — owned by Instance B)

---

## Task 6 — Config Zod Validation on Startup

### Step 6a: Create `core/config.ts`

```typescript
import { z } from 'zod';

const ConfigSchema = z.object({
  LLM_ENDPOINT: z.string().url('LLM_ENDPOINT must be a valid URL'),
  LLM_MODEL: z.string().min(1, 'LLM_MODEL must be non-empty'),
  EMBEDDING_MODEL: z.string().optional(),
  EMBEDDING_ENDPOINT: z.string().url().optional(),
  PERMISSION_MODE: z
    .enum(['read-only', 'workspace-write', 'full-access'])
    .default('workspace-write'),
  LLM_FALLBACK_PROVIDER: z.enum(['gemini', 'anthropic', 'none']).optional(),
  LLM_FALLBACK_MODEL: z.string().optional(),
  TRANSPARENT: z.string().optional(),
  DEBUG_PLANNER: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

let _config: Config | null = null;

export function validateConfig(): Config {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    console.error('\n[config] Startup validation failed:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    console.error('');
    process.exit(1);
  }
  _config = result.data;
  return _config;
}

export function getConfig(): Config {
  if (!_config) return validateConfig();
  return _config;
}

// For test isolation only
export function _resetConfig(): void { _config = null; }
```

### Step 6b: Call in `chat.ts`

At the very top of `chat.ts`, before `startAgent()` or any imports that use env vars:

```typescript
import { validateConfig } from './core/config.js';
validateConfig();
```

This is the only change to `chat.ts`. Do not move other logic.

---

## Task 7 — (Skipped in this track — owned by Instance B)

---

## Task 8 — Skill Registry Singleton Freeze

**File:** `core/skills/registry.ts`

After all `registerSkill()` calls at the bottom of the file, add:

```typescript
let _frozen = false;

// Override registerSkill to warn after freeze
const _originalRegister = registerSkill;
export function registerSkill(skill: MCPSkill): void {
  if (_frozen) {
    console.warn(`[registry] Attempted to register '${skill.name}' after registry was frozen. Ignored.`);
    return;
  }
  registry.set(skill.name, skill);
}

// Called automatically after all built-in skills are registered
function freezeRegistry(): void {
  _frozen = true;
}

// ... (all existing registerSkill calls remain) ...
// After the last registerSkill() call:
freezeRegistry();

// For test isolation
export function _resetRegistry(): void {
  registry.clear();
  _frozen = false;
}
```

**Important:** The existing `registry` Map stays mutable for the `_resetRegistry()` path. The freeze only prevents post-init additions in production flow.

---

## Tests to Write

Create `tests/phase17/instance-a.test.ts`.

Minimum test cases (target: 15 tests):

### Boundary validation (4 tests)
1. `file_reader` with `../../../etc/passwd` → `success: false`, error contains "boundary"
2. `file_writer` with symlink pointing outside workspace → `success: false`
3. `file_reader` with valid workspace path → proceeds to read (or binary check)
4. `file_writer` creating new file in workspace subdir → allowed

### Binary detection (3 tests)
5. File with NUL bytes → `success: false`, error contains "Binary"
6. Plain text file → not blocked by binary check
7. Empty file → not blocked by binary check

### Permission enforcement (4 tests)
8. `run_bash` in `read-only` mode → `success: false`, error contains "Permission denied"
9. `file_writer` in `read-only` mode → denied
10. `web_search` in `read-only` mode → allowed (proceeds to execute)
11. `run_bash` in `full-access` mode → allowed

### Config validation (2 tests)
12. Missing `LLM_ENDPOINT` → `validateConfig()` calls `process.exit(1)` (mock exit)
13. Valid env → returns typed Config object

### Registry freeze (2 tests)
14. Register after freeze → warning emitted, registry unchanged
15. `_resetRegistry()` → freeze lifted, registration works again

---

## How to Run

```bash
cd /Users/erfantari/Claude_Code/Projects/AgenticAGI
pnpm test tests/phase17/instance-a.test.ts
pnpm build
pnpm test  # all 770+ tests must still pass
```

---

## Completion Checklist

- [ ] Task 1: Boundary check in both file skills
- [ ] Task 2: Binary detection in file_reader
- [ ] Task 4: `core/permission.ts` created
- [ ] Task 4: All 15 skills annotated with `permissionLevel`
- [ ] Task 4: `runner.ts` calls enforcer before execution
- [ ] Task 6: `core/config.ts` created with Zod schema
- [ ] Task 6: `chat.ts` calls `validateConfig()` on startup
- [ ] Task 8: Registry frozen after init; `_resetRegistry()` exported
- [ ] Tests: `tests/phase17/instance-a.test.ts` with ≥15 tests
- [ ] `pnpm build` clean
- [ ] All prior tests still pass
