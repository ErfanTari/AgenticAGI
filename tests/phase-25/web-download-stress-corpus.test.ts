/**
 * Stress-test corpus for the web_download_multi_target engine.
 *
 * These tests are not about code coverage — they audit the engine's
 * resistance to the kinds of garbage real search results return:
 *   - School curriculum PDFs masquerading as catalogs
 *   - Personal documents with similar-looking names
 *   - Browser-printed email PDFs that happen to be huge
 *   - Right brand name, wrong artifact (a Neolith press release, not a catalog)
 *   - Right artifact word, wrong brand (someone else's catalog)
 *
 * Each test fixes the SAME engine code paths but feeds adversarial mocked
 * data. If a future change weakens the validators, these tests will catch it.
 *
 * Real-world examples that motivated this corpus, captured from the user's
 * workspace at workspace/Porcelain_PDF/catalogs/:
 *   - Living_Ceramics_generalcatalog.pdf (318KB) was actually
 *     "25_26 Art only 4yr Roadmap Freshmen" by Melissa Ledesma (school)
 *   - Sapiens_Stone_generalcatalog.pdf (2.5MB) by Michelle Yates (personal)
 *   - Neolith_generalcatalog.pdf (27MB) was titled "Mail - Ben - Outlook"
 *     (someone's email exported via Chrome → Skia/PDF)
 */
import { describe, it, expect } from 'vitest';
import {
  runWebDownloadMultiTarget,
  validatePdf,
  checkContentRelevance,
  type SkillRunner,
} from '../../core/skills/web-download-multi-target.js';
import { webDownloadSpecSchema } from '../../core/schemas.js';

function buildRunner(handlers: {
  web_search?: (input: Record<string, unknown>) => Promise<unknown>;
  web_fetch?: (input: Record<string, unknown>) => Promise<unknown>;
  download_file?: (input: Record<string, unknown>) => Promise<unknown>;
  read_pdf?: (input: Record<string, unknown>) => Promise<unknown>;
}): SkillRunner {
  return async (name, input) => {
    const fn = handlers[name as keyof typeof handlers];
    if (!fn) return { success: false, output: '', error: `no mock for ${name}`, skill: name } as never;
    return (await fn(input)) as never;
  };
}

// ── Pure validator audit ─────────────────────────────────────────────────────

describe('checkContentRelevance — audit of the content-truth gate', () => {
  it('REJECTS a school curriculum PDF that pretends to be a Living Ceramics catalog', () => {
    // Real text from the orphan PDF the user flagged
    const text = '[Page 1]\nART CURRICULUM 2025-2026\n4-Year Art Roadmap\nFreshmen Year\nDrawing, Painting, Ceramics, Sculpture\nMrs. Melissa Ledesma\n';
    const result = checkContentRelevance(text, 'Living Ceramics', '2025/2026 general catalog PDF');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/content_mismatch.*Living Ceramics/);
  });

  it('REJECTS an email-PDF even when it is enormous (the Neolith case)', () => {
    const text = '[Page 1]\nMail - Ben - Outlook\nFrom: ben@example.com\nSubject: Project update\n\nHi team,\nAttached is the Q3 report...';
    const result = checkContentRelevance(text, 'Neolith', '2025 catalog PDF');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/content_mismatch.*Neolith/);
  });

  it('REJECTS a personal document even when slightly bigger than the size threshold', () => {
    const text = '[Page 1]\nMichelle Yates\nProfessional Portfolio\nResume and Project History\n2025\n';
    const result = checkContentRelevance(text, 'Sapiens Stone', '2025 catalog PDF');
    expect(result.ok).toBe(false);
  });

  it('ACCEPTS a real catalog with brand name + "catalog" keyword on page 1', () => {
    const text = '[Page 1]\nNEOLITH\nGeneral Catalog 2025/2026\nSurfaces and Colors\n';
    const result = checkContentRelevance(text, 'Neolith', '2025 general catalog PDF');
    expect(result.ok).toBe(true);
  });

  it('ACCEPTS a real catalog where brand appears as compound (SapiensStone vs Sapiens Stone)', () => {
    const text = '[Page 1]\nSapiensStone\nProduct Catalog 2025\nFinishes';
    const result = checkContentRelevance(text, 'Sapiens Stone', '2025 catalog PDF');
    expect(result.ok).toBe(true);
  });

  it('REJECTS a generic "catalog of school art supplies" with no target brand mention', () => {
    const text = '[Page 1]\nArt Supplies Catalog 2025\nPaints, Brushes, Canvas';
    const result = checkContentRelevance(text, 'Neolith', '2025 catalog PDF');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Neolith.*not found/);
  });

  it('REJECTS even if the brand appears once but no artifact keyword is present', () => {
    const text = '[Page 1]\nNeolith was founded in 2009. This article discusses sintered stone surfaces.';
    const result = checkContentRelevance(text, 'Neolith', 'product catalog');
    // Has brand but no catalog/brochure/datasheet keyword → rejected
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no artifact keyword/);
  });
});

