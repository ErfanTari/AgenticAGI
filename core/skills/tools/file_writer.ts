import fs from 'node:fs';
import path from 'node:path';
import type { MCPSkill, SkillResult } from '../types.js';
import { registerSkill } from '../store.js';

const fileWriterSkill: MCPSkill = {
  name: 'file_writer',
  description: 'Write text content to a local file. Use for save/write/append to disk requests.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative output file path' },
      content: { type: 'string', description: 'Text content to write' },
      append: { type: 'boolean', description: 'Append instead of overwrite' },
      overwrite: { type: 'boolean', description: 'Allow replacing existing file when append is false' },
    },
    required: ['path', 'content'],
  },
  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const outputPath = String(input.path ?? '').trim();
    const content = String(input.content ?? '');
    const append = Boolean(input.append ?? false);
    const overwrite = Boolean(input.overwrite ?? false);

    if (!outputPath) {
      return { success: false, output: '', error: 'No output file path provided' };
    }
    if (content.length === 0) {
      return { success: false, output: '', error: 'No file content provided' };
    }

    const resolved = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });

    if (!append && fs.existsSync(resolved) && !overwrite) {
      return {
        success: false,
        output: '',
        error: `File already exists: ${outputPath}. Set overwrite=true or use append.`,
      };
    }

    if (append) {
      fs.appendFileSync(resolved, content, 'utf-8');
      return {
        success: true,
        output: `Appended ${content.length} characters to ${resolved}`,
      };
    }

    fs.writeFileSync(resolved, content, 'utf-8');
    return {
      success: true,
      output: `Wrote ${content.length} characters to ${resolved}`,
    };
  },
};

registerSkill(fileWriterSkill);
export default fileWriterSkill;
