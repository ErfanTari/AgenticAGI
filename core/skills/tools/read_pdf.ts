// Uses pdf-parse v2 (PDFParse class API) — ESM-compatible via named export.
import type { MCPSkill, SkillResult } from '../types.js';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PATHS } from '../../../config/agent.config.js';

const MAX_CHARS = 50_000;
const MAX_FILE_BYTES = 100_000_000; // 100MB
const MAX_PAGES_CAP = 50;

const readPdfSkill: MCPSkill = {
  name: 'read_pdf',
  description: 'Extract text from a PDF file in the workspace. Returns page-by-page text up to 50,000 chars. Input: { path, max_pages?, start_page? }',
  permissionLevel: 'read-only',

  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the PDF file, relative to workspace root (e.g. ".downloads/report.pdf")',
      },
      start_page: {
        type: 'number',
        description: 'First page to read (1-based, default 1)',
      },
      max_pages: {
        type: 'number',
        description: 'Maximum number of pages to read (default: all, capped at 50)',
      },
    },
    required: ['path'],
  },

  async execute(input: Record<string, unknown>): Promise<SkillResult> {
    const rawPath = String(input.path ?? '').trim().replace(/^\/?workspace\//, '');
    if (!rawPath) return { success: false, output: '', error: 'path is required' };

    const wsRoot = PATHS.workspace;
    const resolved = path.resolve(wsRoot, rawPath);

    // Path traversal guard
    if (!resolved.startsWith(wsRoot)) {
      return { success: false, output: '', error: 'Access denied: path escapes workspace boundary' };
    }

    if (!existsSync(resolved)) {
      return { success: false, output: '', error: `File not found: ${rawPath}` };
    }

    const fileStat = await stat(resolved);
    if (fileStat.size > MAX_FILE_BYTES) {
      return { success: false, output: '', error: `File too large: ${fileStat.size} bytes (max ${MAX_FILE_BYTES})` };
    }

    const startPage = typeof input.start_page === 'number' ? Math.max(1, Math.floor(input.start_page)) : 1;
    const maxPages = typeof input.max_pages === 'number'
      ? Math.min(Math.max(1, Math.floor(input.max_pages)), MAX_PAGES_CAP)
      : MAX_PAGES_CAP;

    try {
      // Dynamic import to keep startup fast
      const { PDFParse } = await import('pdf-parse');
      const buffer = await readFile(resolved);

      const parser = new PDFParse({ data: new Uint8Array(buffer) });

      // Parse all pages first to know total count, then filter
      const result = await parser.getText();
      const allPages = result.pages; // Array<{ num: number; text: string }>

      if (allPages.length === 0 || allPages.every(p => !p.text.trim())) {
        return {
          success: false,
          output: '',
          error: 'PDF contains no extractable text. Use ocr_image skill for scanned documents.',
        };
      }

      // Filter to requested page range (1-based, pages are already 1-indexed by pdf-parse)
      const endPage = startPage + maxPages - 1;
      const selectedPages = allPages.filter(p => p.num >= startPage && p.num <= endPage);

      if (selectedPages.length === 0) {
        return { success: false, output: '', error: `No pages found in range ${startPage}–${endPage}` };
      }

      const sections: string[] = [];
      let totalChars = 0;
      let lastPageRead = startPage - 1;
      let truncated = false;

      for (const page of selectedPages) {
        const pageText = page.text.trim();
        const section = `[Page ${page.num}]\n${pageText}`;

        if (totalChars + section.length > MAX_CHARS) {
          truncated = true;
          lastPageRead = page.num;
          break;
        }

        sections.push(section);
        totalChars += section.length + 2; // +2 for \n\n separator
        lastPageRead = page.num;
      }

      let output = sections.join('\n\n');
      if (truncated) {
        output += `\n\n[Truncated at ${MAX_CHARS.toLocaleString()} chars. Use start_page=${lastPageRead + 1} to continue reading from page ${lastPageRead + 1}.]`;
      }

      const filename = path.basename(resolved);
      return {
        success: true,
        output,
        display: `Read PDF: ${filename} (${sections.length} pages, ${totalChars} chars)`,
      };
    } catch (err: unknown) {
      return { success: false, output: '', error: `PDF parse error: ${String(err)}` };
    }
  },
};

export default readPdfSkill;
