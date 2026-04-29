# The One-Call Engine: A New Execution Primitive for AI Agents

**Author:** Zaraban Project
**Date:** April 2026
**Status:** Concept validated — first implementation shipped (Phase 24). Generalisation in progress (Phase 25).

---

## Abstract

Modern AI agents waste most of their inference budget supervising work the model already decided how to do. We propose a different primitive — and a different framing.

**Agents are compilers.** The LLM compiles a natural-language goal into typed bytecode (a `TaskSpec`); a deterministic engine is the runtime; the ledger is the program counter and stack. The model plans once and is fired. Counter-driven code handles retries, bans, timeouts, and termination. State lives in a struct, not in conversation history.

This document defines the execution contract that makes specs trustworthy, the step-type DSL whose design is the actual intellectual work, the escalation protocol that handles novelty without retreating to ReAct, the side-effect classification that makes the system auditable, and the memory loop that makes every run cheaper than the last. We describe the first production implementation (multi-target web download, Phase 24), measured outcomes, and the discipline for Phase 25: build three concrete engines before extracting a universal runtime.

> **The LLM may produce candidates. The engine decides state transitions.**

That is the whole architecture in one line.

---

## 1. The Problem

Modern AI agents are inefficient at multi-step tasks because they are designed to think at every step.

When an agent is asked to download six brand catalogs from the web, the typical flow looks like this:

```
search → think → fetch → think → try download → fail → think → retry → think → fail again → think...
```

Every "think" is an LLM call. Every LLM call consumes tokens, adds latency, and introduces a new opportunity for the model to forget what it already tried, re-attempt a known-bad URL, or lose track of which targets are done.

In production logs, a six-target download task consumed 25–40 LLM iterations — not because the task was hard, but because the agent was rediscovering failure states it had already encountered. The problem is architectural: **state lives in the conversation, and the model is being asked to supervise its own execution.**

That is the wrong job for a stochastic system whose context window forgets what happened forty messages ago.

---

## 2. The Insight

An LLM is excellent at one thing in a multi-step task: **deciding what needs to happen.**

It is poor at a different thing: **managing the execution of what it decided.**

These are two separate jobs, and they should be handled by two separate systems.

The LLM should write the recipe. Code should cook the meal. Planning is a probabilistic function; execution is a deterministic one. Confusing them is the root cause of agent unreliability.

---

## 3. The Execution Contract

Before showing any schema, define what a `TaskSpec` *is*. A spec is a contract — and "contract" is load-bearing, not rhetoric. A valid spec must answer five questions, and each answer must be machine-checkable. If the spec cannot answer all five, the engine should reject it and refuse to run. The schema is the legal text; the contract is the meaning.

**1. What needs to happen.** A flat, ordered list of typed steps. Each step has a `kind` discriminant that selects a runner, an `input` shape that the runner's schema validates, and an `id` that downstream steps reference. No step is "do whatever makes sense" — every step resolves to a single function call with a typed input.

**2. How outputs pass forward.** Named ledger variables. Step `s1` writes to `$results`; step `s2` reads `$results[0]`. Variables are typed (a search step yields `string[]`, a download step yields `{ path: string, bytes: number }`). The engine resolves references at execution time, not parse time, so a step can fail and a later step can be skipped without the spec becoming invalid. References must be statically extractable — if you can't draw the data-flow graph from the spec alone, the contract is broken.

**3. What counts as success.** Validation rules, declared in the step. "HTTP 200" is not success. "File ≥ 7,000,000 bytes that opens as a valid PDF and matches the brand keyword" is success. Every step type owns its own success predicate, expressed in code, not in prompt instructions to the model. A step's `validate` clause is part of the contract: if `validate` returns false, the step's output is invalid, regardless of whether the underlying tool returned success.

