You are working on a TypeScript-based autonomous agent system (Zaraban). The system includes a QueryLoop, Planner/Executor pipeline, and a skills layer (generate_and_save_file, content_writer, etc.).

Your task is to fix systemic architectural issues in file generation, routing, and failure handling. Implement the following changes precisely.

---

## 1. Fix generate_and_save_file (CRITICAL)

### Problem

generate_and_save_file currently delegates to content_writer, which produces partial outputs and breaks the contract (HTML not complete).

### Required Fix

Refactor generate_and_save_file into a fully self-contained generator.

### Implementation requirements

* Call LLM directly (NOT content_writer)
* Enforce strict output contract:

  * Output must start with: "<!DOCTYPE html>"
  * Output must end with: "</html>"
* Add internal retry loop (max 3 attempts)
* Validate after each attempt:

  * contains "<html"
  * contains "<body"
  * endsWith("</html>")

### If validation fails:

* Call LLM again with:

  * previous output
  * explicit error message (e.g. "Output is incomplete: missing </html>")

### Do NOT rely on QueryLoop retries for this

---

## 2. Enforce Tool Purity

### Problem

System incorrectly falls back:
generate_and_save_file → content_writer

### Required Fix

* Remove any dependency between generate_and_save_file and content_writer
* Add hard constraint:

IF task == file generation:
ONLY allowed skill = generate_and_save_file

* Reject or ignore content_writer in this context

---

## 3. Improve Failure Detection (Circuit Breaker)

### Problem

Breaker only detects identical failures (string match), missing semantic repetition.

### Required Fix

Replace failure comparison logic with:

failure_signature = hash({
skill_name,
normalized_input,
error_type
})

* Normalize input (strip whitespace, truncate long text)
* Track last N (3) failure signatures

IF 3 repeated signatures:
→ trigger breaker

---

## 4. Fix QueryLoop Failure Handling

### Problem

System retries blindly without adapting strategy.

### Required Fix

On failure:

* Pass structured failure feedback to LLM:

{
"previous_error": "...",
"failed_skill": "...",
"reason": "invalid HTML output"
}

* Allow model to:

  * retry same skill with correction
  * OR change approach

Add rule:
IF same skill fails twice → force strategy change or escalate

---

## 5. Fix Complexity Routing

### Problem

Complex generation tasks are misclassified as LOW.

### Required Fix

Update assessComplexity():

IF user request contains any of:
["build", "create", "generate", "simulation", "app", "tool", "game"]

AND output involves code or files:
→ complexity = HIGH

Route HIGH tasks to:
planner → executor

NOT query_loop

---

## 6. Upgrade HTML Validation

### Problem

Validation is binary and not actionable.

### Required Fix

Replace with structured validator:

validateHTML(output):
return {
hasDoctype: boolean,
hasHTMLTag: boolean,
hasBody: boolean,
properlyClosed: boolean
}

If invalid:

* Generate specific error:
  "Missing </html>"
  "Missing <body>"
  etc.

Feed this back into retry loop

---

## 7. Stabilize Tool Selection

### Problem

LLM switches tools mid-loop incorrectly.

### Required Fix

In QueryLoop:

* If initial tool = generate_and_save_file
  → lock tool for this task unless explicitly failing 2+ times

Prevent switching to content_writer for same goal

---

## 8. Logging Improvements (Optional but recommended)

Add structured logs:

* failure_signature
* retry_count per skill
* validation_errors
* tool_switch_reason

---

## Expected Outcome

After implementation:

* File generation produces valid full HTML consistently
* No partial JS fragments returned
* QueryLoop does not oscillate between tools
* Failures converge or break early instead of looping
* Complex tasks route to planner instead of query loop

---

## Constraints

* Do not introduce new abstractions unless necessary
* Maintain current architecture (QueryLoop + Planner)
* Keep changes localized to:

  * generate_and_save_file
  * query-loop
  * complexity routing
  * validation utilities

---

Implement clean, minimal, production-grade code.
