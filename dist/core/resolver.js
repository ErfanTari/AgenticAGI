import { fetchByCode, queryEntries, getEntryByCode } from './memory/mod.js';
import { getRelationshipsFrom } from './memory/relationships.js';
export function resolveQuery(c) {
    // Step 1: Direct code fetch — attempt whenever codes are present,
    // regardless of intent. A relationship query like "what does WHO.CT-000001 own?"
    // should still verify the code exists first.
    if (c.codes.length > 0) {
        if (c.intent === 'code_fetch') {
            const result = fetchByCode(c.codes[0]);
            if (result) {
                return { step: 1, entries: [result.entry], contents: [result.content], relationships: [] };
            }
            // code_fetch with no result → fall through (will be caught by not-found guard)
        }
        // Step 3: Relationship query (moved up when code is present + relation detected)
        if (c.relation) {
            // Verify code exists first
            const exists = getEntryByCode(c.codes[0]);
            if (exists) {
                const rels = getRelationshipsFrom(c.codes[0], c.relation);
                if (rels.length > 0) {
                    const entries = rels
                        .map(r => getEntryByCode(r.to_code))
                        .filter((e) => e !== undefined);
                    return { step: 3, entries, contents: [], relationships: rels };
                }
            }
        }
    }
    // Step 2: SQLite filter (combine all available filters)
    const hasFilter = c.nb || c.type || c.status || c.name;
    if (hasFilter) {
        const filter = {};
        if (c.nb)
            filter.nb = c.nb;
        if (c.type)
            filter.type = c.type;
        if (c.status)
            filter.status = c.status;
        if (c.name)
            filter.name = c.name;
        const entries = queryEntries(filter);
        if (entries.length > 0) {
            return { step: 2, entries, contents: [], relationships: [] };
        }
    }
    // Step 3: Relationship query (without code — from filter results)
    // Already handled above when code is present
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
