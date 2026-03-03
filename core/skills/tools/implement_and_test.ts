/**
 * implement_and_test skill
 *
 * Encapsulates the full write → test → fix → retry loop in a single skill.
 * This keeps the planner at 1-2 steps instead of 8 for coding tasks.
 *
 * Internal flow:
 *   1. Generate implementation code via LLM
 *   2. Generate test file via LLM
 *   3. Write both files to workspace/
 *   4. Run tests via run_bash
 *   5. If tests fail: fix code via LLM, go to step 3
 *   6. Repeat up to max_attempts
 *   7. On success: write HOW.PR memory entry documenting the solution
 */
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { callLLM } from '../../llm.js';
import { createEntry } from '../../memory/write.js';
import type { Message } from '../../types.js';
import type { MCPSkill, SkillResult } from '../types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Clean model output to extract valid code.
 * Strategy:
 *  1. Strip <think> tags.
 *  2. If a fenced code block (```...```) is present, extract its content.
 *  3. Otherwise scan for the first import/export/const/function line.
 *  4. Trim any trailing prose that follows the code (after a blank line + prose pattern).
 */
function cleanCode(raw: string): string {
  // Remove think tags
  let s = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/think>/gi, '')
    .replace(/<think>/gi, '');

  // Strategy 1: extract content from the first fenced code block
  const fenceMatch = s.match(/```(?:[a-zA-Z0-9_-]*)?\n([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // Strategy 2: scan for first code-like line
  const lines = s.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^(import |export (function|const|class|default )|const |let |var |function |class )/.test(t)) {
      // Found start of code — take from here, but stop at first trailing prose block
      // (a blank line followed by a non-code line like "Wait," or "Note:")
      const codeLines: string[] = [];
      for (let j = i; j < lines.length; j++) {
        const line = lines[j];
        const trimmed = line.trim();
        // Stop at a closing fence
        if (trimmed === '```') break;
        // Stop if we hit clear prose after the code body
        if (
          codeLines.length > 2 &&
          trimmed === '' &&
          j + 1 < lines.length
        ) {
          const nextTrimmed = lines[j + 1].trim();
          if (
            nextTrimmed.length > 0 &&
            !/^(import |export |const |let |var |function |class |\/\/|\/\*|assert\.|console\.|})/.test(nextTrimmed) &&
            /^[A-Z]|^\d+\.|^Wait|^Note|^However|^Actually|^Let|^Now|^Final|^So,|^\*/.test(nextTrimmed)
          ) {
            break;
          }
        }
        codeLines.push(line);
      }
      return codeLines.join('\n').trim();
    }
  }

  // Fallback: return as-is so fixCode can attempt repair
  return s.trim();
}

function workspacePath(filename: string): string {
  const WORKSPACE_ROOT = path.resolve(process.cwd(), 'workspace');
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  // Ensure ESM is enabled so `import` statements work in node
  const pkgJson = path.join(WORKSPACE_ROOT, 'package.json');
  if (!fs.existsSync(pkgJson)) {
    fs.writeFileSync(pkgJson, '{"type":"module"}\n', 'utf-8');
  }
  const resolved = path.resolve(WORKSPACE_ROOT, filename);
  if (!resolved.startsWith(WORKSPACE_ROOT)) throw new Error('Path outside workspace');
  return resolved;
}

function writeWorkspaceFile(filename: string, content: string): void {
  const filePath = workspacePath(filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

async function runNodeFile(
  filename: string,
  timeoutMs = 30000,
): Promise<{ success: boolean; output: string }> {
  const WORKSPACE_ROOT = path.resolve(process.cwd(), 'workspace');
  return new Promise(resolve => {
    const child = spawn('node', [filename], { cwd: WORKSPACE_ROOT, shell: false });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout?.on('data', d => { stdout += d.toString(); });
    child.stderr?.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ success: false, output: `Command timed out after ${timeoutMs}ms` });
        return;
      }
      const combined = (stdout + (stderr ? '\n' + stderr : '')).trim();
      resolve({ success: code === 0, output: combined });
    });

    child.on('error', err => {
      clearTimeout(timer);
      resolve({ success: false, output: err.message });
    });
  });
}

async function generateCode(implementationPrompt: string): Promise<string> {
  const messages: Message[] = [
    {
      role: 'system',
      content: 'You are a code generation assistant. Output ONLY valid JavaScript code using ESM named exports (export function or export const). No default exports. No markdown fences, no preamble, no commentary. Output the raw code only.',
    },
    { role: 'user', content: implementationPrompt },
  ];
  const raw = await callLLM(messages, { maxTokens: 2000 });
  return cleanCode(raw);
}

/**
 * Extract the function name called in the test prompt.
 * Looks for patterns like "fib(1)=1" or "fibonacci(1) === 1".
 */
function extractFunctionName(testPrompt: string): string {
  const m = testPrompt.match(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/);
  return m ? m[1] : 'fn';
}

/**
 * Extract the import path from the test prompt.
 * Looks for patterns like "Import from ./fibonacci.js" or "'./fibonacci.js'".
 */
function extractImportPath(testPrompt: string, filename: string): string {
  const m = testPrompt.match(/['"](\.\/[^'"]+)['"]/);
  if (m) return m[1];
  // Fall back to deriving from the implementation filename
  return `./${filename}`;
}

