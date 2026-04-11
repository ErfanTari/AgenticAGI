import type { IndexEntry, Relationship } from '../../memory/types.js';
import {
  fetchByCode,
  getRelationshipsFrom,
  getRelationshipsTo,
  hybridSearch,
  queryEntries,
} from '../../memory/mod.js';
import { transparency } from '../../transparency.js';
import type { MCPSkill, SkillResult } from '../types.js';

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 20;
const MAX_CONTENT_CHARS = 1800;
const VALID_NOTEBOOKS = new Set(['WHO', 'WHAT', 'WHEN', 'HOW', 'WHY', 'NOW', 'PLAN']);

function parseLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Strip leading `[` and trailing `]` that the model may copy from MEMORY.md
 * pointer format (e.g. "[WHO.CT-000001]" → "WHO.CT-000001").
 * Only outer brackets are removed; brackets in the middle are preserved.
 */
export function cleanCode(rawCode: string): string {
  return rawCode.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
}

function toOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return undefined;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/m, '').trim();
}

function buildEntrySnapshot(entry: IndexEntry, includeContent: boolean): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {
    code: entry.code,
    nb: entry.nb,
    type: entry.type,
    name: entry.name,
    status: entry.status,
    updated: entry.updated,
    summary: entry.summary,
    due_date: entry.due_date ?? null,
  };

  const shouldIncludeContent = includeContent || entry.nb === 'WHO';
  if (shouldIncludeContent) {
    const fetched = fetchByCode(entry.code);
    if (fetched) {
      const body = stripFrontmatter(fetched.content);
      snapshot.content = body.length > MAX_CONTENT_CHARS
        ? body.slice(0, MAX_CONTENT_CHARS) + '\n\n[truncated]'
        : body;
    }
  }

  return snapshot;
}

function dedupeEntries(entries: IndexEntry[]): IndexEntry[] {
  const seen = new Set<string>();
  const unique: IndexEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.code)) continue;
    seen.add(entry.code);
    unique.push(entry);
  }
  return unique;
}

export function isTerminalPlanExEntry(entry: IndexEntry): boolean {
  return entry.nb === 'PLAN'
    && entry.type === 'EX'
    && (entry.status === 'complete' || entry.status === 'failed');
}

function filterTerminalPlanExEntries(entries: IndexEntry[]): IndexEntry[] {
  const filtered: IndexEntry[] = [];
  for (const entry of entries) {
    if (isTerminalPlanExEntry(entry)) {
      transparency.emit({
        type: 'memory_context_filtered',
        data: { code: entry.code, reason: 'terminal_plan_ex', status: entry.status },
      });
      continue;
    }
    filtered.push(entry);
  }
  return filtered;
}

function findByNameTokens(
  query: string,
  filter: { nb?: string; type?: string; status?: string },
): IndexEntry[] {
  const tokens = query
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 3);

  if (tokens.length === 0) return [];

  const matches: IndexEntry[] = [];
  for (const token of tokens) {
    matches.push(...queryEntries({ ...filter, name: token }));
  }
  return dedupeEntries(matches);
}

function mapRelationships(rels: Relationship[]): Array<Record<string, unknown>> {
  return rels.map(rel => ({
    from_code: rel.from_code,
    relation: rel.relation,
    to_code: rel.to_code,
    note: rel.note ?? null,
    created: rel.created,
  }));
}

function getPrimaryWhoEntry(): IndexEntry | undefined {
  const whoEntries = queryEntries({ nb: 'WHO' });
  if (whoEntries.length === 0) return undefined;

  const sorted = [...whoEntries].sort((a, b) => a.code.localeCompare(b.code));
  return sorted[0];
}

