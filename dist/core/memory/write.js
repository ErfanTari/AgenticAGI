import fs from 'node:fs';
import path from 'node:path';
import { PATHS, TYPE_MAP, resolveTypeKey, EMBEDDING_CONFIG } from '../../config/agent.config.js';
import { generateCode } from './codegen.js';
import { getDb, insertEntry, getEntryByCode } from './index.js';
import { indexContent } from './fts.js';
import { chunkMarkdown } from './chunks.js';
import { storeChunks, fetchEmbeddings } from './embeddings.js';
function sanitizeName(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function resolveEntryPath(nb, type, code, name) {
    const key = resolveTypeKey(nb, type);
    if (!key)
        throw new Error(`Invalid notebook+type: ${nb}.${type}`);
    const subfolder = TYPE_MAP[key].subfolder;
    const sanitized = sanitizeName(name);
    const filename = `${code}_${sanitized}.md`;
    return path.join(PATHS.memory, subfolder, filename);
}
function buildFrontmatter(entry) {
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
function buildMarkdown(entry, body) {
    const frontmatter = buildFrontmatter(entry);
    return frontmatter + '\n\n# ' + entry.name + '\n\n' + body + '\n';
}
export function createEntry(input) {
    const d = getDb();
    // Generate code + insert index row in a single transaction
    // This prevents race conditions: counter increment and insert are atomic
    const run = d.transaction(() => {
        const code = generateCode(input.nb, input.type);
        const updated = new Date().toISOString().slice(0, 10);
        const entryData = {
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
        const entry = { ...entryData, path: filePath };
        insertEntry(entry);
        // Index content for FTS5 BM25 search (sync, inside transaction)
        indexContent(code, input.nb, `${input.name} ${input.summary} ${input.body}`);
        // Store chunks for vector search (sync, inside transaction)
        const chunks = chunkMarkdown(code, markdown);
        if (chunks.length > 0) {
            storeChunks(chunks);
        }
        return entry;
    });
    const entry = run();
    // Schedule embedding computation — fire-and-forget, best-effort
    scheduleEmbedding(entry.code);
    return entry;
}
export function updateEntry(code, updates) {
    const entry = getEntryByCode(code);
    if (!entry)
        throw new Error(`Entry not found: ${code}`);
    const updated = new Date().toISOString().slice(0, 10);
    const newStatus = updates.status ?? entry.status;
    const newSummary = updates.summary ?? entry.summary;
    const d = getDb();
    d.prepare('UPDATE index_entries SET status = ?, summary = ?, updated = ? WHERE code = ?').run(newStatus, newSummary, updated, code);
    // Update markdown frontmatter on disk
    if (fs.existsSync(entry.path)) {
        const content = fs.readFileSync(entry.path, 'utf-8');
        const newContent = content
            .replace(/^status: .+$/m, `status: ${newStatus}`)
            .replace(/^summary: .+$/m, `summary: ${newSummary}`)
            .replace(/^updated: .+$/m, `updated: ${updated}`);
        fs.writeFileSync(entry.path, newContent, 'utf-8');
    }
    return { ...entry, status: newStatus, summary: newSummary, updated };
}
/**
 * Fire-and-forget embedding computation for stored chunks.
 * Only runs when EMBEDDING_CONFIG is set. Failures are silently ignored.
 */
function scheduleEmbedding(code) {
    if (!EMBEDDING_CONFIG)
        return;
    // Use queueMicrotask to avoid blocking the sync return
    queueMicrotask(async () => {
        try {
            const { getDb: getDatabase } = await import('./index.js');
            const d = getDatabase();
            const rows = d.prepare('SELECT id, text FROM chunks WHERE code = ? AND embedding IS NULL').all(code);
            if (rows.length === 0)
                return;
            const texts = rows.map(r => r.text);
            const embeddings = await fetchEmbeddings(texts, EMBEDDING_CONFIG);
            const stmt = d.prepare('UPDATE chunks SET embedding = ? WHERE id = ?');
            const updateAll = d.transaction(() => {
                for (let i = 0; i < rows.length; i++) {
                    const buf = Buffer.from(embeddings[i].buffer, embeddings[i].byteOffset, embeddings[i].byteLength);
                    stmt.run(buf, rows[i].id);
                }
            });
            updateAll();
        }
        catch {
            console.log('[embed] Embedding server unreachable — using BM25 only');
        }
    });
}
