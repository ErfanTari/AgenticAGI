import { describe, it, expect } from 'vitest';

// The verify-plan reminder is a prompt-level injection that fires every K=5 steps.
// Sprint spec §4.2 says to add it in executor.ts or query-loop.ts — but those files
// are in the Do-Not-Touch list for Sprint A. We verify the ZARABAN rules file contains
// the parallel-call and edit-hygiene directives instead, and document the reminder
// requirement for Sprint B (where executor.ts touches are allowed).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const zarabanRules = readFileSync(resolve(process.cwd(), 'prompts/zaraban-rules.md'), 'utf-8');
const editFormat = readFileSync(resolve(process.cwd(), 'prompts/edit-format-diff-fenced.md'), 'utf-8');

describe('zaraban-rules.md content', () => {
  it('contains parallel tool call directive', () => {
    expect(zarabanRules).toContain('Parallel tool calls');
  });

  it('contains edit hygiene directive', () => {
    expect(zarabanRules).toContain('Edit hygiene');
    expect(zarabanRules).toContain('file_reader');
    expect(zarabanRules).toContain('diff-fenced');
  });
});

describe('edit-format-diff-fenced.md content', () => {
  it('contains SEARCH marker format', () => {
    expect(editFormat).toContain('<<<<<<< SEARCH');
    expect(editFormat).toContain('>>>>>>> REPLACE');
  });

  it('documents structured failure feedback fields', () => {
    expect(editFormat).toContain('classification');
    expect(editFormat).toContain('nearestCandidates');
    expect(editFormat).toContain('hint');
  });
});
