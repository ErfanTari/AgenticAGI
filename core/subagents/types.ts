export type SubAgentProfile = 'explore' | 'plan' | 'task';

export type SubAgentContext = {
  parentRequestId: string;
  parentEventId?: string;
  profile: SubAgentProfile;
  goal: string;
  inheritedSummary?: string;
};

export type SubAgentResult =
  | { success: true; profile: SubAgentProfile; summary: SubAgentSummary; tokensUsed: number; iterations: number }
  | { success: false; profile: SubAgentProfile; error: string; partialSummary?: SubAgentSummary };

export type SubAgentSummary = {
  // Explore
  files?: { path: string; relevance: string }[];
  symbols?: { name: string; file: string; signature?: string }[];
  patterns?: string[];
  // Plan
  milestones?: { id: string; title: string; criteria: string; dependsOn?: string[] }[];
  // Task
  artifactsCreated?: string[];
  artifactsModified?: string[];
  verificationStatus?: 'passed' | 'failed' | 'unverified';
  // All
  narrative: string;
};

export type ToolCallRecord = {
  skill: string;
  args: Record<string, string>;
};
