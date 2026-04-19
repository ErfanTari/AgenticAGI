import fs from 'node:fs';
import path from 'node:path';
import { localDateString, localDatePlusDays } from './utils/date.js';
import { getDb, getSettingValue, setSettingValue } from './memory/index.js';
import { simpleGit } from 'simple-git';
import { PATHS } from '../config/agent.config.js';
import { createEntry, updateEntry } from './memory/write.js';
import { isProcessingMessage } from './agent.js';
import { upsertPointerEntry } from './memory/pointer-index.js';
import { isMemoryFullyDisabled } from './memory-mode.js';
import { transparency } from './transparency.js';
// --- Phase 16: Activity tracking for AutoDream ---
const AUTO_DREAM_IDLE_MS = 10 * 60 * 1000; // 10 minutes
let _lastActivityAt = Date.now();
/** Call this whenever the agent processes a message. */
export function recordActivity() {
    _lastActivityAt = Date.now();
}
// --- FIX 1: Timer ---
let timer = null;
export function startHeartbeat() {
    if (timer)
        return; // prevent duplicate timers
    timer = setInterval(runHeartbeatSafe, 1800000);
}
export function stopHeartbeat() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
async function runHeartbeatSafe() {
    if (isProcessingMessage)
        return; // idle check
    try {
        await runHeartbeat();
    }
    catch (e) {
        console.error('[heartbeat] cycle failed:', e);
    }
}
// --- Helpers ---
function today() {
    return localDateString();
}
function daysAgo(n) {
    return localDatePlusDays(-n);
}
function queryStale(nb, type, status, cutoff) {
    const d = getDb();
    return d.prepare('SELECT * FROM index_entries WHERE nb = ? AND type = ? AND status = ? AND updated < ?').all(nb, type, status, cutoff);
}
// --- Individual checks ---
export function checkDeadlines() {
    // FIX 4: Only flag deadlines within the 24h window [today, tomorrow]
    const todayStr = localDateString();
    const tomorrowStr = localDatePlusDays(1);
    const d = getDb();
    const entries = d.prepare('SELECT * FROM index_entries WHERE nb = ? AND status = ? AND due_date >= ? AND due_date <= ?').all('WHEN', 'upcoming', todayStr, tomorrowStr);
    if (entries.length === 0)
        return null;
    return {
        type: 'upcoming_event',
        entries,
        message: `${entries.length} upcoming event(s) need attention`,
    };
}
export function checkOverdueTodos() {
    const todayStr = localDateString();
    const d = getDb();
    // Check NOW.TD todos
    const todoEntries = d.prepare('SELECT * FROM index_entries WHERE nb = ? AND type = ? AND status = ? AND due_date < ?').all('NOW', 'TD', 'open', todayStr);
    // Also check PLAN.PL overdue plans
    const planEntries = d.prepare('SELECT * FROM index_entries WHERE nb = ? AND type = ? AND status = ? AND due_date < ?').all('PLAN', 'PL', 'active', todayStr);
    const entries = [...todoEntries, ...planEntries];
    if (entries.length === 0)
        return null;
    for (const entry of entries) {
        updateEntry(entry.code, { status: 'overdue' });
    }
    return {
        type: 'overdue_todo',
        entries,
        message: `${entries.length} todo(s)/plan(s) overdue — status updated`,
    };
}
export function checkStaleQuestions() {
    const cutoff = daysAgo(3);
    const entries = queryStale('WHY', 'QU', 'open', cutoff);
    if (entries.length === 0)
        return null;
    return {
        type: 'stale_question',
        entries,
        message: `${entries.length} open question(s) unanswered for 3+ days`,
    };
}
export function checkPlanCalibration() {
    const cutoff = daysAgo(7);
    const entries = queryStale('PLAN', 'PL', 'active', cutoff);
    if (entries.length === 0)
        return null;
    return {
        type: 'stale_plan',
        entries,
        message: `${entries.length} planning entry/entries stale for 7+ days`,
    };
}
export function checkStaleProjects() {
    const cutoff = daysAgo(7);
    const entries = queryStale('WHAT', 'PJ', 'active', cutoff);
    if (entries.length === 0)
        return null;
    return {
        type: 'stale_project',
        entries,
        message: `${entries.length} active project(s) with no update in 7+ days`,
    };
}
// --- CHECK 7: Stale Project Brain (PLAN.PJ) ---
export function checkStalePlanPJ() {
    const d = getDb();
    const cutoff = daysAgo(3);
    const entries = d.prepare("SELECT * FROM index_entries WHERE nb = 'PLAN' AND type = 'PJ' AND status = 'active'").all();
    if (entries.length === 0)
        return null;
    // Check last_worked from markdown frontmatter
    const stale = [];
    for (const entry of entries) {
        // Check updated field as proxy for last_worked
        if (entry.updated < cutoff) {
            stale.push(entry);
        }
    }
    // Also check vision_drift between project entries and North Star
    const visionEntries = d.prepare("SELECT * FROM index_entries WHERE nb = 'WHY' AND type = 'MT' AND name LIKE '%North Star%' AND status = 'active'").all();
    if (visionEntries.length > 0) {
        const vision = visionEntries[0];
        const visionKeywords = new Set((vision.summary ?? vision.name).toLowerCase().split(/\s+/).filter(w => w.length > 3));
        for (const entry of entries) {
            if (stale.some(s => s.code === entry.code))
                continue; // already stale
            const entryText = `${entry.name} ${entry.summary ?? ''}`.toLowerCase();
            const hasOverlap = [...visionKeywords].some(kw => entryText.includes(kw));
            if (!hasOverlap) {
                // Vision drift in project brain — could emit separately but included here
            }
        }
    }
    if (stale.length === 0)
        return null;
    return {
        type: 'stale_project_brain',
        entries: stale,
        message: `${stale.length} project brain(s) not updated in 3+ days`,
    };
}
// --- CHECK: AMemLinker — link entries with no relationships (max 5 per heartbeat) ---
export function checkAMemLinker() {
    const d = getDb();
    const MAX_PER_RUN = 5;
    // Find entries with no relationships, ordered by updated ASC (oldest first)
    const entries = d.prepare(`
    SELECT ie.code FROM index_entries ie
    WHERE ie.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM relationships r WHERE r.from_code = ie.code OR r.to_code = ie.code
      )
    ORDER BY ie.updated ASC
    LIMIT ?
  `).all(MAX_PER_RUN);
    const codes = entries.map(e => e.code);
    return { processed: codes.length, codes };
}
// --- CHECK 6: Vision alignment ---
export function checkVisionAlignment() {
    const d = getDb();
    // Find the active North Star vision entry
    const visionEntries = d.prepare("SELECT * FROM index_entries WHERE nb = 'WHY' AND type = 'MT' AND name LIKE '%North Star%' AND status = 'active'").all();
    if (visionEntries.length === 0)
        return null; // No vision — nothing to check
    const vision = visionEntries[0];
    const visionKeywords = (vision.summary ?? vision.name).toLowerCase().split(/\s+/);
    // Get active plans AND projects
    const entries = d.prepare("SELECT * FROM index_entries WHERE ((nb = 'PLAN' AND type = 'PL') OR (nb = 'WHAT' AND type = 'PJ')) AND status = 'active'").all();
    if (entries.length === 0)
        return null; // No plans/projects — nothing to compare
    // Exclude entries that explicitly refer to (or are referred to by) the vision entry — bidirectional
    const connectedCodes = new Set([
        ...d.prepare("SELECT from_code AS code FROM relationships WHERE to_code = ? AND relation = 'refers'").all(vision.code).map(r => r.code),
        ...d.prepare("SELECT to_code AS code FROM relationships WHERE from_code = ? AND relation = 'refers'").all(vision.code).map(r => r.code),
    ]);
    // Check each entry for keyword overlap with vision
    const driftingEntries = [];
    for (const entry of entries) {
        if (connectedCodes.has(entry.code))
            continue; // explicitly connected — skip
        const entryText = `${entry.name} ${entry.summary ?? ''}`.toLowerCase();
        const hasOverlap = visionKeywords.some(kw => kw.length > 3 && entryText.includes(kw));
        if (!hasOverlap) {
            driftingEntries.push(entry);
        }
    }
    if (driftingEntries.length === 0)
        return null;
    return {
        type: 'vision_drift',
        entries: driftingEntries,
        message: `${driftingEntries.length} active plan(s)/project(s) may not align with North Star vision: ${driftingEntries.map(e => e.name).join(', ')}`,
    };
}
// --- Phase 15: NOW Notebook TTL ---
/**
 * Default TTL values for NOW notebook entries.
 * Entries past TTL are archived (after compression for LOG entries).
 */
