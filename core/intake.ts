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
import { extractFirstJsonObject } from './structured.js';
import { intakeJsonSchema } from './schemas.js';
import { stripThinkingTags } from './llm.js';
import { promptLoader } from './prompt-loader.js';
import { TOKEN_BUDGETS } from '../config/agent.config.js';

const GREETING_ONLY = /^\s*(hi|hello|hey|good\s+(morning|afternoon|evening)|howdy|greetings)\s*[!.?]*\s*$/i;

function normalizeGroundingText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function isGroundedInMessage(message: string, candidate: string | null): boolean {
  if (!candidate) return false;
  const normalizedMessage = normalizeGroundingText(message);
  const normalizedCandidate = normalizeGroundingText(candidate);
  if (!normalizedMessage || !normalizedCandidate) return false;
  return normalizedMessage.includes(normalizedCandidate);
}

export interface IntakeSignals {
  summary: string;
  /** Name string when confidence > 0.7, otherwise null */
  personSignal: string | null;
  /** Name string when confidence > 0.7, otherwise null */
  projectSignal: string | null;
  /** Description string, otherwise null */
  timeSignal: string | null;
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

// Loaded at call time from prompts/intake.md via promptLoader
function getIntakeSystemPrompt(): string {
  return promptLoader.load('intake');
}

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
    const clean = stripThinkingTags(response);
    const block = extractFirstJsonObject(clean);
    if (!block) {
      console.warn(`[zaraban][intake] No JSON object found in response. Length: ${response.length}`);
      return null;
    }
    return JSON.parse(block);
  } catch (err) {
    console.warn(`[zaraban][intake] JSON parse error:`, err);
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
  if (GREETING_ONLY.test(message)) {
    const signals: IntakeSignals = {
      summary: message.trim(),
      personSignal: null,
      projectSignal: null,
      timeSignal: null,
      agenticSignal: false,
      procedureSignal: false,
      querySignal: false,
    };

    transparency.emit({
      type: 'intake_signals',
      data: {
        personSignal: null,
        projectSignal: null,
        querySignal: false,
        agenticSignal: false,
      },
    });

    transparency.emit({
      type: 'intake',
      data: {
        summary: signals.summary,
        signals: signals as unknown as Record<string, unknown>,
        resolvedCodes: [],
      },
    });

    return {
      summary: signals.summary,
      signals,
      resolvedContext: [],
      projectCode: null,
    };
  }

  // Call LLM for classification
  const classifyMessages: Message[] = [
    { role: 'system', content: getIntakeSystemPrompt() },
    { role: 'user', content: message },
  ];

  let parsed: ReturnType<typeof parseIntakeResponse> = null;
  try {
    // FIX 1: Add responseSchema for engine-level JSON enforcement
    const response = await llm(classifyMessages, {
      responseSchema: intakeJsonSchema,
      maxTokens: TOKEN_BUDGETS.INTAKE,
      temperature: 0,
      disableThinking: true
    });
    parsed = parseIntakeResponse(response);
    if (!parsed) {
      console.warn(`[zaraban][intake] Schema validation failed. Raw length: ${response.length}. Falling back.`);
    }
  } catch {
    // LLM call failed — use empty signals
  }

  const signals: IntakeSignals = {
    summary: parsed?.summary ?? message.slice(0, 100),
    personSignal:
      (parsed?.person?.confidence ?? 0) > 0.7 && isGroundedInMessage(message, parsed?.person?.name ?? null)
        ? parsed!.person!.name
        : null,
    projectSignal:
      (parsed?.project?.confidence ?? 0) > 0.7 && isGroundedInMessage(message, parsed?.project?.name ?? null)
        ? parsed!.project!.name
        : null,
    timeSignal: parsed?.time?.description ?? null,
    agenticSignal: parsed?.agentic === true,
    procedureSignal: parsed?.procedure === true,
    querySignal: parsed?.query === true,
  };

  transparency.emit({
    type: 'intake_signals',
    data: {
      personSignal: signals.personSignal,
      projectSignal: signals.projectSignal,
      querySignal: signals.querySignal,
      agenticSignal: signals.agenticSignal,
    },
  });

  // Parallel memory lookups based on signals
  const resolvedContext: ResolvedEntry[] = [];
  let projectCode: string | null = null;

  const lookups: Array<Promise<void>> = [];

  // Person lookup
  if (signals.personSignal) {
    lookups.push((async () => {
      try {
        const entries = fuzzyNameSearch(db, signals.personSignal!, 'WHO');
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
  if (signals.projectSignal) {
    lookups.push((async () => {
      try {
        // Search PLAN.PJ project brains
        const planEntries = fuzzyNameSearch(db, signals.projectSignal!, 'PLAN', 'PJ');
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

  // FIX-C4: Project keys are PLAN.PJ only after the Stage 2B collapse.
  const planPj = resolvedContext.find(e => e.code.startsWith('PLAN.PJ'));
  projectCode = planPj?.code ?? projectCode;

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
