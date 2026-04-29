import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveWithinWorkspace,
  renderDestFilename,
  listFilesByGlob,
  validateRecord,
  buildReport,
  renderFinalMessage,
  runFileBatchTransform,
  sideEffectClassForTransform,
  SIDE_EFFECT_CLASS,
  type FileTransformRecord,
  type SkillRunner,
} from '../../core/skills/file-batch-transform.js';
import type { FileBatchTransformSpec } from '../../core/schemas.js';
import { fileBatchTransformSpecSchema } from '../../core/schemas.js';

// ── Test workspace helpers ───────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fbt-'));
});

afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeFixture(rel: string, content: string | Buffer): string {
  const abs = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function makeSpec(overrides: Partial<FileBatchTransformSpec> = {}): FileBatchTransformSpec {
  return fileBatchTransformSpecSchema.parse({
    kind: 'file_batch_transform',
    source: { glob: 'inputs/*.txt' },
    transform: { kind: 'copy' },
    destDir: 'outputs',
    filenameTemplate: '{stem}_copy{ext}',
    ...overrides,
  });
}

// ── 1. Schema ────────────────────────────────────────────────────────────────

describe('fileBatchTransformSpecSchema', () => {
  it('accepts a minimal valid spec with defaults', () => {
    const parsed = fileBatchTransformSpecSchema.parse({
      kind: 'file_batch_transform',
      source: { glob: 'a/*.txt' },
      transform: { kind: 'copy' },
      destDir: 'out',
      filenameTemplate: '{stem}{ext}',
    });
    expect(parsed.overwrite).toBe('if-missing');
    expect(parsed.validation.minBytes).toBe(1);
  });

  it('rejects unknown transform kinds', () => {
    expect(() =>
      fileBatchTransformSpecSchema.parse({
        kind: 'file_batch_transform',
        source: { glob: '*.txt' },
        transform: { kind: 'compress' },
        destDir: 'out',
        filenameTemplate: '{stem}',
      }),
    ).toThrow();
  });

  it('rejects empty filenameTemplate', () => {
    expect(() =>
      fileBatchTransformSpecSchema.parse({
        kind: 'file_batch_transform',
        source: { glob: '*.txt' },
        transform: { kind: 'copy' },
        destDir: 'out',
        filenameTemplate: '',
      }),
    ).toThrow();
  });
});

// ── 2. resolveWithinWorkspace ────────────────────────────────────────────────

describe('resolveWithinWorkspace', () => {
  it('resolves a workspace-relative path under root', () => {
    const result = resolveWithinWorkspace('inputs/foo.txt', tmpRoot);
    expect(result).toBe(path.resolve(tmpRoot, 'inputs/foo.txt'));
  });

  it('throws on path that escapes via ../', () => {
    expect(() => resolveWithinWorkspace('../etc/passwd', tmpRoot)).toThrow(/escapes workspace/);
  });

  it('throws on absolute path outside workspace', () => {
    expect(() => resolveWithinWorkspace('/etc/passwd', tmpRoot)).toThrow(/escapes workspace/);
  });
});

// ── 3. renderDestFilename ────────────────────────────────────────────────────

describe('renderDestFilename', () => {
  it('substitutes {stem} and {ext}', () => {
    expect(renderDestFilename('{stem}_x{ext}', 'inputs/foo.pdf', 0)).toBe('foo_x.pdf');
  });

  it('substitutes {idx} as 1-based zero-padded width 4', () => {
    expect(renderDestFilename('{idx}_{stem}{ext}', 'a/b.txt', 0)).toBe('0001_b.txt');
    expect(renderDestFilename('{idx}_{stem}{ext}', 'a/b.txt', 41)).toBe('0042_b.txt');
  });

  it('handles files with no extension', () => {
    expect(renderDestFilename('{stem}{ext}.bak', 'a/Makefile', 0)).toBe('Makefile.bak');
  });

  it('replaces all occurrences of a token', () => {
    expect(renderDestFilename('{stem}-{stem}{ext}', 'a/b.txt', 0)).toBe('b-b.txt');
  });
});

// ── 4. listFilesByGlob ───────────────────────────────────────────────────────

describe('listFilesByGlob', () => {
  it('matches simple star pattern at one level', () => {
    writeFixture('inputs/a.txt', 'a');
    writeFixture('inputs/b.txt', 'b');
    writeFixture('inputs/c.md', 'c');
    const files = listFilesByGlob('inputs/*.txt', tmpRoot);
    expect(files.sort()).toEqual(['inputs/a.txt', 'inputs/b.txt']);
  });

  it('matches recursive ** across depths', () => {
    writeFixture('a/x.pdf', 'x');
    writeFixture('a/b/y.pdf', 'y');
    writeFixture('a/b/c/z.pdf', 'z');
    writeFixture('a/skip.txt', 'no');
    const files = listFilesByGlob('a/**/*.pdf', tmpRoot);
    expect(files.sort()).toEqual(['a/b/c/z.pdf', 'a/b/y.pdf', 'a/x.pdf']);
  });

  it('returns empty for missing root', () => {
    expect(listFilesByGlob('*.txt', path.join(tmpRoot, 'does-not-exist'))).toEqual([]);
  });

  it('skips node_modules and .git', () => {
    writeFixture('node_modules/foo.txt', 'x');
    writeFixture('.git/HEAD', 'x');
    writeFixture('real.txt', 'x');
    const files = listFilesByGlob('**/*.txt', tmpRoot);
    expect(files).toEqual(['real.txt']);
  });
});

// ── 5. validateRecord ────────────────────────────────────────────────────────

describe('validateRecord', () => {
  it('returns ok=false when destPath missing', () => {
    const record: FileTransformRecord = {
      srcPath: 'a.txt', destPath: null, bytes: null,
      attempts: 1, status: 'pending', errorReason: null,
    };
    const spec = makeSpec();
    expect(validateRecord(record, spec).ok).toBe(false);
  });

  it('returns ok=false when output too small', () => {
    const record: FileTransformRecord = {
      srcPath: 'a.txt', destPath: 'out/a.txt', bytes: 5,
      attempts: 1, status: 'pending', errorReason: null,
    };
    const spec = makeSpec({ validation: { minBytes: 100 } });
    expect(validateRecord(record, spec).ok).toBe(false);
  });

  it('checks requireExtension', () => {
    const record: FileTransformRecord = {
      srcPath: 'a.pdf', destPath: 'out/a.pdf', bytes: 1000,
      attempts: 1, status: 'pending', errorReason: null,
    };
    const spec = makeSpec({
      transform: { kind: 'extract_text_from_pdf' },
      validation: { minBytes: 1, requireExtension: '.txt' },
    });
    const result = validateRecord(record, spec);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('extension mismatch');
  });
});

// ── 6. buildReport ───────────────────────────────────────────────────────────

describe('buildReport', () => {
  it('partitions ledger by status', () => {
    const ledger: FileTransformRecord[] = [
      { srcPath: 'a', destPath: 'd/a', bytes: 1, attempts: 1, status: 'ok', errorReason: null },
      { srcPath: 'b', destPath: null, bytes: null, attempts: 1, status: 'skipped', errorReason: 'dest_exists' },
      { srcPath: 'c', destPath: null, bytes: null, attempts: 2, status: 'error', errorReason: 'boom' },
    ];
    const report = buildReport(ledger, 1234);
    expect(report.ok).toHaveLength(1);
    expect(report.skipped).toHaveLength(1);
    expect(report.errors).toHaveLength(1);
    expect(report.totalMs).toBe(1234);
  });
});

// ── 7. renderFinalMessage ────────────────────────────────────────────────────

describe('renderFinalMessage', () => {
  it('includes counts and transform kind', () => {
    const report = buildReport([
      { srcPath: 'a', destPath: 'd/a', bytes: 5, attempts: 1, status: 'ok', errorReason: null },
      { srcPath: 'b', destPath: null, bytes: null, attempts: 1, status: 'skipped', errorReason: 'dest_exists' },
    ], 5000);
    const msg = renderFinalMessage(report, makeSpec({ transform: { kind: 'rename' } }));
    expect(msg).toContain('FINAL_STATUS:');
    expect(msg).toContain('transform=rename');
    expect(msg).toContain('ok=1 skipped=1 errors=0');
    expect(msg).toContain('Duration:');
  });
});

// ── 8. Side-effect classification ────────────────────────────────────────────

describe('side-effect classification', () => {
  it('engine class is local_write', () => {
    expect(SIDE_EFFECT_CLASS).toBe('local_write');
  });
  it('all current transform kinds are local_write', () => {
    expect(sideEffectClassForTransform('copy')).toBe('local_write');
    expect(sideEffectClassForTransform('rename')).toBe('local_write');
    expect(sideEffectClassForTransform('extract_text_from_pdf')).toBe('local_write');
  });
});

// ── 9–14. Engine integration ────────────────────────────────────────────────

describe('runFileBatchTransform — copy', () => {
  let runSkill: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    runSkill = vi.fn();
  });

  it('copies matching files to destDir and validates bytes', async () => {
    writeFixture('inputs/a.txt', 'hello world');
    writeFixture('inputs/b.txt', 'foo bar');
    writeFixture('inputs/c.md', 'skipme');

    const spec = makeSpec({ filenameTemplate: '{stem}{ext}' });
    const report = await runFileBatchTransform(spec, runSkill as unknown as SkillRunner, { workspaceRoot: tmpRoot });

    expect(report.ok).toHaveLength(2);
    expect(report.errors).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpRoot, 'outputs/a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'outputs/b.txt'))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'outputs/c.md'))).toBe(false);
  });

  it('returns empty ledger when glob matches nothing', async () => {
    const spec = makeSpec({ source: { glob: 'inputs/*.txt' } });
    const report = await runFileBatchTransform(spec, runSkill as unknown as SkillRunner, { workspaceRoot: tmpRoot });
    expect(report.ledger).toHaveLength(0);
  });

  it('overwrite=if-missing skips existing outputs (idempotent re-run)', async () => {
    writeFixture('inputs/a.txt', 'hello');
    writeFixture('outputs/a_copy.txt', 'pre-existing');
    const spec = makeSpec();
    const report = await runFileBatchTransform(spec, runSkill as unknown as SkillRunner, { workspaceRoot: tmpRoot });
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].errorReason).toBe('dest_exists');
    expect(fs.readFileSync(path.join(tmpRoot, 'outputs/a_copy.txt'), 'utf8')).toBe('pre-existing');
  });

  it('overwrite=always replaces existing outputs', async () => {
    writeFixture('inputs/a.txt', 'fresh-content');
    writeFixture('outputs/a_copy.txt', 'old-content');
    const spec = makeSpec({ overwrite: 'always' });
    const report = await runFileBatchTransform(spec, runSkill as unknown as SkillRunner, { workspaceRoot: tmpRoot });
    expect(report.ok).toHaveLength(1);
    expect(fs.readFileSync(path.join(tmpRoot, 'outputs/a_copy.txt'), 'utf8')).toBe('fresh-content');
  });

  it('refuses to start when destDir escapes workspace', async () => {
    writeFixture('inputs/a.txt', 'x');
    const spec = makeSpec({ destDir: '../escapeland' });
    const report = await runFileBatchTransform(spec, runSkill as unknown as SkillRunner, { workspaceRoot: tmpRoot });
    expect(report.ok).toHaveLength(0);
    expect(report.ledger).toHaveLength(0);
  });
});

