#!/usr/bin/env tsx
/**
 * Manual cloud test for the web_download spec extractor.
 *
 * Calls the real LLM with the user's exact porcelain catalog message
 * and validates that the extracted spec matches the schema.
 *
 * Usage: tsx scripts/test-spec-extractor-cloud.ts
 *
 * Requires GEMINI_API_KEY (or OPENAI/ANTHROPIC) in .env.
 *
 * This is NOT part of the regular test suite — it makes real API calls.
 */
import 'dotenv/config';
import { callLLM, withLLMRuntime, getFallbackLLMProfile } from '../core/llm.js';
import { extractWebDownloadSpec } from '../core/skills/web-download-spec-extractor.js';
import { extractFileBatchTransformSpec } from '../core/skills/file-batch-transform-spec-extractor.js';
import { extractApiPaginatedCollectSpec } from '../core/skills/api-paginated-collect-spec-extractor.js';

const PORCELAIN_MESSAGE = `Download the 2025/2026 general catalogs for these 3 porcelain slab brands: Neolith, Living Ceramics, Sapiens Stone. For each brand: search for its catalog page, fetch the downloads page to find a direct PDF link, then download the PDF to workspace/Porcelain_PDF/catalogs/ using filename [BrandName]_generalcatalog.pdf. General catalogs are typically 7MB or larger — skip anything smaller (likely a flyer). Report FINAL_STATUS: ok=[] skipped=[] for all three brands.`;

const SHORT_DOWNLOAD_MESSAGE = `Download Neolith, Sapiens Stone, Laminam catalog PDFs to workspace/catalogs/`;

const DATASHEET_MESSAGE = `Fetch the latest datasheets for STM32F4, RP2040, and ESP32 from each manufacturer's site into workspace/datasheets/ as {BrandName}_datasheet.pdf — must be ≥500KB.`;

const PDF_BATCH_MESSAGE = `Extract text from every PDF in the workspace/inbox folder and save each as a .txt file in workspace/outputs/text/`;

const API_COLLECT_MESSAGE = `Collect all open issues from https://api.github.com/repos/anthropics/claude-code/issues into workspace/data/issues.jsonl using bearer auth GITHUB_TOKEN — paginate via Link header and stop after 5 pages.`;

const OUT_OF_SCOPE_SOFTWARE = `Download the macOS DMG installers for Inkscape, Firefox, and VS Code into workspace/installers/`;

const OUT_OF_SCOPE_REPO = `Clone the github repos for tantivy-py, meilisearch, and qdrant into workspace/cloned-repos/`;

async function testCase(label: string, message: string, extractor: (m: string, h: any) => Promise<unknown>): Promise<boolean> {
  console.log(`\n══ ${label} ══`);
  console.log(`Input: ${message.slice(0, 120)}${message.length > 120 ? '...' : ''}`);

  const t0 = Date.now();
  let spec: unknown = null;
  try {
    spec = await extractor(message, callLLM);
  } catch (err) {
    console.log(`✗ ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  const elapsed = Date.now() - t0;

  if (!spec) {
    console.log(`✗ NULL SPEC (${elapsed}ms) — extractor returned null`);
    return false;
  }

  console.log(`✓ Spec extracted in ${elapsed}ms`);
  console.log(JSON.stringify(spec, null, 2));
  return true;
}

(async () => {
  console.log('Cloud spec-extractor smoke test\n────────────────────────────────');
  // Force the cloud (Gemini) provider as primary so the audit is decoupled
  // from local-LLM JSON quality. This is what production users get when
  // running with cloud-primary mode.
  const cloudProfile = getFallbackLLMProfile();
  if (!cloudProfile) {
    console.error('ERROR: no cloud LLM profile configured (set LLM_FALLBACK_PROVIDER + GEMINI_API_KEY in .env)');
    process.exit(2);
  }
  console.log(`Forced cloud-primary: ${cloudProfile.label} (${cloudProfile.model})\n`);

  await withLLMRuntime({ primary: cloudProfile, fallback: null }, async () => {

  const results: Array<{ label: string; expected: 'extract' | 'reject'; got: boolean }> = [];

  async function check(label: string, msg: string, extractor: (m: string, h: any) => Promise<unknown>, expected: 'extract' | 'reject') {
    const ok = await testCase(label, msg, extractor);
    results.push({ label, expected, got: ok });
  }

  // Cases that SHOULD produce a valid spec
  await check('Web Download — full porcelain message', PORCELAIN_MESSAGE, extractWebDownloadSpec, 'extract');
  await check('Web Download — short single-sentence form', SHORT_DOWNLOAD_MESSAGE, extractWebDownloadSpec, 'extract');
  await check('Web Download — datasheets with alphanumeric part numbers', DATASHEET_MESSAGE, extractWebDownloadSpec, 'extract');
  await check('File Batch Transform — extract text from PDFs', PDF_BATCH_MESSAGE, extractFileBatchTransformSpec, 'extract');
  await check('API Paginated Collect — GitHub issues', API_COLLECT_MESSAGE, extractApiPaginatedCollectSpec, 'extract');

  // Cases the web-download extractor SHOULD reject (return null) so the
  // router can fall through to a more appropriate engine. The current prompt
  // tells the LLM to return {} for these — extractor returns null on parse
  // failure of {}, which is what we want.
  await check('OUT-OF-SCOPE — software DMG installers (should reject)', OUT_OF_SCOPE_SOFTWARE, extractWebDownloadSpec, 'reject');
  await check('OUT-OF-SCOPE — github repo clone (should reject)', OUT_OF_SCOPE_REPO, extractWebDownloadSpec, 'reject');

  let pass = 0;
  let fail = 0;
  console.log(`\n──────────────────────────────── audit summary`);
  for (const r of results) {
    const isCorrect = (r.expected === 'extract' && r.got) || (r.expected === 'reject' && !r.got);
    if (isCorrect) pass++; else fail++;
    const symbol = isCorrect ? '✓' : '✗';
    console.log(`  ${symbol}  [${r.expected}]  ${r.label}  →  ${r.got ? 'spec produced' : 'spec rejected'}`);
  }
  console.log(`────────────────────────────────`);
  console.log(`Results: ${pass} correct, ${fail} incorrect (of ${results.length} cases)`);
  process.exit(fail > 0 ? 1 : 0);
  });
})();
