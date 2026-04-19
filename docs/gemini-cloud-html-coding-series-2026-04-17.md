# Gemini Cloud HTML + Coding Series Report

Date: 2026-04-17
Model: `gemini-2.5-flash`
Runner: `scripts/trace-diagnose-models.mjs`

## Scope

This report covers two Gemini cloud benchmark passes for:

- a single-file HTML bakery website task
- a small Node/Express coding scaffold task

Evidence reviewed for each pass:

- compact trace: `workspace/logs/trace-diagnosis/*.trace.txt`
- full JSON event log: `workspace/logs/trace-diagnosis/*.json`
- console log with per-call timings: `workspace/logs/trace-diagnosis/*.console.log`
- generated outputs in `workspace/outputs/...`

The four runs analyzed:

1. `20260417203256-html-gemini-2-5-flash`
2. `20260417203356-coding-gemini-2-5-flash`
3. `20260417204237-html-gemini-2-5-flash`
4. `20260417204237-coding-gemini-2-5-flash`

## Executive Summary

The Gemini cloud path is cleaner than the earlier local-model traces, but it is still not reliable enough for production on these two task types.

What is improved:

- No trace interleaving appeared in these Gemini runs.
- Intake corruption from earlier local traces (`\\u0000`, false `agenticSignal`) did not reproduce.
- The HTML path can complete in one iteration when the model behaves.

What is still broken:

- HTML generation is not stable: one pass was fast, the next stalled for 67.7s with `empty response content`.
- HTML contract enforcement is weak: both generated sites violated the “self-contained” requirement by pulling remote fonts/images/scripts.
- Coding is still dominated by orchestration, not coding.
- The coding path repeatedly writes placeholder file bodies like `[176 chars]` and `[463 chars]` instead of real code.
- The agent still attempts blocked skills (`run_bash`) in `workspace-write` mode.
- After the work is already done, the loop can spend extra turns repairing or restating completion instead of exiting.

## Run-by-Run Findings

### HTML Run 1

Files:

- `workspace/logs/trace-diagnosis/20260417203256-html-gemini-2-5-flash.trace.txt`
- `workspace/logs/trace-diagnosis/20260417203256-html-gemini-2-5-flash.console.log`
- `workspace/outputs/trace-diag-html-modelprobe/bakery_website_20240730120000/index.html`

Observed behavior:

- Finished in `33.8s`, `2` LLM calls, `1` iteration, `goal_complete`.
- The model ignored the intended single-file target path and invented a nested timestamped subfolder:
  - trace path: `outputs/trace-diag-html-modelprobe/bakery_website_20240730120000/index.html`
  - evidence: `workspace/logs/trace-diagnosis/20260417203256-html-gemini-2-5-flash.trace.txt:14`
- The deliverable is not truly self-contained:
  - Google Fonts: `workspace/outputs/trace-diag-html-modelprobe/bakery_website_20240730120000/index.html:7`
  - Unsplash images: `workspace/outputs/trace-diag-html-modelprobe/bakery_website_20240730120000/index.html:128`
  - Google Maps link: `workspace/outputs/trace-diag-html-modelprobe/bakery_website_20240730120000/index.html:523`

Assessment:

- Fast.
- Usable-looking output.
- Contract-incorrect.

### Coding Run 1

Files:

- `workspace/logs/trace-diagnosis/20260417203356-coding-gemini-2-5-flash.trace.txt`
- `workspace/logs/trace-diagnosis/20260417203356-coding-gemini-2-5-flash.console.log`
- `workspace/outputs/trace-diag-coding-modelprobe/package.json`
- `workspace/outputs/trace-diag-coding-modelprobe/server.js`
- `workspace/outputs/trace-diag-coding-modelprobe/test.js`

Observed behavior:

- Finished in `32.7s`, `8` LLM calls, `5` iterations.
- Intake and decomposition were correct:
  - `agenticSignal: true`
  - evidence: `workspace/logs/trace-diagnosis/20260417203356-coding-gemini-2-5-flash.trace.txt:13`
- Planner still produced a `HIGH` complexity 3-milestone, 6-step plan for a tiny scaffold:
  - evidence: `workspace/logs/trace-diagnosis/20260417203356-coding-gemini-2-5-flash.console.log:4`
