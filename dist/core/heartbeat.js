import { getDb } from './memory/index.js';
import { createEntry, updateEntry } from './memory/write.js';
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
export function checkUpcomingEvents() {
    const d = getDb();
    const entries = d.prepare('SELECT * FROM index_entries WHERE nb = ? AND status = ?').all('WHEN', 'upcoming');
    if (entries.length === 0)
        return null;
    return {
        type: 'upcoming_event',
        entries,
        message: `${entries.length} upcoming event(s) need attention`,
    };
}
export function checkOverdueTodos() {
    const cutoff = daysAgo(1);
    const entries = queryStale('NOW', 'TD', 'open', cutoff);
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
export function checkStalePlans() {
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
export function runHeartbeat() {
    const ran_at = today();
    const notifications = [];
    const checks = [
        checkUpcomingEvents,
        checkOverdueTodos,
        checkStaleQuestions,
        checkStalePlans,
        checkStaleProjects,
    ];
    for (const check of checks) {
        const result = check();
        if (result)
            notifications.push(result);
    }
    let created = null;
    if (notifications.length > 0) {
        const lines = notifications.map(n => `- **${n.type}**: ${n.message}`);
        const body = `## Findings\n\n${lines.join('\n')}\n\n## Details\n\n` +
            notifications.flatMap(n => n.entries.map(e => `- ${e.code} — ${e.name} (${e.status})`)).join('\n');
        created = createEntry({
            nb: 'WHY',
            type: 'MT',
            name: `Heartbeat ${ran_at}`,
            status: 'active',
            summary: `Heartbeat found ${notifications.length} issue(s)`,
            body,
        });
    }
    return { ran_at, notifications, created };
}
