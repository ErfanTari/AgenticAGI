import type { MCPSkill, SkillResult } from '../types.js';

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;

function extractUrls(text: string, filter?: string): string[] {
  const raw = [...text.matchAll(URL_REGEX)].map(m => m[0]);

  // Clean trailing punctuation that is not part of a URL
  const cleaned = raw.map(u => u.replace(/[.,;:!?)>]+$/, ''));

  if (filter) {
    const ext = filter.toLowerCase().replace(/^\./, '');
    return [...new Set(cleaned.filter(u =>
      u.toLowerCase().includes(`.${ext}`) ||
      u.toLowerCase().includes(`/${ext}`)
    ))];
  }

  return [...new Set(cleaned)];
}

const urlExtractSkill: MCPSkill = {
  name: 'url_extract',
  description: 'Extract a clean URL from text. Use after web_search or web_fetch when you need a specific URL to pass to curl or web_fetch. Input: { text, filter?, index? }',
  permissionLevel: 'read-only',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text containing one or more URLs' },
      filter: {
        type: 'string',
        description: 'Optional file extension or keyword to filter URLs (e.g. "pdf", "zip", "catalog", "download")',
      },
      index: {
        type: 'number',
        description: 'Which URL to return (0 = first, default 0)',
      },
    },
    required: ['text'],
  },

  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const text = String(input.text ?? '').trim();
    if (!text) return { success: false, output: '', error: 'text is required' };

    const filter = input.filter ? String(input.filter).trim() : undefined;
    const index = typeof input.index === 'number' ? input.index : 0;

    const urls = extractUrls(text, filter);

    if (urls.length === 0) {
      // Last-resort: try without filter and return first URL found
      if (filter) {
        const allUrls = extractUrls(text, undefined);
        if (allUrls.length > 0) {
          return { success: true, output: allUrls[index] ?? allUrls[0] };
        }
      }
      const msg = filter
        ? `No ${filter} URL found in text`
        : 'No URL found in text';
      return { success: false, output: '', error: msg };
    }

    const chosen = urls[index] ?? urls[0];
    return { success: true, output: chosen };
  },
};

export default urlExtractSkill;
