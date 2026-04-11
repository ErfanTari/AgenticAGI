# Phase 23 Write Path — Orphan Risk Recon

This note documents write-path locations that can still leave markdown and SQLite temporarily out of sync. It is reconnaissance only for the parked cleanup session; no repairs are applied here.

## Confirmed orphan-risk paths

### 1. `createEntry()` file-first write cleanup can fail

- File: `core/memory/write.ts`
- Lines: `325-352`
- Flow:
  - markdown is written to disk first
  - SQLite transaction runs second
  - if SQLite fails, the cleanup path attempts `fs.unlinkSync(filePath)`
- Risk:
  - if the unlink also fails, a markdown file remains on disk without a durable `index_entries` row
  - this is the exact failure mode that produced orphan files earlier in Phase 23

### 2. `upsertEntry()` missing-file recreate branch can leave a recreated file behind

- File: `core/memory/write.ts`
- Lines: `433-476`
- Flow:
  - missing markdown file is recreated on disk
  - SQLite row is updated afterward
  - if the SQLite update fails, cleanup attempts `fs.unlinkSync(newFilePath)`
- Risk:
  - if that unlink fails, the recreated markdown exists on disk while the DB still points to the older state

### 3. `upsertEntry()` existing-row rewrite branch can fail to restore the previous file

- File: `core/memory/write.ts`
- Lines: `486-541`
- Flow:
  - updated markdown is written first
  - SQLite update happens second
  - on SQLite failure, the code tries to restore `previousContent`; if there was no previous file it tries `unlinkSync(targetPath)`
- Risk:
  - if rollback write or unlink fails, the disk file and SQLite row can diverge
  - this is not always a pure “no row exists” orphan, but it is still file/index drift that can surface later as orphaned or stale-path files

## Adjacent drift paths worth revisiting later

### 4. Fingerprint/fuzzy dedup append branches write the file without a transaction wrapper

- File: `core/memory/write.ts`
- Lines: `381-418`
- Flow:
  - existing WHO entry body is appended directly on disk
  - no matching SQLite content update exists because the row already exists
- Risk:
  - not a classic orphan-row problem
  - but if later helper calls fail, file content and the derived search/index state can drift until the next rebuild

## Current mitigation status

- Startup sync and prune scripts can now detect and quarantine orphaned markdown files.
- The underlying write-path cleanup remains best-effort.
- A future slice should decide whether to:
  - stage temp files in a dedicated holding area until SQLite commits
  - add an explicit orphan-repair pass on startup
  - record failed file cleanup in transparency for auditability