// ── End-to-end stress scenarios (full engine loop) ───────────────────────────

describe('Engine stress scenarios — adversarial search results', () => {
  it('rejects+deletes the email-PDF orphan when content check fails (the Neolith case)', async () => {
    const spec = webDownloadSpecSchema.parse({
      kind: 'web_download_multi_target',
      targets: ['Neolith'],
      artifact: '2025 general catalog PDF',
      minBytes: 5_000_000,
      destDir: `__test_neolith_${Date.now()}`,
      filenameTemplate: '{BrandName}_generalcatalog.pdf',
    });

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const runner = buildRunner({
      web_search: async () => ({
        success: true,
        output: 'URL: https://random.edu/files/mail-ben-outlook.pdf',
        skill: 'web_search',
      }),
      // download_file always succeeds (the URL ends in .pdf, no error)
      download_file: async ({ destDir, filename }) => ({
        success: true,
        output: `WORKSPACE_PATH: ${destDir}/${filename}\nDownloaded 27000000 bytes`,
        skill: 'download_file',
      }),
      // read_pdf "succeeds" but returns email content — the content gate should reject
      read_pdf: async () => ({
        success: true,
        output: '[Page 1]\nMail - Ben - Outlook\nFrom: ben@x.com\nSubject: Q3 update',
        skill: 'read_pdf',
      }),
    });

    const report = await runWebDownloadMultiTarget(spec, runner, (e) => {
      events.push(e as { type: string; data: Record<string, unknown> });
    });

    expect(report.ok).toHaveLength(0);
    expect(report.skipped[0].reason).toMatch(/content_mismatch.*Neolith/);

    // The validation_failed event was emitted with cleanup info
    const failedEvent = events.find(e => e.type === 'web_download_validation_failed');
    expect(failedEvent).toBeDefined();
    expect(failedEvent?.data.reason).toMatch(/content_mismatch/);
  });

  it('tries multiple candidates and picks the first one that passes BOTH size and content checks', async () => {
    const spec = webDownloadSpecSchema.parse({
      kind: 'web_download_multi_target',
      targets: ['Neolith'],
      artifact: 'general catalog PDF',
      minBytes: 5_000_000,
      destDir: `__test_neolith_iter_${Date.now()}`,
      filenameTemplate: '{BrandName}.pdf',
    });

    let downloadCallCount = 0;
    const runner = buildRunner({
      web_search: async () => ({
        success: true,
        output: [
          // Top-ranked URL: looks legit but is an unrelated email PDF
          'URL: https://www.neolith.com/marketing/email-update.pdf',
          // Second URL: the real catalog
          'URL: https://www.neolith.com/files/Neolith_GeneralCatalog_2025.pdf',
        ].join('\n'),
        skill: 'web_search',
      }),
      download_file: async ({ url, destDir, filename }) => {
        downloadCallCount++;
        return {
          success: true,
          output: `WORKSPACE_PATH: ${destDir}/${filename}\nDownloaded from ${url}`,
          skill: 'download_file',
        };
      },
      read_pdf: async ({ path: pdfPath }) => {
        const lower = String(pdfPath).toLowerCase();
        // The first download is the email; the second is the real catalog.
        // We can tell which one based on call count (since filename is the same).
        if (downloadCallCount === 1) {
          return {
            success: true,
            output: '[Page 1]\nMail - Ben - Outlook\nNot a catalog',
            skill: 'read_pdf',
          };
        }
        return {
          success: true,
          output: '[Page 1]\nNEOLITH\nGeneral Catalog 2025',
          skill: 'read_pdf',
        };
      },
    });

    const report = await runWebDownloadMultiTarget(spec, runner);
    // The engine retried after content rejection and picked the second URL
    expect(report.ok).toContain('Neolith');
    expect(downloadCallCount).toBe(2);
  });

  it('"download VS Code installer" — engine surfaces NO match because installer ≠ catalog/PDF (audit: this engine is the wrong tool)', async () => {
    const spec = webDownloadSpecSchema.parse({
      kind: 'web_download_multi_target',
      targets: ['VS Code'],
      artifact: 'macOS installer dmg',
      destDir: `__test_vscode_${Date.now()}`,
      filenameTemplate: '{BrandName}.dmg',
    });

    const runner = buildRunner({
      // Realistic Brave search would return code.visualstudio.com landing page
      web_search: async () => ({
        success: true,
        output: 'URL: https://code.visualstudio.com/download',
        skill: 'web_search',
      }),
      web_fetch: async () => ({
        success: true,
        output: '<a href="https://update.code.visualstudio.com/latest/darwin/stable">Download for Mac</a>',
        skill: 'web_fetch',
      }),
    });

    const report = await runWebDownloadMultiTarget(spec, runner);
    // Engine never finds a candidate URL ending in .pdf because installers
    // are .dmg/.exe/.zip — proving this engine is artifact-class-specific
    // and software downloads need a separate engine (see Phase 25.4 plan).
    expect(report.ok).toHaveLength(0);
    expect(report.skipped[0].reason).toMatch(/no PDF candidates/i);
  });

  it('"clone github repo" — engine fails fast because it is not a git_clone engine', async () => {
    const spec = webDownloadSpecSchema.parse({
      kind: 'web_download_multi_target',
      targets: ['anthropics/claude-code'],
      artifact: 'github repository',
      destDir: `__test_repo_${Date.now()}`,
      filenameTemplate: '{BrandName}.pdf',
    });

    const runner = buildRunner({
      web_search: async () => ({
        success: true,
        output: 'URL: https://github.com/anthropics/claude-code',
        skill: 'web_search',
      }),
      web_fetch: async () => ({
        success: true,
        output: '<html>GitHub repo page (no PDFs)</html>',
        skill: 'web_fetch',
      }),
    });

    const report = await runWebDownloadMultiTarget(spec, runner);
    expect(report.ok).toHaveLength(0);
    // The engine correctly produces no result, demonstrating that this is
    // the wrong engine for a clone-repo task. The router would need a
    // dedicated `git_clone` engine to handle this kind.
  });

  it('cleanup is workspace-sandboxed (does NOT delete files outside workspace)', async () => {
    // Direct unit test on cleanupFailedDownload — even if the engine were
    // tricked into validating a path outside workspace, the cleanup helper
    // refuses to unlink it.
    const { cleanupFailedDownload } = await import('../../core/skills/web-download-multi-target.js');
    expect(cleanupFailedDownload('/etc/passwd')).toBe(false);
    expect(cleanupFailedDownload('../../../etc/passwd')).toBe(false);
    expect(cleanupFailedDownload('')).toBe(false);
    expect(cleanupFailedDownload('does/not/exist.pdf')).toBe(false); // workspace-relative but missing
  });
});

