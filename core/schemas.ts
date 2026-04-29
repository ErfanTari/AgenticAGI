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

export const MAX_TASK_PLAN_STEPS = 30;

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
  steps: z.array(TaskStepSchema).min(1).max(MAX_TASK_PLAN_STEPS),
  goals: z.array(TaskGoalSchema).default([]),
  milestones: z.array(TaskMilestoneSchema).default([]),
  complexity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'MAX', 'simple', 'complex']).default('LOW'),
  needsConfirmation: z.boolean().default(false),
  estimatedDuration: z.string().optional(),
  createdAt: z.string(),
});

export type TaskPlan = z.infer<typeof TaskPlanSchema>;

const baseTaskPlanJsonSchema = z.toJSONSchema(TaskPlanSchema) as Record<string, unknown>;

function stripDefaultedStepFieldsFromTransportSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(schema)) as Record<string, any>;
  const defaultedStepFields = new Set(['confidence_score', 'risk_level']);

  const stripRequired = (node: Record<string, any> | undefined): void => {
    if (!node || !Array.isArray(node.required)) return;
    node.required = node.required.filter((field: unknown) =>
      typeof field !== 'string' || !defaultedStepFields.has(field)
    );
  };

  stripRequired(clone.properties?.steps?.items);
  stripRequired(clone.properties?.milestones?.items?.properties?.steps?.items);

  return clone;
}

export const taskPlanJsonSchema = stripDefaultedStepFieldsFromTransportSchema(baseTaskPlanJsonSchema);

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

// FIX 1: JSON schema for milestone revision (engine-level enforcement)
export const milestoneRevisionJsonSchema = z.toJSONSchema(MilestoneRevisionSchema) as Record<string, unknown>;

// FIX 1: Intake classification schema
export const IntakeClassificationSchema = z.object({
  summary: z.string(),
  person: z.object({
    name: z.string(),
    confidence: z.number().min(0).max(1),
  }).nullable(),
  project: z.object({
    name: z.string(),
    confidence: z.number().min(0).max(1),
  }).nullable(),
  time: z.object({
    description: z.string(),
  }).nullable(),
  agentic: z.boolean(),
  procedure: z.boolean(),
  query: z.boolean(),
});

export type IntakeClassification = z.infer<typeof IntakeClassificationSchema>;
export const intakeJsonSchema = z.toJSONSchema(IntakeClassificationSchema) as Record<string, unknown>;

// FIX 1: Plan assertions schema
export const PlanAssertionSchema = z.object({
  passed: z.boolean(),
  failedAssertions: z.array(z.string()).default([]),
  rewritePrompt: z.string().optional(),
});

export type PlanAssertion = z.infer<typeof PlanAssertionSchema>;
export const planAssertionJsonSchema = z.toJSONSchema(PlanAssertionSchema) as Record<string, unknown>;

// FIX 3: Plan referential integrity validation
export interface PlanIntegrityResult {
  valid: boolean;
  orphanedSteps: string[];     // in root steps but not in any milestone
  missingSteps: string[];      // referenced in milestones but not in root steps
  brokenDependencies: string[]; // dependsOn references that don't exist
}

/**
 * FIX 3: Validates that every step in the plan is properly referenced:
 * - Every step in root `steps` array must appear in exactly ONE milestone's `steps` array
 * - Every step referenced in a milestone must exist in root `steps` array
 * - Every `dependsOn` reference must point to a step that exists in root `steps` array
 *
 * Note: milestone.steps is an array of TaskStep objects, not step IDs.
 * We need to extract the IDs from them.
 */
export function validatePlanIntegrity(plan: TaskPlan): PlanIntegrityResult {
  const rootStepIds = new Set(plan.steps.map(s => s.id));

  // Collect all step IDs referenced inside milestones
  const milestoneStepIds = new Set<string>();
  if (plan.milestones && Array.isArray(plan.milestones)) {
    for (const milestone of plan.milestones) {
      if (milestone.steps && Array.isArray(milestone.steps)) {
        for (const step of milestone.steps) {
          // milestone.steps contains TaskStep objects, extract the id
          if (typeof step === 'object' && step !== null && 'id' in step) {
            milestoneStepIds.add((step as any).id);
          }
        }
      }
    }
  }

  // Orphaned: in root but not in any milestone
  const orphanedSteps = [...rootStepIds].filter(id => !milestoneStepIds.has(id));

  // Missing: referenced in milestone but not in root
  const missingSteps = [...milestoneStepIds].filter(id => !rootStepIds.has(id));

  // Broken dependencies: step.dependsOn references a step that doesn't exist
  const brokenDependencies: string[] = [];
  for (const step of plan.steps) {
    if (step.dependsOn && Array.isArray(step.dependsOn)) {
      for (const dep of step.dependsOn) {
        if (typeof dep === 'string' && !rootStepIds.has(dep)) {
          brokenDependencies.push(`${step.id} → ${dep}`);
        }
      }
    }
  }

  return {
    valid: orphanedSteps.length === 0 && missingSteps.length === 0 && brokenDependencies.length === 0,
    orphanedSteps,
    missingSteps,
    brokenDependencies,
  };
}

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

// ── Phase 24: Web Download Multi-Target Spec ─────────────────────────────────

export const webDownloadSpecSchema = z.object({
  kind: z.literal('web_download_multi_target'),
  targets: z.array(z.string().min(1)).min(1),
  artifact: z.string().min(3),
  minBytes: z.number().int().min(0).default(200_000),
  destDir: z.string().min(1),
  filenameTemplate: z.string().min(1),
});

export type WebDownloadSpec = z.infer<typeof webDownloadSpecSchema>;

