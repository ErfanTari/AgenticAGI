import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  initDatabase,
  closeDatabase,
  createEntry,
  addRelationship,
  getRelationshipsFrom,
  getRelationshipsTo,
  getRelationships,
  traverse,
} from '../../core/memory/mod.js';
import { PATHS } from '../../config/agent.config.js';

const TEST_DIR = path.join(os.tmpdir(), `agentic-agi-test-p2-${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, 'memory.sqlite');
const TEST_MEMORY = path.join(TEST_DIR, 'memory');

const origDb = PATHS.db;
const origMemory = PATHS.memory;

// Codes assigned during setup
let contactCode: string;
let projectCode: string;
let knowledgeCode: string;
let todoCode: string;

beforeAll(() => {
  (PATHS as Record<string, string>).db = TEST_DB;
  (PATHS as Record<string, string>).memory = TEST_MEMORY;
  initDatabase(TEST_DB);

  // Create entries to relate
  contactCode = createEntry({
    nb: 'WHO', type: 'CT', name: 'Erfan Tari',
    status: 'active', summary: 'Owner', body: 'The owner.',
  }).code;

  projectCode = createEntry({
    nb: 'PLAN', type: 'PJ', name: 'Activation X-Ray',
    status: 'active', summary: 'AI interpretability project', body: 'Project details.',
  }).code;

  knowledgeCode = createEntry({
    nb: 'WHAT', type: 'KN', name: 'Ceramic Glazing',
    status: 'active', summary: 'Knowledge about ceramic glazing', body: 'Glazing notes.',
  }).code;

  todoCode = createEntry({
    nb: 'NOW', type: 'TD', name: 'Review Glazing',
    status: 'open', summary: 'Review the glazing doc', body: 'Needs review.',
  }).code;
});

afterAll(async () => {
  closeDatabase();
  const { _resetGitInstance } = await import('../../core/memory/versioning.js');
  _resetGitInstance();
  await new Promise(r => setTimeout(r, 100));
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  (PATHS as Record<string, string>).db = origDb;
  (PATHS as Record<string, string>).memory = origMemory;
});

describe('addRelationship', () => {
  it('creates a relationship row', () => {
    const rel = addRelationship({
      from_code: contactCode,
      relation: 'owns',
      to_code: projectCode,
    });

    expect(rel.from_code).toBe(contactCode);
    expect(rel.relation).toBe('owns');
    expect(rel.to_code).toBe(projectCode);
    expect(rel.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('creates a relationship with a note', () => {
    const rel = addRelationship({
      from_code: projectCode,
      relation: 'refers',
      to_code: knowledgeCode,
      note: 'Project uses glazing research',
    });

    expect(rel.note).toBe('Project uses glazing research');
  });

  it('throws when from_code does not exist', () => {
    expect(() => addRelationship({
      from_code: 'WHO.CT-999999',
      relation: 'owns',
      to_code: projectCode,
    })).toThrow('Entry not found: WHO.CT-999999');
  });

  it('throws when to_code does not exist', () => {
    expect(() => addRelationship({
      from_code: contactCode,
      relation: 'owns',
      to_code: 'PLAN.PJ-999999',
    })).toThrow('Entry not found: PLAN.PJ-999999');
  });
});

describe('getRelationshipsFrom', () => {
  it('returns outgoing relationships for a code', () => {
    const rels = getRelationshipsFrom(contactCode);
    expect(rels.length).toBeGreaterThanOrEqual(1);
    rels.forEach(r => expect(r.from_code).toBe(contactCode));
  });

  it('filters by relation type', () => {
    const rels = getRelationshipsFrom(contactCode, 'owns');
    expect(rels.length).toBe(1);
    expect(rels[0].to_code).toBe(projectCode);
  });

  it('returns empty array for code with no outgoing relationships', () => {
    const rels = getRelationshipsFrom(todoCode);
    expect(rels).toEqual([]);
  });
});

describe('getRelationshipsTo', () => {
  it('returns incoming relationships for a code', () => {
    const rels = getRelationshipsTo(projectCode);
    expect(rels.length).toBeGreaterThanOrEqual(1);
    rels.forEach(r => expect(r.to_code).toBe(projectCode));
  });

  it('filters by relation type', () => {
    const rels = getRelationshipsTo(projectCode, 'owns');
    expect(rels.length).toBe(1);
    expect(rels[0].from_code).toBe(contactCode);
  });
});

describe('getRelationships', () => {
  it('returns both directions for a code', () => {
    // projectCode has: incoming "owns" from contact, outgoing "refers" to knowledge
    const rels = getRelationships(projectCode);
    expect(rels.length).toBe(2);

    const incoming = rels.filter(r => r.to_code === projectCode);
    const outgoing = rels.filter(r => r.from_code === projectCode);
    expect(incoming.length).toBe(1);
    expect(outgoing.length).toBe(1);
  });
});

describe('traverse', () => {
  beforeAll(() => {
    // Add: knowledge -> refers -> todo (to create a chain: contact -> project -> knowledge -> todo)
    addRelationship({
      from_code: knowledgeCode,
      relation: 'refers',
      to_code: todoCode,
    });
  });

  it('follows a chain of relationships', () => {
    // contact -owns-> project -refers-> knowledge -refers-> todo
    const nodes = traverse(contactCode);
    const codes = nodes.map(n => n.code);

    expect(codes).toContain(contactCode);
    expect(codes).toContain(projectCode);
    expect(codes).toContain(knowledgeCode);
    expect(codes).toContain(todoCode);
  });

  it('respects maxDepth', () => {
    const nodes = traverse(contactCode, { maxDepth: 1 });
    const codes = nodes.map(n => n.code);

    // Depth 0: contactCode, Depth 1: projectCode
    expect(codes).toContain(contactCode);
    expect(codes).toContain(projectCode);
    // knowledge and todo are depth 2 and 3 — should not appear
    expect(codes).not.toContain(knowledgeCode);
    expect(codes).not.toContain(todoCode);
  });

  it('filters by relation type', () => {
    const nodes = traverse(contactCode, { relation: 'owns' });
    const codes = nodes.map(n => n.code);

    // Only "owns" edges: contact -> project. No "refers" followed.
    expect(codes).toContain(contactCode);
    expect(codes).toContain(projectCode);
    expect(codes).not.toContain(knowledgeCode);
  });

  it('handles cycles without infinite loop', () => {
    // Create a cycle: todo -> refers -> contact
    addRelationship({
      from_code: todoCode,
      relation: 'refers',
      to_code: contactCode,
    });

    const nodes = traverse(contactCode, { maxDepth: 10 });
    // Should still terminate and visit each node once
    const codes = nodes.map(n => n.code);
    const unique = new Set(codes);
    expect(codes.length).toBe(unique.size);
  });

  it('returns only the start node when no relationships exist', () => {
    // Create an isolated entry
    const isolated = createEntry({
      nb: 'WHY', type: 'QU', name: 'Lonely Question',
      status: 'open', summary: 'No connections', body: 'Alone.',
    });

    const nodes = traverse(isolated.code);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].code).toBe(isolated.code);
    expect(nodes[0].depth).toBe(0);
  });
});

describe('Phase 2 acceptance', () => {
  it('answers "what does contact own?" from table only, no file reads', () => {
    // This is the CLAUDE.md Phase 2 acceptance test:
    // query "what does WHO.CT-000001 own?" → returns project from table only
    const owned = getRelationshipsFrom(contactCode, 'owns');

    expect(owned.length).toBe(1);
    expect(owned[0].to_code).toBe(projectCode);
    // No fetchByCode called — purely table-based
  });

  it('relationship query completes in under 5ms', () => {
    const start = performance.now();
    getRelationshipsFrom(contactCode, 'owns');
    getRelationshipsTo(projectCode);
    getRelationships(contactCode);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5);
  });
});
