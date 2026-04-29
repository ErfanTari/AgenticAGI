/**
 * Phase 25.1 — Deterministic file-batch transform engine.
 *
 * The second concrete engine in the One-Call Engine series. Whitepaper:
 *   docs/one-call-engine.md  (§5 Step Types as a DSL)
 *   docs/phase-25-plan.md
 *
 * Step types: copy | rename | extract_text_from_pdf
 *   - composable: each emits { srcPath, destPath, bytes }
 *   - idempotent: overwrite policy makes re-runs safe
 *   - self-validating: each transform owns its own validator predicate
 *
 * State lives in FileTransformRecord[], never in an LLM context.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SkillResult } from './types.js';
import type { FileBatchTransformSpec, FileBatchTransformKind } from '../schemas.js';
import { PATHS } from '../../config/agent.config.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_RETRIES_PER_FILE = 1;
export const MAX_TOTAL_MS = 600_000;
export const MAX_FILES_PER_BATCH = 1000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FileTransformRecord {
  srcPath: string;
  destPath: string | null;
  bytes: number | null;
  attempts: number;
  status: 'pending' | 'ok' | 'skipped' | 'error';
  errorReason: string | null;
}

export interface FileBatchTransformReport {
  ok: FileTransformRecord[];
  skipped: FileTransformRecord[];
  errors: FileTransformRecord[];
  ledger: FileTransformRecord[];
  totalMs: number;
}

export type SkillRunner = (name: string, input: Record<string, unknown>) => Promise<SkillResult>;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve a workspace-relative or absolute path to an absolute path strictly
 * underneath the workspace root. Throws if the resolved path escapes the workspace.
 */
export function resolveWithinWorkspace(p: string, workspaceRoot?: string): string {
  const root = workspaceRoot ?? PATHS.workspace;
  const rootResolved = path.resolve(root);
  const candidate = path.isAbsolute(p) ? path.resolve(p) : path.resolve(rootResolved, p);
  const rel = path.relative(rootResolved, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  return candidate;
}

/**
 * Apply the filename template. Tokens:
 *   {stem} → input basename minus extension
 *   {ext}  → input extension (with leading dot, e.g. ".pdf"); empty if none
 *   {idx}  → 1-based zero-padded index (width 4)
 */
export function renderDestFilename(
  template: string,
  srcPath: string,
  index: number,
): string {
  const base = path.basename(srcPath);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  const idxStr = String(index + 1).padStart(4, '0');
  return template
    .replace(/\{stem\}/g, stem)
    .replace(/\{ext\}/g, ext)
    .replace(/\{idx\}/g, idxStr);
}

// Convert a glob pattern to an anchored regex string.
//   double-star slash -> "(?:.* slash)?" (optional, zero or more dir segments)
//   double-star       -> ".*"            (any chars incl. slashes)
//   single-star       -> "[^/]*"         (single segment, no slash crossing)
//   regex specials in the rest of the pattern are escaped.
export function globToRegexSource(pat: string): string {
  let out = '';
  let i = 0;
  while (i < pat.length) {
    const c = pat[i];
    if (c === '*' && pat[i + 1] === '*' && pat[i + 2] === '/') {
      out += '(?:.*/)?';
      i += 3;
    } else if (c === '*' && pat[i + 1] === '*') {
      out += '.*';
      i += 2;
    } else if (c === '*') {
      out += '[^/]*';
      i++;
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      out += '\\' + c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return `^${out}$`;
}

/**
 * Walk a directory and return relative paths matching a simple glob (`*` and `**`).
 * The glob is interpreted relative to workspace root. We deliberately re-implement
 * a minimal matcher rather than depend on the `glob` skill so this engine is
 * self-contained and unit-testable without spawning rg.
 */
export function listFilesByGlob(globPattern: string, workspaceRoot?: string): string[] {
  const root = workspaceRoot ?? PATHS.workspace;
  const rootResolved = path.resolve(root);
  if (!fs.existsSync(rootResolved)) return [];

  let re: RegExp;
  try {
    re = new RegExp(globToRegexSource(globPattern));
  } catch {
    return [];
  }

  const SKIP = new Set(['node_modules', '.git', 'dist']);
  const out: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootResolved, full);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        if (re.test(rel)) out.push(rel);
      }
    }
  }

  walk(rootResolved);
  out.sort();
  return out;
}

