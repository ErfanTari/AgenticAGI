# Audit Handover For Claude: Process Bloat In HTML Generation Flow

Date: 2026-04-18

Scope:
- Verify the bakery trace diagnosis against the current repository code before proposing fixes.
- Focus on architectural waste, routing drift, prompt-policy conflicts, and any source/runtime mismatch that could explain the log sequence.

Primary trace under review:
- User-provided transparency trace showing `route -> query_loop`, then `memory_write`, then later `intake_signals -> decomposition -> planner`, followed by more generation attempts.

## Executive Summary

The repo confirms a real "process bloat" risk, but with an important nuance:

1. The current source explicitly wants simple single-file HTML generation to go straight to `query_loop` and use `generate_and_save_file` directly.
2. The query-loop prompt also explicitly says "generate first" and says not to write a spec to memory for normal HTML tasks.
3. Despite that, the model is still allowed to choose `memory_write` first because the prompt only instructs it; there is no hard runtime guard blocking that path.
4. The current source does **not** cleanly explain the exact log sequence where `query_loop` starts and then the outer intake/decomposition/planner pipeline appears later in the same run. In both `core/agent.ts` and `dist/core/agent.js`, the quick-complexity branch returns immediately after `runQueryLoop(...)`.
5. That means the logged "mid-loop re-intake" is either:
   - a runtime/build drift issue,
   - a trace aggregation artifact from the diagnostic tooling,
   - or a different execution path than the current source now implements.

So the broad diagnosis is right: there is orchestration waste and policy conflict. But one specific claim from the logs, "query loop re-entered intake in the same source-controlled flow," is **not fully proven by the current repo**.

## Verified Findings From Repo

### 1. Simple agentic messages are intentionally fast-pathed to QueryLoop

Evidence:
- [core/agent.ts](/Users/erfantari/Claude_Code/Projects/AgenticAGI/core/agent.ts:1334)
- [dist/core/agent.js](/Users/erfantari/Claude_Code/Projects/AgenticAGI/dist/core/agent.js:1191)

Behavior:
- `assessComplexity(...)` runs before intake/decomposition for clearly-agentic non-compound messages.
- If complexity is `LOW` or `MEDIUM`, the code emits `route: query_loop`, calls `runQueryLoop(...)`, and returns immediately.

Implication:
- In current source and current built `dist`, a message that takes this path should not continue into `runIntake(...)` later in the same `processMessage()` call.

### 2. The query-loop prompt explicitly forbids spec-first for normal HTML tasks

Evidence:
- [prompts/query-loop.md](/Users/erfantari/Claude_Code/Projects/AgenticAGI/prompts/query-loop.md:21)

Verified policy:
- "CALL `generate_and_save_file` IMMEDIATELY with a detailed description."
- "Do NOT write a spec to memory first. Do NOT call `memory_write` before generating."
- Spec-first is marked rare and reserved for specs exceeding 500 words.

Implication:
- The log’s first action, `memory_write`, is contrary to the current prompt policy.
- This is a real efficiency failure, but it is a prompt-compliance/runtime-guard issue, not just a diagnosis artifact.

### 3. Runtime still permits spec-first; prompt policy is not enforced

Evidence:
- [core/query-loop.ts](/Users/erfantari/Claude_Code/Projects/AgenticAGI/core/query-loop.ts:589)
- [core/query-loop.ts](/Users/erfantari/Claude_Code/Projects/AgenticAGI/core/query-loop.ts:851)

Behavior:
- The loop parses whatever XML tool call the model emits.
- There is no hard rule rejecting `memory_write` as the first tool call for a simple HTML generation request.
- There are guards for malformed XML, repeated generated files, oversized `file_writer`, terminal spec issues, and circuit breaking.
- There is no "spec-first disallowed for simple artifact generation" validator.

Implication:
- The system depends on the model obeying prompt text instead of enforcing the policy in code.
- This is the main reason prompt drift becomes token/cost drift.

### 4. Planner prompt still normalizes spec-code workflows heavily

Evidence:
- [prompts/planner.md](/Users/erfantari/Claude_Code/Projects/AgenticAGI/prompts/planner.md:79)

Behavior:
- Planner examples strongly feature:
  - `memory_write` spec creation
  - `generate_and_save_file` with `spec_code`
