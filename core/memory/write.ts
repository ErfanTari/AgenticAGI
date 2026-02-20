import fs from 'node:fs';
import path from 'node:path';
import { PATHS, TYPE_MAP, resolveTypeKey } from '../../config/agent.config.js';
import type { IndexEntry, CreateEntryInput } from './types.js';
import { generateCode } from './codegen.js';
import { getDb, insertEntry } from './index.js';

function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function resolveEntryPath(nb: string, type: string, code: string, name: string): string {
  const key = resolveTypeKey(nb, type);
  if (!key) throw new Error(`Invalid notebook+type: ${nb}.${type}`);
  const subfolder = TYPE_MAP[key].subfolder;
  const sanitized = sanitizeName(name);
  const filename = `${code}_${sanitized}.md`;
  return path.join(PATHS.memory, subfolder, filename);
}

function buildFrontmatter(entry: Omit<IndexEntry, 'path'>): string {
  return [
    '---',
    `code: ${entry.code}`,
    `nb: ${entry.nb}`,
    `type: ${entry.type}`,
    `name: ${entry.name}`,
    `status: ${entry.status}`,
    `updated: ${entry.updated}`,
    `summary: ${entry.summary}`,
    '---',
  ].join('\n');
}

function buildMarkdown(entry: Omit<IndexEntry, 'path'>, body: string): string {
  const frontmatter = buildFrontmatter(entry);
  return frontmatter + '\n\n# ' + entry.name + '\n\n' + body + '\n';
}

export function createEntry(input: CreateEntryInput): IndexEntry {
  const d = getDb();

  // Generate code + insert index row in a single transaction
  // This prevents race conditions: counter increment and insert are atomic
  const run = d.transaction(() => {
    const code = generateCode(input.nb, input.type);
    const updated = new Date().toISOString().slice(0, 10);

    const entryData: Omit<IndexEntry, 'path'> = {
      code,
      nb: input.nb,
      type: input.type,
      name: input.name,
      status: input.status,
      updated,
      summary: input.summary,
    };

    const filePath = resolveEntryPath(input.nb, input.type, code, input.name);
    const markdown = buildMarkdown(entryData, input.body);

    // File-before-SQLite: write file first, then index
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, markdown, 'utf-8');

    const entry: IndexEntry = { ...entryData, path: filePath };
    insertEntry(entry);

    return entry;
  });

  return run();
}
