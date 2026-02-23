import { getDb } from './memory/index.js';
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
    return new Date().toISOString().slice(0, 10);
}
function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
}
function queryStale(nb, type, status, cutoff) {
    const d = getDb();
    return d.prepare('SELECT * FROM index_entries WHERE nb = ? AND type = ? AND status = ? AND updated < ?').all(nb, type, status, cutoff);
}
// --- Individual checks ---
export function checkDeadlines() {
    // FIX 4: Only flag deadlines within the 24h window [today, tomorrow]
    const todayStr = new Date().toISOString().split('T')[0];
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];
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
    const todayStr = new Date().toISOString().split('T')[0];
    const d = getDb();
    const entries = d.prepare('SELECT * FROM index_entries WHERE nb = ? AND type = ? AND status = ? AND due_date < ?').all('NOW', 'TD', 'open', todayStr);
    if (entries.length === 0)
        return null;
    for (const entry of entries) {
        updateEntry(entry.code, { status: 'overdue' });
    }
    return {
        type: 'overdue_todo',
        entries,
        message: `${entries.length} todo(s) overdue — status updated`,
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
// --- Main heartbeat ---
export async function runHeartbeat() {
    const ran_at = today();
    const notifications = [];
    // FIX 2: Per-check error isolation — one check failing must NEVER stop other checks
    const checks = [
        checkDeadlines,
        checkOverdueTodos,
        checkStaleQuestions,
        checkPlanCalibration,
        checkStaleProjects,
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
            const entry = createEntry({
                nb: 'WHY',
                type: 'MT',
                name: `Heartbeat ${ran_at} — ${notification.type}`,
                status: 'active',
                summary: notification.message,
                body,
            });
            created.push(entry);
            insertQueue.run(entry.code, notification.message, ran_at);
        }
    }
    return { ran_at, notifications, created };
}
