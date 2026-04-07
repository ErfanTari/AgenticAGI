# Phase 17B — Testing Infrastructure & Session Persistence
### For: Claude Code Instance B (separate session)

**Track:** Mock LLM harness + session JSONL log + auto-compact trigger + sandbox detection  
**Parallel track:** Instance A handles `docs/PHASE_17A_INSTANCE_A.md`  
**No file overlap between the two tracks.**

Read `docs/CLAW_ADOPTIONS_PLAN.md` first for full context.

---

## Files You Own

```
tests/mocks/MockLLMHandler.ts       ← NEW (task 3)
tests/mocks/scenarios/              ← NEW: scripted scenario files (task 3)
core/context.ts                     ← add ~5-line threshold trigger (task 5)
core/session/session-log.ts         ← NEW (task 7)
core/skills/tools/run_bash.ts       ← sandbox detection (task 9)
tests/phase17/instance-b.test.ts    ← NEW: your tests
```

Do NOT touch: `core/skills/types.ts`, `core/permission.ts`, `core/skills/runner.ts`,
`core/skills/registry.ts`, `tools/file_reader.ts`, `tools/file_writer.ts`, `core/config.ts`

---

## Task 3 — Mock LLM Handler

### Purpose

Zaraban's tests hit `callLLM()` in many places. Without a mock, tests either:
- Skip the LLM path entirely (reducing coverage), or
- Hit a real LM Studio endpoint (fragile, slow, non-deterministic)

The mock makes end-to-end pipeline tests deterministic. It's the single highest-ROI item.

### Step 3a: Create `tests/mocks/MockLLMHandler.ts`

The `LLMHandler` type is used throughout the codebase. Look at `core/llm.ts` to confirm
the exact interface signature. It typically looks like:

```typescript
type LLMHandler = (
  messages: Message[],
  options?: { responseSchema?: Record<string, unknown>; maxTokens?: number }
) => Promise<string>;
```

Create the mock:

```typescript
// tests/mocks/MockLLMHandler.ts

interface MockScenario {
  /** Substring to match in the last user message */
  trigger: string;
  /** Raw string to return as the LLM response */
  response: string;
}

export class MockLLMHandler {
  private scenarios: MockScenario[];
  public calls: { messages: unknown[]; response: string }[] = [];

  constructor(scenarios: MockScenario[]) {
    this.scenarios = scenarios;
  }

  readonly handler = async (
    messages: { role: string; content: string }[],
    _options?: unknown,
  ): Promise<string> => {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const content = lastUser?.content ?? '';

    for (const scenario of this.scenarios) {
      if (content.includes(scenario.trigger)) {
        this.calls.push({ messages, response: scenario.response });
        return scenario.response;
      }
    }

    throw new Error(
      `[MockLLMHandler] No scenario matched.\n` +
      `Last user message: "${content.slice(0, 120)}"\n` +
      `Available triggers: ${this.scenarios.map(s => `"${s.trigger}"`).join(', ')}`,
    );
  };

  /** Reset call history between tests */
  reset(): void {
    this.calls = [];
  }
}
```

### Step 3b: Create scenario files in `tests/mocks/scenarios/`

Three files are required to cover the planner, decomposition, and executor paths.

**`tests/mocks/scenarios/decompose-simple.ts`**

```typescript
import type { MockScenario } from '../MockLLMHandler.js';

/** Simple single-unit message → one agentic unit */
export const decomposeSimple: MockScenario[] = [
  {
    trigger: 'Decompose the following',
    response: JSON.stringify({
      units: [
        { route: 'agentic', content: 'write hello world to hello.txt' },
      ],
    }),
  },
];
```

**`tests/mocks/scenarios/plan-file-write.ts`**

```typescript
import type { MockScenario } from '../MockLLMHandler.js';

/** Planner returns a 2-step plan: write file + verify */
export const planFileWrite: MockScenario[] = [
  {
    trigger: 'write hello world',
    response: JSON.stringify({
      goal: 'write hello world to hello.txt',
      complexity: 'LOW',
      milestones: [{ id: 'M1', title: 'Write file', steps: ['step-1'] }],
      steps: [
        {
          id: 'step-1',
          skill: 'file_writer',
          description: 'Write hello world',
          input: { path: 'hello.txt', content: 'hello world' },
          dependsOn: [],
        },
      ],
    }),
  },
];
```

