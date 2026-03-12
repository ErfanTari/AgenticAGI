import fs from 'node:fs';
import path from 'node:path';
import { localDateString, localDatePlusDays } from './utils/date.js';
import { getDb, getSettingValue, setSettingValue } from './memory/index.js';
import { simpleGit } from 'simple-git';
import { PATHS } from '../config/agent.config.js';
import { createEntry, updateEntry } from './memory/write.js';
import { isProcessingMessage } from './agent.js';
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
export async function runHeartbeat() {
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
