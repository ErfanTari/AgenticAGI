/**
 * Phase 25.1 — Single LLM call to produce a FileBatchTransformSpec.
 *
 * The whole architecture in one line: the LLM may produce candidates, the
 * engine decides state transitions. This module is the candidate producer.
 */
import type { LLMHandler } from '../types.js';
import { parseStructured } from '../structured.js';
import { fileBatchTransformSpecSchema, type FileBatchTransformSpec } from '../schemas.js';

const EXTRACT_SYSTEM = `You are a structured data extractor.
Extract a file-batch-transform specification from the user message.
Return ONLY valid JSON matching this exact shape — no explanation, no markdown fences:

{
  "kind": "file_batch_transform",
  "source": { "glob": "workspace/inputs/*.pdf" },
  "transform": { "kind": "extract_text_from_pdf" },
  "destDir": "workspace/outputs/text",
  "filenameTemplate": "{stem}.txt",
  "validation": { "minBytes": 100, "requireExtension": ".txt" },
  "overwrite": "if-missing"
}

Rules:
- transform.kind MUST be one of: "copy", "rename", "extract_text_from_pdf".
- source.glob: a glob relative to the workspace root (use forward slashes).
  Tokens supported by the engine: * (single segment), ** (any depth).
- destDir: workspace-relative path. Anything outside workspace/ will be rejected.
- filenameTemplate: applied per-file. Tokens:
    {stem} → input basename without extension
    {ext}  → input extension (with leading dot, e.g. ".pdf")
    {idx}  → 1-based zero-padded index
  Always include either {stem} or {idx} so output filenames are unique.
- validation.minBytes: minimum output size in bytes; use small defaults (e.g. 1) unless
  the user specifies otherwise.
- validation.requireExtension (optional): forces output extension check; include the
  leading dot, e.g. ".txt".
- overwrite: "if-missing" (default, idempotent) or "always". Use "always" only when the
  user explicitly says "re-run" or "overwrite".

Pick exactly ONE transform.kind. Do not invent kinds.`;

export async function extractFileBatchTransformSpec(
  message: string,
  llmHandler: LLMHandler,
): Promise<FileBatchTransformSpec | null> {
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

  const result = await parseStructured(raw, fileBatchTransformSpecSchema, {
    maxRepairAttempts: 1,
    llmHandler,
    context: 'file-batch-transform-spec-extractor',
  });

  if (!result.success || !result.data) return null;
  return result.data;
}