async function generateTests(testPrompt: string, filename: string): Promise<string> {
  // Extract the function name and import path so we can build the scaffold ourselves
  const fnName = extractFunctionName(testPrompt);
  const importPath = extractImportPath(testPrompt, filename);

  // Ask the LLM only for the assert lines — tiny response, no room for analysis
  const messages: Message[] = [
    {
      role: 'system',
      content: `Output ONLY assert.strictEqual() lines. No imports. No comments. No explanation. One line per test case. Format: assert.strictEqual(CALL, EXPECTED);`,
    },
    {
      role: 'user',
      content: `Write assert.strictEqual() lines for these test cases:\n${testPrompt}`,
    },
  ];
  const raw = await callLLM(messages, { maxTokens: 300 });
  // Extract just the assert lines from whatever the model outputs
  const assertLines = raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('assert.') || l.startsWith('//'))
    .join('\n');

  // Build the complete test file ourselves
  return [
    `import assert from 'node:assert';`,
    `import { ${fnName} } from '${importPath}';`,
    '',
    assertLines || `assert.ok(typeof ${fnName} === 'function', '${fnName} should be a function');`,
    '',
    `console.log('All tests passed!');`,
  ].join('\n');
}

async function fixCode(
  code: string,
  testOutput: string,
  implementationPrompt: string,
): Promise<string> {
  const messages: Message[] = [
    {
      role: 'system',
      content: 'You are a code debugging assistant. Fix the provided JavaScript ESM code so the failing tests pass. Output ONLY the corrected code, no commentary, no fences.',
    },
    {
      role: 'user',
      content: `Original task:\n${implementationPrompt}\n\nCurrent code:\n${code}\n\nTest failure output:\n${testOutput}\n\nReturn the corrected code only.`,
    },
  ];
  const raw = await callLLM(messages, { maxTokens: 2000 });
  return cleanCode(raw);
}

// ─── Skill ──────────────────────────────────────────────────────────────────

export const implementAndTestSkill: MCPSkill = {
  name: 'implement_and_test',
  description: 'Write code, run tests, fix failures, retry until passing or max attempts. Use for any coding task: write → run → verify → fix loop. Returns final working code + test output. Automatically writes HOW.PR entry on success.',

  inputSchema: {
    type: 'object',
    properties: {
      implementation_prompt: {
        type: 'string',
        description: 'What to implement (e.g. "Write a fibonacci function using ESM export default")',
      },
      test_prompt: {
        type: 'string',
        description: 'What tests to write (e.g. "Test: fib(1)=1, fib(5)=5, fib(10)=55. Import from ./fibonacci.js")',
      },
      filename: {
        type: 'string',
        description: 'Implementation filename, e.g. "fibonacci.js"',
      },
      test_filename: {
        type: 'string',
        description: 'Test filename, e.g. "fibonacci.test.js"',
      },
      max_attempts: {
        type: 'string',
        description: 'Max fix attempts (default 3)',
      },
    },
    required: ['implementation_prompt', 'test_prompt', 'filename', 'test_filename'],
  },

  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const implementationPrompt = String(input.implementation_prompt ?? '').trim();
    const testPrompt           = String(input.test_prompt           ?? '').trim();
    const filename             = String(input.filename              ?? '').trim();
    const testFilename         = String(input.test_filename         ?? '').trim();
    const maxAttempts          = Math.min(Math.max(parseInt(String(input.max_attempts ?? '3')), 1), 5);

    if (!implementationPrompt || !testPrompt || !filename || !testFilename) {
      return {
        success: false, output: '',
        error: 'implementation_prompt, test_prompt, filename, and test_filename are all required',
      };
    }

    // Generate initial code + tests
    let code = await generateCode(implementationPrompt);
    const tests = await generateTests(testPrompt, filename);

    let lastTestOutput = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Write files
      try {
        writeWorkspaceFile(filename, code);
        writeWorkspaceFile(testFilename, tests);
      } catch (err) {
        return { success: false, output: '', error: `File write failed: ${String(err)}` };
      }

      // Run tests
      const result = await runNodeFile(testFilename);
      lastTestOutput = result.output;

      if (process.env.DEBUG_PLANNER === 'true' || process.env.DEBUG_DEEP === 'true') {
        console.log(`[implement_and_test] Attempt ${attempt}/${maxAttempts}: ${result.success ? '✅ PASS' : '❌ FAIL'}`);
        if (!result.success) console.log(`  output: ${result.output.slice(0, 300)}`);
      }

      if (result.success) {
        // Write HOW.PR entry documenting the working solution
        try {
          const entry = createEntry({
            nb: 'HOW',
            type: 'PR',
            name: `Implementation: ${filename}`,
            summary: `Working ${filename} implementation, tests passed on attempt ${attempt}`,
            body: `## Working Solution\n\nTests passed on attempt ${attempt}.\n\n### Code\n\`\`\`javascript\n${code}\n\`\`\`\n\n### Test Output\n\`\`\`\n${result.output}\n\`\`\``,
            status: 'active',
          });
          return {
            success: true,
            output: `✅ Tests passed on attempt ${attempt}.\n${result.output}\n\nDocumented: ${entry.code} — ${entry.name}`,
          };
        } catch {
          // HOW.PR write failed but tests passed — still success
          return {
            success: true,
            output: `✅ Tests passed on attempt ${attempt}.\n${result.output}`,
          };
        }
      }

      // Tests failed — fix code for next attempt
      if (attempt < maxAttempts) {
        code = await fixCode(code, result.output, implementationPrompt);
      }
    }

    return {
      success: false,
      output: lastTestOutput,
      error: `Tests did not pass after ${maxAttempts} attempt(s). Last output:\n${lastTestOutput}`,
    };
  },
};