- `package.json` was written correctly.
- `server.js` and `test.js` were written as literal placeholders:
  - trace: `workspace/logs/trace-diagnosis/20260417203356-coding-gemini-2-5-flash.trace.txt:91`
  - trace: `workspace/logs/trace-diagnosis/20260417203356-coding-gemini-2-5-flash.trace.txt:112`
  - file: `workspace/outputs/trace-diag-coding-modelprobe/server.js:1`
  - file: `workspace/outputs/trace-diag-coding-modelprobe/test.js:1`
- The model attempted blocked `run_bash` anyway:
  - trace: `workspace/logs/trace-diagnosis/20260417203356-coding-gemini-2-5-flash.trace.txt:133`
- The loop still accepted the task as complete even though two of three source files were unusable.

Assessment:

- Clean trace.
- Wrong artifact.
- Most of the model budget went to planning and orchestration, not real coding.

### HTML Run 2

Files:

- `workspace/logs/trace-diagnosis/20260417204237-html-gemini-2-5-flash.trace.txt`
- `workspace/logs/trace-diagnosis/20260417204237-html-gemini-2-5-flash.console.log`
- `workspace/outputs/trace-diag-html-modelprobe-1/index.html`

Observed behavior:

- Finished in `119.9s`, `4` LLM calls, `2` iterations.
- First tool-selection turn was fine:
  - `outputs/trace-diag-html-modelprobe-1/index.html`
  - evidence: `workspace/logs/trace-diagnosis/20260417204237-html-gemini-2-5-flash.trace.txt:14`
- The generation call then stalled for `67.7s` and failed with `empty response content`:
  - trace: `workspace/logs/trace-diagnosis/20260417204237-html-gemini-2-5-flash.trace.txt:25`
  - console: `workspace/logs/trace-diagnosis/20260417204237-html-gemini-2-5-flash.console.log:3`
- The system then did another orchestration turn and retried generation.
- Final artifact again violated the self-contained requirement:
  - Google Fonts: `workspace/outputs/trace-diag-html-modelprobe-1/index.html:7`
  - Unsplash images: `workspace/outputs/trace-diag-html-modelprobe-1/index.html:119`
  - remote Font Awesome script: `workspace/outputs/trace-diag-html-modelprobe-1/index.html:660`

Assessment:

- Path discipline improved.
- Stability regressed badly.
- Contract enforcement still missing.

### Coding Run 2

Files:

- `workspace/logs/trace-diagnosis/20260417204237-coding-gemini-2-5-flash.trace.txt`
- `workspace/logs/trace-diagnosis/20260417204237-coding-gemini-2-5-flash.console.log`
- `workspace/outputs/trace-diag-coding-modelprobe-1/package.json`
- `workspace/outputs/trace-diag-coding-modelprobe-1/server.js`
- `workspace/outputs/trace-diag-coding-modelprobe-1/test.js`

Observed behavior:

- Finished in `59.6s`, `11` LLM calls, `8` iterations.
- Same invalid placeholder bug reproduced exactly:
  - trace: `workspace/logs/trace-diagnosis/20260417204237-coding-gemini-2-5-flash.trace.txt:91`
  - trace: `workspace/logs/trace-diagnosis/20260417204237-coding-gemini-2-5-flash.trace.txt:112`
  - file: `workspace/outputs/trace-diag-coding-modelprobe-1/server.js:1`
  - file: `workspace/outputs/trace-diag-coding-modelprobe-1/test.js:1`
- Same blocked `run_bash` attempt reproduced:
  - trace: `workspace/logs/trace-diagnosis/20260417204237-coding-gemini-2-5-flash.trace.txt:133`
- After the blocked step, the loop burned 4 extra model turns on completion/repair chatter:
  - repeated completion attempts at `:154`, `:175`, `:196`, `:212`
  - repair narrations at `:165`, `:186`, `:207`, `:210`
- Console confirms a large planning cost before any real file writing:
  - planner latency `37588ms`
  - evidence: `workspace/logs/trace-diagnosis/20260417204237-coding-gemini-2-5-flash.console.log:3`

Assessment:

- Reproducibly invalid coding deliverable.
- Repeated orchestration after completion.
- Worse efficiency than Run 1.

## Effort Split: Coding vs Orchestration

### HTML Tasks

Run 1:

