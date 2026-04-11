/**
 * generate_and_save_file — self-contained file generation and write in one skill call.
 * Handles complete file generation from spec and writes to disk atomically.
 */
import { callLLM } from '../../llm.js';
import { fetchByCode } from '../../memory/fetch.js';
import { TOKEN_BUDGETS } from '../../../config/agent.config.js';
import { runSkill } from '../runner.js';
import type { MCPSkill, SkillResult } from '../types.js';
import type { IndexEntry } from '../../memory/types.js';

type ContentFormat = 'markdown' | 'html' | 'plain';

function isTerminalPlanExEntry(entry: IndexEntry): boolean {
  return entry.nb === 'PLAN'
    && entry.type === 'EX'
    && (entry.status === 'complete' || entry.status === 'failed');
}

// ─── Structured HTML Validator (Fix 6) ───────────────────────────────────────

interface HTMLValidationResult {
  hasDoctype: boolean;
  hasHTMLTag: boolean;
  hasBody: boolean;
  properlyClosed: boolean;
}

function validateHTML(output: string): HTMLValidationResult {
  const stripped = output.trim();
  return {
    hasDoctype: /<!DOCTYPE\s+html>/i.test(stripped),
    hasHTMLTag: /<html[\s>]/i.test(stripped),
    hasBody: /<body[\s>]/i.test(stripped),
    properlyClosed: /<\/html>\s*$/i.test(stripped),
  };
}

function htmlValidationErrors(v: HTMLValidationResult): string[] {
  const errors: string[] = [];
  if (!v.hasDoctype) errors.push('Missing <!DOCTYPE html>');
  if (!v.hasHTMLTag) errors.push('Missing <html> tag');
  if (!v.hasBody) errors.push('Missing <body> tag');
  if (!v.properlyClosed) errors.push('Missing </html> closing tag');
  return errors;
}

// ─── Spec Resolution ─────────────────────────────────────────────────────────

/**
 * Strip YAML frontmatter from a markdown memory file and return the body.
 * Format: "---\n...\n---\n\n# Title\n\nbody"
 */
function extractSpecBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n+([\s\S]*)$/);
  return (match ? match[1] : content).trim();
}

/**
 * Resolve the generation spec from either a memory code (spec_code) or
 * an inline description string. Returns null if neither is usable.
 */
function resolveSpec(
  specCode: unknown,
  description: unknown,
): { spec: string; source: 'memory' | 'inline' } | { error: string } {
  if (typeof specCode === 'string' && specCode.trim()) {
    const code = specCode.trim();
    const fetched = fetchByCode(code);
    if (!fetched) {
      return { error: `spec_code "${code}" not found in memory. Write the spec first using memory_write, then pass the returned code here.` };
    }
    if (isTerminalPlanExEntry(fetched.entry)) {
      return {
        error: `spec_code "${code}" points to a terminal PLAN.EX entry with status "${fetched.entry.status}". ` +
          'Do not generate from completed or failed execution specs. Write a fresh spec with memory_write, ' +
          'or pass a new inline description instead.',
      };
    }
    const spec = extractSpecBody(fetched.content);
    if (!spec) {
      return { error: `spec_code "${code}" exists but has empty body. Write content into the memory entry first.` };
    }
    return { spec, source: 'memory' };
  }

  if (typeof description === 'string' && description.trim()) {
    return { spec: description.trim(), source: 'inline' };
  }

  return { error: 'Either "description" or "spec_code" must be provided.' };
}

// ─── Format Helpers ───────────────────────────────────────────────────────────

function inferFormat(pathValue: string, rawFormat: unknown, description: string): ContentFormat {
  const requested = String(rawFormat ?? '').trim().toLowerCase();
  if (requested === 'markdown' || requested === 'html' || requested === 'plain') {
    return requested;
  }
  if (/\.(html?)$/i.test(pathValue) || /\b(html|website|web page|landing page|portfolio)\b/i.test(description)) {
    return 'html';
  }
  if (/\.(md|markdown)$/i.test(pathValue)) {
    return 'markdown';
  }
  return 'plain';
}

