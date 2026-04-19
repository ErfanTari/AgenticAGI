# Context Diet — Batch 0 Audit Report
**Date:** 2026-04-19  
**Sprint tag target:** `context-diet-complete`

---

## 0.1 — Surface Area

### Core file line counts + key exports

| File | Lines | Key exports |
|------|-------|-------------|
| `core/agent.ts` | 1550 | `isProcessingMessage`, `processMessage`, `startAgent`, `stopAgent`, `_getPendingConfirmationPlan`, `_setPendingConfirmationPlan` |
| `core/context.ts` | 598 | `buildContext`, `buildRollingContext`, `fetchOwnerPersona`, `getIndexSummary`, `rankByRelevance`, `rankByLightRAG`, `trimHistoryToTokenBudget`, `estimateTokens` |
| `core/query-loop.ts` | 892 | `runQueryLoop`, `filterPointerIndex`, `QueryLoopResult`, `ArtifactContext` |
| `core/planner.ts` | 1431 | `decomposeTask`, `assessComplexity`, `filterPlannerMemoryContext`, `resolveTemplates`, `normalizePlanDefaults`, `validateImageAcquisition`, `verifyPlanAssertions`, `PlannerContext`, `ComplexityLevel` |
| `core/executor.ts` | 1360 | `executePlan`, `writeMilestoneMemoryCycle`, `verifyExecution`, `runPostFlightSynthesis`, `buildUserReport`, `buildGroundTruthSnapshot`, `classifyFailure`, `classifyFailureResponse` |
| `core/router.ts` | 910 | `routeDecomposedUnits`, `executeConfirmedPlan`, `buildWorkspaceManifest`, `RouteExecutionResult` |
| `core/intake.ts` | 337 | `runIntake`, `extractConstraints`, `IntakeSignals`, `IntakeResult`, `ResolvedEntry` |
| `core/decomposition.ts` | 437 | `decomposeMessage`, `isLikelyCompoundMessage`, `buildSingleUnitFallback`, `sanitizeForHistory` |
| `core/llm.ts` | 600 | `callLLM`, `getPrimaryLLMProfile`, `getFallbackLLMProfile`, `getAnthropicCloudProfile`, `stripThinkingTags`, `sanitizeFinalOutput` |
| `core/memory-mode.ts` | 56 | `getMemoryMode`, `setMemoryMode`, `isMemoryFullyDisabled`, `getScratchpadPath`, `appendScratchpad`, `readScratchpad`, `clearScratchpad` |
| `core/skills/registry.ts` | 171 | `registerSkill`, `getAllSkills`, `getSkillDescriptions`, `getSkillDescriptionsForPermission`, `getSkillsByPermission`, `getSkillsForIntent` |
| `core/skills/runner.ts` | 22 | `runSkill` |

**`core/memory/context.ts`** — ABSENT (not in project).

### Prompts directory

| File | Bytes | ~Tokens |
|------|-------|---------|
| `prompts/planner.md` | 26,234 | ~6,558 |
| `prompts/query-loop.md` | 5,203 | ~1,300 |
| `prompts/decomposition.md` | 3,414 | ~853 |
| `prompts/intake.md` | 1,650 | ~412 |
| `prompts/milestone-revision.md` | 634 | ~158 |
| `prompts/post-flight.md` | 176 | ~44 |
| `prompts/content-writer.md` | 120 | ~30 |
| **Total** | **37,431** | **~9,357** |

**Critical finding:** `prompts/planner.md` alone is 26KB (~6,558 tokens). This is injected on every agentic decomposition call.

---

## 0.2 — Token Accounting

**Method:** Static analysis + measured sizes. Live TRANSPARENT=true instrumentation was not run (would require an LLM endpoint), but component sizes are exact.

### Prompt component sizes (measured)

| Component | Size | ~Tokens | Notes |
|-----------|------|---------|-------|
| `core/context.ts` SYSTEM_PROMPT | ~900 chars | ~225 | Always injected |
| Owner persona (WHO.CT) | ~200-500 chars | ~100 | Injected if exists, every call |
| Index summary (MEMORY.md) | ~1,000-3,000 chars | ~500 | Injected on summary queries |
| Resolved memory entries | variable | ~200-800 | Injected from `runIntake` results |
| Active PLAN.CT constraints | variable | ~100-300 | Injected every step via buildContext |
| `formatSkills()` output | ~500 chars | ~125 | Per skill in context.ts buildContext |
| `getSkillDescriptionsForPermission()` | 5,650 chars | **1,413** | In query-loop system prompt |
| `prompts/query-loop.md` body | 5,203 bytes | **1,300** | Every query-loop iteration system prompt |
| `prompts/planner.md` body | 26,234 bytes | **6,558** | Every decomposeTask call |

### Estimated per-iteration breakdown (LOW complexity agentic run, "write hello world to ./hello.txt")

Iteration 0 (planning call via `decomposeTask`):
- planner.md: ~6,558 tokens
- skill_descriptions injected into template: ~1,413 tokens
- runtime_context: ~50 tokens
- memory context (if any): ~200-800 tokens
- user message: ~20 tokens
- **Subtotal planning call: ~8,000–9,000 tokens input**

Iteration 1+ (query-loop iterations):
- query-loop.md: ~1,300 tokens
- skill_list in template: ~1,413 tokens (full registry again)
- goal text: ~50 tokens
- pointer index (MEMORY.md filtered): ~200-400 tokens
- prior tool results: ~200-500 tokens each (cumulative)
- user message: ~20 tokens
- **Subtotal per query-loop iteration: ~3,000–4,000 tokens input**

