import type { Classification, ResolvedMemory } from './types.js';
import type { IndexEntry } from './memory/types.js';
import { fetchByCode, queryEntries, getEntryByCode } from './memory/mod.js';
import { getRelationshipsFrom } from './memory/relationships.js';

export function resolveQuery(c: Classification): ResolvedMemory | null {
  // Step 1: Direct code fetch
  if (c.codes.length > 0 && c.intent === 'code_fetch') {
    const result = fetchByCode(c.codes[0]);
    if (result) {
      return { step: 1, entries: [result.entry], contents: [result.content], relationships: [] };
    }
  }

  // Step 2: SQLite filter (combine all available filters)
  const hasFilter = c.nb || c.type || c.status || c.name;
  if (hasFilter) {
    const filter: { nb?: string; type?: string; status?: string; name?: string } = {};
    if (c.nb) filter.nb = c.nb;
    if (c.type) filter.type = c.type;
    if (c.status) filter.status = c.status;
    if (c.name) filter.name = c.name;

    const entries = queryEntries(filter);
    if (entries.length > 0) {
      return { step: 2, entries, contents: [], relationships: [] };
    }
  }

  // Step 3: Relationship query
  if (c.codes.length > 0 && c.relation) {
    const rels = getRelationshipsFrom(c.codes[0], c.relation);
    if (rels.length > 0) {
      const entries = rels
        .map(r => getEntryByCode(r.to_code))
        .filter((e): e is IndexEntry => e !== undefined);
      return { step: 3, entries, contents: [], relationships: rels };
    }
  }

  // Step 4: Name-only search (broader fallback if step 2 was too specific)
  if (c.name && (c.nb || c.type || c.status)) {
    const entries = queryEntries({ name: c.name });
    if (entries.length > 0) {
      return { step: 4, entries, contents: [], relationships: [] };
    }
  }

  // Step 5: Hybrid search — Phase 4 (not implemented)
  return null;
}