**`tests/mocks/scenarios/conversational.ts`**

```typescript
import type { MockScenario } from '../MockLLMHandler.js';

/** Conversational units return a plain text reply */
export const conversationalScenarios: MockScenario[] = [
  {
    trigger: 'what is your name',
    response: 'I am Zaraban.',
  },
  {
    trigger: 'hello',
    response: 'Hello! How can I help you today?',
  },
];
```

---

## Task 5 — Auto-Compact Token Threshold Trigger

**File:** `core/context.ts`

This is a ~5-line addition. Read the existing `buildContext()` function first to understand
where token estimation happens and where `compactContext()` (or equivalent) is called.

Find the section that estimates tokens after building the context. Add:

```typescript
const AUTO_COMPACT_THRESHOLD = 100_000;

// After estimating final token count, before returning:
if (estimatedTokens > AUTO_COMPACT_THRESHOLD && isCompactionCircuitClosed()) {
  // Compact and rebuild — only if we haven't already compacted this call
  if (!alreadyCompacted) {
    compactContext(/* ... */);
    alreadyCompacted = true;
    // Recalculate token count after compaction
  }
}
```

**Implementation notes:**
- Check how `_compactionFailures` and `_resetCompactionCircuit()` are already structured in this file — the circuit breaker is already implemented in Phase 15/16
- `isCompactionCircuitClosed()` is probably already a local check (`_compactionFailures < 3` or similar)
- The key addition is the 100K threshold check: if tokens exceed it AND circuit is closed → trigger compaction regardless of the 70% budget check
- Do not remove the existing 70% trigger — this is a second, higher trigger

If `buildContext()` doesn't have a single `estimatedTokens` variable, look for where `estimateTokens()` or `countTokens()` is called. Add the threshold check right after.

---

## Task 7 — Session JSONL Persistence

### Purpose

Zaraban has no conversation replay. After a crash or restart, the agent has no memory
of what was said (only what was persisted to the 7-notebook system). Session JSONL gives
us: debugging, audit trail, and future "resume session" capability.

### Step 7a: Create `core/session/session-log.ts`

```typescript
import fs from 'fs';
import path from 'path';
import os from 'os';

const SESSION_DIR = path.join(os.homedir(), '.zaraban', 'sessions');
const MAX_FILE_SIZE = 256 * 1024; // 256 KB
const MAX_ROTATIONS = 3;

export interface SessionTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: string; // ISO timestamp
}

function getSessionFilePath(sessionId: string): string {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const date = new Date().toISOString().split('T')[0];
  return path.join(SESSION_DIR, `${date}_${sessionId}.jsonl`);
}

function rotateIfNeeded(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < MAX_FILE_SIZE) return;

    // Shift existing rotations
    for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
      const old = `${filePath}.${i}`;
      const newer = `${filePath}.${i + 1}`;
      if (fs.existsSync(old)) {
        if (i === MAX_ROTATIONS - 1) fs.unlinkSync(old); // drop oldest
        else fs.renameSync(old, newer);
      }
    }
    fs.renameSync(filePath, `${filePath}.1`);
  } catch {
    // Rotation failure must never crash the agent
  }
}

export class SessionLog {
  private sessionId: string;
  private filePath: string;

  constructor(sessionId?: string) {
    this.sessionId = sessionId ?? `s${Date.now()}`;
    this.filePath = getSessionFilePath(this.sessionId);
  }

  append(turn: SessionTurn): void {
    try {
      rotateIfNeeded(this.filePath);
      fs.appendFileSync(this.filePath, JSON.stringify(turn) + '\n', 'utf-8');
    } catch {
      // Fire-and-forget — never block the agent
    }
  }

  loadLast(n: number): SessionTurn[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const lines = fs.readFileSync(this.filePath, 'utf-8')
        .split('\n')
        .filter(Boolean);
      return lines.slice(-n).map(l => JSON.parse(l) as SessionTurn);
    } catch {
      return [];
    }
  }

  get id(): string { return this.sessionId; }
  get path(): string { return this.filePath; }
}

// Singleton for the current process session
let _current: SessionLog | null = null;

export function currentSession(): SessionLog {
  if (!_current) _current = new SessionLog();
  return _current;
}

// For test isolation
export function _resetSession(): void { _current = null; }
```

### Step 7b: Wire into `chat.ts`

After each user message received from REPL (before passing to `processMessage`):