- Orchestration time: `4.7s` (`14.1%`)
- Useful HTML generation time: `28.8s` (`85.9%`)
- Successful output tokens: orchestration `306` (`5.9%`), HTML generation `4881` (`94.1%`)

Run 2:

- Orchestration time: `9.9s` (`8.3%`)
- Failed/stalled generation time: `67.7s` (`56.6%`)
- Useful HTML generation time: `42.0s` (`35.1%`)
- Successful output tokens: orchestration `1066` (`12.0%`), HTML generation `7811` (`88.0%`)
- Note: the failed `empty response content` call consumed time but returned no recorded token usage, so token-based accounting understates wasted work.

HTML takeaway:

- HTML is not orchestration-heavy.
- HTML is stability-heavy: when it fails, the waste is inside the generation step itself.

### Coding Tasks

Run 1:

- Orchestration time: `28.0s` (`86.1%`)
- Useful coding time: `2.7s` (`8.4%`)
- Placeholder/fake coding time: `1.8s` (`5.4%`)
- Output-token split:
  - orchestration `2190` (`88.0%`)
  - useful code `215` (`8.6%`)
  - placeholder code `82` (`3.3%`)

Run 2:

- Orchestration time: `54.3s` (`91.5%`)
- Useful coding time: `2.6s` (`4.4%`)
- Placeholder/fake coding time: `2.4s` (`4.1%`)
- Output-token split:
  - orchestration `3118` (`91.3%`)
  - useful code `212` (`6.2%`)
  - placeholder code `86` (`2.5%`)

Coding aggregate across both runs:

- Time: `89.6%` orchestration, `5.8%` useful coding, `4.6%` placeholder/fake coding
- Output tokens: `89.9%` orchestration, `7.2%` useful coding, `2.8%` placeholder/fake coding

Coding takeaway:

- The system is spending almost all model effort on orchestration, not code.
- The little “coding” that remains is partly invalid because placeholder content is accepted as real output.

## Errors and Bugs Seen in This Series

### 1. Placeholder file bodies are being written as if they were valid code

Symptom:

- `server.js` and `test.js` become `[176 chars]` and `[463 chars]` in both coding runs.

Root cause:

- Query-loop history compression rewrites large XML tag values into placeholders like `[123 chars]` inside the assistant history itself:
  - `core/query-loop.ts:95`
  - `core/query-loop.ts:106`
  - `core/query-loop.ts:111`
- That teaches the model that placeholder bodies are acceptable XML tool outputs.
- `file_writer` then accepts any string payload with no content validity check:
  - `core/skills/tools/file_writer.ts:45`

Fix:

1. Stop storing placeholder text inside executable XML fields.
2. Replace prior tool calls in history with a non-executable summary such as `file_writer(path=..., content_omitted=true, bytes=436)`.
3. Add a hard reject in query-loop and `file_writer` for placeholder bodies matching `^\\[\\d+ chars\\]$`.
4. Add minimum-validity checks for code files before accepting success.

### 2. HTML “self-contained” contract is not enforced

Symptom:

- Both HTML outputs include remote fonts, remote images, and in one run a remote Font Awesome script.

Root cause:

- `generate_and_save_file` validates only HTML structure, not offline/self-containedness:
  - `core/skills/tools/generate_and_save_file.ts:462`

Fix:

1. Add HTML validation rules that fail on:
   - `<link href=\"https://...\">`
   - `<script src=\"https://...\">`
   - `src=\"https://...\"`
   - `url('https://...')`
2. Make the generation prompt explicitly say “no remote URLs of any kind.”
3. For benchmark mode, reject output unless every asset is inline.

### 3. Exact output-path compliance is not deterministic

Symptom:

- HTML Run 1 invented `bakery_website_20240730120000/` under the requested folder.
- HTML Run 2 used the resolved directory correctly.

Root cause:

- Path rewriting only swaps the directory prefix but still allows arbitrary nested suffixes:
  - `core/query-loop.ts:290`
  - `core/query-loop.ts:315`
- For single-artifact goals, “use resolved output directory exactly” is still advisory, not enforced:
  - `core/query-loop.ts:331`
  - `core/query-loop.ts:351`

Fix:

1. For single-artifact create goals, compute the canonical target path server-side and overwrite the model path.
2. If the goal implies `index.html`, force `resolvedDir/index.html`.
3. Reject extra nested directories on that path class.