// ── Transform implementations ────────────────────────────────────────────────

/** Copy file from srcAbs to destAbs. Idempotent under overwrite='always'. */
async function transformCopy(
  srcAbs: string,
  destAbs: string,
): Promise<{ bytes: number }> {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(srcAbs, destAbs);
  const stat = fs.statSync(destAbs);
  return { bytes: stat.size };
}

/** Rename (move) file from srcAbs to destAbs. Cross-device fallback to copy+unlink. */
async function transformRename(
  srcAbs: string,
  destAbs: string,
): Promise<{ bytes: number }> {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  try {
    fs.renameSync(srcAbs, destAbs);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      fs.copyFileSync(srcAbs, destAbs);
      fs.unlinkSync(srcAbs);
    } else {
      throw err;
    }
  }
  const stat = fs.statSync(destAbs);
  return { bytes: stat.size };
}

/**
 * Extract text from PDF using the read_pdf skill, write result to destAbs.
 * Defers PDF parsing to the existing read_pdf tool — engine just orchestrates.
 */
async function transformExtractTextFromPdf(
  srcRel: string,
  destAbs: string,
  runSkill: SkillRunner,
): Promise<{ bytes: number }> {
  const result = await runSkill('read_pdf', { path: srcRel });
  if (!result.success) {
    throw new Error(`read_pdf failed: ${result.error ?? 'unknown'}`);
  }
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.writeFileSync(destAbs, result.output, 'utf8');
  const stat = fs.statSync(destAbs);
  return { bytes: stat.size };
}

// ── Validators ────────────────────────────────────────────────────────────────

export function validateRecord(
  record: FileTransformRecord,
  spec: FileBatchTransformSpec,
  workspaceRoot?: string,
): { ok: boolean; reason: string } {
  if (!record.destPath) return { ok: false, reason: 'no destination written' };
  if (record.bytes == null) return { ok: false, reason: 'bytes unknown' };

  const minBytes = spec.validation.minBytes;
  if (record.bytes < minBytes) {
    return { ok: false, reason: `output too small: ${record.bytes} < ${minBytes}` };
  }

  if (spec.validation.requireExtension) {
    const want = spec.validation.requireExtension.toLowerCase();
    if (!record.destPath.toLowerCase().endsWith(want)) {
      return { ok: false, reason: `extension mismatch: expected ${want}` };
    }
  }

  // Per-kind extra checks
  if (spec.transform.kind === 'copy') {
    try {
      const srcAbs = resolveWithinWorkspace(record.srcPath, workspaceRoot);
      const srcStat = fs.statSync(srcAbs);
      if (srcStat.size !== record.bytes) {
        return { ok: false, reason: `byte mismatch src=${srcStat.size} dest=${record.bytes}` };
      }
    } catch {
      return { ok: false, reason: 'src file not readable for verification' };
    }
  }

  if (spec.transform.kind === 'rename') {
    try {
      const srcAbs = resolveWithinWorkspace(record.srcPath, workspaceRoot);
      if (fs.existsSync(srcAbs)) {
        return { ok: false, reason: 'source still exists after rename' };
      }
    } catch { /* unable to resolve src — non-fatal */ }
  }

  return { ok: true, reason: '' };
}

// ── Report rendering ──────────────────────────────────────────────────────────