describe('runFileBatchTransform — rename', () => {
  it('moves file to dest path and removes source', async () => {
    writeFixture('inputs/a.txt', 'data');
    const spec = makeSpec({ transform: { kind: 'rename' }, filenameTemplate: '{stem}_renamed{ext}' });
    const report = await runFileBatchTransform(spec, vi.fn() as unknown as SkillRunner, { workspaceRoot: tmpRoot });
    expect(report.ok).toHaveLength(1);
    expect(fs.existsSync(path.join(tmpRoot, 'inputs/a.txt'))).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, 'outputs/a_renamed.txt'))).toBe(true);
  });
});

describe('runFileBatchTransform — extract_text_from_pdf', () => {
  it('writes extracted text via read_pdf skill and validates output', async () => {
    writeFixture('inputs/doc.pdf', '%PDF-1.4 fake');
    const runSkill = vi.fn().mockResolvedValue({
      success: true,
      output: '[Page 1]\nThis is the extracted text content of the PDF document.',
    });

    const spec = makeSpec({
      source: { glob: 'inputs/*.pdf' },
      transform: { kind: 'extract_text_from_pdf' },
      filenameTemplate: '{stem}.txt',
      validation: { minBytes: 10, requireExtension: '.txt' },
    });

    const report = await runFileBatchTransform(spec, runSkill as unknown as SkillRunner, { workspaceRoot: tmpRoot });
    expect(report.ok).toHaveLength(1);
    expect(runSkill).toHaveBeenCalledWith('read_pdf', { path: 'inputs/doc.pdf' });
    const out = fs.readFileSync(path.join(tmpRoot, 'outputs/doc.txt'), 'utf8');
    expect(out).toContain('extracted text');
  });

  it('marks record as error when read_pdf fails (after retry)', async () => {
    writeFixture('inputs/doc.pdf', '%PDF-1.4 fake');
    const runSkill = vi.fn().mockResolvedValue({ success: false, output: '', error: 'parse error' });

    const spec = makeSpec({
      source: { glob: 'inputs/*.pdf' },
      transform: { kind: 'extract_text_from_pdf' },
      filenameTemplate: '{stem}.txt',
    });
    const report = await runFileBatchTransform(spec, runSkill as unknown as SkillRunner, { workspaceRoot: tmpRoot });
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].errorReason).toContain('read_pdf failed');
  });

  it('rejects output that fails minBytes validator and surfaces as error', async () => {
    writeFixture('inputs/doc.pdf', '%PDF-1.4 fake');
    const runSkill = vi.fn().mockResolvedValue({ success: true, output: 'hi' });

    const spec = makeSpec({
      source: { glob: 'inputs/*.pdf' },
      transform: { kind: 'extract_text_from_pdf' },
      filenameTemplate: '{stem}.txt',
      validation: { minBytes: 10_000 },
    });
    const report = await runFileBatchTransform(spec, runSkill as unknown as SkillRunner, { workspaceRoot: tmpRoot });
    expect(report.ok).toHaveLength(0);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].errorReason).toContain('output too small');
  });
});

