import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import type { MCPSkill, SkillResult } from '../types.js';

// ─── Security: Blocked patterns (hardcoded — cannot be overridden by LLM or planner) ───

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive.*--force|--force.*--recursive)/i, reason: 'recursive force delete' },
  { pattern: /rm\s+-rf/i, reason: 'recursive force delete' },
  { pattern: /rm\s+-fr/i, reason: 'recursive force delete' },
  { pattern: /:\(\)\s*\{.*:\s*\|.*:.*\}/s, reason: 'fork bomb' },
  { pattern: /mkfs[\s\/]/i, reason: 'filesystem format' },
  { pattern: /dd\s+if=/i, reason: 'raw disk operation' },
  { pattern: />\s*\/dev\/(sd[a-z]|hd[a-z]|disk)/i, reason: 'device overwrite' },
  { pattern: /chmod\s+777/i, reason: 'chmod 777 — unsafe permission change' },
  { pattern: /chmod\s+-R\s+777\s+\//i, reason: 'recursive root permission change' },
  { pattern: /\bsudo\b/i, reason: 'sudo — privilege escalation not allowed' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: 'system power command' },
  { pattern: /kill\s+-9\s+1\b/i, reason: 'kill init process' },
  { pattern: /curl\s+[^\|]*\|\s*(bash|sh|zsh|fish)/i, reason: 'pipe URL to shell' },
  { pattern: /wget\s+[^\|]*\|\s*(bash|sh|zsh|fish)/i, reason: 'pipe URL to shell' },
  { pattern: /\|\s*(bash|sh|zsh|fish)\s*$/im, reason: 'pipe to shell' },
  { pattern: /eval\s+\$\(/i, reason: 'eval subshell' },
  { pattern: /\$\(curl\s/i, reason: 'curl subshell' },
  { pattern: /`curl\s/i, reason: 'curl backtick subshell' },
  // Multi-line bypass prevention
  { pattern: /rm[\s\S]*-[\s\S]*r[\s\S]*f/i, reason: 'recursive delete (multiline attempt)' },
];

const REQUIRES_CONFIRMATION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(?!-[a-z]*r)/i, reason: 'file deletion' },
  { pattern: /\brmdir\b/i, reason: 'directory removal' },
  { pattern: /\btruncate\s/i, reason: 'file truncation' },
  { pattern: /git\s+(reset\s+--hard|clean\s+-f|push\s+.*--force)/i, reason: 'destructive git operation' },
  { pattern: /DROP\s+TABLE/i, reason: 'SQL table drop' },
  { pattern: /DELETE\s+FROM/i, reason: 'SQL bulk delete' },
  { pattern: /npm\s+(uninstall|remove)\s/i, reason: 'package removal' },
  { pattern: /pip\s+uninstall\s/i, reason: 'package removal' },
];

interface AuditResult {
  blocked: boolean;
  requiresConfirmation: boolean;
  reason?: string;
}

export function auditCommand(command: string): AuditResult {
  // Check each line AND the full command to prevent newline bypass
  const lines = command.split('\n');
  const targets = [command, ...lines];

  for (const target of targets) {
    for (const { pattern, reason } of BLOCKED_PATTERNS) {
      if (pattern.test(target)) {
        return { blocked: true, requiresConfirmation: false, reason };
      }
    }
  }

  for (const target of targets) {
    for (const { pattern, reason } of REQUIRES_CONFIRMATION_PATTERNS) {
      if (pattern.test(target)) {
        return { blocked: false, requiresConfirmation: true, reason };
      }
    }
  }

  return { blocked: false, requiresConfirmation: false };
}

// ─── Security: Workspace scope enforcement ───────────────────────────────────

const TRAVERSAL_PATTERNS = [
  /\.\.[\/\\]/,       // ../
  /~\//,              // home dir reference
  /\$HOME\b/,         // $HOME variable
  /\/etc\//i,         // system config
  /\/usr\//i,         // system binaries
  /\/var\//i,         // system var
  /\/tmp\/.*\.\./,    // tmp traversal
];

export function checkWorkspaceScope(command: string): boolean {
  return !TRAVERSAL_PATTERNS.some(p => p.test(command));
}

// ─── Command normalizers ─────────────────────────────────────────────────────

function normalizeWorkspacePathsInCommand(command: string): string {
  return command
    .replace(/^(?:cd\s+(?:\.\/)?workspace\s*&&\s*)+/i, '')
    .replace(/(^|[\s"'`])(?:\.\/)?workspace\//g, '$1')
    .replace(/\/workspace\//g, '');
}

function normalizeWorkspaceCwd(cwd: string): string {
  const normalized = cwd
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/^workspace\/?/, '');

  if (!normalized || normalized === '.') return '';
  return normalized;
}

/**
 * run_bash skill
 *
 * Runs bash commands inside the workspace directory.
 * Security: Path jailed to workspace/, dangerous commands blocked, 30s timeout.
 * Audit: Hardcoded blocklist that cannot be overridden by LLM or planner.
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
    const rawCommand = input.command as string;
    const command = typeof rawCommand === 'string'
      ? normalizeWorkspacePathsInCommand(rawCommand)
      : '';
    const rawCwd = input.cwd as string | undefined;
    const cwd = typeof rawCwd === 'string' ? normalizeWorkspaceCwd(rawCwd) : undefined;
    const timeoutMs = Math.min(parseInt(String(input.timeout || '30000')), 60000);

    if (!rawCommand || typeof rawCommand !== 'string' || !command.trim()) {
      return {
        success: false,
        output: '',
        error: 'Invalid input: command must be a non-empty string',
      };
    }

    // ── Hardcoded security audit — cannot be bypassed ──────────────────────
    const audit = auditCommand(command);

    if (audit.blocked) {
      const cmd100 = String(input.command).slice(0, 100);
      return {
        success: false,
        output: `Command not allowed: blocked — ${audit.reason}\nCommand: ${cmd100}\nThis restriction is hardcoded and cannot be overridden.`,
        error: `Command not allowed: blocked — ${audit.reason}\nCommand: ${cmd100}`,
      };
    }

    const isAutonomous = (input._context as string) === 'autonomous';
    if (audit.requiresConfirmation && isAutonomous) {
      return {
        success: false,
        output: `CONFIRMATION_REQUIRED: "${command}" requires explicit user approval before execution in autonomous mode. Reason: ${audit.reason}.`,
        error: `Confirmation required: ${audit.reason}`,
      };
    }

    // ── Workspace scope enforcement ────────────────────────────────────────
    if (!checkWorkspaceScope(command)) {
      const WORKSPACE = process.env.WORKSPACE_PATH ?? path.join(process.cwd(), 'workspace');
      return {
        success: false,
        output: `BLOCKED: Command references paths outside the workspace. All file operations must stay within: ${WORKSPACE}`,
        error: 'Path traversal blocked',
      };
    }

    try {
      const WORKSPACE_ROOT = path.resolve(process.cwd(), 'workspace');
      if (!fs.existsSync(WORKSPACE_ROOT)) {
        fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
      }

      let resolvedCwd = WORKSPACE_ROOT;
      if (cwd) {
        resolvedCwd = path.resolve(WORKSPACE_ROOT, cwd);
        if (!resolvedCwd.startsWith(WORKSPACE_ROOT)) {
          return {
            success: false,
            output: '',
            error: 'Access denied: cwd outside workspace',
          };
        }
        if (!fs.existsSync(resolvedCwd)) {
          return {
            success: false,
            output: '',
            error: `Directory does not exist: ${cwd}`,
          };
        }
      }

      const result = await executeCommand(command, resolvedCwd, timeoutMs);

      if (result.timedOut) {
        return {
          success: false,
          output: '',
          error: `Command timed out after ${timeoutMs}ms`,
        };
      }

      const MAX_OUTPUT = 10000;
      let output = result.stdout + (result.stderr ? '\n' + result.stderr : '');
      if (output.length > MAX_OUTPUT) {
        output = output.slice(0, MAX_OUTPUT) + '\n\n[Output truncated at 10000 chars]';
      }

      if (result.exitCode !== 0) {
        return {
          success: false,
          output,
          error: result.stderr || `Command exited with code ${result.exitCode}`,
        };
      }

      return { success: true, output };
    } catch (err) {
      return {
        success: false,
        output: '',
        error: `Command execution failed: ${String(err)}`,
      };
    }
  },
};

/**
 * Execute a shell command with timeout.
 * Uses detached process group so timeout kills the entire process tree.
 */
function executeCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    // H1: detached=true creates a new process group — allows killing the full tree
    const child = spawn('bash', ['-c', command], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout?.on('data', (data) => { stdout += data.toString(); });
    child.stderr?.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 0,
        timedOut,
      });
    });

    child.on('error', (err) => {
      if (err.message.includes('ETIMEDOUT')) timedOut = true;
      clearTimeout(timer);
      resolve({
        stdout: stdout.trim(),
        stderr: err.message,
        exitCode: 1,
        timedOut,
      });
    });

    // H1: Kill entire process group on timeout
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL'); // negative PID = kill entire group
        }
      } catch {
        child.kill('SIGKILL'); // fallback if process group kill fails
      }
    }, timeoutMs);
  });
}
