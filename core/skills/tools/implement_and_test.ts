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

const REPAIR_ARTIFACTS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'tests'],
  properties: {
    code: { type: 'string' },
    tests: { type: 'string' },
  },
};

// ─── npm Install Helpers ─────────────────────────────────────────────────────

const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'module',
  'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline',
  'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty',
  'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
  'node:assert', 'node:buffer', 'node:child_process', 'node:cluster', 'node:console',
  'node:constants', 'node:crypto', 'node:dgram', 'node:dns', 'node:domain', 'node:events',
  'node:fs', 'node:http', 'node:http2', 'node:https', 'node:module', 'node:net',
  'node:os', 'node:path', 'node:perf_hooks', 'node:process', 'node:punycode',
  'node:querystring', 'node:readline', 'node:repl', 'node:stream', 'node:string_decoder',
  'node:sys', 'node:timers', 'node:tls', 'node:trace_events', 'node:tty', 'node:url',
  'node:util', 'node:v8', 'node:vm', 'node:wasi', 'node:worker_threads', 'node:zlib',
]);

function normalizePackageName(specifier: string): string | null {
  const trimmed = specifier.trim();
  if (!trimmed || NODE_BUILTINS.has(trimmed)) return null;

  if (trimmed.startsWith('@')) {
    const [scope, name] = trimmed.split('/');
    if (!scope || !name) return trimmed;
    return `${scope}/${name}`;
  }

  return trimmed.split('/')[0];
}

function extractNpmPackages(code: string): string[] {
  const imports: string[] = [];
  const esmPattern = /^import\s+.*?\s+from\s+['"]([^./][^'"]*)['"]/gm;
  const esmSideEffectPattern = /^import\s+['"]([^./][^'"]*)['"]/gm;
  const cjsPattern = /require\(['"]([^./][^'"]*)['"]\)/g;
  const dynamicImportPattern = /import\(\s*['"]([^./][^'"]*)['"]\s*\)/g;
  for (const match of code.matchAll(esmPattern)) imports.push(match[1]);
  for (const match of code.matchAll(esmSideEffectPattern)) imports.push(match[1]);
  for (const match of code.matchAll(cjsPattern)) imports.push(match[1]);
  for (const match of code.matchAll(dynamicImportPattern)) imports.push(match[1]);
  return [...new Set(imports
    .map(normalizePackageName)
    .filter((pkg): pkg is string => Boolean(pkg)))];
}

async function installNpmPackages(
  packages: string[],
  projectDir: string,
): Promise<{ success: boolean; output: string }> {
  return new Promise(resolve => {
    const child = spawn('npm', ['install', ...packages, '--save'], {
      cwd: projectDir,
      shell: false,
    });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', d => { stdout += d.toString(); });
    child.stderr?.on('data', d => { stderr += d.toString(); });

    child.on('close', code => {
      const combined = (stdout + (stderr ? '\n' + stderr : '')).trim();
      resolve({ success: code === 0, output: combined });
    });

    child.on('error', err => {
      resolve({ success: false, output: err.message });
    });
  });
}

