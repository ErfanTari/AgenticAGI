# LM Studio Trace Diagnosis — 2026-04-16

## Scope

This report diagnoses where local-model traces fail or waste time in the current Zaraban/AgenticAGI pipeline, using isolated LM Studio benchmarks plus the user-shared UI traces.

Tasks tested:

- HTML benchmark: single-file bakery website
- Coding benchmark: small Node.js Express project with `package.json`, `server.js`, and `test.js`

Models exercised:

- `qwen3.5-35b-a3b-claude-4.6-opus-engineer-9e-qx64-hi-mlx`
- `glm-4.7-flash-mlx`

Primary trace artifacts live in:

- `workspace/logs/trace-diagnosis/20260416130033-*`
- `workspace/logs/trace-diagnosis/20260416130447-*`
- `workspace/logs/trace-diagnosis/20260416133157-*`
- `workspace/logs/trace-diagnosis/20260416134506-*`
- `workspace/logs/trace-diagnosis/20260416134905-*`
- `workspace/logs/trace-diagnosis/20260416135800-*`

## Executive Summary

The biggest early problem was architectural, not model-only: rich generation prompts were being routed through heavier intake/decomposition/planner paths, and single-file HTML tasks wasted extra LLM turns on folder probing and post-success confirmation. Those issues are now materially improved.

After the fixes in this change set:

- Qwen HTML improved from `228.4s / 7 llm calls / 3 query-loop iters` to `168.2s / 2 llm calls / 1 query-loop iter`.
- The original GLM HTML `planner 400 Bad Request` failure disappeared on the new fast path.
- GLM still remains weak on this workload: it no longer hard-fails in the planner, but it still emits malformed junk instead of a usable tool/action response.
- Qwen coding now reaches the correct agentic route and can eventually produce a valid project, but the multi-file coding loop is still inefficient and unstable.

Bottom line:

- Qwen is still the best model in this setup.
- The HTML path is meaningfully improved.
- The remaining major work is the multi-file coding execution loop, not the single-file HTML path.

## Before / After

### HTML benchmark

| Run | Model | Outcome | Duration | LLM calls | Notes |
| --- | --- | --- | ---: | ---: | --- |
| `20260416130033` | Qwen | Success | 228.4s | 7 | Full intake + decomposition + planner + `list_dir` + extra final turn |
| `20260416130447` | GLM | Failure | 340.1s | 4 | Dies on planner call after `221151ms` with `400 Bad Request` |
| `20260416132605` | Qwen | Success | 223.3s | 5 | Intermediate state: still planner path, but query loop reduced to one action |
| `20260416133157` | Qwen | Success | 168.2s | 2 | Correct fast path: direct `query_loop`, one `generate_and_save_file`, done |
| `20260416135800` | GLM | No explicit error, unusable output | 279.8s | 2 | Fast path removes planner failure, but model output is still malformed garbage |

### Coding benchmark

| Run | Model | Outcome | Duration | LLM calls | Notes |
| --- | --- | --- | ---: | ---: | --- |
| `20260416131026` | Qwen | Wrong route / no artifact | 168.6s | 1 | Prompt was misrouted, never entered the agentic coding path |
| `20260416133502` | Qwen | Incomplete artifact | 479.3s | 10 | Reached agentic path but generated broken/leaky code |
| `20260416134506` | Qwen | Partial artifact | 148.0s | 7 | Parser confusion caused only `test.js` to be written |
| `20260416134905` | Qwen | Correct files produced | 506.9s | 23 | Output correctness recovered, but loop remained extremely inefficient |

## Recurring Failure Classes

### 1. Rich generation prompts were misclassified too early

Observed symptoms:

- Single-file HTML prompts were routed through intake + decomposition + planner instead of using the lighter query loop.
- Coding prompts could fall into compatibility shims instead of the agentic path.

Root cause:

- Rich artifact generation requests looked like simple `file_writer` compatibility cases.
- Query compatibility was too broad: messages containing words like `task` could accidentally look like memory queries.

Impact:

- Extra LLM calls
- More chances for malformed XML/planner output
- More cost and latency before any real work starts

Fix implemented:

- Rich artifact generation prompts no longer collapse into simple `file_writer` compatibility.
- Query compatibility now requires retrieval-style phrasing instead of firing on broad notebook words alone.

### 2. Output-folder selection was delegated to the model

Observed symptoms:

- The model spent turns checking directories or reasoning about numbered variants.
- HTML runs used `list_dir` before doing actual work.

Root cause:

- The system knew the user wanted a fresh numbered output directory, but the loop still left the selection burden on the model.

Impact:

- Wasted query-loop iterations
- More room for inconsistent path choices

Fix implemented:

- Query loop now resolves the fresh output directory once per task.
- File paths are rewritten into that resolved directory automatically.
- The goal block tells the model to use the resolved directory directly.

### 3. Single-file artifact tasks asked “are we done?” after success

Observed symptoms:

- After `generate_and_save_file` succeeded, the loop spent another LLM call just to produce a final summary.

Root cause:

- There was no direct terminal condition for create-mode single-artifact goals.

Impact:

- One avoidable LLM call on nearly every successful HTML run

Fix implemented:

- Create-mode single-artifact goals now terminate immediately after successful `generate_and_save_file`.

### 4. Generated code could leak reasoning into saved files

Observed symptoms:

- `server.js` was previously written with a huge `<think>`/reasoning dump.

Root cause:

- `generate_and_save_file` stripping was robust for HTML fences, but too weak against orphaned/unclosed reasoning blocks in non-HTML code.

Impact:

- “Successful” traces could still write unusable code

Fix implemented:

- Recover content after orphaned reasoning blocks when a real code/content anchor exists.
- Reject outputs that still contain obvious reasoning artifacts.

