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

// --- Task Plan schemas (Phase 9: Planner + Executor) ---

export const TaskStepSchema = z.object({
  id: z.string(),
  description: z.string(),
  skill: z.string(),
  input: z.record(z.string(), z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
  ])),
  dependsOn: z.array(z.string()).default([]),
  storeResultAs: z.string().nullable().optional(),
  optional: z.boolean().optional().default(false),
  confidence_score: z.number().min(0).max(1).default(0.8),
  risk_level: z.enum(['LOW', 'MED', 'HIGH']).default('LOW'),
});

export type TaskStep = z.infer<typeof TaskStepSchema>;

export const TaskGoalSchema = z.object({
  id: z.string(),
  sourceUnitIds: z.array(z.string()).default([]),
  description: z.string(),
});

export type TaskGoal = z.infer<typeof TaskGoalSchema>;

export const TaskMilestoneSchema = z.object({
  id: z.string(),
  goalIds: z.array(z.string()).default([]),
  title: z.string(),
  description: z.string(),
  completionCriteria: z.string(),
  steps: z.array(TaskStepSchema).min(1),
});

export type TaskMilestone = z.infer<typeof TaskMilestoneSchema>;

export const TaskPlanSchema = z.object({
  goal: z.string(),
  steps: z.array(TaskStepSchema).min(1).max(8),
  goals: z.array(TaskGoalSchema).default([]),
  milestones: z.array(TaskMilestoneSchema).default([]),
  complexity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'MAX', 'simple', 'complex']).default('LOW'),
  needsConfirmation: z.boolean().default(false),
  estimatedDuration: z.string().optional(),
});

export type TaskPlan = {
  goal: string;
  steps: TaskStep[];
  goals?: TaskGoal[];
  milestones?: TaskMilestone[];
  complexity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'MAX' | 'simple' | 'complex';
  needsConfirmation?: boolean;
  estimatedDuration?: string;
  createdAt: string;
};

export const taskPlanJsonSchema = z.toJSONSchema(TaskPlanSchema) as Record<string, unknown>;

// --- Verification schema ---

export const VerificationResultSchema = z.object({
  verified: z.boolean(),
  confidence: z.number().min(0).max(1),
  issues: z.array(z.string()).default([]),
  suggestion: z.string().optional(),
});

export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const verificationJsonSchema = z.toJSONSchema(VerificationResultSchema) as Record<string, unknown>;

// --- Milestone revision schema ---

export const MilestoneRevisionSchema = z.object({
  revised: z.boolean(),
  milestones: z.array(z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    completionCriteria: z.string(),
  })).optional(),
  reason: z.string().optional(),
  abort: z.boolean().optional(),
});

export type MilestoneRevision = z.infer<typeof MilestoneRevisionSchema>;

// --- Post-flight synthesis schema ---

export const PostFlightSchema = z.object({
  verification: z.object({
    verified: z.boolean(),
    confidence: z.number().min(0).max(1),
    issues: z.array(z.string()).default([]),
    suggestion: z.string().optional(),
  }),
  summary: z.string().min(10),
  reflection: z.object({
    went_well: z.string(),
    to_improve: z.string(),
    learned: z.string(),
  }),
});

export type PostFlightResult = z.infer<typeof PostFlightSchema>;
export const postFlightJsonSchema = z.toJSONSchema(PostFlightSchema) as Record<string, unknown>;
