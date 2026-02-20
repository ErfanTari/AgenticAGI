import type { Relationship, AddRelationshipInput, TraversalNode } from './types.js';
export declare function addRelationship(input: AddRelationshipInput): Relationship;
export declare function getRelationshipsFrom(code: string, relation?: string): Relationship[];
export declare function getRelationshipsTo(code: string, relation?: string): Relationship[];
export declare function getRelationships(code: string): Relationship[];
export declare function traverse(startCode: string, options?: {
    maxDepth?: number;
    relation?: string;
}): TraversalNode[];
