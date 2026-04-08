/**
 * /cost operator — reports token usage and model costs for the session
 */

import { currentSession } from '../session/session-log.js';
import { estimateTokens } from '../context.js';

export interface CostReport {
  sessionTokensUsed: number;
  estimatedCost: number;
  modelUsed: string;
  turnCount: number;
  averageTokensPerTurn: number;
}

export function getCostReport(): CostReport {
  const session = currentSession();
  const log = session.loadLast(1000); // Load up to 1000 recent turns

  const sessionTokens = log.reduce((sum, entry) => {
    return sum + estimateTokens(entry.content || '');
  }, 0);

  const turnCount = Math.floor(log.length / 2); // user + assistant pairs
  const modelUsed = process.env.LLM_MODEL || 'local-model';

  // Simple cost estimate: assume $0.001 per 1K tokens for local models
  // Adjust if using Claude or other APIs
  const costPer1kTokens = modelUsed.includes('claude') ? 0.003 : 0.001;
  const estimatedCost = (sessionTokens / 1000) * costPer1kTokens;

  return {
    sessionTokensUsed: sessionTokens,
    estimatedCost,
    modelUsed,
    turnCount,
    averageTokensPerTurn: turnCount > 0 ? Math.round(sessionTokens / turnCount) : 0,
  };
}

export function formatCostReport(report: CostReport): string {
  const lines: string[] = [
    '📊 Cost Report',
    `Model: ${report.modelUsed}`,
    `Turns: ${report.turnCount}`,
    `Total tokens: ${report.sessionTokensUsed.toLocaleString()}`,
    `Average per turn: ${report.averageTokensPerTurn}`,
    `Estimated cost: $${report.estimatedCost.toFixed(4)}`,
  ];
  return lines.join('\n');
}
