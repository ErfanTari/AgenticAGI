import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  renderFilename, looksLikePdfUrl, buildSearchQuery, extractPdfLinksFromHtml,
  rankCandidatePages, rankPdfLinks, validatePdf, buildReport, renderFinalMessage,
  runWebDownloadMultiTarget,
  MAX_SEARCHES_PER_TARGET, MAX_DOWNLOADS_PER_TARGET,
  type TargetRecord, type SkillRunner,
} from '../../core/skills/web-download-multi-target.js';
import type { WebDownloadSpec } from '../../core/schemas.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseSpec: WebDownloadSpec = {
  kind: 'web_download_multi_target',
  targets: ['Neolith', 'Living Ceramics'],
  artifact: '2025 general catalog PDF',
  minBytes: 200_000,
  destDir: 'Porcelain_PDF/catalogs',
  filenameTemplate: '{BrandName}_generalcatalog.pdf',
};

function makePendingRecord(target: string): TargetRecord {
  return {
    target,
    searches: 0,
    pagesFetched: 0,
    downloads: 0,
    candidateUrls: [],
    bannedUrls: new Set(),
    status: 'pending',
    filePath: null,
    skipReason: null,
  };
}

// ── 1. renderFilename — {BrandName} substitution ─────────────────────────────

describe('renderFilename', () => {
  it('replaces {BrandName} with sanitized brand name', () => {
    expect(renderFilename('{BrandName}_catalog.pdf', 'Neolith')).toBe('Neolith_catalog.pdf');
  });

  it('converts spaces to underscores', () => {
    expect(renderFilename('{BrandName}_catalog.pdf', 'Living Ceramics')).toBe('Living_Ceramics_catalog.pdf');
  });

  it('strips special characters (& and . removed, spaces → underscore)', () => {
    const result = renderFilename('{BrandName}_catalog.pdf', 'Brand & Co.');
    expect(result).toBe('Brand_Co_catalog.pdf');
  });

  it('handles all-caps brand', () => {
    expect(renderFilename('{BrandName}.pdf', 'PORCELAIN')).toBe('PORCELAIN.pdf');
  });

  it('handles single-word brand unchanged', () => {
    expect(renderFilename('{BrandName}_gen.pdf', 'Dekton')).toBe('Dekton_gen.pdf');
  });
});

// ── 2. looksLikePdfUrl ────────────────────────────────────────────────────────

describe('looksLikePdfUrl', () => {
  it('returns true for .pdf extension', () => {
    expect(looksLikePdfUrl('https://brand.com/files/catalog.pdf')).toBe(true);
  });

  it('ignores query string when checking extension', () => {
    expect(looksLikePdfUrl('https://brand.com/download.pdf?token=abc')).toBe(true);
  });

  it('returns false for HTML page', () => {
    expect(looksLikePdfUrl('https://brand.com/downloads/')).toBe(false);
  });

  it('returns false for .pdff (not exact)', () => {
    expect(looksLikePdfUrl('https://brand.com/file.pdff')).toBe(false);
  });
});

// ── 3. buildSearchQuery ───────────────────────────────────────────────────────

describe('buildSearchQuery', () => {
  it('first search includes filetype:pdf', () => {
    const q = buildSearchQuery('Neolith', '2025 general catalog PDF', 0);
    expect(q).toContain('filetype:pdf');
    expect(q).toContain('Neolith');
  });

  it('second search uses different terms', () => {
    const q1 = buildSearchQuery('Neolith', '2025 general catalog PDF', 0);
    const q2 = buildSearchQuery('Neolith', '2025 general catalog PDF', 1);
    expect(q2).not.toEqual(q1);
    expect(q2).toContain('Neolith');
  });
});

// ── 4. extractPdfLinksFromHtml ────────────────────────────────────────────────

