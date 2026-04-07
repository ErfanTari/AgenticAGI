# Zaraban — Prompt Architecture Redesign: JSON Templates → Markdown Files + Token Budget Increases
### For: Claude Code (single session)
### Tag on completion: `phase-18-prompts-complete`

---

## Context

Read `CLAUDE.md` fully before touching any file. Current state: **933 tests pass**, build clean,
tag `log-fixes-complete`. The architecture is decomposition-first (Phase 13+), QueryLoop for
LOW/MEDIUM, milestone planner+executor for HIGH/MAX.

This sprint does two things:

1. **Extract all large inline prompt strings from `.ts` files into `.md` template files.**
   The principle already exists in the architecture: "markdown for human-readable persistent
   storage." Prompt templates are human-authored instructions — they belong in `.md` files,
   not interpolated template literals buried in TypeScript.

2. **Raise token budgets across every LLM call site** to eliminate the truncation class of
   bugs that the log-analysis sprint already partially addressed.

**Do not change routing logic, skill implementations, or test assertions.**
**Do not break the 933 existing tests. Add new tests only.**
**After each batch: `pnpm build && pnpm test`**

---

## Why Markdown Templates

Current problem: prompt engineering means editing TypeScript files, rebuilding, restarting.
Every prompt iteration touches compiled code. There is no single place to review all system
prompts together. Inline template literals resist diffing and review.

Target: prompt engineering means editing `.md` files in `prompts/`. No TypeScript rebuild
needed for prompt iteration. A `PromptLoader` reads templates at startup (or lazily), performs
`{{variable}}` substitution, and caches the result. TypeScript files keep only the variable
injection call, not the prompt body.

This also aligns with the core architecture philosophy: markdown is the human-readable layer,
TypeScript is the execution layer. Prompts are authored content — they are markdown.

---

## Files You Will Create

```
prompts/
  decomposition.md        ← system prompt for decomposeMessage()
  planner.md              ← system prompt for buildPlan() / parsePlan()
  query-loop.md           ← iteration prompt for QueryLoop
  post-flight.md          ← system prompt for runPostFlightSynthesis()
  milestone-revision.md   ← prompt for reviseRemainingMilestones()
  intake.md               ← startup intake / findings classifier prompt
  content-writer.md       ← content_writer LLM system prompt

core/prompt-loader.ts     ← NEW: loads .md templates, substitutes variables, caches
tests/phase18/prompts.test.ts ← NEW: your tests
```

## Files You Will Modify

```
core/decomposition.ts     ← replace inline prompt with promptLoader.load('decomposition', vars)
core/planner.ts           ← replace inline prompt with promptLoader.load('planner', vars)
core/query-loop.ts        ← replace inline prompt with promptLoader.load('query-loop', vars)
core/executor.ts          ← replace post-flight and revision inline prompts
core/intake.ts            ← replace intake prompt
core/skills/tools/content_writer.ts  ← replace content_writer LLM prompt
config/agent.config.ts    ← raise all token budget constants
```

## Do NOT Touch

- `core/schemas.ts` — Zod schemas stay in TypeScript (they are code, not content)
- `core/llm.ts` — LLM adapter is not a prompt
- `core/context.ts` — context assembly is not a prompt template
- `core/router.ts`, `core/agent.ts` — routing logic untouched
- Any test file outside `tests/phase18/`
- `CLAUDE.md`

---

## Batch 1 — Build the PromptLoader Infrastructure

### TASK 1 — `core/prompt-loader.ts`

Create `core/prompt-loader.ts` with the following contract:

```typescript
// core/prompt-loader.ts

type TemplateVars = Record<string, string>;

interface PromptLoader {
  /** Load a named template, substitute {{key}} placeholders, return final string.
   *  Template name maps to prompts/<name>.md
   *  Caches the raw file on first read. Substitution is not cached (vars change per call).
   *  Throws if the file does not exist.
   */
  load(name: string, vars?: TemplateVars): string;

  /** Force-reload a template from disk (for hot-reload and testing). */
  invalidate(name: string): void;

  /** Clear all cached templates. */
  invalidateAll(): void;

  /** Returns true if template file exists at prompts/<name>.md */
  exists(name: string): boolean;
}

export function createPromptLoader(promptsDir?: string): PromptLoader;
export const promptLoader: PromptLoader; // default singleton pointed at ./prompts/
```

Implementation rules:
- `promptsDir` defaults to `path.join(process.cwd(), 'prompts')`
- Cache: `Map<string, string>` — keys are template names, values are raw file contents
- Substitution: replace all occurrences of `{{key}}` with `vars[key]`; keys not found in
  vars are left as-is (do NOT throw on missing vars — aids partial substitution)
