import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { MCPSkill, SkillResult } from '../types.js';
import { tileImage } from '../../multimedia/tiling.js';
import { describeImage } from '../../multimedia/vision-router.js';

function mimeFromExt(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  return map[ext] ?? 'image/png';
}

const viewImageSkill: MCPSkill = {
  name: 'view_image',
  description: 'Describe an image using a vision model. Tiles large images into 1072×1072 chunks. Routes to local Qwen 3 VL 8B first; escalates to cloud Gemini on low confidence.',
  permissionLevel: 'read-only',

  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the image file' },
      prompt: {
        type: 'string',
        description: 'Optional prompt for the vision model',
      },
    },
    required: ['path'],
  },

  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const filePath = String(input.path ?? '').trim();
    if (!filePath) return { success: false, output: '', error: 'path is required' };

    const prompt = typeof input.prompt === 'string' && input.prompt
      ? input.prompt
      : 'Describe this image in detail. Note any text, UI elements, objects, and notable visual features.';

    try {
      const buffer = await readFile(filePath);
      const mime = mimeFromExt(filePath);
      const tiles = await tileImage(buffer);

      if (tiles.length === 1) {
        const result = await describeImage(tiles[0].buffer, prompt, mime);
        return {
          success: true,
          output: result.description,
          display: `[view_image: ${tiles.length} tile, tier=${result.tier}, confidence=${result.confidence}]`,
        };
      }

      // Multi-tile: describe each, synthesize
      const tileResults = await Promise.all(
        tiles.map(async t => {
          const tilePrompt = `${prompt} (Tile ${t.index + 1} of ${tiles.length}, position x=${t.x},y=${t.y})`;
          const r = await describeImage(t.buffer, tilePrompt, mime);
          return { tile: t.index, x: t.x, y: t.y, description: r.description, tier: r.tier };
        }),
      );

      const synthesized = tileResults
        .map(t => `[Tile ${t.tile + 1} @${t.x},${t.y}]: ${t.description}`)
        .join('\n\n');
      const allLocal = tileResults.every(t => t.tier === 'local');

      return {
        success: true,
        output: synthesized,
        display: `[view_image: ${tiles.length} tiles, tier=${allLocal ? 'local' : 'mixed'}]`,
      };
    } catch (err) {
      return { success: false, output: '', error: String(err) };
    }
  },
};

export default viewImageSkill;