export function buildReport(
  ledger: FileTransformRecord[],
  totalMs: number,
): FileBatchTransformReport {
  return {
    ok: ledger.filter(r => r.status === 'ok'),
    skipped: ledger.filter(r => r.status === 'skipped'),
    errors: ledger.filter(r => r.status === 'error'),
    ledger,
    totalMs,
  };
}

export function renderFinalMessage(
  report: FileBatchTransformReport,
  spec: FileBatchTransformSpec,
): string {
  const lines: string[] = ['FINAL_STATUS:'];
  lines.push(`transform=${spec.transform.kind}`);
  lines.push(`ok=${report.ok.length} skipped=${report.skipped.length} errors=${report.errors.length}`);

  if (report.ok.length > 0) {
    lines.push(`output_dir=${spec.destDir}`);
  }

  if (report.skipped.length > 0) {
    lines.push('skipped=[');
    for (const r of report.skipped.slice(0, 20)) {
      lines.push(`  ${r.srcPath} → ${r.errorReason ?? 'unknown'}`);
    }
    if (report.skipped.length > 20) lines.push(`  … and ${report.skipped.length - 20} more`);
    lines.push(']');
  }

  if (report.errors.length > 0) {
    lines.push('errors=[');
    for (const r of report.errors.slice(0, 20)) {
      lines.push(`  ${r.srcPath} → ${r.errorReason ?? 'unknown'}`);
    }
    if (report.errors.length > 20) lines.push(`  … and ${report.errors.length - 20} more`);
    lines.push(']');
  }

  lines.push(`Duration: ${Math.round(report.totalMs / 1000)}s`);
  return lines.join('\n');
}

// ── Main engine ───────────────────────────────────────────────────────────────

export interface RunOptions {
  workspaceRoot?: string;
  emit?: (event: unknown) => void;
}

