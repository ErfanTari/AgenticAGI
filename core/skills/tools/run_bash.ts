import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import type { MCPSkill, SkillResult } from '../types.js';

/**
 * run_bash skill
 *
 * Runs bash commands inside the workspace directory.
 * Security: Path jailed to workspace/, dangerous commands blocked, 30s timeout.
 */
export const runBash: MCPSkill = {
  name: 'run_bash',
  description: 'Run a bash command inside the workspace directory. Use for git, npm, file ops, build steps, deployment commands.',

  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Bash command to run (e.g., "npm install" or "git status")',
      },
      cwd: {
        type: 'string',
        description: 'Optional subdirectory inside workspace/ to run command in',
      },
      timeout: {
        type: 'string',
        description: 'Optional timeout in milliseconds (default: 30000, max: 60000)',
      },
    },
    required: ['command'],
  },

  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const command = input.command as string;
    const cwd = input.cwd as string | undefined;
    const timeoutMs = Math.min(parseInt(String(input.timeout || '30000')), 60000);

    if (!command || typeof command !== 'string') {
      return {
        success: false,
        output: "",
        error: 'Invalid input: command must be a non-empty string',
      };
    }

    // Blocked dangerous commands (case-insensitive)
    const blockedPatterns = [
      'rm -rf /',
      'rm -rf ~',
      'sudo',
      'chmod 777',
      '> /etc',
      'dd if=',
      'mkfs',
      ':(){',  // fork bomb
      '> /dev',
      'rm -rf *',  // too dangerous even in workspace
    ];

    const commandLower = command.toLowerCase();
    for (const pattern of blockedPatterns) {
      if (commandLower.includes(pattern.toLowerCase())) {
        return {
          success: false,
        output: "",
          error: `Command not allowed: contains blocked pattern "${pattern}"`,
        };
      }
    }

    try {
      // Workspace root (create if missing)
      const WORKSPACE_ROOT = path.resolve(process.cwd(), 'workspace');
      if (!fs.existsSync(WORKSPACE_ROOT)) {
        fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
      }

      // Resolve working directory
      let resolvedCwd = WORKSPACE_ROOT;
      if (cwd) {
        resolvedCwd = path.resolve(WORKSPACE_ROOT, cwd);
        if (!resolvedCwd.startsWith(WORKSPACE_ROOT)) {
          return {
            success: false,
        output: "",
            error: 'Access denied: cwd outside workspace',
          };
        }
        if (!fs.existsSync(resolvedCwd)) {
          return {
            success: false,
        output: "",
            error: `Directory does not exist: ${cwd}`,
          };
        }
      }

      // Execute command with timeout
      const result = await executeCommand(command, resolvedCwd, timeoutMs);

      if (result.timedOut) {
        return {
          success: false,
        output: "",
          error: `Command timed out after ${timeoutMs}ms`,
        };
      }

      // Truncate output at 10000 chars
      const MAX_OUTPUT = 10000;
      let output = result.stdout + (result.stderr ? '\n' + result.stderr : '');
      if (output.length > MAX_OUTPUT) {
        output = output.slice(0, MAX_OUTPUT) + '\n\n[Output truncated at 10000 chars]';
      }

      if (result.exitCode !== 0) {
        return {
          success: false,
          output: output,
          error: result.stderr || `Command exited with code ${result.exitCode}`,
        };
      }

      return {
        success: true,
        output,
      };
    } catch (err) {
      return {
        success: false,
        output: "",
        error: `Command execution failed: ${String(err)}`,
      };
    }
  },
};

/**
 * Execute a shell command with timeout
 */
function executeCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 0,
        timedOut,
      });
    });

    child.on('error', (err) => {
      if (err.message.includes('ETIMEDOUT')) {
        timedOut = true;
      }
      resolve({
        stdout: stdout.trim(),
        stderr: err.message,
        exitCode: 1,
        timedOut,
      });
    });

    // Manual timeout handler
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000); // Force kill after 1s
    }, timeoutMs);

    child.on('close', () => clearTimeout(timer));
  });
}