describe('extractPdfLinksFromHtml', () => {
  it('finds href .pdf links', () => {
    const html = `<a href="/files/catalog.pdf">Download</a>`;
    const links = extractPdfLinksFromHtml(html, 'https://brand.com');
    expect(links).toContain('https://brand.com/files/catalog.pdf');
  });

  it('resolves relative URLs against baseUrl', () => {
    const html = `<a href="../assets/brochure.pdf">PDF</a>`;
    const links = extractPdfLinksFromHtml(html, 'https://brand.com/en/downloads/');
    expect(links[0]).toMatch(/brand\.com.*brochure\.pdf/);
  });

  it('deduplicates identical links', () => {
    const html = `<a href="/a.pdf">1</a><a href="/a.pdf">2</a>`;
    const links = extractPdfLinksFromHtml(html, 'https://brand.com');
    expect(links.filter(l => l.includes('a.pdf'))).toHaveLength(1);
  });

  it('returns empty array when no pdf links found', () => {
    const html = `<a href="/page.html">Home</a>`;
    expect(extractPdfLinksFromHtml(html, 'https://brand.com')).toHaveLength(0);
  });
});

// ── 5. rankCandidatePages ────────────────────────────────────────────────────

describe('rankCandidatePages', () => {
  it('flipbook domain scored lower than brand-matching URL', () => {
    const record = makePendingRecord('Neolith');
    const urls = [
      'https://issuu.com/neolith/docs/catalog',
      'https://www.neolith.com/en/downloads/',
    ];
    const ranked = rankCandidatePages(urls, record);
    expect(ranked[0]).toContain('neolith.com');
  });

  it('filters out banned URLs from record', () => {
    const record = makePendingRecord('Neolith');
    const banned = 'https://www.neolith.com/banned';
    record.bannedUrls.add(banned);
    const ranked = rankCandidatePages([banned, 'https://www.neolith.com/ok'], record);
    expect(ranked).not.toContain(banned);
  });
});

// ── 6. rankPdfLinks ──────────────────────────────────────────────────────────

describe('rankPdfLinks', () => {
  it('artifact keyword bonus bumps relevant link higher', () => {
    const record = makePendingRecord('Dekton');
    const links = [
      'https://cdn.dekton.com/random-document.pdf',
      'https://cdn.dekton.com/2025-general-catalog.pdf',
    ];
    const ranked = rankPdfLinks(links, baseSpec, record);
    expect(ranked[0]).toContain('2025');
  });

  it('filters banned domain links', () => {
    const record = makePendingRecord('Test');
    const links = ['https://issuu.com/test/catalog.pdf', 'https://test.com/catalog.pdf'];
    const ranked = rankPdfLinks(links, baseSpec, record);
    expect(ranked).not.toContain('https://issuu.com/test/catalog.pdf');
  });
});

// ── 7. validatePdf ───────────────────────────────────────────────────────────

describe('validatePdf', () => {
  it('returns ok=false when read_pdf fails', async () => {
    const runSkill: SkillRunner = vi.fn().mockResolvedValue({ success: false, output: '', error: 'PDF parse error' });
    const result = await validatePdf('Porcelain_PDF/catalogs/test.pdf', 200_000, runSkill);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('read_pdf failed');
  });

  it('returns ok=true when read_pdf succeeds', async () => {
    const runSkill: SkillRunner = vi.fn().mockResolvedValue({ success: true, output: '[Page 1]\nHello' });
    const result = await validatePdf('Porcelain_PDF/catalogs/test.pdf', 0, runSkill);
    expect(result.ok).toBe(true);
  });
});

// ── 8. buildReport ───────────────────────────────────────────────────────────

describe('buildReport', () => {
  it('correctly splits ok and skipped from ledger', () => {
    const ledger: TargetRecord[] = [
      { ...makePendingRecord('BrandA'), status: 'ok', filePath: 'dir/BrandA.pdf' },
      { ...makePendingRecord('BrandB'), status: 'skipped', skipReason: 'no PDF found' },
    ];
    const report = buildReport(ledger, 5000);
    expect(report.ok).toEqual(['BrandA']);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].target).toBe('BrandB');
  });
});

// ── 9. renderFinalMessage ────────────────────────────────────────────────────

