import type { MCPSkill, SkillResult } from '../types.js';
import { upsertEntryWithRetry } from '../../memory/write.js';
import { memoryAgent } from '../../memory/memory-agent.js';

/**
 * memory_write skill
 *
 * Creates new memory entries in the structured notebook system.
 * Use this inside multi-step plans when the planner needs to write to memory.
 * Supports all notebook types (WHO, WHAT, WHEN, HOW, WHY, NOW, PLAN).
 */
export const memoryWriteMCPSkill: MCPSkill = {
  name: 'memory_write',
  description: 'Create a new memory entry in the notebook system. Use for saving projects, contacts, todos, events, knowledge entries, procedures, and more.',
  permissionLevel: 'workspace-write',
  inputSchema: {
    type: 'object',
    properties: {
      nb: {
        type: 'string',
        description: 'Notebook: WHO | WHAT | WHEN | HOW | WHY | NOW | PLAN',
      },
      type: {
        type: 'string',
        description: 'Type code: CT|ORG (WHO), PJ|KN (WHAT), CA|DL (WHEN), PR (HOW), MT|QU (WHY), TD|RP (NOW), PL (PLAN)',
      },
      name: {
        type: 'string',
        description: 'Human-readable name for the entry (e.g. "PersianPoetry", "Research APIs todo")',
      },
      summary: {
        type: 'string',
        description: 'One-line summary visible in the index',
      },
      body: {
        type: 'string',
        description: 'Full markdown content for the entry body',
      },
      status: {
        type: 'string',
        description: 'Entry status: active | open | upcoming | closed | archived (default: active)',
      },
    },
    required: ['nb', 'type', 'name'],
  },

  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    // Normalize input — models sometimes send alternate field names
    let nb = (input.nb as string)?.toUpperCase?.();
    let type = (input.type as string)?.toUpperCase?.();
    let name = input.name as string;

    // Handle "code": "WHAT.PJ-NEW" or "entry_type": "WHAT.PJ" format
    const codeStr = (input.code as string) ?? (input.entry_type as string) ?? '';
    if ((!nb || !type) && codeStr) {
      const m = codeStr.match(/^([A-Z]+)\.([A-Z]+)/i);
      if (m) {
        nb = nb ?? m[1].toUpperCase();
        type = type ?? m[2].toUpperCase();
      }
    }

    // Infer name from "content" if name not given
    if (!name) {
      const content = (input.content as string) ?? '';
      name = content.slice(0, 60).replace(/\s+/g, ' ').trim();
    }

    const summary = (input.summary as string) ?? (input.content as string)?.slice(0, 100) ?? name;
    const body = (input.body as string) ?? (input.content as string) ?? '';
    const status = (input.status as string) ?? 'active';

    if (!nb || !type || !name) {
      return {
        success: false,
        output: '',
        error: 'Invalid input: nb, type, and name are required (or provide code/entry_type with content)',
      };
    }

    // Validate notebook
    const validNBs = ['WHO', 'WHAT', 'WHEN', 'HOW', 'WHY', 'NOW', 'PLAN'];
    if (!validNBs.includes(nb)) {
      return {
        success: false,
        output: '',
        error: `Invalid notebook '${nb}'. Must be one of: ${validNBs.join(', ')}`,
      };
    }

    try {
      const result = await upsertEntryWithRetry({ nb, type, name, summary, body, status });
      const verb = result.created ? 'Created' : 'Updated';
      const suffix = result.created ? '' : ' (already existed)';
      // FIX-C3: enqueue new_code so session cache is updated
      memoryAgent.enqueue({
        type: 'new_code',
        code: result.code,
        workingMemoryId: null,
      });
      // output is the bare code so downstream steps can use {{step_result}} as a valid code
      // The human-readable message is available via the display field
      return {
        success: true,
        output: result.code,
        display: `${verb} ${result.code}: ${name}${suffix}`,
      };
    } catch (err) {
      return {
        success: false,
        output: '',
        error: `Failed to create memory entry: ${String(err)}`,
      };
    }
  },
};