- Use `fs.readFileSync` (sync read, prompt templates are small and read at call time)
- `load()` throws a descriptive error if the `.md` file is missing
- Export both a factory (`createPromptLoader`) and a default singleton (`promptLoader`)

---

### TASK 2 — Token Budget Constants (`config/agent.config.ts`)

Locate all `maxTokens` constants in `config/agent.config.ts`. Add or replace:

```typescript
export const TOKEN_BUDGETS = {
  // Structural LLM calls (JSON output required)
  INTAKE:              800,   // was 600
  DECOMPOSITION:      2000,   // was likely ~512 or default
  PLANNER:            8192,   // was 4096
  MILESTONE_REVISION: 2000,   // was likely ~512
  POST_FLIGHT:        3000,   // was likely ~1000
  QUERY_LOOP_ITER:    2000,   // per-iteration call
  QUERY_LOOP_NARRATE:  800,   // narration synthesis
  VERIFICATION:       1500,   // was likely ~512

  // Content generation (these are minimums — callers may request more)
  CONTENT_WRITER_HTML:     12000,  // was 6000
  CONTENT_WRITER_MARKDOWN:  8000,  // was 4000
  CONTENT_WRITER_PLAIN:     6000,  // was 4000
  CONTENT_WRITER_CODE:      8000,  // was 4000

  // Memory and background ops
  WORKING_MEMORY_SUMMARY:    800,  // was 500
  RELATIONSHIP_INFER:        600,  // new — for relationship inference calls
} as const;
```

Replace every hardcoded `maxTokens: N` in the following call sites with the corresponding
constant from `TOKEN_BUDGETS`. The goal: one place to tune all token budgets.

---

## Batch 2 — Write the Markdown Templates

Extract the prompt bodies from each call site into their corresponding `.md` files.
The `.md` file is the source of truth. Variable injection points use `{{variable_name}}` syntax.

Below are the variable signatures each template must support.

---

### `prompts/decomposition.md`

Source: `core/decomposition.ts` — the system prompt passed to the decomposition LLM call.

Variables available for injection:
```
{{current_date}}     — ISO date string
{{memory_summary}}   — one-line memory index summary (optional, may be empty)
```

The template must preserve all existing routing rules (conversational / query / agentic),
the JSON output schema description, and the instruction about never splitting greeting units.

---

### `prompts/planner.md`

Source: `core/planner.ts` — the system prompt for `buildPlan()` / `parsePlan()`.

Variables:
```
{{skill_descriptions}}   — formatted skill catalog (from registry)
{{prior_context}}        — resolved query units injected as context (may be empty)
{{relevant_procedure}}   — HOW.PR procedure body if found (may be empty)
{{current_date}}         — ISO date string
{{complexity}}           — LOW | MEDIUM | HIGH | MAX
```

The template must include:
- SINGLE-FILE HTML RULE block (already in current prompt)
- PLAN.EX lifecycle rules
- FILE CREATION RULES block
- COMPARISON TASK RULES block
- The JSON plan output schema description
- No `mkdir` rule

---

### `prompts/query-loop.md`

Source: `core/query-loop.ts` — the per-iteration prompt for the QueryLoop engine.

Variables:
```
{{goal}}             — the unit's goal text
{{available_skills}} — skill descriptions relevant to query work
{{iteration}}        — current iteration number (string)
{{max_iterations}}   — max allowed iterations (string)
{{prior_results}}    — formatted results from previous iterations (may be empty)
{{memory_context}}   — memory entries surfaced for this unit (may be empty)
```

---

### `prompts/post-flight.md`

Source: `core/executor.ts` — `runPostFlightSynthesis()` prompt.

Variables:
```
{{plan_summary}}       — goal + milestone titles
{{step_results}}       — completed steps with outputs
{{ground_truth}}       — filesystem/DB snapshot text
{{current_date}}       — ISO date string
```

The template must request the `PostFlightSchema` JSON output
(`verification`, `summary`, `reflection` fields).

---

### `prompts/milestone-revision.md`

Source: `core/executor.ts` — `reviseRemainingMilestones()` prompt.

Variables:
```
{{original_milestones}}    — JSON of remaining milestones
{{completed_summary}}      — what has been done so far
{{failure_reason}}         — why revision was triggered
```

---

### `prompts/intake.md`

Source: `core/intake.ts` — the startup intake classifier prompt.

Variables:
```
{{recent_memory}}    — recent entries from session cache / pointer index
{{current_date}}     — ISO date string
```

---

### `prompts/content-writer.md`

Source: `core/skills/tools/content_writer.ts` — the LLM system prompt for content generation.