describe('renderFinalMessage', () => {
  it('includes FINAL_STATUS, ok, skipped, and destDir', () => {
    const report = {
      ok: ['Neolith'],
      skipped: [{ target: 'Living Ceramics', reason: 'no PDF found' }],
      ledger: [],
      totalMs: 12000,
    };
    const msg = renderFinalMessage(report, baseSpec);
    expect(msg).toContain('FINAL_STATUS:');
    expect(msg).toContain('ok=[Neolith]');
    expect(msg).toContain('Living Ceramics');
    expect(msg).toContain('Porcelain_PDF/catalogs');
  });
});

// ── 10–16. runWebDownloadMultiTarget integration ──────────────────────────────

describe('runWebDownloadMultiTarget', () => {
  let runSkill: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    runSkill = vi.fn();
  });

  function mockSearch(urls: string[]) {
    return { success: true, output: urls.map(u => `URL: ${u}`).join('\n') };
  }
  function mockFetch(pdfLinks: string[]) {
    return { success: true, output: pdfLinks.map(u => `<a href="${u}">PDF</a>`).join('') };
  }
  function mockDownload(filename: string) {
    return { success: true, output: `Downloaded 8000000 bytes\nWORKSPACE_PATH: Porcelain_PDF/catalogs/${filename}\nMIME: application/pdf` };
  }
  function mockReadPdf(brand: string = 'Neolith') {
    // Realistic catalog cover-page text. The new content-relevance check in
    // validatePdf requires both the brand name AND an artifact keyword.
    return { success: true, output: `[Page 1]\n${brand}\nGeneral Catalog 2025\nProducts and Collections` };
  }

  it('succeeds when search returns direct PDF URL and download validates', async () => {
    const spec = { ...baseSpec, targets: ['Neolith'] };
    runSkill
      .mockResolvedValueOnce(mockSearch(['https://neolith.com/catalog.pdf']))
      .mockResolvedValueOnce(mockDownload('Neolith_generalcatalog.pdf'))
      .mockResolvedValueOnce(mockReadPdf());

    const report = await runWebDownloadMultiTarget(spec, runSkill);
    expect(report.ok).toContain('Neolith');
  });

  it('skips target when search returns no results', async () => {
    const spec = { ...baseSpec, targets: ['UnknownBrand'] };
    runSkill.mockResolvedValue({ success: true, output: 'No results found' });

    const report = await runWebDownloadMultiTarget(spec, runSkill);
    expect(report.ok).toHaveLength(0);
    expect(report.skipped[0].target).toBe('UnknownBrand');
  });

  it('bans URL after download failure and tries next candidate', async () => {
    const spec = { ...baseSpec, targets: ['Neolith'] };
    runSkill
      .mockResolvedValueOnce(mockSearch(['https://bad.com/catalog.pdf', 'https://neolith.com/real.pdf']))
      .mockResolvedValueOnce({ success: false, output: '', error: 'HTTP 403' }) // first URL fails
      .mockResolvedValueOnce(mockDownload('Neolith_generalcatalog.pdf')) // second URL succeeds
      .mockResolvedValueOnce(mockReadPdf());

    const report = await runWebDownloadMultiTarget(spec, runSkill);
    expect(report.ok).toContain('Neolith');
  });

  it('does not exceed MAX_DOWNLOADS_PER_TARGET download attempts', async () => {
    const spec = { ...baseSpec, targets: ['Neolith'] };
    const failDl = { success: false, output: '', error: 'HTTP 404' };

    runSkill
      .mockResolvedValueOnce(mockSearch(['https://a.com/1.pdf', 'https://b.com/2.pdf', 'https://c.com/3.pdf', 'https://d.com/4.pdf']))
      .mockResolvedValue(failDl);

    const report = await runWebDownloadMultiTarget(spec, runSkill);
    const downloadCalls = runSkill.mock.calls.filter(([name]) => name === 'download_file');
    expect(downloadCalls.length).toBeLessThanOrEqual(MAX_DOWNLOADS_PER_TARGET);
    expect(report.skipped[0].target).toBe('Neolith');
  });

  it('does not exceed MAX_SEARCHES_PER_TARGET search attempts', async () => {
    const spec = { ...baseSpec, targets: ['Neolith'] };
    runSkill.mockResolvedValue({ success: true, output: 'No results found' });

    await runWebDownloadMultiTarget(spec, runSkill);
    const searchCalls = runSkill.mock.calls.filter(([name]) => name === 'web_search');
    expect(searchCalls.length).toBeLessThanOrEqual(MAX_SEARCHES_PER_TARGET);
  });

  it('handles two targets independently — success for one, skip for other', async () => {
    runSkill
      // Neolith: search returns PDF → download → validate
      .mockResolvedValueOnce(mockSearch(['https://neolith.com/catalog.pdf']))
      .mockResolvedValueOnce(mockDownload('Neolith_generalcatalog.pdf'))
      .mockResolvedValueOnce(mockReadPdf())
      // Living Ceramics: search returns nothing
      .mockResolvedValueOnce({ success: true, output: 'No results found' })
      .mockResolvedValueOnce({ success: true, output: 'No results found' });

    const report = await runWebDownloadMultiTarget(baseSpec, runSkill);
    expect(report.ok).toContain('Neolith');
    expect(report.skipped.map(s => s.target)).toContain('Living Ceramics');
  });
});

