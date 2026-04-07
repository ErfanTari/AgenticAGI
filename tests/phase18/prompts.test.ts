/**
 * Phase 18 — PromptLoader + Template + TOKEN_BUDGETS tests
 * 15 tests total:
 *   8 PromptLoader unit tests
 *   4 Integration smoke tests
 *   3 Token budget tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPromptLoader, promptLoader } from '../../core/prompt-loader.js';
import { TOKEN_BUDGETS } from '../../config/agent.config.js';

// ─── PromptLoader unit tests ──────────────────────────────────────────────────

describe('PromptLoader unit tests', () => {
  let tmpDir: string;
  let loader: ReturnType<typeof createPromptLoader>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaraban-pl-test-'));
    loader = createPromptLoader(tmpDir);
  });

  it('1. load() returns the full template content for a known template', () => {
    fs.writeFileSync(path.join(tmpDir, 'hello.md'), 'Hello world!');
    expect(loader.load('hello')).toBe('Hello world!');
  });

  it('2. load() substitutes a single {{var}} correctly', () => {
    fs.writeFileSync(path.join(tmpDir, 'greet.md'), 'Hello {{name}}!');
    expect(loader.load('greet', { name: 'Zaraban' })).toBe('Hello Zaraban!');
  });

  it('3. load() substitutes multiple distinct {{var}} placeholders in one pass', () => {
    fs.writeFileSync(path.join(tmpDir, 'multi.md'), '{{a}} and {{b}} and {{c}}');
    expect(loader.load('multi', { a: 'X', b: 'Y', c: 'Z' })).toBe('X and Y and Z');
  });

  it('4. load() leaves unresolved {{var}} placeholders intact', () => {
    fs.writeFileSync(path.join(tmpDir, 'partial.md'), '{{known}} and {{unknown}}');
    const result = loader.load('partial', { known: 'ok' });
    expect(result).toBe('ok and {{unknown}}');
  });

  it('5. load() caches raw content — second call does not re-read disk', () => {
    const filePath = path.join(tmpDir, 'cached.md');
    fs.writeFileSync(filePath, 'original');
    loader.load('cached'); // prime cache

    // Overwrite disk — loader should still return cached value
    fs.writeFileSync(filePath, 'modified');
    expect(loader.load('cached')).toBe('original');
  });

  it('6. invalidate() clears cache entry — next load() re-reads disk', () => {
    const filePath = path.join(tmpDir, 'inv.md');
    fs.writeFileSync(filePath, 'first');
    loader.load('inv'); // prime cache
    fs.writeFileSync(filePath, 'second');
    loader.invalidate('inv');
    expect(loader.load('inv')).toBe('second');
  });

  it('7. invalidateAll() clears all entries', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.md'), 'a-content');
    fs.writeFileSync(path.join(tmpDir, 'b.md'), 'b-content');
    loader.load('a');
    loader.load('b');

    // Overwrite both on disk
    fs.writeFileSync(path.join(tmpDir, 'a.md'), 'a-new');
    fs.writeFileSync(path.join(tmpDir, 'b.md'), 'b-new');
    loader.invalidateAll();

    expect(loader.load('a')).toBe('a-new');
    expect(loader.load('b')).toBe('b-new');
  });

  it('8. load() throws a descriptive error if the template file does not exist', () => {
    expect(() => loader.load('nonexistent')).toThrow(/nonexistent/);
  });
});

// ─── Integration smoke tests ──────────────────────────────────────────────────

describe('Integration smoke tests', () => {
  const TEMPLATE_NAMES = [
    'decomposition',
    'planner',
    'query-loop',
    'post-flight',
    'milestone-revision',
    'intake',
    'content-writer',
  ];

  it('9. All 7 template files exist on disk', () => {
    for (const name of TEMPLATE_NAMES) {
      expect(promptLoader.exists(name), `Template ${name}.md should exist`).toBe(true);
    }
  });

  it('10. decomposition.md loads without error and contains {{current_date}}', () => {
    const content = promptLoader.load('decomposition');
    expect(content).toContain('{{current_date}}');
  });

  it('11. planner.md loads without error and contains {{skill_descriptions}}', () => {
    const content = promptLoader.load('planner');
    expect(content).toContain('{{skill_descriptions}}');
  });

  it('12. content-writer.md loads without error and contains {{format}}', () => {
    const content = promptLoader.load('content-writer');
    expect(content).toContain('{{format}}');
  });
});

// ─── Token budget tests ───────────────────────────────────────────────────────

describe('Token budget tests', () => {
  it('13. TOKEN_BUDGETS.PLANNER is >= 8192', () => {
    expect(TOKEN_BUDGETS.PLANNER).toBeGreaterThanOrEqual(8192);
  });

  it('14. TOKEN_BUDGETS.CONTENT_WRITER_HTML is >= 12000', () => {
    expect(TOKEN_BUDGETS.CONTENT_WRITER_HTML).toBeGreaterThanOrEqual(12000);
  });

  it('15. All values in TOKEN_BUDGETS are positive integers', () => {
    for (const [key, value] of Object.entries(TOKEN_BUDGETS)) {
      expect(Number.isInteger(value), `${key} should be an integer`).toBe(true);
      expect(value, `${key} should be positive`).toBeGreaterThan(0);
    }
  });
});
