import { getDb, getEntryByCode } from './index.js';
import type { Relationship, AddRelationshipInput, TraversalNode } from './types.js';

export function addRelationship(input: AddRelationshipInput): Relationship {
  const d = getDb();

  // Verify both codes exist
  if (!getEntryByCode(input.from_code)) {
    throw new Error(`Entry not found: ${input.from_code}`);
  }
  if (!getEntryByCode(input.to_code)) {
    throw new Error(`Entry not found: ${input.to_code}`);
  }

  const created = new Date().toISOString().slice(0, 10);
  const row: Relationship = {
    from_code: input.from_code,
    relation: input.relation,
    to_code: input.to_code,
    note: input.note ?? null,
    created,
  };

  d.prepare(`
    INSERT INTO relationships (from_code, relation, to_code, note, created)
    VALUES (@from_code, @relation, @to_code, @note, @created)
  `).run(row);

  return row;
}

export function getRelationshipsFrom(code: string, relation?: string): Relationship[] {
  const d = getDb();
  if (relation) {
    return d.prepare(
      'SELECT * FROM relationships WHERE from_code = @code AND relation = @relation'
    ).all({ code, relation }) as Relationship[];
  }
  return d.prepare(
    'SELECT * FROM relationships WHERE from_code = @code'
  ).all({ code }) as Relationship[];
}

export function getRelationshipsTo(code: string, relation?: string): Relationship[] {
  const d = getDb();
  if (relation) {
    return d.prepare(
      'SELECT * FROM relationships WHERE to_code = @code AND relation = @relation'
    ).all({ code, relation }) as Relationship[];
  }
  return d.prepare(
    'SELECT * FROM relationships WHERE to_code = @code'
  ).all({ code }) as Relationship[];
}

export function getRelationships(code: string): Relationship[] {
  const d = getDb();
  return d.prepare(
    'SELECT * FROM relationships WHERE from_code = @code OR to_code = @code'
  ).all({ code }) as Relationship[];
}

export function traverse(
  startCode: string,
  options?: { maxDepth?: number; relation?: string }
): TraversalNode[] {
  const maxDepth = options?.maxDepth ?? 3;
  const relation = options?.relation;

  const visited = new Set<string>();
  const result: TraversalNode[] = [];
  const queue: TraversalNode[] = [{ code: startCode, depth: 0, relation: null, from: null }];

  while (queue.length > 0) {
    const node = queue.shift()!;

    if (visited.has(node.code)) continue;
    visited.add(node.code);
    result.push(node);

    if (node.depth >= maxDepth) continue;

    // Follow outgoing relationships
    const outgoing = getRelationshipsFrom(node.code, relation);
    for (const rel of outgoing) {
      if (!visited.has(rel.to_code)) {
        queue.push({
          code: rel.to_code,
          depth: node.depth + 1,
          relation: rel.relation,
          from: node.code,
        });
      }
    }

    // Follow incoming relationships
    const incoming = getRelationshipsTo(node.code, relation);
    for (const rel of incoming) {
      if (!visited.has(rel.from_code)) {
        queue.push({
          code: rel.from_code,
          depth: node.depth + 1,
          relation: rel.relation,
          from: node.code,
        });
      }
    }
  }

  return result;
}
