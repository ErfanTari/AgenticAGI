/**
 * Phase 25.4 — anti-mimicry guards on the prompt layer.
 *
 * The Qwen 3.6 trace showed the LLM running inside QueryLoop emitting
 *
 *     FINAL_STATUS: ok=[] skipped=[Porselanosa, iris ceramic, fiandre]
 *
 * even though no engine fired. The format is reserved for the deterministic
 * `web_download_multi_target` engine's `renderFinalMessage`. Any prompt that
 * teaches the LLM to print that format is a regression — it makes the diag's
 * `outcome=mimicry` detector fire and confuses operators reading the trace.
 *
 * Two prompts are checked:
 *   1. decomposition.md — must NOT instruct the unit text to contain
 *      `FINAL_STATUS:`. (The original trace's decomposed unit ended with
 *      `Report FINAL_STATUS: ok=[] skipped=[]`, but that was actually being
 *      pasted from the `Catalogs` starter chip in `public/index.html`. The
 *      decomposition prompt itself never injected it; we just lock that down.)
 *   2. query-loop-base.md — must teach `QUERY_LOOP_RESULT` (the fallback's
 *      distinct format) and NOT positively instruct the LLM to emit
 *      `FINAL_STATUS:`. Negative mentions ("FINAL_STATUS is reserved…") are
 *      allowed and in fact required.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const promptDir = path.join(process.cwd(), 'prompts');

describe('decomposition.md does not teach FINAL_STATUS mimicry', () => {
  const decomposition = fs.readFileSync(path.join(promptDir, 'decomposition.md'), 'utf8');

  it('does not contain the substring FINAL_STATUS:', () => {
    expect(decomposition).not.toContain('FINAL_STATUS:');
  });

  it('does not instruct the unit to "Report FINAL_STATUS"', () => {
    expect(decomposition.toLowerCase()).not.toContain('report final_status');
  });

  it('does not contain a Report ok=[] skipped=[] template', () => {
    // Catches any "Report ... ok=[] skipped=[]" fragment regardless of label
    expect(decomposition).not.toMatch(/ok\s*=\s*\[\s*\]\s*skipped\s*=\s*\[\s*\]/i);
  });
});

describe('query-loop-base.md uses the distinct QUERY_LOOP_RESULT format', () => {
  const queryLoop = fs.readFileSync(path.join(promptDir, 'query-loop-base.md'), 'utf8');

  it('teaches the QUERY_LOOP_RESULT label for the consolidated report', () => {
    expect(queryLoop).toContain('QUERY_LOOP_RESULT');
  });

  it('does NOT positively instruct the LLM to emit FINAL_STATUS:', () => {
    // We allow negative mentions — sentences that explicitly forbid mimicry —
    // but a single line that ALSO contains an emit verb (emit/output/return/
    // produce/print) AND `FINAL_STATUS:` AND no negation marker is a smoking
    // gun for mimicry training.
    const lines = queryLoop.split('\n');
    const positiveEmit = lines.find(line =>
      /\b(emit|output|return|produce|print|write)\b/i.test(line) &&
      /FINAL_STATUS\s*:/.test(line) &&
      !/(NOT|reserved|engine|mimic|do not|don't|never)/i.test(line),
    );
    expect(
      positiveEmit,
      'query-loop-base.md must not positively instruct the LLM to emit FINAL_STATUS — that label is reserved for the deterministic engine.',
    ).toBeUndefined();
  });
});

describe('public/index.html starter chips do not embed FINAL_STATUS in user messages', () => {
  // The Catalogs starter chip used to set
  //   data-prompt="...Report FINAL_STATUS: ok=[] skipped=[]..."
  // which pasted the engine's output format directly into the user's message.
  // QueryLoop fallback would then dutifully echo it back, and the diag would
  // see a FINAL_STATUS line with no engine_start event → flagged as mimicry.
  const indexHtml = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');

  it('no starter-chip data-prompt contains the substring FINAL_STATUS:', () => {
    // Pull every data-prompt="..." attribute and verify none contain the
    // reserved label. This is robust against the chip moving in markup.
    const dataPrompts = Array.from(indexHtml.matchAll(/data-prompt="([^"]*)"/g)).map(m => m[1]);
    expect(dataPrompts.length).toBeGreaterThan(0); // sanity: starter chips do exist
    for (const prompt of dataPrompts) {
      expect(prompt, `starter-chip data-prompt leaks engine format: "${prompt.slice(0, 80)}…"`).not.toContain(
        'FINAL_STATUS',
      );
    }
  });
});
