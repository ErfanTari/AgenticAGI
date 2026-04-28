import type { MCPSkill, SkillResult } from '../types.js';
import { createEntry, updateEntry } from '../../memory/mod.js';
import { queryEntries } from '../../memory/index.js';
import { isMemoryFullyDisabled } from '../../memory-mode.js';

const MEMORY_DISABLED_REPLY = 'Memory is disabled. task_tracker requires memory to persist tasks.';

const taskTrackerSkill: MCPSkill = {
  name: 'task_tracker',
  description: 'Track ongoing tasks persisted in NOW.TD. Operations: add (create task), list (show tasks, optionally filter by status), update (change task status). Status values: pending | in_progress | done.',
  permissionLevel: 'workspace-write',

  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['add', 'list', 'update'],
        description: 'Operation to perform',
      },
      title: {
        type: 'string',
        description: '(add) Task title',
      },
      description: {
        type: 'string',
        description: '(add) Optional task description',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'done'],
        description: '(list) Filter by status; (update) new status',
      },
      code: {
        type: 'string',
        description: '(update) Task code, e.g. NOW.TD-000001',
      },
    },
    required: ['operation'],
  },

  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    if (isMemoryFullyDisabled()) {
      return { success: false, output: '', error: MEMORY_DISABLED_REPLY };
    }

    const operation = String(input.operation ?? '');

    if (operation === 'add') {
      const title = String(input.title ?? '').trim();
      if (!title) {
        return { success: false, output: '', error: 'title is required for add operation' };
      }
      const description = typeof input.description === 'string' ? input.description : '';
      const entry = createEntry({
        nb: 'NOW',
        type: 'TD',
        name: title,
        status: 'pending',
        summary: title,
        body: description || `## Task\n${title}`,
      });
      return {
        success: true,
        output: `Task created: ${entry.code} — ${title}`,
      };
    }

    if (operation === 'list') {
      const statusFilter = typeof input.status === 'string' ? input.status : undefined;
      const filter: { nb: string; type: string; status?: string } = { nb: 'NOW', type: 'TD' };
      if (statusFilter) filter.status = statusFilter;
      const entries = queryEntries(filter);
      if (entries.length === 0) {
        return { success: true, output: `No tasks found${statusFilter ? ` with status '${statusFilter}'` : ''}.` };
      }
      const lines = entries.map(e => `${e.code} [${e.status}] ${e.name}`);
      return { success: true, output: lines.join('\n') };
    }

    if (operation === 'update') {
      const code = String(input.code ?? '').trim();
      if (!code.match(/^NOW\.TD-\d+$/)) {
        return { success: false, output: '', error: `Invalid task code: '${code}'. Expected format: NOW.TD-000001` };
      }
      const newStatus = String(input.status ?? '').trim();
      if (!['pending', 'in_progress', 'done'].includes(newStatus)) {
        return { success: false, output: '', error: `Invalid status '${newStatus}'. Must be: pending | in_progress | done` };
      }
      try {
        updateEntry(code, { status: newStatus });
        return { success: true, output: `Task ${code} updated to status '${newStatus}'` };
      } catch (err) {
        return { success: false, output: '', error: `Task ${code} not found or update failed: ${String(err)}` };
      }
    }

    return { success: false, output: '', error: `Unknown operation '${operation}'. Valid: add | list | update` };
  },
};

export default taskTrackerSkill;
