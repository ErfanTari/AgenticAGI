import type { MCPSkill, SkillResult } from '../types.js';
import { registerSkill } from '../store.js';

const MAX_LOG_CHARS = 30000;

function truncate(text: string): string {
  if (text.length <= MAX_LOG_CHARS) return text;
  return text.slice(0, MAX_LOG_CHARS);
}

function extractTsErrors(logs: string): string[] {
  const matches = [...logs.matchAll(/error TS\d+:[^\n]*/g)];
  return matches.slice(0, 6).map(m => m[0]);
}

function extractTestFailures(logs: string): string[] {
  const lines = logs.split('\n');
  return lines
    .filter(line => /FAIL|AssertionError|Expected:|Received:|×\s/.test(line))
    .slice(0, 8)
    .map(line => line.trim());
}

const logAnalyzerSkill: MCPSkill = {
  name: 'log_analyzer',
  description: 'Analyze compiler/test logs and return root causes with fix suggestions.',
  inputSchema: {
    type: 'object',
    properties: {
      logs: { type: 'string', description: 'Raw compiler/test/runtime logs' },
      mode: { type: 'string', description: 'Optional mode: compiler|tests|runtime|auto' },
    },
    required: ['logs'],
  },
  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const rawLogs = String(input.logs ?? '').trim();
    if (!rawLogs) {
      return { success: false, output: '', error: 'No logs provided' };
    }

    const logs = truncate(rawLogs);
    const mode = String(input.mode ?? 'auto').toLowerCase();

    const tsErrors = extractTsErrors(logs);
    const testFailures = extractTestFailures(logs);

    const lines: string[] = ['Log analysis:'];

    if (mode === 'compiler' || mode === 'auto') {
      if (tsErrors.length > 0) {
        lines.push('- Compiler errors:');
        tsErrors.forEach(err => lines.push(`  - ${err}`));
        lines.push('- Suggested fixes: check type annotations, return types, and incompatible assignments.');
      }
    }

    if (mode === 'tests' || mode === 'auto') {
      if (testFailures.length > 0) {
        lines.push('- Test failures:');
        testFailures.forEach(err => lines.push(`  - ${err}`));
        lines.push('- Suggested fixes: align expected/received values and update failing implementation paths.');
      }
    }

    if (tsErrors.length === 0 && testFailures.length === 0) {
      lines.push('- No obvious compiler/test signatures found.');
      lines.push('- Suggested next step: inspect stack trace top frame and reproduce with minimal command.');
    }

    return { success: true, output: lines.join('\n') };
  },
};

registerSkill(logAnalyzerSkill);
export default logAnalyzerSkill;
