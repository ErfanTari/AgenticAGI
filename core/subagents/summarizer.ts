import type { SubAgentProfile, SubAgentSummary, ToolCallRecord } from './types.js';

export function extractSummary(
  profile: SubAgentProfile,
  finalMessage: string,
  toolCallHistory: ToolCallRecord[],
): SubAgentSummary {
  // Look for ```json ... ``` block at end of message
  const jsonMatch = finalMessage.match(/```json\s*([\s\S]+?)\s*```\s*$/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]) as SubAgentSummary;
      if (parsed.narrative) return parsed;
    } catch { /* fall through */ }
  }

  return buildFallbackSummary(profile, finalMessage, toolCallHistory);
}

function buildFallbackSummary(
  profile: SubAgentProfile,
  finalMessage: string,
  toolCallHistory: ToolCallRecord[],
): SubAgentSummary {
  const narrative = finalMessage.slice(0, 500);

  if (profile === 'explore') {
    const files = toolCallHistory
      .filter(t => t.skill === 'file_reader')
      .map(t => ({ path: t.args.filePath ?? t.args.path ?? '', relevance: 'read during exploration' }));
    const symbols = toolCallHistory
      .filter(t => t.skill === 'grep_workspace')
      .map(t => ({ name: t.args.pattern ?? '', file: '' }));
    return { narrative, files, symbols };
  }

  if (profile === 'task') {
    const artifactsCreated = toolCallHistory
      .filter(t => t.skill === 'file_writer' || t.skill === 'generate_and_save_file')
      .map(t => t.args.filePath ?? t.args.path ?? '');
    const artifactsModified = toolCallHistory
      .filter(t => t.skill === 'patch_file')
      .map(t => t.args.filePath ?? t.args.filepath ?? '');
    return { narrative, artifactsCreated, artifactsModified, verificationStatus: 'unverified' };
  }

  // plan — no structured fallback beyond narrative
  return { narrative };
}