Variables:
```
{{format}}           — html | markdown | plain | code
{{max_tokens}}       — the resolved token budget (string)
{{context}}          — existing content to modify (may be empty → new content)
{{extra_rules}}      — any format-specific rules injected by the caller (may be empty)
```

---

## Batch 3 — Wire PromptLoader into Call Sites

For each call site, replace the inline template literal with a `promptLoader.load()` call.

### Pattern

Before:
```typescript
const systemPrompt = `
  You are a decomposition engine...
  Current date: ${localDateString()}
  ...400 lines of instructions...
`;
const response = await callLLM({ system: systemPrompt, maxTokens: 512, ... });
```

After:
```typescript
import { promptLoader } from './prompt-loader.js';
import { TOKEN_BUDGETS } from '../config/agent.config.js';

const systemPrompt = promptLoader.load('decomposition', {
  current_date: localDateString(),
  memory_summary: memSummary ?? '',
});
const response = await callLLM({ system: systemPrompt, maxTokens: TOKEN_BUDGETS.DECOMPOSITION, ... });
```

Apply this pattern to:

1. `core/decomposition.ts` — `decomposeMessage()` system prompt
2. `core/planner.ts` — `buildPlan()` system prompt
3. `core/query-loop.ts` — iteration call prompt
4. `core/executor.ts` — `runPostFlightSynthesis()` prompt
5. `core/executor.ts` — `reviseRemainingMilestones()` prompt
6. `core/intake.ts` — intake classifier prompt
7. `core/skills/tools/content_writer.ts` — content generation system prompt

**Wire `TOKEN_BUDGETS` constants in the same pass.** Do not leave any hardcoded `maxTokens`
integer literals in the modified call sites after this sprint.

---

## Batch 4 — Tests (`tests/phase18/prompts.test.ts`)

Write tests covering:

### PromptLoader unit tests (8 tests)

1. `load()` returns the full template content for a known template
2. `load()` substitutes a single `{{var}}` correctly
3. `load()` substitutes multiple distinct `{{var}}` placeholders in one pass
4. `load()` leaves unresolved `{{var}}` placeholders intact (no partial-injection errors)
5. `load()` caches raw content — second call does not re-read disk (mock `fs.readFileSync`)
6. `invalidate()` clears cache entry — next `load()` re-reads disk
7. `invalidateAll()` clears all entries — verified by checking cache is empty
8. `load()` throws a descriptive error if the template file does not exist

### Integration smoke tests (4 tests)

9. All 7 template files exist on disk (use `promptLoader.exists()`)
10. `decomposition.md` loads without error and contains `{{current_date}}`
11. `planner.md` loads without error and contains `{{skill_descriptions}}`
12. `content-writer.md` loads without error and contains `{{format}}`

### Token budget tests (3 tests)

13. `TOKEN_BUDGETS.PLANNER` is `>= 8192`
14. `TOKEN_BUDGETS.CONTENT_WRITER_HTML` is `>= 12000`
15. All values in `TOKEN_BUDGETS` are positive integers

**Total: 15 tests.**

---

## Acceptance Criteria

- `pnpm build` — zero TypeScript errors
- `pnpm test` — all **948 tests pass** (933 existing + 15 new)
- All 7 `.md` template files exist in `prompts/`
- Zero inline multi-line prompt template literals remain in the 7 modified call sites
- Zero hardcoded `maxTokens` integer literals in the 7 modified call sites
  (all use `TOKEN_BUDGETS.*` constants)
- `promptLoader` is the single export used across all call sites — no parallel loader instances
- Tag: `phase-18-prompts-complete`

---

## Architecture Notes for Claude Code

**Do not move Zod schemas to markdown.** `core/schemas.ts` defines runtime-validated types.
Those stay in TypeScript. Markdown templates contain the *human instruction* layer only —
what the model is asked to do and how to format its response. The Zod schema that validates
the response is still in TypeScript.

**Template variables are strings only.** Do not pass objects or arrays into `load()`.
Callers are responsible for formatting complex data (skill lists, memory entries) to strings
before injection.

**Prompt content must be 1:1 migrated, not revised.** Copy the existing prompt text faithfully
into the `.md` file during migration. Do not improve or shorten prompts during this sprint —
that is a separate concern. The goal is structural separation, not content changes. The only
exception: remove TypeScript interpolation boilerplate (`${}`) and replace with `{{}}` markers.

**Hot-reload is not required.** The loader caches on first read. Prompt changes take effect
on next agent restart. This is acceptable — agents are not long-running daemons in this
deployment. The `invalidate()` method exists for testing only.

**Load order:** `promptLoader` singleton is initialized lazily on first `.load()` call.
It does not fail at import time if `prompts/` does not exist — it fails at first `.load()` call.
This preserves test isolation (tests can point `promptsDir` at a tmpDir with mock templates).