const NOW_TTL = {
    'NOW.TD': 30, // completed todos — 30 days
    'NOW.LOG': 14, // log entries — 14 days (compress first)
    'NOW.RP': 60, // reports — 60 days
};
export async function checkNowTTL() {
    const d = getDb();
    const archived = [];
    const todayStr = localDateString();
    for (const [typeKey, ttlDays] of Object.entries(NOW_TTL)) {
        const [nb, type] = typeKey.split('.');
        try {
            // Build a cutoff date using localDatePlusDays(-ttlDays)
            const cutoff = localDatePlusDays(-ttlDays);
            let entries = [];
            if (type === 'TD') {
                // Only archive completed todos
                entries = d.prepare(`
          SELECT * FROM index_entries
          WHERE nb = ? AND type = ? AND status = 'closed'
          AND updated < ?
        `).all(nb, type, cutoff);
            }
            else if (type === 'LOG') {
                // Archive log entries past TTL (compress into weekly summary first — best-effort)
                entries = d.prepare(`
          SELECT * FROM index_entries
          WHERE nb = ? AND type = ? AND status = 'active'
          AND updated < ?
        `).all(nb, type, cutoff);
                // Compress logs into a weekly summary if there are enough
                if (entries.length >= 7) {
                    const compressSummary = `Weekly log summary: ${entries.length} log entries from ${entries[0]?.updated ?? cutoff} to ${entries[entries.length - 1]?.updated ?? todayStr}`;
                    try {
                        createEntry({
                            nb: 'NOW',
                            type: 'RP',
                            name: `Log Summary — Week of ${cutoff}`,
                            status: 'active',
                            summary: compressSummary.slice(0, 100),
                            body: entries.map(e => `- ${e.updated}: ${e.name} — ${e.summary ?? ''}`).join('\n'),
                        });
                    }
                    catch { /* non-fatal */ }
                }
            }
            else if (type === 'RP') {
                // Archive old reports
                entries = d.prepare(`
          SELECT * FROM index_entries
          WHERE nb = ? AND type = ? AND status = 'active'
          AND updated < ?
        `).all(nb, type, cutoff);
            }
            // Check ttl_days column override if present
            const overriddenEntries = d.prepare(`
        SELECT * FROM index_entries
        WHERE nb = ? AND type = ? AND status != 'archived' AND ttl_days IS NOT NULL
        AND DATE(updated, '+' || ttl_days || ' days') < ?
      `).all(nb, type, todayStr);
            const deduped = new Map();
            for (const e of entries)
                deduped.set(e.code, e);
            for (const e of overriddenEntries)
                deduped.set(e.code, e);
            const allToArchive = [...deduped.values()];
            for (const entry of allToArchive) {
                try {
                    d.prepare('UPDATE index_entries SET status = ? WHERE code = ?')
                        .run('archived', entry.code);
                    archived.push(entry);
                }
                catch { /* best-effort */ }
            }
        }
        catch (err) {
            console.warn(`[heartbeat] TTL check for ${typeKey} failed:`, err);
        }
    }
    if (archived.length === 0)
        return null;
    return {
        type: 'stale_project', // reuse existing type
        entries: archived,
        message: `${archived.length} NOW entries archived by TTL`,
    };
}
// --- Main heartbeat ---
/**
 * H5 — Monthly git gc --auto to keep memory repo lean.
 */