- The planner prompt is not aligned with the stronger "generate-first" preference from `query-loop.md`.

Implication:
- There is a cross-prompt policy conflict:
  - `query-loop.md` says: description-first, spec-first only rarely.
  - `planner.md` still teaches spec-code as a primary pattern.
- This mismatch increases the chance of unnecessary `PLAN.EX` churn and inflated LLM turns.

### 5. Coding units are always routed through QueryLoop after planning

Evidence:
- [core/router.ts](/Users/erfantari/Claude_Code/Projects/AgenticAGI/core/router.ts:684)

Behavior:
- If any decomposed unit has `taskType === 'coding'`, router emits `coding_route_selected` and calls `runQueryLoop(...)`.

Implication:
- For coding tasks, the architecture already has two possible doors into `query_loop`:
  - direct quick-complexity bypass in `agent.ts`
  - later planned route in `router.ts`
- This is not necessarily wrong, but it makes trace interpretation harder and increases the chance of duplicate or overlapping paths if routing state is not perfectly gated.

### 6. Intake is only supposed to run once per message in current source

Evidence:
- [core/agent.ts](/Users/erfantari/Claude_Code/Projects/AgenticAGI/core/agent.ts:1440)
- [core/intake.ts](/Users/erfantari/Claude_Code/Projects/AgenticAGI/core/intake.ts:101)

Behavior:
- `runIntake(...)` is called from `processMessage(...)` before decomposition, unless memory is disabled.
- It is not called from `query-loop.ts`.

Implication:
- The exact trace pattern "query loop started, then later intake ran" is not directly explained by current source.

### 7. Diagnostic script runs against built code in `dist/`

Evidence:
- [scripts/trace-diagnose-models.mjs](/Users/erfantari/Claude_Code/Projects/AgenticAGI/scripts/trace-diagnose-models.mjs:8)

Behavior:
- The trace script imports:
  - `processMessage` from `../dist/core/agent.js`
  - runtime components from `dist/...`

Implication:
- Any mismatch between `core/` and `dist/` matters.
- In this repo snapshot, both source and built files show the early return after the quick query-loop path, so the log mismatch cannot be dismissed as source-only drift.

## What The Logs Likely Mean

Based on current repo verification, the safest interpretation is:

1. The bakery task qualified for the quick-complexity `query_loop` fast path.
2. Inside `query_loop`, the model violated prompt policy and chose `memory_write` before generation.
3. The later `intake -> decomposition -> planner` events probably came from one of these:
   - a second top-level processing pass,
   - a derived/merged trace artifact,
   - or a runtime regression not visible in the current checked-in source.

This means:
- The "spec-first inefficiency" is definitely real.
- The "mid-loop re-intake" is a credible operational symptom, but the current source does not prove the exact mechanism.

## Confirmed Architectural Issues

### Issue A: Prompt policy is not backed by runtime constraints

Symptom:
- Model used `memory_write` first despite explicit prompt instructions not to.

Root cause:
- `query-loop.ts` trusts the tool choice if XML is valid.

Impact:
- Extra LLM call
- extra memory write
- bigger prompt payload on subsequent turns
- more latency and cost

### Issue B: Cross-prompt inconsistency between QueryLoop and Planner

Symptom:
- One prompt teaches description-first generation, another teaches spec-code workflow as the standard idiom.

Root cause:
- `prompts/query-loop.md` and `prompts/planner.md` encode different preferred behaviors for similar artifact-generation tasks.

Impact:
- Higher chance of unnecessary planning/spec persistence
- harder-to-predict routing behavior
- harder debugging because "bad" behavior is still partially taught by the system

### Issue C: Dual entry points into QueryLoop complicate control flow

Symptom:
- Fast path in `agent.ts`
- Planned coding path in `router.ts`

Root cause:
- QueryLoop is used both as a direct low/medium shortcut and as the coding executor after planning.

Impact:
- Not automatically a bug, but it raises the chance of duplicate orchestration and confusing transparency traces if state handoff is imperfect.

### Issue D: Timeout/routing pressure is believable from code and logs

Symptom from logs:
- `gemma-4-31b-it` aborts at 30s for planner/intake tasks.
- `gemma-4-26b-a4b-it` eventually succeeds for file generation.

