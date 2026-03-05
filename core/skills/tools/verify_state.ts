/**
 * P8: verify_state skill — verifies that a file, memory entry, or bash command
 * produces the expected output/state.
 */
import fs from 'node:fs';
import type { MCPSkill, SkillResult } from '../types.js';

const verifyStateSkill: MCPSkill = {
  name: 'verify_state',
  description: 'Verify that a file exists with expected content, a memory entry exists, or a bash command produces expected output.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['file_write', 'memory_write', 'run_bash'],
        description: 'Type of operation to verify',
      },
      target: {
        type: 'string',
        description: 'File path, memory code, or bash command to verify',
      },
      expected: {
        type: 'string',
        description: 'Optional: expected content or pattern to match',
      },
    },
    required: ['operation', 'target'],
  },
  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const operation = String(input.operation ?? '');
    const target = String(input.target ?? '');
    const expected = input.expected ? String(input.expected) : undefined;

    try {
      if (operation === 'file_write') {
        if (!fs.existsSync(target)) {
          return { success: false, output: '', error: `File not found: ${target}` };
        }
        if (expected) {
          const content = fs.readFileSync(target, 'utf-8');
          const matches = content.includes(expected);
          return {
            success: matches,
            output: matches ? `File verified: ${target}` : `File exists but content mismatch`,
            error: matches ? undefined : `Expected content not found in ${target}`,
          };
        }
        return { success: true, output: `File exists: ${target}` };

      } else if (operation === 'memory_write') {
        const { getEntryByCode } = await import('../../memory/index.js');
        const entry = getEntryByCode(target);
        if (!entry) {
          return { success: false, output: '', error: `Memory entry not found: ${target}` };
        }
        return { success: true, output: `Memory entry verified: ${target} (${entry.name})` };

      } else if (operation === 'run_bash') {
        const { exec } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execAsync = promisify(exec);

        const { stdout, stderr } = await execAsync(target, { timeout: 10000 });
        const output = stdout + (stderr ? `\nSTDERR: ${stderr}` : '');

        if (expected) {
          const matches = output.includes(expected);
          return {
            success: matches,
            output,
            error: matches ? undefined : `Expected output "${expected}" not found`,
          };
        }
        return { success: true, output: output.trim() || 'Command succeeded with no output' };
      }

      return { success: false, output: '', error: `Unknown operation: ${operation}` };
    } catch (err) {
      return { success: false, output: '', error: String(err) };
    }
  },
};

export default verifyStateSkill;