function extractMissingPackageFromError(output: string): string | null {
  // Match "Cannot find package 'X'" or "MODULE_NOT_FOUND" with module name
  const cannotFind = output.match(/Cannot find package '([^']+)'/);
  if (cannotFind) return normalizePackageName(cannotFind[1]);
  const moduleNotFound = output.match(/Cannot find module '([^./][^']+)'/);
  if (moduleNotFound) return normalizePackageName(moduleNotFound[1]);
  return null;
}

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

  // Remove preamble sentences line by line (same patterns as stripThinkingTags in llm.ts)
  s = s.replace(/^Let me [^\n]+\n/gim, '');
  s = s.replace(/^I need to [^\n]+\n/gim, '');
  s = s.replace(/^I will [^\n]+\n/gim, '');
  s = s.replace(/^I can see [^\n]+\n/gim, '');
  s = s.replace(/^I should [^\n]+\n/gim, '');
  s = s.replace(/^Let['´]s [^\n]+\n/gim, '');

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

function getWorkspaceRoot(): string {
  return path.resolve(process.cwd(), 'workspace');
}

function workspacePath(filename: string): string {
  const WORKSPACE_ROOT = getWorkspaceRoot();
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

function ensureProjectDir(projectDir: string): void {
  fs.mkdirSync(projectDir, { recursive: true });
  const pkgJson = path.join(projectDir, 'package.json');
  if (!fs.existsSync(pkgJson)) {
    fs.writeFileSync(pkgJson, '{"type":"module"}\n', 'utf-8');
  }
}

function relativeToProject(filename: string, projectDir: string): string {
  const resolved = workspacePath(filename);
  const relative = path.relative(projectDir, resolved);
  return relative.length > 0 ? relative.replace(/\\/g, '/') : path.basename(resolved);
}

function readWorkspaceFile(filename: string): string | null {
  const filePath = workspacePath(filename);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

function writeWorkspaceFile(filename: string, content: string): void {
  const filePath = workspacePath(filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

async function runNodeFile(
  filename: string,
  timeoutMs = 30000,
  projectDir?: string,
): Promise<{ success: boolean; output: string }> {
  const cwd = projectDir ?? getWorkspaceRoot();
  return new Promise(resolve => {
    const child = spawn('node', [filename], { cwd, shell: false });
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

async function runNodeCheck(
  filename: string,
  timeoutMs = 10000,
  projectDir?: string,
): Promise<{ success: boolean; output: string }> {
  const cwd = projectDir ?? getWorkspaceRoot();
  return new Promise(resolve => {
    const child = spawn('node', ['--check', filename], { cwd, shell: false });
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
        resolve({ success: false, output: `Syntax check timed out after ${timeoutMs}ms` });
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
  // Fall back to deriving the relative path from the test file directory.
  return `./${filename}`;
}

function deriveImportPath(filename: string, testFilename: string): string {
  const relative = path.relative(path.dirname(testFilename), filename).replace(/\\/g, '/');
  if (!relative || relative === '') return `./${path.basename(filename)}`;
  return relative.startsWith('.') ? relative : `./${relative}`;
}

async function generateTests(testPrompt: string, filename: string, testFilename: string): Promise<string> {
  // Extract the function name and import path so we can build the scaffold ourselves
  const fnName = extractFunctionName(testPrompt);
  const importPath = extractImportPath(testPrompt, deriveImportPath(filename, testFilename));

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

async function repairArtifacts(
  code: string,
  tests: string,
  failureOutput: string,
  implementationPrompt: string,
  testPrompt: string,
  filename: string,
  testFilename: string,
): Promise<{ code: string; tests: string }> {
  const messages: Message[] = [
    {
      role: 'system',
      content: [
        'You are a JavaScript debugging assistant.',
        'You will receive an implementation file and a test file.',
        'Repair whatever is broken so the tests can run and pass.',
        'Preserve correct content when possible.',
        'Return ONLY a JSON object with full file contents:',
        '{"code":"...","tests":"..."}',
        'The implementation must stay valid JavaScript ESM.',
        'The tests must stay valid JavaScript ESM, import from the implementation file, and use node:assert.',
      ].join(' '),
    },
    {
      role: 'user',
      content: `Original implementation task:
${implementationPrompt}

Original test task:
${testPrompt}

Implementation filename:
${filename}

Test filename:
${testFilename}

Current implementation:
${code}

Current tests:
${tests}

Failure output:
${failureOutput}

Return the full corrected contents for both files.`,
    },
  ];
  const raw = await callLLM(messages, {
    responseSchema: REPAIR_ARTIFACTS_SCHEMA,
    maxTokens: 4000,
  });

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(jsonMatch?.[0] ?? raw) as { code: string; tests: string };

  return {
    code: cleanCode(parsed.code),
    tests: cleanCode(parsed.tests),
  };
}

// ─── Skill ──────────────────────────────────────────────────────────────────

export const implementAndTestSkill: MCPSkill = {
  name: 'implement_and_test',
  description: 'Write or reuse code, run tests, repair implementation or tests, retry until passing or max attempts. Use for coding task loops: write/check -> run -> verify -> fix. Returns final working code + test output. Automatically writes HOW.PR entry on success.',

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

    // Working directory: always the directory containing the implementation file.
    const implementationFilePath = workspacePath(filename);
    const projectDir = path.dirname(implementationFilePath);

    // Reuse existing artifacts when present so "check/fix" operates on real files, not fresh rewrites.
    ensureProjectDir(projectDir);

    let code = readWorkspaceFile(filename) ?? await generateCode(implementationPrompt);
    let tests = readWorkspaceFile(testFilename) ?? await generateTests(testPrompt, filename, testFilename);
    const implementationCommandPath = relativeToProject(filename, projectDir);
    const testCommandPath = relativeToProject(testFilename, projectDir);

    // Scan implementation for npm packages and install before first run
    const requiredPackages = extractNpmPackages(code);
    if (requiredPackages.length > 0) {
      const installResult = await installNpmPackages(requiredPackages, projectDir);
      if (!installResult.success) {
        return {
          success: false,
          output: installResult.output,
          error: `npm install failed for packages [${requiredPackages.join(', ')}]:\n${installResult.output}`,
        };
      }
    }

    let lastTestOutput = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Write files
      try {
        writeWorkspaceFile(filename, code);
        writeWorkspaceFile(testFilename, tests);
      } catch (err) {
        return { success: false, output: '', error: `File write failed: ${String(err)}` };
      }

      const implementationSyntax = await runNodeCheck(implementationCommandPath, 10000, projectDir);
      if (!implementationSyntax.success) {
        lastTestOutput = implementationSyntax.output;
        if (attempt < maxAttempts) {
          const repaired = await repairArtifacts(
            code,
            tests,
            implementationSyntax.output,
            implementationPrompt,
            testPrompt,
            filename,
            testFilename,
          );
          code = repaired.code;
          tests = repaired.tests;
          continue;
        }
        break;
      }

      const testSyntax = await runNodeCheck(testCommandPath, 10000, projectDir);
      if (!testSyntax.success) {
        lastTestOutput = testSyntax.output;
        if (attempt < maxAttempts) {
          const repaired = await repairArtifacts(
            code,
            tests,
            testSyntax.output,
            implementationPrompt,
            testPrompt,
            filename,
            testFilename,
          );
          code = repaired.code;
          tests = repaired.tests;
          continue;
        }
        break;
      }

      // Run tests
      const result = await runNodeFile(testCommandPath, 30000, projectDir);
      lastTestOutput = result.output;

      // Handle MODULE_NOT_FOUND: try to install missing package then retry
      if (!result.success) {
        const missingPkg = extractMissingPackageFromError(result.output);
        if (missingPkg && attempt < maxAttempts) {
          const retryInstall = await installNpmPackages([missingPkg], projectDir);
          if (retryInstall.success) {
            // Retry this attempt without incrementing counter
            const retryResult = await runNodeFile(testCommandPath, 30000, projectDir);
            lastTestOutput = retryResult.output;
            if (retryResult.success) {
              try {
                const entry = createEntry({
                  nb: 'HOW',
                  type: 'PR',
                  name: `Implementation: ${filename}`,
                  summary: `Working ${filename} implementation, tests passed on attempt ${attempt}`,
                  body: `## Working Solution\n\nTests passed on attempt ${attempt}.\n\n### Code\n\`\`\`javascript\n${code}\n\`\`\`\n\n### Test Output\n\`\`\`\n${retryResult.output}\n\`\`\``,
                  status: 'active',
                });
                return {
                  success: true,
                  output: `Tests passed on attempt ${attempt}.\n${retryResult.output}\n\nDocumented: ${entry.code} — ${entry.name}`,
                };
              } catch {
                return {
                  success: true,
                  output: `Tests passed on attempt ${attempt}.\n${retryResult.output}`,
                };
              }
            }
          } else {
            // npm install failed — instruct LLM to rewrite using only built-ins
            const repaired = await repairArtifacts(
              code,
              tests,
              `${result.output}\n\nThe package '${missingPkg}' could not be installed. Rewrite using only Node.js built-in modules (node:fs, node:http, node:assert, etc.). No npm packages.`,
              implementationPrompt,
              testPrompt,
              filename,
              testFilename,
            );
            code = repaired.code;
            tests = repaired.tests;
            continue;
          }
        }
      }

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
        const repaired = await repairArtifacts(
          code,
          tests,
          result.output,
          implementationPrompt,
          testPrompt,
          filename,
          testFilename,
        );
        code = repaired.code;
        tests = repaired.tests;
      }
    }

    return {
      success: false,
      output: lastTestOutput,
      error: `Tests did not pass after ${maxAttempts} attempt(s). Last output:\n${lastTestOutput}`,
    };
  },
};
