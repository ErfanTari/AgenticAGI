#!/usr/bin/env node
/**
 * wipe-memory.mjs — completely resets all agent memory.
 *
 * Deletes:
 *   - All markdown files under memory/ (WHO, WHAT, WHEN, HOW, WHY, NOW, PLAN)
 *   - memory/MEMORY.md
 *   - index/memory.sqlite (and WAL/SHM files)
 *   - Any .bak SQLite snapshots in index/
 *
 * Preserves:
 *   - workspace/  (your benchmark outputs stay)
 *   - All source code, config, prompts
 *
 * Usage:
 *   node scripts/wipe-memory.mjs
 *   node scripts/wipe-memory.mjs --yes   (skip confirmation prompt)
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MEMORY_DIR = path.join(ROOT, 'memory');
const INDEX_DIR  = path.join(ROOT, 'index');

// ─── helpers ──────────────────────────────────────────────────────────────────

function rmrf(target) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

function countFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) count++;
  }
  return count;
}

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => { rl.close(); resolve(answer.trim().toLowerCase()); });
  });
}

// ─── plan ─────────────────────────────────────────────────────────────────────

const memoryFiles = countFiles(MEMORY_DIR);
const dbFiles = fs.existsSync(INDEX_DIR)
  ? fs.readdirSync(INDEX_DIR).filter(f => f.endsWith('.sqlite') || f.endsWith('.sqlite-shm') || f.endsWith('.sqlite-wal') || f.endsWith('.bak'))
  : [];

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  zaraban — memory wipe');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  memory files : ${memoryFiles} files in memory/`);
console.log(`  sqlite files : ${dbFiles.join(', ') || 'none'}`);
console.log('  workspace/   : untouched');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const skipConfirm = process.argv.includes('--yes');

if (!skipConfirm) {
  const answer = await ask('Wipe all memory? This cannot be undone. Type "yes" to confirm: ');
  if (answer !== 'yes') {
    console.log('Aborted.');
    process.exit(0);
  }
}

// ─── wipe ─────────────────────────────────────────────────────────────────────

// 1. Delete all notebook subdirs + MEMORY.md
const notebooks = ['WHO', 'WHAT', 'WHEN', 'HOW', 'WHY', 'NOW', 'PLAN'];
for (const nb of notebooks) {
  const dir = path.join(MEMORY_DIR, nb);
  if (fs.existsSync(dir)) {
    rmrf(dir);
    console.log(`  ✓ deleted memory/${nb}/`);
  }
}

const memoryMd = path.join(MEMORY_DIR, 'MEMORY.md');
if (fs.existsSync(memoryMd)) {
  fs.unlinkSync(memoryMd);
  console.log('  ✓ deleted memory/MEMORY.md');
}

// 2. Delete SQLite files
for (const f of dbFiles) {
  const fpath = path.join(INDEX_DIR, f);
  if (fs.existsSync(fpath)) {
    fs.unlinkSync(fpath);
    console.log(`  ✓ deleted index/${f}`);
  }
}

// 3. Re-create empty notebook folders so the agent can write on first run
for (const nb of notebooks) {
  fs.mkdirSync(path.join(MEMORY_DIR, nb), { recursive: true });
}
console.log('  ✓ re-created empty notebook folders');

console.log('\n  Memory wiped. Run `pnpm ui` to start fresh.\n');
