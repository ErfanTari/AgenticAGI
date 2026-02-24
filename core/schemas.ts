import { z } from 'zod';

export const WriteEntrySchema = z.object({
  nb: z.enum(['WHO', 'WHAT', 'WHEN', 'HOW', 'WHY', 'NOW', 'PLAN']),
  type: z.string(),
  name: z.string().min(1),
  status: z.string().default('active'),
  summary: z.string(),
  body: z.string(),
  due_date: z.string().optional(),
  relationships: z.array(z.object({
    relation: z.enum(['works_for', 'owns', 'supplies', 'blocks', 'refers']),
    to_code: z.string(),
  })).optional(),
});

export type WriteEntry = z.infer<typeof WriteEntrySchema>;

export const writeEntryJsonSchema = z.toJSONSchema(WriteEntrySchema) as Record<string, unknown>;
