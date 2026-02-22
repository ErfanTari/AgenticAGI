import fs from 'node:fs';
import path from 'node:path';
import type { MCPSkill, SkillResult } from '../types.js';
import { registerSkill } from '../store.js';

const codeEditorSkill: MCPSkill = {
  name: 'code_editor',
  description: 'Edit source files with deterministic operations (replace/overwrite/insert).',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Target source file path' },
      operation: { type: 'string', description: 'Operation: replace|overwrite|insert_after|insert_before' },
      target: { type: 'string', description: 'Target text for replace/insert operations' },
      content: { type: 'string', description: 'New content or inserted text' },
      all: { type: 'boolean', description: 'Replace all matches when operation=replace' },
      create: { type: 'boolean', description: 'Allow creating missing file when operation=overwrite' },
    },
    required: ['path', 'operation', 'content'],
  },
  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const filePath = String(input.path ?? '').trim();
    const operation = String(input.operation ?? '').trim().toLowerCase();
    const target = String(input.target ?? '');
    const content = String(input.content ?? '');
    const replaceAll = Boolean(input.all ?? false);
    const create = Boolean(input.create ?? false);

    if (!filePath) return { success: false, output: '', error: 'No file path provided' };
    if (!operation) return { success: false, output: '', error: 'No operation provided' };

    const resolved = path.resolve(filePath);
    const exists = fs.existsSync(resolved);

    if (!exists && !(operation === 'overwrite' && create)) {
      return { success: false, output: '', error: `File not found: ${resolved}` };
    }

    let original = exists ? fs.readFileSync(resolved, 'utf-8') : '';
    let updated = original;

    if (operation === 'overwrite') {
      updated = content;
    } else if (operation === 'replace') {
      if (!target) return { success: false, output: '', error: 'target is required for replace' };
      if (!original.includes(target)) {
        return { success: false, output: '', error: 'target text not found in file' };
      }
      updated = replaceAll ? original.split(target).join(content) : original.replace(target, content);
    } else if (operation === 'insert_after') {
      if (!target) return { success: false, output: '', error: 'target is required for insert_after' };
      const idx = original.indexOf(target);
      if (idx === -1) return { success: false, output: '', error: 'target text not found in file' };
      const pos = idx + target.length;
      updated = original.slice(0, pos) + content + original.slice(pos);
    } else if (operation === 'insert_before') {
      if (!target) return { success: false, output: '', error: 'target is required for insert_before' };
      const idx = original.indexOf(target);
      if (idx === -1) return { success: false, output: '', error: 'target text not found in file' };
      updated = original.slice(0, idx) + content + original.slice(idx);
    } else {
      return { success: false, output: '', error: `Unsupported operation: ${operation}` };
    }

    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, updated, 'utf-8');

    const changed = Math.abs(updated.length - original.length);
    return {
      success: true,
      output: `Edited ${resolved} using ${operation}. Size delta: ${changed} chars.`,
    };
  },
};

registerSkill(codeEditorSkill);
export default codeEditorSkill;
