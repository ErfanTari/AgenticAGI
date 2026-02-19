export interface IndexEntry {
  code: string;
  nb: string;
  type: string;
  name: string;
  status: string;
  updated: string;
  summary: string;
  path: string;
}

export interface CreateEntryInput {
  nb: string;
  type: string;
  name: string;
  status: string;
  summary: string;
  body: string;
}

export interface Relationship {
  from_code: string;
  relation: string;
  to_code: string;
  note: string | null;
  created: string;
}

export interface AddRelationshipInput {
  from_code: string;
  relation: string;
  to_code: string;
  note?: string;
}

export interface TraversalNode {
  code: string;
  depth: number;
  relation: string | null;
  from: string | null;
}

export interface QueryFilter {
  nb?: string;
  type?: string;
  status?: string;
  name?: string;
}

export interface FetchResult {
  entry: IndexEntry;
  content: string;
}