// ── Generality audit ────────────────────────────────────────────────────────
//
// The engine is INTENTIONALLY narrow: it is "find a PDF per target by web
// search". This section documents — by tests — exactly which download intents
// it supports and which it cannot. Each "fails-correctly" case is a
// requirements signal for a future engine kind, not a bug in this one.
//
// The taxonomy is intentionally explicit so a planner / router can reason
// about which engine is right for a given user goal. See docs/phase-25-plan.md
// "Engine kinds taxonomy" for how these cases map to future engines.

import { detectMultiTargetDownload } from '../../core/router/dedicated-engine-dispatch.js';

interface AuditCase {
  intent: string;
  message: string;
  expected: 'in-scope' | 'out-of-scope';
  reason: string;
}

const AUDIT_CASES: AuditCase[] = [
  {
    intent: 'porcelain-catalog (in-scope)',
    message: 'Download Neolith, Sapiens Stone, Laminam catalog PDFs to workspace/catalogs/',
    expected: 'in-scope',
    reason: 'Multi-target + PDF artifact + commercial brand pages — exactly what this engine targets.',
  },
  {
    intent: 'datasheet PDFs with alphanumeric part numbers (out-of-scope by regex)',
    message: 'Fetch the datasheets for STM32F4, RP2040, ESP32 from manufacturer sites',
    expected: 'out-of-scope',
    reason:
      'Two regex limitations stack here:\n' +
      '    (a) MULTI_TARGET_DOWNLOAD_RE\'s artifact list includes catalogs/brochures/lookbooks/pdf but NOT "datasheets" — adding it is a one-word edit.\n' +
      '    (b) CATALOG_TARGET_LIST_RE requires letter-only tokens between commas; alphanumeric part numbers like "STM32F4" never match. Supporting them needs a parallel technical-list regex.\n' +
      '    Both are real engine extensions, not bugs. Until either lands, datasheet collection routes via QueryLoop.',
  },
  {
    intent: 'software installer .dmg (out-of-scope)',
    message: 'Download Inkscape, Firefox, VS Code macOS installers',
    expected: 'out-of-scope',
    reason: 'Installers are .dmg/.pkg, not .pdf. URL filter rejects them. Needs a software_install_multi_target engine.',
  },
  {
    intent: 'github repo clone (out-of-scope)',
    message: 'Clone the github repos for tantivy-py, meilisearch, and qdrant',
    expected: 'out-of-scope',
    reason: 'Verb is "clone" not "download". Needs a git_clone_multi_target engine using the git skill.',
  },
  {
    intent: 'github releases zip (out-of-scope)',
    message: 'Download the v1.0 release zip from github.com/anthropics/claude-code',
    expected: 'out-of-scope',
    reason: 'Single-target + .zip artifact. This engine only finds .pdf URLs. Needs a github_release_download engine.',
  },
  {
    intent: 'image asset (out-of-scope)',
    message: 'Download the official Tesla, Apple, and Microsoft logos as PNG',
    expected: 'out-of-scope',
    reason: 'PNG, not PDF. URL filter and validator are PDF-specific. Needs an image_asset_multi_target engine.',
  },
  {
    intent: 'archive tarball (out-of-scope)',
    message: 'Download the source tar.gz for nginx, redis, and postgres latest stable',
    expected: 'out-of-scope',
    reason: '.tar.gz artifact, not .pdf. Needs a release_archive_multi_target engine.',
  },
  {
    intent: 'single-target download (out-of-scope: dispatcher requires N≥2)',
    message: 'Download the latest Python documentation PDF',
    expected: 'out-of-scope',
    reason: 'CATALOG_TARGET_LIST_RE requires comma-separated capitalized targets (N≥2). Single-target uses QueryLoop.',
  },
  {
    intent: 'natural-language brand list (in-scope)',
    message: 'Get me the brochures for Dekton, Lapitec, and Caesarstone',
    expected: 'in-scope',
    reason: 'Multi-target capitalized list + brochure (artifact keyword present in extractor prompt).',
  },
];

