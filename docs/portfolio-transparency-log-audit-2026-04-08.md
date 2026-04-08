# Portfolio Transparency Log Audit

Date: 2026-04-08

## Scope

This note analyzes the 2026-04-08 transparency log for the portfolio website task and checks the claims from the external reports against the actual repository implementation.

The goal is not to restate the whole log. The goal is to answer three questions:

1. What happened in the run?
2. What actually failed or wasted time?
3. Which design changes in this repo would solve those issues cleanly?

## What The Log Shows

The session completed successfully, but it took a longer path than necessary.

Observed execution path from the log:

1. The user asked: create a portfolio website in the workspace with colorful solid-color placeholder cards.
2. The system first ran a memory-grounded synthesis turn using retrieved entries for `WHO.CT-000076`, `WHEN.DL-000002`, and `WHAT.PJ-000075`.
3. That first assistant reply incorrectly reframed the task as part of "Zaraban Dashboard", mentioned the deadline, and asked for confirmation instead of executing.
4. The request was then routed to QueryLoop as `LOW` complexity.
5. QueryLoop iteration 1 called `generate_and_save_file` with both a long inline `description` and `spec_code: "PLAN.EX-000077"`.
6. That failed because `PLAN.EX-000077` did not exist yet.
7. QueryLoop iteration 2 wrote the spec to memory using `memory_write`.
8. QueryLoop iteration 3 called `generate_and_save_file` again with the now-valid spec code.
9. The inner file-generation subcall took about 92 seconds and produced `portfolio.html`.
10. QueryLoop iteration 4 returned a plain-text success summary and stopped.

Bottom line: the task succeeded, but only after one unnecessary conversational turn, one avoidable tool failure, and one full retry cycle.

## Repo-Backed Findings

### 1. The first bad turn was caused by quick-resolve synthesis over-trusting retrieved memory

This is strongly supported by `core/agent.ts`.

When `quickResolve()` finds entries, the agent builds a special synthesis prompt. For non-command cases it says:

- `Do not claim entries are missing - everything relevant has already been retrieved.`
- `Base your answer on the content of these entries.`

Relevant code:

- `core/agent.ts:1254-1257`
- `core/agent.ts:1289-1299`

This matches the log exactly. The model treated retrieved memory as task-defining context and pulled the request toward the existing "Zaraban Dashboard" and deadline.

Important nuance: this incident is better explained by the quick-resolve synthesis path than by planner-side "project brain" behavior. The planner's project-brain path exists, but it is in `core/planner.ts:813-850`, which is not the first mechanism implicated by this log.

### 2. The spec-code failure was a real dependency-order bug

This is not just "the model was sloppy." The skill implementation explicitly requires the spec to exist first.

Relevant code:

- `core/skills/tools/generate_and_save_file.ts:55-75`
- `core/skills/tools/generate_and_save_file.ts:63`

Behavior:

- If `spec_code` is present, the skill resolves it first.
- If the entry is missing, it returns:
  `spec_code "..." not found in memory. Write the spec first using memory_write, then pass the returned code here.`

That is exactly the error seen in the log.

### 3. The mixed payload shape was accepted even though it was logically contradictory

The failed call included both:

- a long `description`
- a `spec_code`

In the current skill implementation, `spec_code` wins if present. The description is effectively ignored if the memory entry exists.

Relevant code:

- `core/skills/tools/generate_and_save_file.ts:55-75`

This means the system currently tolerates a confused contract:

- "Use this memory spec"
- "Also here is a full inline spec anyway"

That is a design smell and should be rejected earlier.

### 4. There is a routing mismatch between the quick path and the planner heuristics

The quick pre-check in `core/agent.ts` intentionally sends LOW/MEDIUM work straight to QueryLoop:

- `core/agent.ts:1215-1217`

But the planner heuristics separately say that generation plus code/file output should be `HIGH`:

- `core/planner.ts:40-46`

The user request in the log clearly contains both a generation verb and a file/artifact target. So the system has two different complexity judgments living in two different places.

This matters because it changes behavior:

- the quick path optimized for speed
- the planner heuristics would have treated this as a heavier artifact-generation task

### 5. The command detector likely missed a greeting-prefixed imperative

The quick-resolve guard is supposed to prevent command requests from falling into retrieval-only synthesis.

Relevant code:

- `core/memory/quick-resolve.ts:199-210`
- `core/memory/quick-resolve.ts:236-264`

The command detector looks for commands at the start of the message or in a narrow polite-command form. A message like:

`Hi zaraban, create a portfolio website ...`

is a plausible miss:

- it starts with a greeting
- the command is not the first token

That would explain why the request got trapped in the retrieval synthesis path before reaching execution.

### 6. The system records artifact context after generation, but does not verify the result

After successful generation, QueryLoop:

- records written files
- stores artifact context
- injects `LAST_ARTIFACT_CONTEXT`
- tells itself not to re-read the file it just generated

Relevant code:

- `core/query-loop.ts:616-623`
- `core/query-loop.ts:627-635`
- `core/query-loop.ts:642-650`

What it does not do is automatically call `verify_state`.

The verification skill exists:

- `core/skills/tools/verify_state.ts:9-18`
- `core/skills/tools/verify_state.ts:44-58`

But the success path does not invoke it.

So the report claim about missing post-write verification is valid.

### 7. The artifact-generation stack is internally inconsistent

QueryLoop still pushes the model toward `generate_and_save_file` for large generated artifacts:

- `core/query-loop.ts:208-210`

It also locks that strategy once chosen:

- `core/query-loop.ts:400-401`
- `core/query-loop.ts:526-545`

But the skill itself is marked deprecated:

- `core/skills/tools/generate_and_save_file.ts:2`
- `core/skills/tools/generate_and_save_file.ts:146-149`
- `core/skills/tools/generate_and_save_file.ts:198`