Repo evidence:
- The trace script sets a long primary timeout, but runtime model roles are still broad and rely on shared handler infrastructure.
- Planner and classifier are separate LLM calls before work happens.

Impact:
- expensive retry cascades
- fallback churn
- partial work lost to timeout before a simpler model gets the same task

## Items That Need Claude To Verify Further

These are not disproven, but they are not fully established by the current repo alone:

1. Whether the exact mid-trace `intake -> decomposition -> planner` sequence happened inside a single `processMessage()` call or was merged from multiple passes.
2. Whether transparency logs in the failing run were "derived" or stitched from multiple phases beyond the exact current runtime path.
3. Whether there was a stale runtime build or local patch present when that trace was captured.

## Recommended Fixes

### Fix 1: Add a hard runtime guard against spec-first for simple artifact generation

Suggested location:
- [core/query-loop.ts](/Users/erfantari/Claude_Code/Projects/AgenticAGI/core/query-loop.ts)

Suggested policy:
- If goal is a single-artifact HTML/file creation task and:
  - iteration is 1
  - tool call is `memory_write`
  - and there is no explicit user request for a spec document
- then reject the call with a targeted repair message:
  - "For this task, do not write a spec to memory first. Call `generate_and_save_file` directly with a detailed description."

This is the highest-value change.

### Fix 2: Align planner prompt with query-loop prompt

Suggested location:
- [prompts/planner.md](/Users/erfantari/Claude_Code/Projects/AgenticAGI/prompts/planner.md)

Change:
- Make description-first generation the default for single-file HTML/code artifacts.
- Keep `spec_code` only for genuinely oversized specs or explicit multi-step build state.

Goal:
- Remove policy contradiction between planner and query-loop.

### Fix 3: Add trace-level correlation IDs or phase IDs

Suggested locations:
- [core/transparency.ts](/Users/erfantari/Claude_Code/Projects/AgenticAGI/core/transparency.ts)
- `processMessage`, `runQueryLoop`, and trace scripts

Change:
- Add a top-level request ID and a sub-phase ID:
  - `message_id`
  - `execution_path` like `quick_query_loop`, `full_pipeline`, `planned_coding_query_loop`

Goal:
- Make it impossible to misread merged traces as a single linear control path.

### Fix 4: Gate planner/intake instrumentation on path selection

Suggested location:
- [core/agent.ts](/Users/erfantari/Claude_Code/Projects/AgenticAGI/core/agent.ts)

Change:
- Once quick-complexity routes to `query_loop`, mark the request as path-final and ensure no late observers or wrappers can emit intake/planner events for the same request.

Note:
- Current source already returns early, so this may be more about instrumentation discipline than business logic.

### Fix 5: Prefer stable/cheap models by role

Suggested direction:
- Use smaller/faster models for intake and decomposition.
- Reserve stronger models for actual file generation if needed.
- Avoid 31B-class planner/intake calls when the task is obviously simple.

Goal:
- reduce abort/fallback churn
- keep "thinking budget" for artifact creation, not orchestration

## Suggested Validation Plan

After fixes, Claude should validate with the trace harness on the bakery prompt and confirm:

1. Expected path:
   - `route(query_loop)`
   - `query_loop_start`
   - first action is `generate_and_save_file`
   - no `memory_write`
   - no later `intake_signals`
   - no later `decomposition`
   - no planner call

2. Failure path:
   - if file generation fails, retry remains inside `query_loop`
   - system does not bounce back into top-level planner/intake

3. Token/call shape:
   - classifier/planner calls for the simple bakery benchmark should be zero after quick path is selected
   - or exactly one top-level complexity check plus file generation loop, depending on implementation choice

## Bottom Line

The repo validates the main architectural concern:
- simple HTML generation is still vulnerable to unnecessary spec-first behavior and prompt-policy drift.

The repo does **not** fully validate the exact mechanism implied by the trace:
- current `agent.ts` and `dist/core/agent.js` should return immediately after the quick `query_loop` path, so the observed later intake/planner events need separate verification.

Best next move for Claude:
- treat this as both a real optimization problem and a trace-integrity/control-flow audit,
- fix the runtime guard first,
- then verify whether the "mid-loop re-intake" is a real control-flow bug or a logging/derivation artifact.