```typescript
import { currentSession } from './core/session/session-log.js';

// After reading user input:
currentSession().append({ role: 'user', content: userInput, ts: new Date().toISOString() });

// After getting agent response:
currentSession().append({ role: 'assistant', content: response.text, ts: new Date().toISOString() });
```

Do not add it to `processMessage()` itself — only the outermost REPL loop in `chat.ts`.
This keeps the session log at the UI boundary, not inside the core agent.

---

## Task 9 — Sandbox Detection for `run_bash`

**File:** `tools/run_bash.ts`

Add sandbox detection as a one-time cached check:

```typescript
import { execSync } from 'child_process';

type SandboxStatus = 'full' | 'none';
let _sandboxStatus: SandboxStatus | null = null;

function detectSandbox(): SandboxStatus {
  if (_sandboxStatus !== null) return _sandboxStatus;
  try {
    execSync('unshare --user --pid echo ok', {
      stdio: 'pipe',
      timeout: 2000,
    });
    _sandboxStatus = 'full';
  } catch {
    _sandboxStatus = 'none';
  }
  return _sandboxStatus;
}

// For test injection
export function _setSandboxStatus(s: SandboxStatus | null): void {
  _sandboxStatus = s;
}
```

In the skill's `execute()`:

```typescript
const sandbox = detectSandbox();
const mode = process.env.PERMISSION_MODE ?? 'workspace-write';

let warningPrefix = '';
if (sandbox === 'none' && mode === 'full-access') {
  warningPrefix = '[warning: no sandbox — running without isolation]\n';
}

// Prepend to output:
return {
  success: true,
  output: warningPrefix + rawOutput,
};
```

The sandbox check must **not block** or slow down execution. The 2-second timeout on
`execSync` ensures it doesn't hang. Cache the result so subsequent calls are instant.

---

## Tests to Write

Create `tests/phase17/instance-b.test.ts`.

Minimum test cases (target: 12 tests):

### MockLLMHandler (4 tests)
1. Trigger matches → returns correct response string
2. No match → throws with clear error message containing the unmatched content
3. Multiple scenarios → first match wins
4. `reset()` clears `calls` array

### Auto-compact threshold (2 tests)
5. Mock history at 110K estimated tokens → compaction triggered (spy on compaction fn)
6. Mock history at 90K → compaction NOT triggered by threshold (may still be triggered by 70%)

### Session JSONL (4 tests)
7. `append()` creates file and writes valid JSON line
8. `loadLast(3)` returns last 3 turns in order
9. File > 256 KB → rotation creates `.1` backup
10. `append()` failure (unwritable dir) → does NOT throw, agent continues

### Sandbox detection (2 tests)
11. Mock `execSync` to succeed → `detectSandbox()` returns `'full'`; output has no warning
12. Mock `execSync` to throw → `detectSandbox()` returns `'none'`; `full-access` mode adds warning prefix

---

## How to Run

```bash
cd /Users/erfantari/Claude_Code/Projects/AgenticAGI
pnpm test tests/phase17/instance-b.test.ts
pnpm build
pnpm test  # all 770+ tests must still pass
```

---

## Completion Checklist

- [ ] Task 3: `tests/mocks/MockLLMHandler.ts` created
- [ ] Task 3: 3 scenario files in `tests/mocks/scenarios/`
- [ ] Task 3: Used in at least 2 integration tests (planner or decomposition paths)
- [ ] Task 5: `core/context.ts` has 100K threshold trigger
- [ ] Task 5: Threshold only fires when circuit is closed (not double-compacting)
- [ ] Task 7: `core/session/session-log.ts` created
- [ ] Task 7: `chat.ts` calls `append()` after user input + after assistant reply
- [ ] Task 9: `run_bash.ts` has cached `detectSandbox()` with 2s timeout
- [ ] Task 9: Warning prefix added when `sandbox=none` + `PERMISSION_MODE=full-access`
- [ ] Tests: `tests/phase17/instance-b.test.ts` with ≥12 tests
- [ ] `pnpm build` clean
- [ ] All prior tests still pass

---

## Coordination Note

When both instances are done, run the full test suite once together:

```bash
pnpm test
pnpm stress:p15:codex
pnpm build
```

Then one instance updates `CLAUDE.md` with the Phase 17 section and creates the git tag.
Decide which instance does that based on who finishes first.