// ── 17–18. extractWebDownloadSpec ────────────────────────────────────────────

describe('extractWebDownloadSpec', () => {
  it('parses valid spec from representative user message', async () => {
    const { extractWebDownloadSpec } = await import('../../core/skills/web-download-spec-extractor.js');
    const validJson = JSON.stringify({
      kind: 'web_download_multi_target',
      targets: ['Neolith', 'Living Ceramics', 'Sapiens Stone'],
      artifact: '2025 general catalog PDF',
      minBytes: 7000000,
      destDir: 'Porcelain_PDF/catalogs',
      filenameTemplate: '{BrandName}_generalcatalog.pdf',
    });
    const handler = vi.fn().mockResolvedValue(validJson);
    const spec = await extractWebDownloadSpec(
      'Download the 2025 general catalogs for Neolith, Living Ceramics, Sapiens Stone into workspace/Porcelain_PDF/catalogs',
      handler,
    );
    expect(spec).not.toBeNull();
    expect(spec!.targets).toContain('Neolith');
    expect(spec!.kind).toBe('web_download_multi_target');
  });

  it('returns null when LLM returns non-parseable response', async () => {
    const { extractWebDownloadSpec } = await import('../../core/skills/web-download-spec-extractor.js');
    const handler = vi.fn().mockResolvedValue('Sorry, I cannot help with that.');
    const spec = await extractWebDownloadSpec('download stuff', handler);
    expect(spec).toBeNull();
  });
});

// ── 19–20. detectMultiTargetDownload ─────────────────────────────────────────

describe('detectMultiTargetDownload', () => {
  // Test the detection logic directly by reproducing it here
  const MULTI_TARGET_DOWNLOAD_RE = /\b(download|find|fetch|get|grab)\b[\s\S]{0,200}?\b(catalogs?|catalogues?|brochures?|lookbooks?|pdf)\b/i;
  const CATALOG_TARGET_LIST_RE = /[A-Z][a-zA-Z]+(?:\s*,\s*[A-Z][a-zA-Z]+){1,}/;
  function detect(msg: string) {
    return MULTI_TARGET_DOWNLOAD_RE.test(msg) && CATALOG_TARGET_LIST_RE.test(msg);
  }

  it('true for "download Neolith, SapienStone, Living Ceramics 2025 catalog PDF"', () => {
    expect(detect('download Neolith, SapienStone, Living Ceramics 2025 catalog PDF')).toBe(true);
  });

  it('false for single target "download a single PDF"', () => {
    expect(detect('download a single PDF')).toBe(false);
  });

  it('false for "search the web for news"', () => {
    expect(detect('search the web for news')).toBe(false);
  });

  it('true for "fetch catalogs for Dekton, Laminam, Flaviker"', () => {
    expect(detect('fetch catalogs for Dekton, Laminam, Flaviker')).toBe(true);
  });
});
