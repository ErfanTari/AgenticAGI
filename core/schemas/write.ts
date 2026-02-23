import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const WriteRelationshipSchema = z.object({
  relation: z.enum(['works_for', 'owns', 'supplies', 'blocks', 'refers']),
  to_code: z.string().min(1),
});

export const WriteEntrySchema = z.object({
  nb: z.enum(['WHO', 'WHAT', 'WHEN', 'HOW', 'WHY', 'NOW', 'PLAN']),
  type: z.string().min(1),
  name: z.string().min(1),
  status: z.string().min(1),
  summary: z.string().min(1),
  body: z.string().min(1),
  due_date: z.string().optional(),
  relationships: z.array(WriteRelationshipSchema).optional(),
});

export type WriteEntryPayload = z.infer<typeof WriteEntrySchema>;
export type WriteRelationshipPayload = z.infer<typeof WriteRelationshipSchema>;

export const WriteEntryJsonSchema = zodToJsonSchema(WriteEntrySchema as any, {
  name: 'write_entry',
  target: 'jsonSchema7',
});

export const WriteRelationshipJsonSchema = zodToJsonSchema(WriteRelationshipSchema as any, {
  name: 'write_relationship',
  target: 'jsonSchema7',
});