export async function runFileBatchTransform(
  spec: FileBatchTransformSpec,
  runSkill: SkillRunner,
  options: RunOptions = {},
): Promise<FileBatchTransformReport> {
  const emit = options.emit ?? (() => {});
  const startMs = Date.now();
  const workspaceRoot = options.workspaceRoot ?? PATHS.workspace;

  emit({ type: 'file_batch_transform_engine_start', data: { spec } });

  // ── Validate destDir is workspace-relative and resolvable ────────────────────
  let destDirAbs: string;
  try {
    destDirAbs = resolveWithinWorkspace(spec.destDir, workspaceRoot);
  } catch (err) {
    emit({
      type: 'file_batch_transform_engine_done',
      data: { ok: 0, skipped: 0, errors: 0, totalMs: 0, abortReason: 'destDir escapes workspace' },
    });
    return buildReport([], Date.now() - startMs);
  }
  fs.mkdirSync(destDirAbs, { recursive: true });

  // ── Discover source files ────────────────────────────────────────────────────
  const sourceFiles = listFilesByGlob(spec.source.glob, workspaceRoot)
    .slice(0, MAX_FILES_PER_BATCH);

  if (sourceFiles.length === 0) {
    emit({
      type: 'file_batch_transform_engine_done',
      data: { ok: 0, skipped: 0, errors: 0, totalMs: Date.now() - startMs, abortReason: 'no inputs matched glob' },
    });
    return buildReport([], Date.now() - startMs);
  }

  // ── Build initial ledger ─────────────────────────────────────────────────────
  const ledger: FileTransformRecord[] = sourceFiles.map(rel => ({
    srcPath: rel,
    destPath: null,
    bytes: null,
    attempts: 0,
    status: 'pending',
    errorReason: null,
  }));

  // ── Transform each file ──────────────────────────────────────────────────────
  for (let i = 0; i < ledger.length; i++) {
    const record = ledger[i];

    if (Date.now() - startMs > MAX_TOTAL_MS) {
      record.status = 'skipped';
      record.errorReason = 'timeout';
      continue;
    }

    const destFilename = renderDestFilename(spec.filenameTemplate, record.srcPath, i);
    let destAbs: string;
    try {
      destAbs = resolveWithinWorkspace(path.join(spec.destDir, destFilename), workspaceRoot);
    } catch {
      record.status = 'error';
      record.errorReason = 'dest path escapes workspace';
      emit({ type: 'file_batch_transform_record_done', data: { ...record } });
      continue;
    }

    const destRel = path.relative(path.resolve(workspaceRoot), destAbs);

    // Idempotency check
    if (spec.overwrite === 'if-missing' && fs.existsSync(destAbs)) {
      record.status = 'skipped';
      record.errorReason = 'dest_exists';
      record.destPath = destRel;
      try { record.bytes = fs.statSync(destAbs).size; } catch { /* leave null */ }
      emit({ type: 'file_batch_transform_record_done', data: { ...record } });
      continue;
    }

    // Source readability
    let srcAbs: string;
    try {
      srcAbs = resolveWithinWorkspace(record.srcPath, workspaceRoot);
      fs.statSync(srcAbs);
    } catch {
      record.status = 'error';
      record.errorReason = 'src not readable';
      emit({ type: 'file_batch_transform_record_done', data: { ...record } });
      continue;
    }

    emit({
      type: 'file_batch_transform_record_attempt',
      data: { srcPath: record.srcPath, destPath: destRel, kind: spec.transform.kind },
    });

    let transformErr: string | null = null;
    while (record.attempts <= MAX_RETRIES_PER_FILE) {
      record.attempts++;
      try {
        let bytes: number;
        switch (spec.transform.kind) {
          case 'copy':
            ({ bytes } = await transformCopy(srcAbs, destAbs));
            break;
          case 'rename':
            ({ bytes } = await transformRename(srcAbs, destAbs));
            break;
          case 'extract_text_from_pdf':
            ({ bytes } = await transformExtractTextFromPdf(record.srcPath, destAbs, runSkill));
            break;
          default: {
            const exhaustive: never = spec.transform.kind;
            throw new Error(`unknown transform kind: ${String(exhaustive)}`);
          }
        }

        record.destPath = destRel;
        record.bytes = bytes;

        const valid = validateRecord(record, spec, workspaceRoot);
        if (!valid.ok) {
          // Delete partial output before retry
          try { fs.unlinkSync(destAbs); } catch { /* ignore */ }
          record.destPath = null;
          record.bytes = null;
          transformErr = valid.reason;
          continue;
        }

        record.status = 'ok';
        record.errorReason = null;
        transformErr = null;
        break;
      } catch (err) {
        transformErr = err instanceof Error ? err.message : String(err);
      }
    }

    if (record.status !== 'ok') {
      record.status = 'error';
      record.errorReason = transformErr ?? 'unknown failure';
    }

    emit({ type: 'file_batch_transform_record_done', data: { ...record } });
  }

  const report = buildReport(ledger, Date.now() - startMs);
  emit({
    type: 'file_batch_transform_engine_done',
    data: {
      ok: report.ok.length,
      skipped: report.skipped.length,
      errors: report.errors.length,
      totalMs: report.totalMs,
    },
  });
  return report;
}

// ── Side-effect classification (per whitepaper §8) ────────────────────────────

/**
 * Static side-effect class for this engine. Used by the runtime to decide
 * approval gating. `local_write` = sandboxed workspace writes only.
 *
 * Future-proofing for §8 of the whitepaper: when destDir resolves outside
 * the configured workspace, the engine refuses to start (see
 * resolveWithinWorkspace). No dynamic check needed at runtime.
 */
export const SIDE_EFFECT_CLASS = 'local_write' as const;

/** Per-transform-kind side-effect class. All current kinds are local_write. */
export function sideEffectClassForTransform(kind: FileBatchTransformKind): 'none' | 'local_write' {
  switch (kind) {
    case 'copy':
    case 'rename':
    case 'extract_text_from_pdf':
      return 'local_write';
  }
}
