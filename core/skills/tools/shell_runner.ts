import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { MCPSkill, SkillResult } from '../types.js';
import { registerSkill } from '../store.js';

const exec = promisify(execCb);

const MAX_OUTPUT_CHARS = 12000;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 300000;

const ALLOWED_EXACT_COMMANDS = new Set([
  'pnpm test',
  'pnpm build',
  'pnpm --version',
  'npm test',
  'npm run test',
  'npm run build',
  'npx vitest run',
  'npx tsc --noEmit',
]);

const ALLOWED_COMMAND_PATTERNS = [
  /^mkdir\s+-p\s+[\w./-]+$/i,
  /^python3\s+[\w./-]+$/i,
  /^node\s+[\w./-]+$/i,
  /^chmod\s+\+x\s+[\w./-]+$/i,
];

function trimOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + '\n\n[output truncated]';
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function isAllowedCommand(command: string): boolean {
  const segments = command.split('&&').map(s => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every(segment => {
    if (ALLOWED_EXACT_COMMANDS.has(segment)) return true;
    return ALLOWED_COMMAND_PATTERNS.some(pattern => pattern.test(segment));
  });
}

const shellRunnerSkill: MCPSkill = {
  name: 'shell_runner',
  description: 'Run safe project commands (build/test/compiler). Use for run tests, build, compile, fix loops.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Allowed command to run (e.g. pnpm test, pnpm build)' },
      cwd: { type: 'string', description: 'Optional working directory (defaults to current project root)' },
      timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds (max 300000)' },
    },
    required: ['command'],
  },
  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const rawCommand = String(input.command ?? '');
    const command = normalizeCommand(rawCommand);
    const cwd = String(input.cwd ?? process.cwd()).trim() || process.cwd();
    const resolvedCwd = path.resolve(cwd);
    const timeoutRaw = Number(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const timeoutMs = Math.max(1000, Math.min(MAX_TIMEOUT_MS, timeoutRaw));

    if (!command) {
      return { success: false, output: '', error: 'No command provided' };
    }

    if (!isAllowedCommand(command)) {
      return {
        success: false,
        output: '',
        error: `Command not allowed: '${command}'. Allowed: ${Array.from(ALLOWED_EXACT_COMMANDS).join(', ')}, mkdir -p <path>, python3 <path>, node <path>, chmod +x <path>`,
      };
    }

    try {
      const { stdout, stderr } = await exec(command, {
        cwd: resolvedCwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });

      const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
      return {
        success: true,
        output: trimOutput(combined || `${command} completed with no output`),
      };
    } catch (error) {
      const e = error as {
        stdout?: string;
        stderr?: string;
        message?: string;
        code?: number | string;
      };
      const combined = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim();
      return {
        success: false,
        output: trimOutput(combined),
        error: `Command failed: ${command}${e.code !== undefined ? ` (code ${e.code})` : ''}`,
      };
    }
  },
};

registerSkill(shellRunnerSkill);
export default shellRunnerSkill;