// ── 15. Transparency events ─────────────────────────────────────────────────

describe('runFileBatchTransform — transparency events', () => {
  it('emits engine_start, record_attempt, record_done, engine_done', async () => {
    writeFixture('inputs/a.txt', 'hello');
    const events: Array<{ type: string }> = [];
    const spec = makeSpec();
    await runFileBatchTransform(spec, vi.fn() as unknown as SkillRunner, {
      workspaceRoot: tmpRoot,
      emit: (e) => events.push(e as { type: string }),
    });
    const types = events.map(e => e.type);
    expect(types).toContain('file_batch_transform_engine_start');
    expect(types).toContain('file_batch_transform_record_attempt');
    expect(types).toContain('file_batch_transform_record_done');
    expect(types).toContain('file_batch_transform_engine_done');
  });
});

// ── 16. Spec extractor ───────────────────────────────────────────────────────

describe('extractFileBatchTransformSpec', () => {
  it('parses a valid spec from representative user message', async () => {
    const { extractFileBatchTransformSpec } = await import('../../core/skills/file-batch-transform-spec-extractor.js');
    const validJson = JSON.stringify({
      kind: 'file_batch_transform',
      source: { glob: 'inbox/*.pdf' },
      transform: { kind: 'extract_text_from_pdf' },
      destDir: 'outputs/text',
      filenameTemplate: '{stem}.txt',
      validation: { minBytes: 100, requireExtension: '.txt' },
      overwrite: 'if-missing',
    });
    const handler = vi.fn().mockResolvedValue(validJson);
    const spec = await extractFileBatchTransformSpec(
      'extract text from every PDF in workspace/inbox into outputs/text/',
      handler,
    );
    expect(spec).not.toBeNull();
    expect(spec!.transform.kind).toBe('extract_text_from_pdf');
  });

  it('returns null on unparseable response', async () => {
    const { extractFileBatchTransformSpec } = await import('../../core/skills/file-batch-transform-spec-extractor.js');
    const handler = vi.fn().mockResolvedValue('Sorry, I cannot help with that.');
    const spec = await extractFileBatchTransformSpec('do something', handler);
    expect(spec).toBeNull();
  });
});