### 4. Misleading fallback logging

Symptom:

- Console says `trying fallback` on HTML Run 2, but the next logged provider is still `diag-local-primary/gemini-2.5-flash`.

Root cause:

- The warning is emitted before checking whether a fallback actually exists:
  - `core/llm.ts:614`
  - `core/llm.ts:623`

Fix:

1. Only log “trying fallback” if `runtime.fallback` is non-null.
2. Otherwise log “no fallback configured; surfacing error.”

### 5. `empty response content` is not retried at the right layer

Symptom:

- HTML Run 2 lost `67.7s` inside a generation call and then recovered only after a new outer query-loop turn.

Root cause:

- `callOpenAICompatibleEndpoint` throws immediately on empty content:
  - `core/llm.ts:482`
  - `core/llm.ts:501`
- No same-provider retry exists for this class of failure.

Fix:

1. Add 1-2 immediate same-provider retries for `empty response content`.
2. Preserve the same request payload and keep the retry inside the LLM layer.
3. Record retry count in transparency so the UI shows whether the recovery was internal or loop-level.

### 6. Blocked-skill awareness is not strong enough

Symptom:

- Both coding runs attempted `run_bash` even though planner context already knew blocked skills should not be used.

Root cause:

- The model is told about blocked skills in text, but the execution loop still lets it plan around them and attempt them.

Fix:

1. Remove blocked skills from the tool list presented to the query-loop model.
2. If verification requires a blocked skill, short-circuit to a limited-completion summary instead of attempting it.
3. Mark test execution as optional when permission mode forbids it.

### 7. Completion handling after blocked verification is wasteful

Symptom:

- Coding Run 2 spent 4 extra LLM turns after the files already existed.

Root cause:

- Over-broad tool-intent repair and no short-circuit for “deliverables exist; optional verification blocked”:
  - tool-intent heuristic: `core/query-loop.ts:151`
  - repair loop: `core/query-loop.ts:668`

Fix:

1. Narrow `looksLikeToolIntent` so plain completion summaries do not re-enter repair.
2. If all required files exist and the only remaining blocked step is optional verification, end immediately.
3. Treat repeated semantically identical completion summaries as completion, not format failure.

### 8. Planner cost is too high for tiny scaffolds

Symptom:

- Coding planner cost was `20.6s` in Run 1 and `37.6s` in Run 2 for a trivial 3-file Node scaffold.

Root cause:

- The system still routes this prompt through a high-complexity multi-milestone planning path.

Fix:

1. Add a deterministic scaffold fast-path for small coding tasks like:
   - `package.json`
   - one server file
   - one test file
2. Lower complexity classification for “small multi-file scaffold” tasks.
3. Skip full planner when file set and artifact shape are explicit in the user prompt.

### 9. Memory sync foreign-key errors still happen at startup

Symptom:

- Every diagnostic process emitted `syncMemoryFilesToIndex` foreign-key failures for:
  - `memory/WHAT/projects/WHAT.PJ-000069_persianpoetry.md`
  - `memory/NOW/todos/NOW.TD-000006_research-persian-poetry-apis.md`

Relevant code:

- sync path: `core/memory/index.ts:234`
- chunk insertion with FK to `index_entries`: `core/memory/embeddings.ts:8`
- chunk write call during sync: `core/memory/index.ts:281`

Likely cause:

- `storeChunks` is called after an `INSERT OR IGNORE` / update path without a per-entry transactional guarantee that the parent row is present and consistent for those specific codes.

Fix:

1. Make per-entry sync transactional:
   - upsert `index_entries`
   - delete old chunks for `code`
   - insert new chunks
2. Assert parent existence before chunk insert.
3. Log the offending code and parent-row lookup result, not just the file path.

## Recommended Next Phase

Priority order:

1. Fix placeholder history compression leak.
2. Add hard validation for code-file placeholder bodies.
3. Enforce single-artifact canonical paths server-side.
4. Add self-contained HTML validation.
5. Remove blocked skills from query-loop tool exposure.
6. Add same-provider retry for `empty response content`.
7. Add a small-scaffold coding fast-path to cut planner/orchestration overhead.

If these are fixed, the next benchmark pass should answer two questions:

1. Does coding stop writing placeholder files?
2. Does the coding effort split move materially away from `~90% orchestration`?