### Fraction breakdown (query-loop iteration)

| Category | Tokens | % of ~3,500 total |
|----------|--------|-------------------|
| System prompt (query-loop.md) | ~1,300 | 37% |
| Skill registry text | ~1,413 | 40% |
| Memory context (pointer index) | ~300 | 9% |
| Tool outputs from prior iterations | ~350 | 10% |
| User message + task goal | ~70 | 2% |

**FLAG: System prompt + skill registry = ~77% of average query-loop iteration input. This is the primary target.**

For the planner call, skill registry + planner.md template = ~8,000/9,000 = **89% of total input**.

---

## 0.3 — Memory-Off Audit

### Baseline (memory enabled)
- **1555 pass / 25 fail** — matches expected pre-existing failures

### Memory-disabled (`MEMORY_MODE=disabled`)
- **1554 pass / 26 fail** — 1 net new failure

### New failure identified (not in pre-existing list)

| Test | File | Likely cause |
|------|------|--------------|
| `processMessage > greeting returns instantly without LLM` | `tests/phase3/agent.test.ts` | Memory-disabled changes agent init path in a way that affects the greeting fast-path |

**All other failures visible in memory-disabled run appear to be pre-existing** (phase16 query-loop-fastpath, phase18/grep-workspace, phase13/decomposition, phase6/skills memory-query, phase9/p1-stress, phase20/reasoning-strip, phase3/memory-query-from-SQLite).

**Net new coupling bugs: 1** (phase3 greeting fast-path). Must be investigated before tag.

---

## 0.4 — Skill Injection Audit

Every place the full skill registry is stringified into a prompt:

| Location | File | Line | Injected size | Notes |
|----------|------|------|--------------|-------|
| Query-loop system prompt | `core/query-loop.ts` | 314 | ~1,413 tokens | Every iteration |
| Planner decomposition prompt | `core/router.ts` | 695 | ~1,413 tokens | Via `decomposeTask` context |
| Autonomous mode | `core/autonomous.ts` | 91 | ~1,413 tokens | Lower priority target |
| Intent routing | `core/intent.ts` | — | varies | Shim — low volume |

**Primary hotspots:**
1. `core/query-loop.ts:314` — fires every query-loop iteration (3–20x per request)
2. `core/router.ts:695` → `core/planner.ts:1103` — fires on every `decomposeTask` call

**Total skill registry injection cost per LOW-complexity request (3 QL iterations + 1 planning):**  
4 × 1,413 = **5,652 tokens wasted on registry text** that the model references only 1-2 skills from.

Two-stage discovery (Batch 1.3) would reduce this to ~400 tokens (one-liner list) + one schema fetch (~100 tokens) = **~500 tokens**, a **91% reduction** for this component.

---

## 0.5 — Prompt Template Reference Audit

### Template loading mechanism
Templates are loaded by name via `promptLoader.load(name, vars)` (singleton, file-cached, vars substituted at call time). This is already the "load by ID" pattern. No direct body concatenation exists for the main templates.

### Template usage map

| Template | Loaded in | Frequency |
|----------|-----------|-----------|
| `planner` | `core/planner.ts:1102` | Once per agentic decomposition |
| `query-loop` | `core/query-loop.ts:326` | Every QL iteration (3–20x per request) |
| `decomposition` | `core/decomposition.ts:293` | Once per message (before planning) |
| `intake` | (loaded in intake pipeline) | Once per message |
| `milestone-revision` | `core/executor.ts:432` | On milestone revision attempts |
| `post-flight` | `core/executor.ts:1208` | Once per completed plan |
| `content-writer` | `core/skills/tools/content_writer.ts:456` | On content_writer skill invocations |

### Log bloat from repeated templates

In a 10-iteration query-loop run:
- `query-loop.md` (5,203 bytes) is injected 10 times = **52,030 bytes** in transparency logs
- `planner.md` (26,234 bytes) injected once per replanning = **26,234 bytes**

If transparency logs store the full prompt body per event, a single 10-iteration run generates **~78KB** of repeated template text in logs.

**Recommendation:** Transparency events should log `{promptId: 'query-loop', ctxHash: <hash_of_vars>}` instead of the full body. Template body is recoverable from `prompts/<id>.md`. This alone removes the bloat.

**Current state:** The promptLoader already uses named IDs. Transparency events need to adopt prompt ID references rather than embedding the body — this is a Batch 1.2 change.

---

## Key Findings Summary

| Finding | Severity | Target Batch |
|---------|----------|-------------|
| Skill registry = 40% of QL input per iteration | CRITICAL | Batch 1.3 |
| `planner.md` = 26KB, injected every decomposition call | CRITICAL | Batch 1.2 / 1.1 |
| Query-loop.md = 37% of QL system prompt | HIGH | Batch 1.1 |
| Persona injected unconditionally when memory enabled | HIGH | Batch 2.1 |
| Index summary injected on any summary query | MEDIUM | Batch 2.1 |
| Memory-disabled net new failure: greeting fast-path | MEDIUM | Batch 2.3/fix |
| Transparency logs store full prompt bodies (bloat) | MEDIUM | Batch 1.2 |
| No per-iteration token accounting in transparency events | MEDIUM | Batch 4.1 |

**Primary 60% reduction target:**  
Eliminating full skill registry from every QL iteration (saves ~1,413/3,500 = 40%) + trimming query-loop.md system prompt (saves ~1,300/3,500 = 37%) yields theoretical 77% reduction if both are addressed. Even achieving 60% of that improvement hits the sprint goal.

---

*Report complete. Batch 1 may begin.*