function buildGenerationPrompt(
  pathValue: string,
  description: string,
  format: ContentFormat,
  previousOutput?: string,
  errorMessage?: string,
  context?: string,
): string {
  const lines: string[] = [];

  if (previousOutput && errorMessage) {
    lines.push(`Your previous output was INVALID: ${errorMessage}`);
    lines.push(`Previous output (incomplete):\n${previousOutput.slice(0, 500)}`);
    lines.push('You MUST fix the output and return a complete, valid version.');
    lines.push('');
  }

  if (context) {
    lines.push(`You are modifying existing content for the file "${pathValue}".`);
    lines.push(`EXISTING CONTENT:\n${context}`);
    lines.push(`MODIFICATION REQUEST: ${description}`);
    lines.push('Return the COMPLETE modified file — not just the changed section.');
  } else {
    lines.push(`Create the complete contents for the file "${pathValue}".`);
    lines.push(`User request: ${description}`);
  }

  if (format === 'html') {
    lines.push(
      'Return a COMPLETE, save-ready HTML5 document.',
      'REQUIREMENTS:',
      '- MUST start with: <!DOCTYPE html>',
      '- MUST contain <html>, <head>, and <body> tags',
      '- MUST end with: </html>',
      '- Include all CSS inline in <style> tags',
      '- Include all JS inline in <script> tags',
      '- Load external libraries via CDN only',
      '- Do NOT truncate or omit any part of the document',
    );
  } else if (format === 'markdown') {
    lines.push('Return the complete markdown content for this file.');
  } else {
    lines.push('Return the complete save-ready file contents with no omissions.');
  }

  return lines.join('\n\n');
}

// ─── Skill Definition ─────────────────────────────────────────────────────────