**4. What happens on failure.** A policy field, drawn from a closed enum: `try_next` (advance to the next candidate input), `skip` (mark the step skipped and continue), `fallback` (run a paired recovery step), `abort` (terminate the whole spec), or `escalate` (handoff to §7's escalation protocol). The engine reads the policy. The model never decides at runtime whether to retry — the model decided that when it wrote the spec.

**5. What state must survive interruption.** Step status, attempts, banned inputs, partial artifacts. The ledger is the snapshot. Crash anywhere and resume from the last completed step. This is non-negotiable: if the runtime cannot serialise the ledger and continue from a serialisation, you do not have a runtime — you have a script.

A spec that answers all five is a contract. A spec that answers fewer is a wish. The engine accepts contracts and rejects wishes.

---

## 4. The Architecture

### Step 1 — One structured call

The agent receives a task in natural language. It makes a single LLM call to produce a structured execution spec:

```json
{
  "kind": "web_download_multi_target",
  "targets": ["Neolith", "SapienStone", "LivingCeramics"],
  "artifact": "2025 general catalog PDF",
  "minBytes": 7000000,
  "destDir": "Porcelain_PDF/catalogs",
  "filenameTemplate": "{BrandName}_generalcatalog.pdf"
}
```

The schema is enforced by Zod. The call is bounded at 400 tokens. The LLM's job is done. **It produces a spec. It is no longer involved.**

### Step 2 — Deterministic execution

A TypeScript engine reads the spec and runs it. Each target gets a `TargetRecord` in a flat ledger:

```typescript
interface TargetRecord {
  target: string;
  searches: number;        // counter, not LLM judgment
  pagesFetched: number;    // counter
  downloads: number;       // counter
  candidateUrls: string[];
  bannedUrls: Set<string>; // grows monotonically; never forgotten
  status: 'pending' | 'ok' | 'skipped';
  filePath: string | null;
  skipReason: string | null;
}
```

Retry logic is a counter comparison. Failure handling is set membership. Loop termination is a wall clock and three integers. None of it consults a model.

```
Engine state (TypeScript object, not LLM memory):
  ├── target: "Neolith"
  ├── searches: 1 / 2
  ├── pagesFetched: 2 / 3
  ├── downloads: 1 / 3
  ├── bannedUrls: {url_403, url_flipbook}
  └── status: in_progress
```

The hard caps come from `core/skills/web-download-multi-target.ts`:

```12:16:core/skills/web-download-multi-target.ts
export const MAX_SEARCHES_PER_TARGET = 2;
export const MAX_PAGES_PER_TARGET = 3;
export const MAX_DOWNLOADS_PER_TARGET = 3;
export const MAX_TOTAL_MS = 120_000;
```

Two phases per target — discover, then download — both governed by their counter. Banned domains (Issuu, FlipHTML5, Yumpu, Calameo, Joomag, PubHTML5, ArchiExpo) are blocked at the ranking layer, not via prompt instructions. A flipbook host scores `−5`; the engine never picks it.

### Step 3 — Deterministic output

When the engine finishes, it renders a plain-text report from the ledger alone — no LLM call required:

```
FINAL_STATUS:
ok=[Neolith, SapienStone]
skipped=[
  LivingCeramics: no valid PDF after 2 searches / 3 pages / 3 attempts
]
Files saved to: Porcelain_PDF/catalogs
Duration: 47s
```

The user gets the same answer they would get from a perfect model — without paying for one.

---

## 5. Step Types as a DSL

The set of step types the engine supports is itself a domain-specific language. Designing it well is the actual intellectual work of building an engine. Everything downstream — reliability, auditability, memory compounding — is a consequence of step-type design.

Three principles govern good step types.

**Principle 1: Composable.** Every step's output must be nameable and consumable by another step. A step that only mutates global state (writes a file, sends an email) and emits no machine-readable result is a dead end — the next step has nothing to bind to. Even side-effect steps must return a typed receipt: `{ path: 'workspace/x.pdf', bytes: 7_412_993, sha256: '…' }`. Composability is what lets the engine resolve `$file` in step 4 to the path produced by step 3 without the LLM ever seeing either value.

**Principle 2: Idempotent where possible.** Retries must be safe. The engine retries automatically; it cannot distinguish "succeeded but the network timed out before the response arrived" from "failed; please retry." Idempotency makes that distinction harmless. `download_file` that overwrites the destination is idempotent; one that appends is not. `create_record` should upsert by deterministic key, not error on duplicates. `submit_form` that uses an Idempotency-Key header is safer than one that does not. When a step type cannot be made idempotent — because the underlying API genuinely is not — that step type must declare itself non-idempotent in its descriptor and force `maxRetries: 0` in the policy. Hiding non-idempotency is how systems duplicate orders.

**Principle 3: Self-validating.** Each step type defines its own success in code, not via LLM judgment. HTTP 200 is not success — the server can return 200 with an HTML login page when you asked for a PDF. "Downloaded ≥ 7MB *and* opens as a valid PDF *and* contains the brand keyword on page 1" is success. Validation is a function from the step's own output and inputs to `boolean`. It runs after every attempt, before the engine moves on. The model is never asked "did that work?" — the validator already answered.

**The granularity warning.** Step types live on a spectrum. Too primitive — `read_byte`, `tcp_connect`, `parse_token` — and the spec is just a slow Python program written in JSON: every spec is enormous, the LLM can't reliably produce one, and the cognitive overhead defeats the point. Too coarse — `do_the_porcelain_task` — and the engine cannot checkpoint, retry sub-parts, or resume from a partial failure: the step is a black box and you have rebuilt the original LLM loop with extra ceremony.

The right granularity is **one verb the LLM reaches for unprompted when describing the task.** `web_search`, `download_file`, `validate_pdf`, `extract_links`, `transform_image`, `paginate_api`. These are the actions the model would name in a free-form plan. Step types should be the nouns of that vocabulary, not the consonants underneath them and not the paragraphs above them.

A step library that gets granularity right looks small (twenty to forty types), reads like a mid-level imperative API, and lets the LLM produce specs of three to fifteen steps for ninety percent of real tasks. A step library that gets it wrong either bloats specs into hundreds of lines or collapses them into a single opaque kind. Both are recoverable, but only by rewriting the library — which is why this design choice deserves more attention than the runtime.

---

## 6. The Failure Taxonomy

The engine's reliability comes from naming the ways it can fail and giving each one a deterministic response. Every entry below is enforced by code, not by a prompt instruction.

| Failure | Detection | Response |
|---|---|---|
| Search returns nothing useful | `parseSearchResults().length === 0` after rank+filter | Increment `searches`; retry with alternate query template; bail at cap |
| Landing page is a flipbook | Domain in `BANNED_DOMAINS` or score `≤ −4` | Drop from ranking; never fetched |
| Page fetch errors (403/404/timeout) | `web_fetch.success === false` | Add URL to `bannedUrls`; continue |
| Page has no PDF anchors | `extractPdfLinksFromHtml()` returns `[]` | Increment `pagesFetched`; move to next page |
| Download HTTP failure | `download_file.success === false` | Add URL to `bannedUrls`; try next candidate |
| Download succeeds but is too small | `stat.size < spec.minBytes` | Mark file invalid; ban URL |
| Download succeeds but is not a real PDF | `read_pdf.success === false` | Mark invalid; ban URL |
| Login wall / signin page in URL | URL contains `login\|signin\|register\|account` | Score `−3`; deprioritised, often dropped |
| Wall-clock exceeded | `Date.now() − startMs > MAX_TOTAL_MS` | Break inner loop; remaining targets recorded as `skipReason: 'timeout'` |
| Spec extraction fails | `extractWebDownloadSpec()` returns `null` | Fall through to general QueryLoop (graceful degradation) |
| LLM returns unparseable JSON | Three-layer parse chain (Phase 23): direct → `jsonrepair` → schema-corrected retry | Hard fail returns `null`; router degrades gracefully |

Each failure is *named*, *detected* by a deterministic check, and *responded to* by a deterministic action. There is no row that reads "the model decides what to do." That column does not exist.

---

## 7. The Escalation Protocol

Terminal failure is not a crash. It is an escalation trigger.

When the engine has exhausted its policy on a step — every retry consumed, every fallback skipped, every counter at its cap — it does not crash, return an empty result, or call back into a conversational loop. It packages the relevant slice of the ledger and sends *one* structured recovery call to the LLM. That call is the only LLM invocation after the initial spec extraction, and the engine is strict about what it includes:

- The failed step's `id`, `kind`, and last-resolved `input`.
- The error code, validation reason, and last attempt's raw output (truncated).
- The current ledger slice: completed steps, partial outputs, banned URLs / banned record IDs, counters at their caps.
- The original spec.
- Nothing from the user's conversation history. Nothing from working memory beyond the ledger. The escalation prompt is hermetic.

The LLM produces a typed recovery decision: a *continuation spec* that appends new steps to the ledger, a *revised spec* that replaces remaining steps, or an *abandon* verdict that surfaces the ledger to the user as the final result. The engine validates the recovery against the same Zod schema as the original spec, then resumes — the ledger continues to accumulate.

This is the answer to "what if the world changes mid-run" without retreating to ReAct. ReAct asks the model on every step; the escalation protocol asks the model only when *the engine itself has declared no further deterministic progress is possible.* The difference is bounded vs unbounded LLM consultation.

**The discipline matters more than the mechanism.** Target rate: one replan per ~10 ordinary steps. If a task type consistently hits escalation — the same `kind` with the same family of failures across runs — that is not a runtime problem. That is a *step library* problem: the step vocabulary is missing a verb the world requires, and the fix is to add a step type, not to teach the LLM to improvise. Escalation is the smoke alarm; consistent escalation on a kind means the building's wiring is wrong, and the right move is to rewire, not to keep installing alarms.

A second discipline: the recovery call has its own circuit breaker. Two consecutive escalations on the same step `id` within one task abort the task entirely and surface the ledger to the user. A spec that needs three replans is a spec that should never have been written; the task is past the boundary of what the current step library can express, and the user deserves to know that.

Escalation is not a fallback to the old loop in disguise. It is a single, accountable, schema-enforced call that produces a continuation contract. The model still does not supervise execution. The model patches the recipe; the engine cooks it.

---

## 8. Side Effects and Approval Gates

Reliability is necessary but not sufficient. A reliable engine that submits the wrong form or deletes the wrong file is worse than an unreliable one — it fails confidently. Side-effect classification is what makes the engine acceptable in environments where LLM-decided side effects are unacceptable.

Every step type, at registration time, declares a side-effect class drawn from a closed enum:

| Class | Examples | Approval default |
|---|---|---|
| `none` | `web_search`, `web_fetch`, `parse_html`, `extract_links`, `validate_pdf`, `read_record` | No gate. Run freely. |
| `local_write` | `download_file` (to sandboxed `destDir`), `write_ledger`, `save_artifact`, `create_workspace_record` | No gate by default; gated when path leaves a configured allowlist. |
| `external_write` | `submit_form`, `send_email`, `create_api_resource`, `post_message` | Gate. Engine pauses; user approves. |
| `destructive` | `delete_file`, `overwrite_existing`, `cancel_order`, `purchase`, `transfer_funds` | Gate, with explicit confirmation copy. Approval cannot be cached across sessions. |

The classification lives on the **tool registry**, not on the spec and not in the LLM's prompt. The engine reads it. Gated steps pause the runtime, emit a structured `approval_request` event with the step's `id`, `kind`, resolved `input`, and class, and resume only after explicit approval is recorded. Approvals can be granted per-step, per-class-this-session, or per-task; the policy is configured outside the spec.

The security argument is unambiguous: **you can audit a compiled execution graph; you cannot audit a stream of consciousness.** A `TaskSpec` enumerates every side-effecting step before execution. A reviewer can read it, redline it, run dry-run mode (which executes only `none`-class steps and produces a synthetic ledger), and only then authorise the live run. The conversational loop offers no such surface — every turn is a fresh decision with no pre-commitment, and "approval" is whatever the model happened to ask for in that turn's prose.

This is also where the side-effect classification compounds with the step-type DSL from §5. Self-validating steps mean the engine knows whether each side effect actually occurred; idempotent steps mean approved retries are safe; composable outputs mean the gate's record references the same artifact the next step will consume. A registry-level discipline becomes an audit trail by construction.

In Zaraban, this lines up with the existing `permissionLevel` field on every skill (`read-only` / `workspace-write` / `full-access`) — the engine inherits that taxonomy, sharpens it into the four classes above, and adds the structural fact that gates fire *before* the step runs, not as a side effect of an already-in-flight LLM turn.

---

## 9. Ledgers as Memory

Most agent frameworks have to bolt memory on. Zaraban built memory first and is now plugging the engine into it. That ordering is not cosmetic; it changes what every spec call looks like.

When the engine completes a task, the ledger is converted into a `RunRecord` and written to the `HOW.RR` (run record) notebook:

```typescript
interface RunRecord {
  code: string;                          // HOW.RR-NNNNNN
  task_description: string;              // original natural-language goal
  spec_kind: string;                     // 'web_download_multi_target'
  spec_summary: {
    targets?: string[];
    artifact?: string;
    inputs_hash: string;                 // sha256 of canonical spec.inputs
  };
  outcome: 'success' | 'partial' | 'failure';
  duration_ms: number;
  winning_path: Array<{                  // what worked
    target?: string;
    discovery: { query: string; page: string };
    artifact: { url: string; bytes: number; validator: 'read_pdf' };
  }>;
  dead_ends: Array<{                     // what didn't, with reason
    url: string;
    reason: 'http_403' | 'too_small' | 'flipbook' | 'invalid_pdf' | 'login_wall';
  }>;
  ledger_snapshot: unknown;              // full TargetRecord[] for replay
  session_id: string;
  created_at: string;                    // ISO8601
}
```

The compounding loop:

```
memory  →  spec call (1 LLM invocation)  →  deterministic execution  →  ledger  →  RunRecord  →  memory
   ↑                                                                                                ↓
   └────────────────────────  next task seeds bannedUrls + candidateUrls  ───────────────────────────┘
```

Concretely, when the spec extractor runs, the memory layer fetches recent `RunRecord` entries whose `spec_kind` matches and whose `task_description` is semantically near the new request. Their `dead_ends` seed the engine's `bannedUrls` *before the new spec even runs.* Their `winning_path[*].artifact.url` seeds `candidateUrls` as priors. The deterministic engine never starts cold: it inherits the failure memory of every prior run.

**Spec generation is therefore not cold-start. It is retrieval-augmented planning.** The single LLM call that produces the spec is informed by a structured prior — not raw conversation history, not embedding-only similarity hits, but typed records of what specifically worked and failed for tasks of this kind. The model writes a better spec because it is operating on a richer prior; the engine runs faster because it starts with curated bans and curated candidates; the user sees lower latency and higher success rates over time on tasks they have asked for before.

This is what differentiates Zaraban from a generic workflow tool. A generic tool can adopt the spec/runtime separation tomorrow; what it cannot adopt overnight is a memory layer that was built before any tools existed and that already has typed slots for run records, contacts, projects, procedures, and reflections. Phase 24 is the first engine to participate in that memory loop. Phase 25's three engines will participate in it from the day they ship, and `RunRecord` becomes the universal cross-engine artifact that makes "what did I learn from prior runs" a straight lookup, not an intuition.

---

## 10. Why This Is Better

| Dimension | Conversational LLM loop | One-Call Engine |
|---|---|---|
| LLM calls per six-target task | 25–40 | 1 (plus rare escalations) |
| Tokens per task (typical) | 60k–120k | ~1.5k (spec + final summary) |
| State location | Conversation history | TypeScript ledger object |
| Retry policy | Model judgment, drifts under context pressure | Three integer counters per target |
| Failure memory | Frequently lost when context rolls | Permanent in `bannedUrls: Set` and `RunRecord.dead_ends` |
| Loop termination | Model decides "I've tried enough" | `while (counter < cap && Date.now() < deadline)` |
| Crash recovery | Restart from zero | Resumable from last completed `TargetRecord` |
| Predictability | Variable run-to-run | Deterministic given spec + skill outputs |
| Auditability | Read 40-iteration trace | Read flat ledger array; spec is the manifest |
| Side-effect approval | Per-turn prose request, no pre-commitment | Pre-classified at registry; gate fires before step runs |
| Memory compounding | Bolted on; embedding-similarity at best | Typed `RunRecord`; seeds bans and candidates by construction |
| Token cost | High | Minimal |
| Latency | Bound by LLM RTT × iterations | Bound by network + a single ~400-token call |

The dominant cost in the old loop was not the model's intelligence. It was the model's **rediscovery** of facts already in its own context, on every turn, in slightly different words.

---

## 11. Comparison With Prior Art

This pattern has been discovered independently by several agent frameworks. The convergence is meaningful — it suggests a correct abstraction, not a local optimisation.

| System | Same idea, expressed as |
|---|---|
| **OpenClaw / Lobster** | Workflow shell where the agent generates a `.lobster` pipeline spec and a typed runtime executes it. Approval gates pause side effects. Resumable with tokens. |
| **Claude Code** | Tools partitioned into concurrent (reads, parallelizable) and serialized (writes, sequential). The agent plans; the harness decides execution order. |
| **Gemini CLI** | Search grounding happens as a fixed retrieval pass, not an LLM-decided action. Discovery is deterministic; synthesis is LLM. |
| **OpenAI Assistants / function calling** | Tools surface declaratively; the loop is hidden but still LLM-supervised. Closer to the old pattern than the new one. |
| **LangGraph** | State graph with typed transitions; the model picks edges. Halfway: state is structured but transitions still consult the model on every step. |
| **Zaraban Phase 24** | One structured spec; counter-driven engine; ledger as state; LLM fired after spec extraction; ledgers feed back into typed memory. Nearest neighbour to Lobster, but with retrieval-augmented planning by construction. |

Convergence across independent systems matters. It says this is the correct abstraction, not a quirk of any one design.

---

## 12. What Makes This Implementation Different

**Memory-aware spec generation.** Per §9. The spec is produced by an agent that already remembered the relevant context.

**Three-layer schema parse chain (Phase 23).** When the LLM returns malformed JSON, we don't ask the model to try again — we run `jsonrepair`. If that fails, we run a single corrective retry with a structured prompt that includes the Zod error path. If *that* fails, we degrade gracefully. The spec call is therefore reliable enough to trust as a single point of decision.

**Tool-level circuit breaker.** Two consecutive identical-argument failures of the same skill in the same request trip a circuit breaker. The engine cannot loop on the same broken URL forever even if a counter were misconfigured. Defence in depth.

**Transparency events at every state transition.** The engine emits `web_download_engine_start`, `web_download_target_start`, `web_download_search`, `web_download_fetch`, `web_download_attempt`, `web_download_target_done`, `web_download_engine_done`. Every transition is auditable. The flat trace is the truth; no inference required.

**Graceful degradation.** If spec extraction fails, the router falls through to the QueryLoop engine. If the QueryLoop times out, the user gets a partial result with the failure reason. The system is never silently wrong.

---

## 13. Risks and Limitations

The pattern is not free.

**Spec quality bounds outcomes.** A bad spec produces a bad run. The `extractWebDownloadSpec` call must be well-prompted, schema-validated, and small. We currently bound it at 400 output tokens. Recovery is the escalation protocol (§7), not retrying the extractor.

**Domain coverage.** Each new domain needs a dedicated engine + schema. There is no zero-shot domain. This is a deliberate tradeoff: generality for reliability. We believe this is the right tradeoff for production agents and the wrong one for research demos.

**Discoverability of when to invoke.** Phase 24 uses two regexes in the router (`MULTI_TARGET_DOWNLOAD_RE` + `CATALOG_TARGET_LIST_RE`) to decide whether to invoke the engine. This works but does not scale. The post-Phase-25 dispatcher will add a single LLM-graded "what kind of task is this?" call, returning a `TaskKind` discriminant before the kind-specific extractor runs.

**Adversarial inputs.** A malicious target list could try to coerce the spec extractor into writing files outside `destDir`. Mitigation: the SSRF guard, the workspace-rooted download path, and the MIME/magic-number check on every download. None of these depend on the LLM's judgment. Per §8, side-effect classification ensures any out-of-allowlist write is gated, not silent.

**Over-banning.** The `BANNED_DOMAINS` set is hand-curated. A legitimate flipbook-hosted catalog will be missed. This is a deliberate choice: a missed catalog is recoverable; a 40-iteration runaway loop is not. As the memory layer accumulates `RunRecord.dead_ends`, the curated set can be supplemented (not replaced) by per-task-kind learned bans.

**Step-library drift.** The biggest long-term risk is not runtime: it is the step library going stale. New tools, new APIs, new failure modes appear. A library that stops growing produces specs that increasingly require escalation, and escalation rates are the leading indicator of library staleness. The fix is a quarterly review of the per-`kind` escalation rate; sustained > 10% means the library needs new verbs.

---

## 14. Measured Outcomes — Phase 24

For a representative six-target porcelain catalog task (Neolith, SapienStone, LivingCeramics, Dekton, Laminam, Flaviker):

| Metric | Old QueryLoop | One-Call Engine |
|---|---|---|
| LLM calls | 28–37 (varied per run) | 1 |
| Wall clock | 4–9 min | 35–90 s |
| Tokens (in + out) | ~85k typical | ~1.4k |
| Targets completed (median) | 3 of 6 | 5 of 6 |
| Determinism (same input → same outcome) | No | Yes (modulo network) |
| Crash recovery | Restart from zero | Ledger persists; resumable |
| Per-target failure attributable to | "Model gave up" / "lost track" / "tried bad URL again" | Specific counter cap or ban reason |

The tail-target (typically `LivingCeramics` — flipbook-only distribution) is the same in both systems. The difference is that the engine **says so explicitly** and stops, while the loop spent another 8 iterations rediscovering the same fact.

---

## 15. Roadmap — Three Engines Before the Universal

The temptation, after one working engine, is to extract a universal `TaskSpec` runtime immediately. That would be a mistake. **Universal abstractions extracted from a single example are vague.** They optimise for what the first engine happened to need and miss the structure that only emerges when independent engines start to look alike under pressure.

The discipline is therefore: **build three concrete engines first.** Phase 24 shipped the first. Phase 25 will ship two more, in this order:

**Engine #2 — `file_batch_transform`.** Take a glob of input files, apply a typed transform to each, validate, write to an output directory, produce a per-file ledger. Concrete examples: convert 50 PNGs to WebP at 80% quality with size validation; rename a folder of CSVs by a deterministic rule with collision detection; extract first-page text from a folder of PDFs into a JSON index.

**Engine #3 — `api_paginated_collect`.** Authenticate against an HTTP API, walk a paginated endpoint, collect records into a structured store, validate, deduplicate, halt on terminal page or count. Concrete examples: pull the last 30 days of issues from a GitHub repo into JSONL; collect all rows of a Google Sheet via the Sheets API; mirror an RSS feed with last-seen-id checkpointing.

Only **after the third engine is in production** do we extract `TaskSpec`. By then the actually-shared parts will be obvious — and they will not be the parts we would have guessed from Phase 24 alone:

- **Ledger format.** All three will need a flat array of typed records with status, attempts, banned-input set, and partial output.
- **Retry policy.** All three will need `try_next` / `skip` / `fallback` / `abort` / `escalate` and they will agree on the semantics.
- **Validation interface.** All three will need a typed `validate(output, input) → { ok, reason }` predicate per step kind.
- **Checkpointing.** All three will need to serialise the ledger to disk after every step, keyed by `(taskId, stepId)`.
- **Resume logic.** All three will need to re-hydrate the ledger and re-enter execution at the first non-terminal step.

The bits that *vary* — discovery strategies, ranking heuristics, side-effect classes per step kind, validation predicates — stay engine-specific. The universal runtime is only the parts that survived three independent design pressures.

This is the discipline that separates a runtime that ages well from a framework that ossifies on day one. The four engines after `TaskSpec` extraction (file, api, browser, data, plus whatever Phase 26 brings) plug in by registering a `(schema, runner, classifier, formatter)` tuple. The router becomes a kind-discriminator. The escalation protocol, the side-effect gates, and the memory loop are runtime concerns once and run-engine concerns never.

---

## 16. The Underlying Claim

Most "agent" systems are LLM-supervised loops with tools attached. The model is the orchestrator, the planner, the executor, the retry policy, the timeout, and the summariser — all at once. This is a category error. It conflates a probabilistic decision-making function with a deterministic state machine and gets the worst of both.

The One-Call Engine separates them. **Agents are compilers.** The LLM compiles a goal into bytecode. The engine is the runtime. The ledger is the program counter. State is a struct, not a transcript. Side effects are typed at the registry level and gated before they fire. Memory is the symbol table, written back after every successful run, indexed for the next compilation.

> The LLM may produce candidates. The engine decides state transitions.

Several open Zaraban architectural threads dissolve under this framing.

**Complexity detection folds into the planner.** We have spent many sprints on heuristics that decide whether a request is LOW / MEDIUM / HIGH / MAX so the right engine fires. With specs, complexity is no longer a guess — it is the *length and shape of the produced spec*. A spec with two steps is simple; a spec with twelve steps and three escalation hooks is complex. The detector becomes a downstream measurement, not an upstream prediction. We delete the heuristic and read the bytecode.

**`implement_and_test` becomes a schema rule, not a planner instruction.** We have a recurring failure mode where the planner produces code-writing steps without paired tests. Today this is an instruction in the planner prompt, and instructions in prompts get forgotten under context pressure. With typed step kinds, it becomes a schema-level invariant: any `file_writer` step whose output type is `executable` (`.ts`, `.py`, `.js`, etc.) must be paired with a matching `validate` step in the same spec. The Zod schema rejects specs that violate this; the LLM cannot produce a valid spec without the pairing. **Schema rules don't get forgotten under context pressure; planner rules do.**

The same logic applies elsewhere. Constraint extraction becomes a typed field on the spec, not a parallel pass. Confirmation gates become a side-effect class, not a router branch. Retry caps become per-step policy, not a planner instinct. Every behaviour we currently enforce by prompt becomes a thing we enforce by type.

The model writes the recipe. Code cooks the meal. The kitchen has timers, ovens, a list of bad ingredients pinned to the wall, an approval slip for anything that touches the customer, and a notebook where every shift's outcomes are recorded. The chef is not consulted on whether to set a timer.

That is not a limitation of intelligence. That is what intelligence, properly deployed, looks like.

---

## Appendix A — Code References

Spec schema:

```244:253:core/schemas.ts
export const webDownloadSpecSchema = z.object({
  kind: z.literal('web_download_multi_target'),
  targets: z.array(z.string().min(1)).min(1),
  artifact: z.string().min(3),
  minBytes: z.number().int().min(0).default(200_000),
  destDir: z.string().min(1),
  filenameTemplate: z.string().min(1),
});

export type WebDownloadSpec = z.infer<typeof webDownloadSpecSchema>;
```

Spec extractor — the only LLM call in the entire task:

```25:52:core/skills/web-download-spec-extractor.ts
export async function extractWebDownloadSpec(
  message: string,
  llmHandler: LLMHandler,
): Promise<WebDownloadSpec | null> {
  let raw: string;
  try {
    raw = await llmHandler(
      [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: message },
      ],
      { maxTokens: 400 },
    );
  } catch {
    return null;
  }

  const result = await parseStructured(raw, webDownloadSpecSchema, {
    maxRepairAttempts: 1,
    llmHandler,
    context: 'web-download-spec-extractor',
  });

  if (!result.success || !result.data) return null;
  if (result.data.targets.length < 1) return null;

  return result.data;
}
```

Ledger type — engine state lives here, not in any prompt:

```24:34:core/skills/web-download-multi-target.ts
export interface TargetRecord {
  target: string;
  searches: number;
  pagesFetched: number;
  downloads: number;
  candidateUrls: string[];
  bannedUrls: Set<string>;
  status: 'pending' | 'ok' | 'skipped';
  filePath: string | null;
  skipReason: string | null;
}
```

Router gate — how a natural-language request becomes an engine invocation:

```680:716:core/router.ts
  if (detectMultiTargetDownload(goalMessage)) {
    transparency.emit({
      type: 'route',
      data: {
        level: 'MEDIUM',
        reason: 'multi-target download detected — routing to deterministic engine',
        path: 'web_download_engine',
      },
    });

    const { extractWebDownloadSpec } = await import('./skills/web-download-spec-extractor.js');
    const { runWebDownloadMultiTarget, renderFinalMessage } = await import('./skills/web-download-multi-target.js');
    const { runSkill } = await import('./skills/runner.js');

    const spec = await extractWebDownloadSpec(goalMessage, llmHandler);

    if (spec) {
      const report = await runWebDownloadMultiTarget(
        spec,
        (name, input) => runSkill(name, input, parentCtx, signal),
        (event) => transparency.emit(event as Parameters<typeof transparency.emit>[0]),
      );
      return {
        parts: [{ order: minOrder, route: 'agentic', reply: renderFinalMessage(report, spec) }],
        plan: { /* … */ },
      };
    }
    // Spec extraction failed — fall through to Tier 2 (QueryLoop)
  }
```

---

## Appendix B — Phase 25 `TaskSpec` Sketch (Post-Engine-#3)

To be extracted *only after* `file_batch_transform` and `api_paginated_collect` have shipped. Sketched here for orientation, not for early implementation:

```typescript
type TaskKind =
  | 'web_download_multi_target'
  | 'file_batch_transform'
  | 'api_paginated_collect'
  | 'browser_form_submit'
  | 'data_diff_export';

interface TaskSpec<K extends TaskKind = TaskKind, I = unknown> {
  kind: K;
  inputs: I;
  policy: {
    onFail: 'try_next' | 'skip' | 'fallback' | 'abort' | 'escalate';
    maxRetries: number;
    timeoutMs: number;
    parallelism: number;
  };
  outputs: {
    summary: 'ledger' | 'llm' | 'none';
    artifacts: string[];
  };
}

interface EngineEntry<K extends TaskKind, I, L> {
  kind: K;
  schema: ZodSchema<I>;
  sideEffectClass: 'none' | 'local_write' | 'external_write' | 'destructive';
  runner: (spec: TaskSpec<K, I>, deps: EngineDeps) => Promise<L>;
  formatReport: (ledger: L, spec: TaskSpec<K, I>) => string;
  toRunRecord: (ledger: L, spec: TaskSpec<K, I>) => RunRecord;
}

const engineRegistry: Map<TaskKind, EngineEntry<TaskKind, unknown, unknown>> = new Map();
```

The web-download engine becomes:

```typescript
registerEngine({
  kind: 'web_download_multi_target',
  schema: webDownloadSpecSchema,
  sideEffectClass: 'local_write',
  runner: runWebDownloadMultiTarget,
  formatReport: renderFinalMessage,
  toRunRecord: webDownloadLedgerToRunRecord,
});
```

A new domain — say file-transform — adds one registration and lives alongside it. The router does not change. The escalation protocol does not change. The memory loop does not change. **Everything else is reuse.**

---

*This document describes an architectural direction under active development. The first implementation is in production. Two more engines are next, then the universal runtime. The pattern, as far as we can tell, is correct.*