const memoryReadSkill: MCPSkill = {
  name: 'memory_read',
  description: 'Read memory entries by code, notebook filters, or semantic query. Use this first when a task must use existing memory content.',
  permissionLevel: 'read-only',
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Optional entry code like WHO.CT-000001' },
      query: { type: 'string', description: 'Optional semantic query for hybrid memory search' },
      nb: { type: 'string', description: 'Optional notebook filter (WHO/WHAT/WHEN/HOW/WHY/NOW/PLAN)' },
      type: { type: 'string', description: 'Optional type filter (CT, PJ, TD, etc.)' },
      status: { type: 'string', description: 'Optional status filter (active/open/archived...)' },
      name: { type: 'string', description: 'Optional partial name filter' },
      relation: { type: 'string', description: 'Optional relation filter for code-based relationship lookup' },
      direction: { type: 'string', description: 'Optional relation direction: from (default) or to' },
      limit: { type: 'string', description: 'Optional max entries (default 6, max 20)' },
      includeContent: { type: 'string', description: 'true/false; include markdown body excerpts (default true)' },
    },
    required: [],
  },
  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    try {
      const code = toOptionalString(input.code) !== undefined
        ? cleanCode(toOptionalString(input.code)!)
        : undefined;
      const query = toOptionalString(input.query);
      const rawNb = toOptionalString(input.nb);
      const normalizedNb = rawNb?.toUpperCase();
      const nb = normalizedNb && VALID_NOTEBOOKS.has(normalizedNb) ? normalizedNb : undefined;
      const type = toOptionalString(input.type);
      const status = toOptionalString(input.status);
      const name = toOptionalString(input.name);
      const relation = toOptionalString(input.relation);
      const direction = toOptionalString(input.direction) ?? 'from';
      const limit = parseLimit(input.limit);
      const includeContent = toOptionalBoolean(input.includeContent) ?? false;
      const allowTerminalPlanEx = nb === 'PLAN'
        && type === 'EX'
        && (status === 'complete' || status === 'failed');

      let entries: IndexEntry[] = [];
      let relationships: Relationship[] = [];

      if (code) {
        const fetched = fetchByCode(code);
        if (!fetched) {
          return { success: false, output: '', error: `Memory entry not found: ${code}` };
        }
        entries = [fetched.entry];
        if (relation) {
          relationships = direction === 'to'
            ? getRelationshipsTo(code, relation)
            : getRelationshipsFrom(code, relation);
        } else {
          relationships = direction === 'to'
            ? getRelationshipsTo(code)
            : getRelationshipsFrom(code);
        }
      } else if (query) {
        let searchResults: Array<{ entry: IndexEntry }> = [];
        try {
          searchResults = await hybridSearch(query, { nb });
        } catch {
          // Hybrid search is best-effort; fall back to name-token scan.
          searchResults = [];
        }

        entries = searchResults.map(result => result.entry);
        if (!allowTerminalPlanEx) {
          entries = filterTerminalPlanExEntries(entries);
        }
        entries = entries.slice(0, limit);

        if (entries.length === 0) {
          entries = findByNameTokens(query, { nb, type, status });
          if (!allowTerminalPlanEx) {
            entries = filterTerminalPlanExEntries(entries);
          }
          entries = entries.slice(0, limit);
        }

        if (entries.length === 0) {
          entries = queryEntries({ nb, type, status, name });
          if (!allowTerminalPlanEx) {
            entries = filterTerminalPlanExEntries(entries);
          }
          entries = entries.slice(0, limit);
        }

        if (entries.length === 0 && !nb && !type && !status && !name) {
          entries = queryEntries({});
          if (!allowTerminalPlanEx) {
            entries = filterTerminalPlanExEntries(entries);
          }
          entries = entries.slice(0, limit);
        }

        if (!entries.some(entry => entry.nb === 'WHO') && /\b(name|title|bio|contact|profile|personal|about)\b/i.test(query)) {
          const whoEntries = queryEntries({ nb: 'WHO' }).slice(0, 1);
          entries = dedupeEntries([...whoEntries, ...entries]).slice(0, limit);
        }

        if (/\b(name|title|bio|contact|profile|personal|about)\b/i.test(query)) {
          const primaryWho = getPrimaryWhoEntry();
          if (primaryWho) {
            entries = dedupeEntries([primaryWho, ...entries]).slice(0, limit);
          }
        }
      } else {
        entries = queryEntries({ nb, type, status, name });
        if (!allowTerminalPlanEx) {
          entries = filterTerminalPlanExEntries(entries);
        }
        entries = entries.slice(0, limit);
      }

      if (entries.length === 0) {
        return {
          success: false,
          output: '',
          error: 'No matching memory entries found',
        };
      }

      const payload = {
        count: entries.length,
        entries: entries.map(entry => buildEntrySnapshot(entry, includeContent)),
        relationships: mapRelationships(relationships),
      };

      return { success: true, output: JSON.stringify(payload) };
    } catch (err) {
      return {
        success: false,
        output: '',
        error: `memory_read failed: ${String(err)}`,
      };
    }
  },
};

export default memoryReadSkill;