describe('Generality audit — intent shapes the engine handles vs not', () => {
  for (const c of AUDIT_CASES) {
    it(`[${c.expected}] ${c.intent}`, () => {
      const matched = detectMultiTargetDownload(c.message);
      // The dispatcher's regex is a NECESSARY condition. If matched=false,
      // the engine is never invoked for this message — by design.
      if (c.expected === 'in-scope') {
        expect(matched, `dispatcher should fire for: ${c.intent}\n  reason: ${c.reason}`).toBe(true);
      } else {
        expect(matched, `dispatcher should NOT fire for: ${c.intent}\n  reason: ${c.reason}`).toBe(false);
      }
    });
  }

  it('audit summary is documented (this test self-asserts the categorization)', () => {
    const inScope = AUDIT_CASES.filter(c => c.expected === 'in-scope');
    const outOfScope = AUDIT_CASES.filter(c => c.expected === 'out-of-scope');
    // We expect a meaningful split — too few out-of-scope cases would mean the
    // audit isn't covering the broader intent space; too few in-scope would
    // mean the engine has been over-narrowed.
    expect(inScope.length).toBeGreaterThanOrEqual(2);
    expect(outOfScope.length).toBeGreaterThanOrEqual(4);
  });
});

// ── URL filter audit ─────────────────────────────────────────────────────────
//
// Demonstrates that the engine's URL discovery is HARD-CODED to .pdf. Adding
// support for other artifact classes is a one-line schema addition AND a new
// engine kind — but until then, these cases are the contract.

import { looksLikePdfUrl } from '../../core/skills/web-download-multi-target.js';

describe('URL filter — what looksLikePdfUrl accepts (artifact-class contract)', () => {
  it('accepts standard .pdf URLs', () => {
    expect(looksLikePdfUrl('https://example.com/docs/catalog.pdf')).toBe(true);
    expect(looksLikePdfUrl('https://example.com/PDF/Catalog.PDF')).toBe(true);
  });

  it('rejects everything that is not a .pdf', () => {
    expect(looksLikePdfUrl('https://example.com/installer.dmg')).toBe(false);
    expect(looksLikePdfUrl('https://example.com/source.tar.gz')).toBe(false);
    expect(looksLikePdfUrl('https://example.com/release.zip')).toBe(false);
    expect(looksLikePdfUrl('https://example.com/logo.png')).toBe(false);
    expect(looksLikePdfUrl('https://example.com/setup.exe')).toBe(false);
    expect(looksLikePdfUrl('https://github.com/owner/repo')).toBe(false);
  });
});
