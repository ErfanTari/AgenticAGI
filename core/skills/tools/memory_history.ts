import type { MCPSkill, SkillResult } from '../types.js';
import { getEntryHistory, rollbackEntry } from '../../memory/versioning.js';

const memoryHistorySkill: MCPSkill = {
  name: 'memory_history',
  description:
    'Get version history for a memory entry. Shows all changes made over time. Use when user asks what changed or wants to rollback a memory entry.',
  permissionLevel: 'read-only',
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Entry code like WHO.CT-000001' },
      rollback_to: { type: 'string', description: 'Optional commit hash to rollback to' },
    },
    required: ['code'],
  },
  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const code = typeof input.code === 'string' ? input.code.trim() : '';
    if (!code) {
      return { success: false, output: '', error: 'code is required' };
    }

    const rollbackTo = typeof input.rollback_to === 'string' ? input.rollback_to.trim() : undefined;

    if (rollbackTo) {
      const ok = await rollbackEntry(code, rollbackTo);
      if (ok) {
        return {
          success: true,
          output: `Rolled back ${code} to commit ${rollbackTo}`,
          display: `Rolled back ${code} to commit ${rollbackTo.slice(0, 8)}`,
        };
      }
      return { success: false, output: '', error: `Rollback failed for ${code} at ${rollbackTo}` };
    }

    const history = await getEntryHistory(code);
    if (history.length === 0) {
      return { success: true, output: `No version history found for ${code}`, display: 'No history' };
    }

    const lines = history.map(
      (h, i) => `${i + 1}. ${h.hash.slice(0, 8)} — ${h.message} (${h.date.slice(0, 10)})`,
    );
    const output = `Version history for ${code}:\n${lines.join('\n')}`;
    return { success: true, output, display: `${history.length} commits found` };
  },
};

export default memoryHistorySkill;
