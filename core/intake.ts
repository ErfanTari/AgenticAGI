/**
 * Intake Classification Pipeline — Phase 15, Section 1
 *
 * Classifies incoming messages and resolves relevant memory context
 * before any decomposition or planning occurs.
 */
import type { LLMHandler, Message } from './types.js';
import type { IndexEntry } from './memory/types.js';
import type Database from 'better-sqlite3';
import { sessionCache } from './memory/session-cache.js';
import { transparency } from './transparency.js';

export interface IntakeSignals {
  summary: string;
  personSignal: { name: string; confidence: number } | null;
  projectSignal: { name: string; confidence: number } | null;
  timeSignal: { description: string } | null;
  agenticSignal: boolean;
  procedureSignal: boolean;
  querySignal: boolean;
}

export interface ResolvedEntry {
  code: string;
  summary: string;
  nb: string;
  name: string;
}

export interface IntakeResult {
  summary: string;
  signals: IntakeSignals;
  resolvedContext: ResolvedEntry[];
  projectCode: string | null;
}

const INTAKE_SYSTEM_PROMPT = `You are a message intake classifier. Analyze the message and return ONLY a JSON object.

Return this structure:
{
  "summary": "one-sentence summary of what the message is about",
  "person": { "name": "person name if mentioned or implied", "confidence": 0.0-1.0 } or null,
  "project": { "name": "project name if referenced", "confidence": 0.0-1.0 } or null,
  "time": { "description": "time component description" } or null,
  "agentic": true/false,
  "procedure": true/false,
  "query": true/false
}

Questions to answer:
1. One-sentence summary: what is this message about?
2. Is a specific person mentioned or implied? (confidence > 0.7 means clearly identified)
3. Is a specific project referenced (by name or pronoun)? (confidence > 0.7 means clearly identified)
4. Is there a time component (deadline, date, scheduling)?
5. Is there an action requested that requires planning? (agentic = true)
6. Is there a procedure or method being described? (procedure = true)
7. Is this asking about something already in memory? (query = true)

Return ONLY the JSON object, no extra text.`;