That is a design contradiction:

- prompts prefer the tool
- orchestration locks into the tool
- the tool advertises that it should not be the preferred path

## What Was Inefficient

### Unnecessary turn 1

The assistant should have executed, but instead:

- reframed the request around unrelated memory context
- asked for confirmation

This added an avoidable round-trip before any useful work happened.

### Unnecessary failed tool call

The first QueryLoop tool call used a future spec code that had not been created yet. That guaranteed failure and forced:

- one extra LLM turn
- one extra skill call
- one extra state transition

### Redundant specification effort

The run effectively specified the same artifact twice:

- once in the user-facing prose plan
- once again in the memory spec written during iteration 2

That duplicated reasoning without increasing correctness.

### Long generation latency

The inner file-generator call took about 92 seconds. The log shows this clearly.

The code path itself is not the same as the QueryLoop prompt bloat issue, because the inner generator used a minimal two-message prompt in the log. So the main inefficiency here is not "the file generator got the full giant prompt." That specific claim is not supported by this session.

The prompt-bloat concern is still directionally valid for QueryLoop itself, because each loop turn carries a large system instruction block plus growing message history.

## Claims From The External Reports

### Clearly true

- Invalid dependency order on `spec_code`
- Memory context hijacked task interpretation
- The first reply should have executed instead of asking for confirmation
- Missing post-generation verification
- There is a meaningful routing mismatch around artifact generation

### Partly true, but needs refinement

- "Project brain contamination"
  - Partly true as a symptom.
  - More precisely, this log implicates quick-resolve synthesis prompt design before planner-side project-brain usage.

- "Prompt bloat"
  - True at the QueryLoop/session level.
  - Not true for the inner file-generator subcall in this specific log, which used a small prompt.

- "Successful hallucination" of `PLAN.EX-000077`
  - Plausible inference.
  - Not directly provable from repo code.

### Not the right immediate conclusion

- "Add a brand new complexity scorer"
  - The repo already has complexity scoring.
  - The problem is inconsistency between the fast-path gate and the planner heuristics, not total absence of scoring.

## Failure Points

These are the main failure points surfaced by this session:

1. Greeting-prefixed imperative commands can slip past command-intent detection.
2. Retrieved memory is treated too aggressively as scope-setting context.
3. The quick execution path and planner path use different complexity logic.
4. `generate_and_save_file` allows an ambiguous payload contract.
5. Post-write verification is missing from the normal success path.
6. The system prompt and tool metadata disagree on the preferred artifact-generation tool.

## Design Improvements That Would Solve This In This Repo

### 1. Normalize command detection before quick-resolve synthesis

Fix the command detector so greetings and assistant-name prefixes do not block execution intent.

Good repo-level approach:

- preprocess the leading salutation and vocative before `isCommandIntent()`
- or detect the first imperative clause instead of matching only the beginning of the raw string

Relevant code:

- `core/memory/quick-resolve.ts:201-210`

Expected effect:

- `Hi zaraban, create ...` routes as an action, not a memory-grounded retrieval answer

### 2. Keep retrieved memory as background for commands, not task scope

For command-like requests, retrieved memory should help with tone, naming, and continuity, but it should not redefine the project unless the user explicitly asks for that.

Relevant code:

- `core/agent.ts:1278-1287`
- `core/agent.ts:1289-1299`

Expected effect:

- no more "this is part of Dashboard/deadline" behavior for simple artifact requests

### 3. Unify complexity policy across the fast gate and planner

The system should not classify the same request as:

- cheap LOW/MEDIUM work in one place
- obvious `HIGH` artifact generation in another

Relevant code:

- `core/agent.ts:1215-1217`
- `core/planner.ts:40-46`

Expected effect:

- more predictable routing for website/app/code-generation tasks

### 4. Add a pre-dispatch validator for `generate_and_save_file`

Before calling the skill:

- reject payloads that contain both `description` and `spec_code`
- if `spec_code` is present, verify it exists before dispatch
- if it does not exist, force the `memory_write` step first

Relevant code:

- `core/skills/tools/generate_and_save_file.ts:55-75`
- `core/query-loop.ts`

Expected effect:

- removes the exact failure seen in iteration 1
- makes the contract explicit instead of relying on tool failure to teach the model

### 5. Add mandatory post-write verification in QueryLoop

After successful `generate_and_save_file` or `file_writer`, call `verify_state` automatically.

Relevant code:

- `core/query-loop.ts:616-650`
- `core/skills/tools/verify_state.ts:9-18`

Expected effect:

- closes the loop on artifact creation
- gives transparency on whether the file really exists
- creates a cleaner completion condition for generated artifacts

### 6. Resolve the `generate_and_save_file` contradiction

Choose one of these directions:

- keep `generate_and_save_file` as the preferred artifact tool and remove the deprecation messaging
- or migrate prompts and orchestration toward `content_writer + file_writer`

Relevant code:

- `core/query-loop.ts:208-210`
- `core/query-loop.ts:400-401`
- `core/query-loop.ts:526-545`
- `core/skills/tools/generate_and_save_file.ts:2`

Expected effect:

- less prompt confusion
- cleaner tool selection behavior

## Practical Conclusion

This was a successful run with one real logic failure and several avoidable inefficiencies.

The most important fixes are:

1. improve command detection before quick-resolve synthesis
2. stop letting retrieved memory redefine command scope
3. enforce spec existence before `generate_and_save_file`
4. add automatic post-write verification
5. unify artifact-generation routing rules

If those were in place, this session would likely have been:

- direct execution from the first actionable turn
- no phantom Dashboard/deadline framing
- no invalid `spec_code` failure
- a cleaner and more trustworthy completion signal