### 5. Multi-action XML responses corrupted tool execution

Observed symptoms:

- Coding traces showed impossible pairings like one action/path in the narration but a different `path`/`description` being executed.
- The loop sometimes executed a mashed-up hybrid of several intended actions.

Root cause:

- `parseXmlAction()` collected flat tags across the whole response and effectively kept the last seen value for each tag.
- When the model emitted multiple `<action>` blocks, the parser built a Frankenstein tool call.

Impact:

- Wrong file written
- Wrong tool executed
- Long self-repair spirals in coding tasks

Fix implemented:

- `parseXmlAction()` now uses only the first complete action block and its local parameters.

### 6. Coding tasks still over-index on blocked skills and verbose completion chatter

Observed symptoms:

- Repeated `run_bash` attempts in `workspace-write` mode
- Plain-text “I already finished” turns that still trigger repair loops
- History pruning during long coding runs

Root cause:

- The coding prompt still encourages test execution, so the model keeps trying `run_bash`.
- After file creation, the model often narrates progress instead of emitting either the next XML action or a clean final completion.

Impact:

- Multi-file coding tasks remain slow and unstable, even when they eventually succeed.

Status:

- Not fully fixed in this pass.
- This is now the highest-value remaining execution problem.

### 7. Memory sync is noisy and unhealthy before every benchmark

Observed symptoms:

- Every isolated benchmark begins with:
  - `syncMemoryFilesToIndex error ... FOREIGN KEY constraint failed`
  - `memory/WHAT/projects/WHAT.PJ-000069_persianpoetry.md`
  - `memory/NOW/todos/NOW.TD-000006_research-persian-poetry-apis.md`

Root cause:

- Memory bootstrap/index sync is inconsistent for at least two files.

Impact:

- Pollutes traces
- Lowers confidence in memory state before any LLM work starts

Status:

- Diagnosed but not fixed in this pass.

### 8. UI traces can mix unrelated runs

Observed symptoms from the user-shared trace:

- `Who is Sara?` events appeared inside a bakery website run
- Intake/decomposition ordering looked impossible in a true single run

Root cause:

- The UI trace view is effectively showing a global bus stream rather than a hard per-run slice.

Impact:

- Makes model diagnosis look worse or weirder than the actual run
- Contaminates token/cost interpretation

Status:

- Confirmed by the earlier read-only review.
- Not changed in this pass.

## What Was Implemented

Files changed:

- `core/agent.ts`
- `core/query-loop.ts`
- `core/skills/tools/generate_and_save_file.ts`
- `core/utils/xml-parser.ts`
- `tests/phase13/rich-artifact-compatibility.test.ts`
- `tests/phase16/query-loop-output-fastpath.test.ts`
- `tests/phase20/generate-and-save-file-reasoning-strip.test.ts`
- `tests/phase24/xml-parser-first-action.test.ts`
- `scripts/trace-diagnose-models.mjs`

Implemented behavior changes:

1. Rich HTML/coding generation prompts no longer get mistaken for simple `file_writer` compatibility requests.
2. Query classification is stricter and no longer treats broad “task/output” wording as a memory query by default.
3. Query loop resolves a stable fresh output directory once and rewrites file paths into it.
4. Single-file create tasks stop immediately after successful file generation.
5. File generation rejects leaked reasoning artifacts and recovers code after orphaned think blocks.
6. XML action parsing now uses the first complete action block only.

## Recommended Next Plan

### Priority 1: Fix multi-file coding loops

Goal:

- Make the Node/Express-style coding benchmark complete in a small number of turns, not 20.

Recommended work:

1. Add a project-scaffold execution mode for small multi-file coding tasks.
2. Prevent `run_bash` from being proposed at all in `workspace-write` coding loops.
3. Add a stronger terminal rule:
   - If all requested files exist in the resolved output directory, accept plain-text completion instead of repair-looping.
4. Add a per-goal file checklist so the loop knows which outputs are still missing.

Expected payoff:

- Largest remaining cost/latency reduction
- Better reliability on coding benchmarks

### Priority 2: Fix memory sync foreign-key errors

Goal:

- Remove startup noise and restore trust in memory bootstrap.

Recommended work:

1. Inspect the parent/index row relationships for:
   - `WHAT.PJ-000069`
   - `NOW.TD-000006`
2. Repair bootstrap ordering or dangling references in memory sync.

Expected payoff:

- Cleaner traces
- Lower risk of hidden memory corruption

### Priority 3: Scope UI traces by run/thread

Goal:

- Make trace diagnosis trustworthy in the UI.

Recommended work:

1. Attach a stable run identifier to each emitted transparency event.
2. Filter the UI stream by the active run/thread instead of subscribing raw to the global bus.

Expected payoff:

- Cleaner operator debugging
- No more unrelated events inside benchmark traces

### Priority 4: Add stricter malformed-output guards for weak models

Goal:

- Fail fast and visibly when a local model emits junk instead of a valid tool/action.

Recommended work:

1. Detect malformed XML/noise-heavy outputs earlier and classify them as structured model failure.
2. Count “junk no_action” exits separately from genuine clean completions.
3. Consider per-model guardrails or stronger XML repair for GLM specifically.

Expected payoff:

- Better model comparisons
- Less ambiguous “no explicit error but useless output” traces

## Current Conclusion

The HTML path is substantially better now and the original planner-path bottleneck was real. Qwen benefits directly from the routing/query-loop changes. GLM’s catastrophic planner failure was largely system-path related, but GLM still remains substantially less reliable than Qwen because it often cannot produce a clean actionable response even after that bottleneck is removed.

The remaining major engineering problem is not the single-file website flow anymore. It is the multi-file coding loop.
