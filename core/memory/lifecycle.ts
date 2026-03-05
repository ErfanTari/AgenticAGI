/**
 * P4: Memory Lifecycle — decay, utility, conflict resolution, metadata extraction.
 */
import { getDb } from './index.js';
import type { LLMHandler } from '../types.js';

export const NOTEBOOK_DECAY_RATES: Record<string, number> = {
  'NOW': 0.3,
  'WHEN': 0.2,
  'WHAT': 0.05,
  'WHO': 0.02,
  'WHY': 0.01,
  'HOW': 0.05,
  'PLAN': 0.05,
};

interface EntryWithScores {
  code: string;
  nb: string;
  importance_score: number;
  utility_score: number;
  usage_count: number;
  updated: string;
  decay_rate: number;
  active_page: number;
  pinned: number;
}

/**
 * Compute decay score: S(t) = importance * e^(-decay * days) + usage * 0.1 * e^(-decay * days)
 */
export function computeDecayScore(entry: EntryWithScores, now: Date): number {
  const updatedMs = new Date(entry.updated).getTime();
  const days = (now.getTime() - updatedMs) / (1000 * 60 * 60 * 24);
  const decayRate = entry.decay_rate ?? NOTEBOOK_DECAY_RATES[entry.nb] ?? 0.1;

  const importanceTerm = (entry.importance_score ?? 0.5) * Math.exp(-decayRate * days);
  const usageTerm = (entry.usage_count ?? 0) * 0.1 * Math.exp(-decayRate * days);

  return importanceTerm + usageTerm;
}

/**
 * Run full decay cycle: DECAY → PRUNE → PAGE
 * Updates scores in database without deleting content.
 */
export function runDecayCycle(): void {
  const db = getDb();
  const now = new Date();

  try {
    // Get all non-archived, non-pinned entries
    const entries = db.prepare(
      "SELECT code, nb, importance_score, utility_score, usage_count, updated, decay_rate, active_page, pinned FROM index_entries WHERE status != 'archived' AND (pinned IS NULL OR pinned = 0)"
    ).all() as EntryWithScores[];

    const stmt = db.prepare(
      'UPDATE index_entries SET importance_score = ?, active_page = ? WHERE code = ?'
    );

    const updateAll = db.transaction(() => {
      for (const entry of entries) {
        const score = computeDecayScore(entry, now);
        // PAGE: if score is very low, move to inactive page (active_page = 0)
        const activePage = score > 0.05 ? 1 : 0;
        stmt.run(score, activePage, entry.code);
      }
    });

    updateAll();

    // Always keep WHO entries and PLAN.CT entries on active page
    db.prepare(
      "UPDATE index_entries SET active_page = 1 WHERE nb = 'WHO' OR (nb = 'PLAN' AND type = 'CT')"
    ).run();
  } catch (err) {
    console.warn('[lifecycle] runDecayCycle failed:', err);
  }
}

/**
 * Update utility score for an entry (clamped to [0.1, 10.0]).
 * Also increments usage_count and sets last_accessed.
 */
export function updateUtilityScore(code: string, delta: number): void {
  const db = getDb();

  try {
    const row = db.prepare('SELECT utility_score, usage_count FROM index_entries WHERE code = ?')
      .get(code) as { utility_score: number; usage_count: number } | undefined;

    if (!row) return;

    const newScore = Math.min(10.0, Math.max(0.1, (row.utility_score ?? 1.0) + delta));
    const newCount = (row.usage_count ?? 0) + 1;
    const now = new Date().toISOString();

    db.prepare(
      'UPDATE index_entries SET utility_score = ?, usage_count = ?, last_accessed = ? WHERE code = ?'
    ).run(newScore, newCount, now, code);
  } catch (err) {
    console.warn('[lifecycle] updateUtilityScore failed:', err);
  }
}

/**
 * Extract metadata from memory entry content using LLM.
 * Populates atomic_facts and confidence fields.
 */
export async function extractMemoryMetadata(
  code: string,
  body: string,
  summary: string,
  llmHandler: LLMHandler,
): Promise<void> {
  try {
    const messages = [
      {
        role: 'system' as const,
        content: `Extract metadata from this memory entry. Return JSON:
{"facts": ["fact1"], "confidence": 0.0-1.0, "importance_score": 0.0-1.0}
importance_score rules:
- 0.9: critical/urgent/deadline/must-do
- 0.7-0.8: important, high-priority, key information
- 0.5: normal/default
- 0.2-0.4: minor/trivial/low-priority`,
      },
      {
        role: 'user' as const,
        content: `Summary: ${summary}\n\nBody: ${body.slice(0, 500)}`,
      },
    ];

    const metadataSchema = {
      type: 'object',
      properties: {
        facts: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'number' },
        importance_score: { type: 'number' },
      },
      required: ['facts', 'confidence', 'importance_score'],
    };
    const response = await llmHandler(messages, { maxTokens: 300, responseSchema: metadataSchema });
    const cleaned = response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const db = getDb();
      const importanceScore = typeof parsed.importance_score === 'number'
        ? Math.max(0, Math.min(1, parsed.importance_score))
        : null;
      if (importanceScore !== null) {
        db.prepare(
          'UPDATE index_entries SET atomic_facts = ?, confidence = ?, importance_score = ? WHERE code = ?'
        ).run(
          JSON.stringify(parsed.facts ?? []),
          parsed.confidence ?? 1.0,
          importanceScore,
          code,
        );
      } else {
        db.prepare(
          'UPDATE index_entries SET atomic_facts = ?, confidence = ? WHERE code = ?'
        ).run(
          JSON.stringify(parsed.facts ?? []),
          parsed.confidence ?? 1.0,
          code,
        );
      }
    }
  } catch (err) {
    console.warn('[lifecycle] extractMemoryMetadata failed:', err);
  }
}

/**
 * Resolve a conflict between new input and existing entry.
 * Only fires when name similarity > 0.6 AND llmHandler is present.
 */
export async function resolveConflict(
  input: { name: string; body: string; summary: string },
  existing: { name: string; body: string; summary: string },
  llmHandler: LLMHandler,
): Promise<'MERGE_FACTS' | 'SUPERSEDE_OLD' | 'APPEND_NEW'> {
  try {
    // Check name similarity before calling LLM (constraint 6)
    const similarity = nameSimilarity(input.name, existing.name);
    if (similarity < 0.6) return 'APPEND_NEW';

    const messages = [
      {
        role: 'system' as const,
        content: 'You are resolving a memory conflict. Given two versions of the same entry, decide how to handle them. Return ONLY one of: MERGE_FACTS, SUPERSEDE_OLD, APPEND_NEW',
      },
      {
        role: 'user' as const,
        content: `Existing: ${existing.summary}\n${existing.body.slice(0, 300)}\n\nNew: ${input.summary}\n${input.body.slice(0, 300)}`,
      },
    ];

    const response = await llmHandler(messages, { maxTokens: 50 });
    const cleaned = response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim().toUpperCase();

    if (cleaned.includes('MERGE_FACTS')) return 'MERGE_FACTS';
    if (cleaned.includes('SUPERSEDE_OLD')) return 'SUPERSEDE_OLD';
    return 'APPEND_NEW';
  } catch {
    return 'APPEND_NEW';
  }
}

/**
 * Simple name similarity score (0..1) based on word overlap.
 */
function nameSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}