async function checkGitMaintenance() {
    const d = getDb();
    try {
        const lastMaintenance = getSettingValue(d, 'last_git_maintenance');
        const daysSince = lastMaintenance
            ? (Date.now() - new Date(lastMaintenance).getTime()) / 86400000
            : 999;
        if (daysSince < 30)
            return;
        const memoryPath = PATHS.memory;
        if (!fs.existsSync(path.join(memoryPath, '.git')))
            return;
        const git = simpleGit(memoryPath);
        await git.raw(['gc', '--auto', '--quiet']);
        setSettingValue(d, 'last_git_maintenance', new Date().toISOString());
        console.log('[heartbeat] git gc --auto completed');
    }
    catch (err) {
        console.warn('[heartbeat] git maintenance failed (non-fatal):', err);
    }
}
/**
 * FIX 4 — Idempotent heartbeat alert creation.
 * If an active WHY.MT alert with the same type already exists, updates it in place
 * instead of creating a duplicate. Prevents alert accumulation on extended absence.
 */
function upsertHeartbeatAlert(type, summary, body, ran_at) {
    const d = getDb();
    const existing = d.prepare(`
    SELECT code FROM index_entries
    WHERE nb = 'WHY' AND type = 'MT'
    AND status = 'active'
    AND name LIKE ?
    LIMIT 1
  `).get(`%${type}%`);
    if (existing) {
        // Update timestamp and summary — no new entry created
        d.prepare('UPDATE index_entries SET updated = ?, summary = ? WHERE code = ?')
            .run(ran_at, summary, existing.code);
        const row = d.prepare('SELECT * FROM index_entries WHERE code = ?').get(existing.code);
        return row;
    }
    return createEntry({
        nb: 'WHY',
        type: 'MT',
        name: `Heartbeat — ${type}`,
        status: 'active',
        summary,
        body,
    });
}
/**
 * Phase 16 — AutoDream
 * When the agent has been idle for >10 minutes, reads today's WHEN.EV entries
 * and refreshes the pointer index with any coded references found in their content.
 * This keeps MEMORY.md up-to-date with recently referenced codes without a full scan.
 */
