import fs from 'node:fs';
import path from 'node:path';
import type { MCPSkill, SkillResult } from '../types.js';

const MAX_CHARS = 50000;

const SUPPORTED_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.csv', '.ts', '.js', '.py',
  '.yaml', '.yml', '.toml', '.xml', '.html', '.css',
  '.sh', '.sql', '.env', '.cfg', '.ini', '.log',
]);

const fileReaderSkill: MCPSkill = {
  name: 'file_reader',
  description: 'Read a file from disk. Use when user asks to read, open, or load a file.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path' },
    },
    required: ['path'],
  },
  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const filePath = String(input.path ?? '');
    if (!filePath.trim()) {
      return { success: false, output: '', error: 'No file path provided' };
    }

    const resolved = path.resolve(filePath);

    if (!fs.existsSync(resolved)) {
      return { success: false, output: '', error: `File not found: ${filePath}` };
    }

    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      return { success: false, output: '', error: `Not a file: ${filePath}` };
    }

    const ext = path.extname(resolved).toLowerCase();
    if (ext && !SUPPORTED_EXTENSIONS.has(ext)) {
      return { success: false, output: '', error: 'Binary file not supported' };
    }

    const content = fs.readFileSync(resolved, 'utf-8');

    if (content.length > MAX_CHARS) {
      return {
        success: true,
        output: content.slice(0, MAX_CHARS) +
          `\n\nFile truncated at ${MAX_CHARS} characters. Full file is ${content.length} chars.`,
      };
    }

    return { success: true, output: content };
  },
};

export default fileReaderSkill;
