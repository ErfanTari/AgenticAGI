import type { LLMHandler } from '../types.js';
import { parseStructured } from '../structured.js';
import { webDownloadSpecSchema, type WebDownloadSpec } from '../schemas.js';

const EXTRACT_SYSTEM = `You are a structured data extractor.
Extract a web download specification from the user message.
Return ONLY valid JSON matching this exact shape — no explanation, no markdown fences:

{
  "kind": "web_download_multi_target",
  "targets": ["Brand1", "Brand2"],
  "artifact": "2025 general catalog PDF",
  "minBytes": 7000000,
  "destDir": "Porcelain_PDF/catalogs",
  "filenameTemplate": "{BrandName}_generalcatalog.pdf"
}

Rules:
- targets: extract all brand/company names mentioned
- artifact: describe what document type to find ("2025 catalog PDF", "general brochure PDF")
- minBytes: if user says "7MB" convert to 7000000; if not mentioned use 200000
- destDir: if user mentions a folder use it verbatim; otherwise infer from context or use "downloads"
- filenameTemplate: always include {BrandName}; keep it short and filesystem-safe`;

export async function extractWebDownloadSpec(
  message: string,
  llmHandler: LLMHandler,
): Promise<WebDownloadSpec | null> {
  let raw: string;
  try {
    raw = await llmHandler(
      [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: message },
      ],
      { maxTokens: 400 },
    );
  } catch {
    return null;
  }

  const result = await parseStructured(raw, webDownloadSpecSchema, {
    maxRepairAttempts: 1,
    llmHandler,
    context: 'web-download-spec-extractor',
  });

  if (!result.success || !result.data) return null;
  if (result.data.targets.length < 1) return null;

  return result.data;
}