function parseIntakeResponse(response: string): {
  summary: string;
  person: { name: string; confidence: number } | null;
  project: { name: string; confidence: number } | null;
  time: { description: string } | null;
  agentic: boolean;
  procedure: boolean;
  query: boolean;
} | null {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

function fuzzyNameSearch(
  db: Database.Database,
  name: string,
  nb: string,
  type?: string,
): IndexEntry[] {
  try {
    const lower = name.toLowerCase();
    const typeFilter = type ? `AND type = '${type}'` : '';
    const rows = db.prepare(`
      SELECT * FROM index_entries
      WHERE nb = ? AND status != 'archived' ${typeFilter}
      AND (LOWER(name) LIKE ? OR LOWER(name) LIKE ? OR LOWER(summary) LIKE ?)
      LIMIT 3
    `).all(nb, `%${lower}%`, `${lower}%`, `%${lower}%`) as IndexEntry[];
    return rows;
  } catch {
    return [];
  }
}

export async function runIntake(
  message: string,
  db: Database.Database,
  llm: LLMHandler,
): Promise<IntakeResult> {
  // Call LLM for classification
  const classifyMessages: Message[] = [
    { role: 'system', content: INTAKE_SYSTEM_PROMPT },
    { role: 'user', content: message },
  ];

  let parsed: ReturnType<typeof parseIntakeResponse> = null;
  try {
    const response = await llm(classifyMessages, { maxTokens: 256, temperature: 0 });
    parsed = parseIntakeResponse(response);
  } catch {
    // LLM call failed — use empty signals
  }

  const signals: IntakeSignals = {
    summary: parsed?.summary ?? message.slice(0, 100),
    personSignal: parsed?.person ?? null,
    projectSignal: parsed?.project ?? null,
    timeSignal: parsed?.time ?? null,
    agenticSignal: parsed?.agentic ?? false,
    procedureSignal: parsed?.procedure ?? false,
    querySignal: parsed?.query ?? false,
  };

  // Parallel memory lookups based on signals
  const resolvedContext: ResolvedEntry[] = [];
  let projectCode: string | null = null;

  const lookups: Array<Promise<void>> = [];

  // Person lookup
  if (signals.personSignal && signals.personSignal.confidence > 0.7) {
    lookups.push((async () => {
      try {
        const entries = fuzzyNameSearch(db, signals.personSignal!.name, 'WHO');
        for (const entry of entries) {
          if (!resolvedContext.some(r => r.code === entry.code)) {
            resolvedContext.push({
              code: entry.code,
              summary: entry.summary ?? entry.name,
              nb: entry.nb,
              name: entry.name,
            });
          }
        }
      } catch { /* best-effort */ }
    })());
  }

  // Project lookup
  if (signals.projectSignal && signals.projectSignal.confidence > 0.7) {
    lookups.push((async () => {
      try {
        // Search WHAT.PJ
        const whatEntries = fuzzyNameSearch(db, signals.projectSignal!.name, 'WHAT', 'PJ');
        for (const entry of whatEntries) {
          if (!resolvedContext.some(r => r.code === entry.code)) {
            resolvedContext.push({
              code: entry.code,
              summary: entry.summary ?? entry.name,
              nb: entry.nb,
              name: entry.name,
            });
            if (!projectCode) projectCode = entry.code;
          }
        }

        // Search PLAN.PJ (project brains)
        const planEntries = fuzzyNameSearch(db, signals.projectSignal!.name, 'PLAN', 'PJ');
        for (const entry of planEntries) {
          if (!resolvedContext.some(r => r.code === entry.code)) {
            resolvedContext.push({
              code: entry.code,
              summary: entry.summary ?? entry.name,
              nb: entry.nb,
              name: entry.name,
            });
            if (!projectCode) projectCode = entry.code;
          }
        }
      } catch { /* best-effort */ }
    })());
  }

  // Time lookup
  if (signals.timeSignal) {
    lookups.push((async () => {
      try {
        const entries = db.prepare(`
          SELECT * FROM index_entries
          WHERE nb = 'WHEN' AND status != 'archived'
          ORDER BY due_date ASC
          LIMIT 3
        `).all() as IndexEntry[];
        for (const entry of entries) {
          if (!resolvedContext.some(r => r.code === entry.code)) {
            resolvedContext.push({
              code: entry.code,
              summary: entry.summary ?? entry.name,
              nb: entry.nb,
              name: entry.name,
            });
          }
        }
      } catch { /* best-effort */ }
    })());
  }

  // Procedure lookup
  if (signals.procedureSignal) {
    lookups.push((async () => {
      try {
        const lower = signals.summary.toLowerCase();
        const entries = db.prepare(`
          SELECT * FROM index_entries
          WHERE nb = 'HOW' AND type = 'PR' AND status != 'archived'
          AND (LOWER(name) LIKE ? OR LOWER(summary) LIKE ?)
          LIMIT 3
        `).all(`%${lower.slice(0, 30)}%`, `%${lower.slice(0, 30)}%`) as IndexEntry[];
        for (const entry of entries) {
          if (!resolvedContext.some(r => r.code === entry.code)) {
            resolvedContext.push({
              code: entry.code,
              summary: entry.summary ?? entry.name,
              nb: entry.nb,
              name: entry.name,
            });
          }
        }
      } catch { /* best-effort */ }
    })());
  }

  await Promise.all(lookups);

  // FIX-C4: Seed session cache with resolved entries
  for (const entry of resolvedContext) {
    sessionCache.set(entry.code, {
      code: entry.code,
      nb: entry.nb,
      type: entry.code.split('.')[1]?.split('-')[0] ?? '',
      name: entry.name,
      status: 'active',
      updated: '',
      summary: entry.summary,
      path: '',
      due_date: null,
    });
  }

  // FIX-C4: Prefer PLAN.PJ over WHAT.PJ for projectCode (project brain keys on PLAN.PJ)
  const planPj = resolvedContext.find(e => e.code.startsWith('PLAN.PJ'));
  const whatPj = resolvedContext.find(e => e.code.startsWith('WHAT.PJ'));
  projectCode = planPj?.code ?? whatPj?.code ?? projectCode;

  // FIX-C4: Emit transparency event after resolution
  transparency.emit({
    type: 'intake',
    data: {
      summary: signals.summary,
      signals: signals as unknown as Record<string, unknown>,
      resolvedCodes: resolvedContext.map(e => e.code),
    },
  });

  return {
    summary: signals.summary,
    signals,
    resolvedContext,
    projectCode,
  };
}
