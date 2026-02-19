export type {
  IndexEntry,
  CreateEntryInput,
  Relationship,
  AddRelationshipInput,
  TraversalNode,
  QueryFilter,
  FetchResult,
} from './types.js';

export { initDatabase, getDb, closeDatabase, getEntryByCode, queryEntries } from './index.js';
export { generateCode, parseCode } from './codegen.js';
export { createEntry } from './write.js';
export { fetchByCode } from './fetch.js';
export { search } from './search.js';
export { addRelationship, getRelationshipsFrom, getRelationshipsTo, getRelationships, traverse } from './relationships.js';