const generateAndSaveFileSkill: MCPSkill = {
  name: 'generate_and_save_file',
  description: [
    'Generate a complete file (HTML, JS, CSS, etc.) from a detailed specification and write it to disk in one step.',
    'PREFERRED: Use spec_code (a memory code like PLAN.EX-000042) to avoid JSON escaping limits.',
    'Step 1: Write the detailed spec with memory_write → get back a code.',
    'Step 2: Call this skill with {"path":"...","spec_code":"PLAN.EX-000042"}.',
    'FALLBACK: Use description for short inline specs only (under 200 chars).',
  ].join(' '),
  permissionLevel: 'workspace-write',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative path inside workspace/ for the file to create',
      },
      spec_code: {
        type: 'string',
        description: 'Memory code of a PLAN.EX/HOW.PR entry containing the full generation spec. Use this instead of description for complex specs to avoid JSON escaping issues.',
      },
      description: {
        type: 'string',
        description: 'Inline spec for simple files. For complex HTML/JS use spec_code instead.',
      },
      context: {
        type: 'string',
        description: 'Existing content to modify/extend. Use {{stepN_result}} to pipe a prior step\'s output here. When present the generator modifies this content rather than creating from scratch.',
      },
      format: {
        type: 'string',
        description: 'Optional output format: "markdown" | "html" | "plain"',
        enum: ['markdown', 'html', 'plain'],
      },
      style: {
        type: 'string',
        description: 'Optional style/tone hint for the generated file',
      },
      maxTokens: {
        type: 'number',
        description: 'Optional generation budget override',
      },
      mode: {
        type: 'string',
        description: 'File write mode: "write" (default) or "append"',
        enum: ['write', 'append'],
      },
    },
    required: ['path'],
  },

  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const pathValue = String(input.path ?? '').trim();

    if (!pathValue) {
      return { success: false, output: '', error: 'Invalid input: path must be a non-empty string' };
    }

    // Guard: spec_code must be a memory code string, not a JSON blob from memory_read output
    if (typeof input.spec_code === 'string' && input.spec_code.trim()) {
      const sc = input.spec_code.trim();
      if (sc.startsWith('{') || sc.startsWith('[')) {
        return {
          success: false, output: '',
          error: `spec_code received a JSON object instead of a memory code. ` +
            `Expected format: "PLAN.EX-000042". ` +
            `If you used memory_read output, pass the "code" field value directly, ` +
            `or write a NEW spec with memory_write first and use its returned code. ` +
            `Got: ${sc.slice(0, 80)}...`,
        };
      }
      if (!/^[A-Z]+\.[A-Z]+-\d{6}$/.test(sc)) {
        // Not fatal — could be an inline description passed in the wrong field.
        // Demote to description so resolveSpec handles it gracefully.
        input = { ...input, spec_code: undefined, description: input.description ?? sc };
      }
    }

    // Resolve spec: spec_code (memory pointer) takes priority over inline description
    const resolved = resolveSpec(input.spec_code, input.description);
    if ('error' in resolved) {
      return { success: false, output: '', error: resolved.error };
    }
    const { spec: description, source: specSource } = resolved;

    // Guard: context must be source code, not JSON data or a planning document.
    // If context looks like a JSON blob, strip it and warn — don't enter Modification Mode
    // with garbage data, which causes the LLM to regurgitate the spec as plain text.
    let rawContext = typeof input.context === 'string' ? input.context.trim() : '';
    if (rawContext && (rawContext.startsWith('{') || rawContext.startsWith('['))) {
      console.warn(
        '[generate_and_save_file] context field contained JSON data instead of source code — ' +
        'ignoring context and switching to Creation Mode. ' +
        'Pass background knowledge via spec_code, not context.',
      );
      rawContext = '';
    }
    const context = rawContext || undefined;

    console.log(`[generate_and_save_file] spec source=${specSource} path=${pathValue} spec_length=${description.length} has_context=${!!context}`);

    const format = inferFormat(pathValue, input.format, description);
    const formatBudget =
      format === 'html'     ? TOKEN_BUDGETS.GENERATE_FILE_HTML :
      format === 'markdown' ? TOKEN_BUDGETS.GENERATE_FILE_MARKDOWN :
                              TOKEN_BUDGETS.GENERATE_FILE_PLAIN;
    const maxTokens = typeof input.maxTokens === 'number'
      ? Math.max(input.maxTokens, formatBudget)
      : formatBudget;
    const styleHint = typeof input.style === 'string' ? `\nStyle: ${input.style}` : '';

    const systemPrompt = format === 'html'
      ? 'You are a file generator. Output ONLY the complete file content with no explanation, no markdown fences, no commentary. The output must start with <!DOCTYPE html> and end with </html>.'
      : 'You are a file generator. Output ONLY the complete file content with no explanation, no markdown fences, no commentary.';

    const MAX_RETRIES = 3;
    let previousOutput: string | undefined;
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const prompt = buildGenerationPrompt(pathValue, description + styleHint, format, previousOutput, lastError, context);

      let generated: string;
      try {
        generated = await callLLM(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
          { maxTokens },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, output: '', error: `LLM call failed: ${msg}` };
      }

      // Strip thinking tags and markdown fences if model wrapped output
      let content = generated
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/^```[a-z]*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim();

      // For HTML: validate structure
      if (format === 'html') {
        const validation = validateHTML(content);
        const errors = htmlValidationErrors(validation);

        if (errors.length === 0) {
          // Valid — write file via permission gate
          const writeResult = await runSkill('file_writer', {
            path: pathValue,
            content,
            mode: input.mode,
          });

          if (!writeResult.success) return writeResult;

          return {
            success: true,
            output: `Generated and saved ${pathValue}`,
            display: `Generated and saved ${pathValue}`,
          };
        }

        // Invalid — set up for retry
        lastError = errors.join('; ');
        previousOutput = content;
        console.warn(`[generate_and_save_file] attempt ${attempt} validation failed: ${lastError}`);
        continue;
      }

      // For non-HTML: write immediately via permission gate
      const writeResult = await runSkill('file_writer', {
        path: pathValue,
        content,
        mode: input.mode,
      });

      if (!writeResult.success) return writeResult;

      return {
        success: true,
        output: `Generated and saved ${pathValue}`,
        display: `Generated and saved ${pathValue}`,
      };
    }

    return {
      success: false,
      output: '',
      error: `Failed to generate valid HTML after ${MAX_RETRIES} attempts. Last errors: ${lastError}`,
    };
  },
};

export default generateAndSaveFileSkill;
