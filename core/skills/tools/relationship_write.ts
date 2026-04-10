import { getDb } from '../../memory/mod.js';
import { addRelationship } from '../../memory/relationships.js';
import type { MCPSkill, SkillResult } from '../types.js';

const CODE_PATTERN = /^[A-Z]+\.[A-Z]+-\d{6,}$/i;

/**
 * Resolve a name-or-code string to a canonical code.
 *
 * Priority order:
 *  1. Already a valid code → return as-is
 *  2. Exact case-insensitive name match (excluding archived) → most recently updated wins
 *  3. Starts-with match (excluding archived) → most recently updated wins
 *  4. Contains match (excluding archived) → most recently updated wins
 */
function resolveEntity(nameOrCode: string): string | null {
  // Priority 1: already a valid code
  if (CODE_PATTERN.test(nameOrCode)) return nameOrCode;

  const d = getDb();

  // Priority 2: exact name match, most recent first, excluding archived
  const exact = d.prepare(`
    SELECT code FROM index_entries
    WHERE LOWER(name) = LOWER(?)
    AND status != 'archived'
    ORDER BY updated DESC
    LIMIT 1
  `).get(nameOrCode) as { code: string } | undefined;

  if (exact) return exact.code;

  // Priority 3: starts-with match, most recent first, excluding archived
  const startsWith = d.prepare(`
    SELECT code FROM index_entries
    WHERE LOWER(name) LIKE LOWER(?)
    AND status != 'archived'
    ORDER BY updated DESC
    LIMIT 1
  `).get(`${nameOrCode}%`) as { code: string } | undefined;

  if (startsWith) return startsWith.code;

  // Priority 4: contains match, most recent first, excluding archived
  const contains = d.prepare(`
    SELECT code FROM index_entries
    WHERE LOWER(name) LIKE LOWER(?)
    AND status != 'archived'
    ORDER BY updated DESC
    LIMIT 1
  `).get(`%${nameOrCode}%`) as { code: string } | undefined;

  if (contains) return contains.code;

  return null;
}

/**
 * relationship_write skill
 *
 * Creates a directed relationship between two memory entries.
 * Accepts codes directly OR entry names (resolved via canonical lookup).
 * When a prior plan step stores a code via storeResultAs, pass that
 * template (e.g. {{sara_code}}) as from_code — it will already be a
 * valid code and skip the name lookup entirely.
 */
export const relationshipWriteSkill: MCPSkill = {
  name: 'relationship_write',
  description: 'Create a relationship between two memory entries. Accepts entry codes (e.g. WHO.CT-000001) or entry names. Prefer codes from storeResultAs over raw names.',
  permissionLevel: 'workspace-write',
  inputSchema: {
    type: 'object',
    properties: {
      from_code: {
        type: 'string',
        description: 'Code (WHO.CT-000001) or name ("Sara Ahmadi") of the source entry',
      },
      relation: {
        type: 'string',
        description: 'Relationship type: interested_in | owns | works_for | blocks | refers',
      },
      to_code: {
        type: 'string',
        description: 'Code (PLAN.PJ-000003) or name ("AgenticAGI") of the target entry',
      },
      note: {
        type: 'string',
        description: 'Optional human note about this relationship',
      },
    },
    required: ['from_code', 'relation', 'to_code'],
  },

  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const rawFrom = String(input.from_code ?? '').trim();
    const relation = String(input.relation ?? '').trim();
    const rawTo   = String(input.to_code   ?? '').trim();
    const note    = input.note ? String(input.note) : undefined;

    if (!rawFrom || !relation || !rawTo) {
      return { success: false, output: '', error: 'from_code, relation, and to_code are all required' };
    }

    if (process.env.DEBUG_DEEP === 'true') {
      console.log(`[relationship_write:DEEP] raw from="${rawFrom}" to="${rawTo}"`);
    }

    const fromCode = resolveEntity(rawFrom);
    const toCode   = resolveEntity(rawTo);

    if (process.env.DEBUG_DEEP === 'true') {
      console.log(`[relationship_write:DEEP] resolved from=${fromCode} to=${toCode}`);
    }

    if (!fromCode) {
      return {
        success: false,
        output: '',
        error: `Could not find entry for: "${rawFrom}". Use the entry code directly (e.g. PLAN.PJ-000014) or create the entry first.`,
      };
    }
    if (!toCode) {
      return {
        success: false,
        output: '',
        error: `Could not find entry for: "${rawTo}". Use the entry code directly (e.g. PLAN.PJ-000014) or create the entry first.`,
      };
    }

    try {
      const rel = addRelationship({ from_code: fromCode, relation, to_code: toCode, note });
      return {
        success: true,
        output: `Relationship created: ${rel.from_code} ${rel.relation} ${rel.to_code}`,
      };
    } catch (err) {
      return { success: false, output: '', error: `Failed to create relationship: ${String(err)}` };
    }
  },
};