export async function checkAutoDream() {
    const idleMs = Date.now() - _lastActivityAt;
    if (idleMs < AUTO_DREAM_IDLE_MS)
        return null;
    try {
        const d = getDb();
        const todayStr = localDateString();
        // Read today's episodic events (WHEN.EV)
        const events = d.prepare(`SELECT code, name, summary, path FROM index_entries
       WHERE nb = 'WHEN' AND type = 'EV' AND updated >= ? AND status != 'archived'
       ORDER BY updated DESC LIMIT 20`).all(todayStr);
        if (events.length === 0)
            return null;
        let consolidated = 0;
        for (const ev of events) {
            // Extract codes referenced in the event body
            let body = '';
            try {
                if (ev.path && fs.existsSync(ev.path)) {
                    body = fs.readFileSync(ev.path, 'utf-8');
                }
            }
            catch { /* best-effort */ }
            const codePattern = /\b([A-Z]+\.[A-Z]+-\d{6,})\b/g;
            const content = `${ev.summary} ${body}`;
            let match;
            while ((match = codePattern.exec(content)) !== null) {
                const refCode = match[1];
                try {
                    const refRow = d.prepare('SELECT code, name, summary FROM index_entries WHERE code = ? AND status != \'archived\' LIMIT 1').get(refCode);
                    if (refRow) {
                        upsertPointerEntry({ code: refRow.code, name: refRow.name, summary: refRow.summary ?? '', lastActive: todayStr });
                        consolidated++;
                    }
                }
                catch { /* best-effort */ }
            }
        }
        if (consolidated > 0) {
            console.log(`[heartbeat] AutoDream: refreshed ${consolidated} pointer entries from today's events`);
        }
    }
    catch (err) {
        console.warn('[heartbeat] AutoDream failed:', err);
    }
    return null; // AutoDream never produces a user-facing notification
}
export async function runHeartbeat() {
    if (isMemoryFullyDisabled()) {
        transparency.emit({ type: 'heartbeat_skipped_memory_disabled', data: {} });
        return { ran_at: today(), notifications: [], created: [] };
    }
    // Guard: skip all checks if DB is not initialized
    try {
        const db = getDb();
        if (!db) {
            console.warn('[heartbeat] DB not initialized — skipping heartbeat cycle');
            return { ran_at: today(), notifications: [], created: [] };
        }
    }
    catch {
        console.warn('[heartbeat] DB not initialized — skipping heartbeat cycle');
        return { ran_at: today(), notifications: [], created: [] };
    }
    const ran_at = today();
    const notifications = [];
    // FIX 2: Per-check error isolation — one check failing must NEVER stop other checks
    const checks = [
        checkDeadlines,
        checkOverdueTodos,
        checkStaleQuestions,
        checkPlanCalibration,
        checkStaleProjects,
        checkVisionAlignment,
        checkStalePlanPJ,
        checkNowTTL,
        checkAutoDream, // Phase 16
    ];
    for (const check of checks) {
        try {
            const result = await check();
            if (result)
                notifications.push(result);
        }
        catch (e) {
            console.error(`[heartbeat] check failed:`, e);
        }
    }
    const created = [];
    if (notifications.length > 0) {
        const d = getDb();
        const insertQueue = d.prepare('INSERT INTO heartbeat_queue (code, message, seen, created) VALUES (?, ?, 0, ?)');
        for (const notification of notifications) {
            const body = `## Findings\n\n- **${notification.type}**: ${notification.message}\n\n## Details\n\n` +
                notification.entries.map(e => `- ${e.code} — ${e.name} (${e.status})`).join('\n');
            const entry = upsertHeartbeatAlert(notification.type, notification.message, body, ran_at);
            created.push(entry);
            try {
                insertQueue.run(entry.code, notification.message, ran_at);
            }
            catch {
                // Duplicate key on heartbeat_queue — entry already queued, safe to ignore
            }
        }
    }
    // H5: Monthly git maintenance
    checkGitMaintenance().catch(() => { });
    return { ran_at, notifications, created };
}
