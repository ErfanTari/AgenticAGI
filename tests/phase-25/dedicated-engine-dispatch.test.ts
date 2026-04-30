/**
 * Tests for the dedicated-engine dispatcher (Phase 25 routing fix).
 *
 * The dispatcher is the single source of truth for "should this message
 * fire the web_download / file_batch / api_paginated engines?". It runs
 * BEFORE the quick-complexity LLM call in processMessage to ensure messages
 * that match a dedicated kind never get rerouted to QueryLoop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectMultiTargetDownload,
  detectFileBatchTransform,
  detectApiPaginatedCollect,
  dispatchDedicatedEngine,
} from '../../core/router/dedicated-engine-dispatch.js';
import {
  stripWorkspacePrefix,
  webDownloadSpecSchema,
  fileBatchTransformSpecSchema,
  apiPaginatedCollectSpecSchema,
} from '../../core/schemas.js';
import { transparency, type TransparencyEventEnvelope } from '../../core/transparency.js';

// ── Detection regex tests ────────────────────────────────────────────────────

describe('detectMultiTargetDownload', () => {
  it('matches the original Phase 24 user message', () => {
    const msg = `Download the 2025/2026 general catalogs for these 3 porcelain slab brands: Neolith, Living Ceramics, Sapiens Stone. For each brand: search for its catalog page, fetch the downloads page to find a direct PDF link, then download the PDF to workspace/Porcelain_PDF/catalogs/ using filename [BrandName]_generalcatalog.pdf. General catalogs are typically 7MB or larger — skip anything smaller (likely a flyer). Report FINAL_STATUS: ok=[] skipped=[] for all three brands.`;
    expect(detectMultiTargetDownload(msg)).toBe(true);
  });

  it('matches a SHORT one-sentence form that decomposition would treat as conversational', () => {
    const msg = 'Download Neolith, Living Ceramics, Sapiens Stone 2025 catalog PDFs to workspace/catalogs/';
    expect(detectMultiTargetDownload(msg)).toBe(true);
  });

  it('matches "fetch catalogs for Dekton, Laminam, Flaviker"', () => {
    expect(detectMultiTargetDownload('fetch catalogs for Dekton, Laminam, Flaviker')).toBe(true);
  });

  it('does not match single-target download', () => {
    expect(detectMultiTargetDownload('download a catalog from neolith.com')).toBe(false);
  });

  it('does not match a question about catalogs', () => {
    expect(detectMultiTargetDownload('what catalogs do we have for Neolith and SapienStone?')).toBe(false);
  });

  // ── Phase 25.4 regression suite — failing trace from Qwen 3.6 ───────────
  // The router silently downgraded this exact message to QueryLoop because
  // CATALOG_TARGET_LIST_RE required uppercase first letters. The mixed-case
  // "iris ceramic" and lowercase "fiandre" failed the regex; the engine
  // never fired; QueryLoop ran 33 iterations and hallucinated a FINAL_STATUS
  // line. The fix relaxes the regex to allow lowercase first letters.

  it('Bug-1 regression: matches mixed-case cataphoric brand list (Porselanosa, iris ceramic, fiandre)', () => {
    const msg = `Download the 2025/2026 general catalogs for these 3 porcelain slab brands: Porselanosa, iris ceramic, fiandre. For each brand: search for its catalog page, fetch the downloads page to find a direct PDF link, then download the PDF to workspace/Porcelain_PDF/catalogs/ using filename {BrandName}_generalcatalog.pdf. General catalogs are typically 7MB or larger — skip anything smaller (likely a flyer).`;
    expect(detectMultiTargetDownload(msg)).toBe(true);
  });

  it('matches all-lowercase brand list', () => {
    expect(detectMultiTargetDownload('download catalogs for porcelain slab brands: porselanosa, iris ceramic, fiandre')).toBe(true);
  });

  it('matches all-uppercase brand list', () => {
    expect(detectMultiTargetDownload('Download PDF catalogs for NEOLITH, DEKTON, LAMINAM')).toBe(true);
  });

  it('matches Oxford-comma brand list with "and" before the last item', () => {
    expect(detectMultiTargetDownload('Download catalogs for Neolith, Dekton, and Laminam')).toBe(true);
  });

  it('matches brand list followed by additional task instructions', () => {
    const msg = 'Download catalogs for Neolith, Dekton, Laminam. For each brand: search the page, then download the PDF to workspace/catalogs/.';
    expect(detectMultiTargetDownload(msg)).toBe(true);
  });

  it('matches brand list with two-word lowercase names', () => {
    expect(detectMultiTargetDownload('Download catalogs for these brands: living ceramics, sapiens stone, iris ceramic')).toBe(true);
  });
});

describe('detectFileBatchTransform', () => {
  it('matches "convert all PDFs in workspace/inbox to text"', () => {
    expect(detectFileBatchTransform('convert all PDFs in the workspace/inbox folder to text files')).toBe(true);
  });

  it('matches "extract text from every PDF in the folder"', () => {
    expect(detectFileBatchTransform('extract text from every PDF in the inbox folder')).toBe(true);
  });

  it('does not match a single-file copy', () => {
    expect(detectFileBatchTransform('copy this PDF to my desktop')).toBe(false);
  });
});

describe('detectApiPaginatedCollect', () => {
  it('matches "collect all issues from the GitHub API into JSONL"', () => {
    expect(detectApiPaginatedCollect('collect all issues from the GitHub API into a jsonl file')).toBe(true);
  });

  it('matches with explicit URL', () => {
    expect(detectApiPaginatedCollect('mirror records from https://api.example.com/v1/items into workspace/data/')).toBe(true);
  });

  it('does not match a generic "fetch the page" without URL/api keyword', () => {
    expect(detectApiPaginatedCollect('fetch the news for me')).toBe(false);
  });
});

// ── Dispatcher tests ─────────────────────────────────────────────────────────

describe('dispatchDedicatedEngine', () => {
  it('returns handled:false on a message that matches no kind', async () => {
    const result = await dispatchDedicatedEngine('hello, what is the weather like?', vi.fn());
    expect(result.handled).toBe(false);
  });

  it('routes a multi-target download message to web_download_engine', async () => {
    const validSpec = JSON.stringify({
      kind: 'web_download_multi_target',
      targets: ['Neolith', 'Sapiens Stone'],
      artifact: '2025 general catalog PDF',
      minBytes: 7000000,
      destDir: 'Porcelain_PDF/catalogs',
      filenameTemplate: '{BrandName}_generalcatalog.pdf',
    });
    // LLM is consulted ONLY to extract the spec
    const llmHandler = vi.fn().mockResolvedValue(validSpec);

    const result = await dispatchDedicatedEngine(
      'Download Neolith, Sapiens Stone 2025 catalog PDFs to workspace/Porcelain_PDF/catalogs/',
      llmHandler,
      {
        // Inject a mock skill runner so download_file/web_search etc. don't actually run
        runSkill: vi.fn().mockImplementation(async (name: string) => {
          if (name === 'web_search') return { success: true, output: '' };
          if (name === 'web_fetch') return { success: true, output: '' };
          return { success: false, output: '', error: 'no candidates' };
        }),
      },
    );

    expect(result.handled).toBe(true);
    expect(result.kind).toBe('web_download_multi_target');
    expect(result.reply).toContain('FINAL_STATUS:');
    expect(result.reply).toContain('skipped=');
    expect(llmHandler).toHaveBeenCalledTimes(1);
  });

  it('falls through (handled:false) when spec extraction fails', async () => {
    const llmHandler = vi.fn().mockResolvedValue('Sorry, I cannot help with that.');

    const result = await dispatchDedicatedEngine(
      'Download Neolith, Sapiens Stone 2025 catalog PDFs to workspace/Porcelain_PDF/catalogs/',
      llmHandler,
    );

    // Detection matched but the spec was unparseable — graceful fall-through to next router tier
    expect(result.handled).toBe(false);
  });

  it('routes a file batch transform request to the file engine', async () => {
    const validSpec = JSON.stringify({
      kind: 'file_batch_transform',
      source: { glob: 'inbox/*.pdf' },
      transform: { kind: 'extract_text_from_pdf' },
      destDir: 'outputs/text',
      filenameTemplate: '{stem}.txt',
      validation: { minBytes: 10 },
      overwrite: 'if-missing',
    });
    const llmHandler = vi.fn().mockResolvedValue(validSpec);

    const result = await dispatchDedicatedEngine(
      'extract text from every PDF in the inbox folder into outputs/text',
      llmHandler,
      {
        runSkill: vi.fn().mockResolvedValue({ success: false, output: '', error: 'no files' }),
      },
    );

    expect(result.handled).toBe(true);
    expect(result.kind).toBe('file_batch_transform');
    expect(result.reply).toContain('FINAL_STATUS:');
  });

  it('routes an API paginated collect request to the api engine', async () => {
    const validSpec = JSON.stringify({
      kind: 'api_paginated_collect',
      endpoint: 'https://api.example.com/items',
      auth: { kind: 'none' },
      pagination: { kind: 'offset', offsetParam: 'offset', limitParam: 'limit', limit: 100 },
      destFile: 'data/items.jsonl',
      maxRecords: 500,
      maxPages: 5,
    });
    const llmHandler = vi.fn().mockResolvedValue(validSpec);

    const result = await dispatchDedicatedEngine(
      'collect all items from https://api.example.com/items into workspace/data/items.jsonl',
      llmHandler,
      {
        // Provide a fetchFn so we don't actually hit the network
        fetchFn: vi.fn().mockResolvedValue({ status: 200, headers: {}, body: [] }),
      },
    );

    expect(result.handled).toBe(true);
    expect(result.kind).toBe('api_paginated_collect');
    expect(result.reply).toContain('FINAL_STATUS:');
  });

  // ── Path normalization (defends against `workspace/workspace/X` doubling) ──

  it('schema strips a leading workspace/ prefix from web_download destDir', () => {
    const parsed = webDownloadSpecSchema.parse({
      kind: 'web_download_multi_target',
      targets: ['Foo', 'Bar'],
      artifact: 'catalog PDF',
      destDir: 'workspace/Porcelain_PDF/catalogs',
      filenameTemplate: '{BrandName}.pdf',
    });
    expect(parsed.destDir).toBe('Porcelain_PDF/catalogs');
  });

  it('schema strips ./workspace/ from file_batch destDir and source.glob', () => {
    const parsed = fileBatchTransformSpecSchema.parse({
      kind: 'file_batch_transform',
      source: { glob: './workspace/inbox/*.pdf' },
      transform: { kind: 'extract_text_from_pdf' },
      destDir: 'workspace/outputs/text',
      filenameTemplate: '{stem}.txt',
    });
    expect(parsed.source.glob).toBe('inbox/*.pdf');
    expect(parsed.destDir).toBe('outputs/text');
  });

  it('schema strips workspace/ from api_paginated destFile', () => {
    const parsed = apiPaginatedCollectSpecSchema.parse({
      kind: 'api_paginated_collect',
      endpoint: 'https://example.com/api',
      pagination: { kind: 'offset', offsetParam: 'offset', limitParam: 'limit', limit: 100 },
      destFile: 'workspace/data/items.jsonl',
    });
    expect(parsed.destFile).toBe('data/items.jsonl');
  });

  it('stripWorkspacePrefix is idempotent and handles edge cases', () => {
    expect(stripWorkspacePrefix('workspace/x')).toBe('x');
    expect(stripWorkspacePrefix('Workspace/x')).toBe('x'); // case-insensitive
    expect(stripWorkspacePrefix('./workspace/x')).toBe('x');
    expect(stripWorkspacePrefix('workspace//x')).toBe('x'); // collapses // to /
    expect(stripWorkspacePrefix('foo/bar')).toBe('foo/bar'); // no prefix → unchanged
    expect(stripWorkspacePrefix('  workspace/x  ')).toBe('x'); // trims first
    // Idempotent
    expect(stripWorkspacePrefix(stripWorkspacePrefix('workspace/x'))).toBe('x');
  });

  // ── Phase 25.4: routing transparency events ─────────────────────────────

  describe('route_consider transparency events (Bug 2)', () => {
    let captured: TransparencyEventEnvelope[];
    let off: () => void;

    beforeEach(() => {
      captured = [];
      transparency.enable();
      off = transparency.on(e => captured.push(e));
    });

    afterEach(() => {
      off();
      transparency.disable();
    });

    it('emits a route_consider event for ALL THREE tiers, even when no tier matches', async () => {
      await dispatchDedicatedEngine('hello, what is the weather like?', vi.fn());

      const considers = captured.filter(e => e.type === 'route_consider') as Extract<
        TransparencyEventEnvelope,
        { type: 'route_consider' }
      >[];
      expect(considers).toHaveLength(3);
      const tiers = considers.map(c => c.data.tier);
      expect(tiers).toEqual(['web_download_engine', 'file_batch_transform', 'api_paginated_collect']);
      // None should match
      expect(considers.every(c => c.data.matched === false)).toBe(true);
      // Each should carry per-sub-regex details for the diag formatter
      expect(considers[0].data.details).toMatchObject({
        MULTI_TARGET_DOWNLOAD_RE: expect.any(Boolean),
        CATALOG_TARGET_LIST_RE: expect.any(Boolean),
      });
    });

    it('emits route_consider for all three tiers even when Tier 1a wins', async () => {
      const validSpec = JSON.stringify({
        kind: 'web_download_multi_target',
        targets: ['Neolith', 'Sapiens Stone'],
        artifact: 'catalog PDF',
        destDir: 'catalogs',
        filenameTemplate: '{BrandName}.pdf',
      });
      await dispatchDedicatedEngine(
        'Download Neolith, Sapiens Stone catalog PDFs to workspace/catalogs/',
        vi.fn().mockResolvedValue(validSpec),
        { runSkill: vi.fn().mockResolvedValue({ success: false, output: '', error: 'no' }) },
      );

      const considers = captured.filter(e => e.type === 'route_consider');
      expect(considers).toHaveLength(3);
    });

    it('emits route_consider for the failing user trace (Porselanosa, iris ceramic, fiandre)', async () => {
      const msg = `Download the 2025/2026 general catalogs for these 3 porcelain slab brands: Porselanosa, iris ceramic, fiandre. For each brand: search for its catalog page, fetch the downloads page to find a direct PDF link, then download the PDF to workspace/Porcelain_PDF/catalogs/ using filename {BrandName}_generalcatalog.pdf.`;
      // Send a refusal so spec extraction fails — we still want all three considers emitted up front
      await dispatchDedicatedEngine(msg, vi.fn().mockResolvedValue('Sorry, I cannot help.'));

      const considers = captured.filter(e => e.type === 'route_consider') as Extract<
        TransparencyEventEnvelope,
        { type: 'route_consider' }
      >[];
      expect(considers).toHaveLength(3);
      const t1 = considers.find(c => c.data.tier === 'web_download_engine');
      expect(t1?.data.matched).toBe(true);
      expect(t1?.data.details).toMatchObject({
        MULTI_TARGET_DOWNLOAD_RE: true,
        CATALOG_TARGET_LIST_RE: true,
      });
    });
  });

  describe('spec_extraction transparency events (Bug 3)', () => {
    let captured: TransparencyEventEnvelope[];
    let off: () => void;

    beforeEach(() => {
      captured = [];
      transparency.enable();
      off = transparency.on(e => captured.push(e));
    });

    afterEach(() => {
      off();
      transparency.disable();
    });

    it('emits spec_extraction with rawLlmOutput when extractor returns null', async () => {
      const refusal = 'Sorry, I cannot help with that.';
      await dispatchDedicatedEngine(
        'Download Neolith, Sapiens Stone PDFs to workspace/catalogs/',
        vi.fn().mockResolvedValue(refusal),
      );

      const specs = captured.filter(e => e.type === 'spec_extraction') as Extract<
        TransparencyEventEnvelope,
        { type: 'spec_extraction' }
      >[];
      expect(specs).toHaveLength(1);
      expect(specs[0].data).toMatchObject({
        engine: 'web_download_engine',
        attempted: true,
        succeeded: false,
      });
      expect(typeof specs[0].data.reason).toBe('string');
      expect(specs[0].data.reason!.length).toBeGreaterThan(0);
      // The raw LLM output must be captured (truncated, but non-empty) so the
      // diag layer can show what the model actually produced.
      expect(specs[0].data.rawLlmOutput).toContain('Sorry');
    });

    it('emits spec_extraction with succeeded:true on a clean spec extraction', async () => {
      const validSpec = JSON.stringify({
        kind: 'web_download_multi_target',
        targets: ['Neolith', 'Sapiens Stone'],
        artifact: 'catalog PDF',
        destDir: 'catalogs',
        filenameTemplate: '{BrandName}.pdf',
      });
      await dispatchDedicatedEngine(
        'Download Neolith, Sapiens Stone PDFs to workspace/catalogs/',
        vi.fn().mockResolvedValue(validSpec),
        { runSkill: vi.fn().mockResolvedValue({ success: false, output: '', error: 'no' }) },
      );

      const specs = captured.filter(e => e.type === 'spec_extraction') as Extract<
        TransparencyEventEnvelope,
        { type: 'spec_extraction' }
      >[];
      expect(specs).toHaveLength(1);
      expect(specs[0].data).toMatchObject({
        engine: 'web_download_engine',
        attempted: true,
        succeeded: true,
      });
    });

    it('emits final_reply_origin=engine when Tier 1a actually fires', async () => {
      const validSpec = JSON.stringify({
        kind: 'web_download_multi_target',
        targets: ['Neolith', 'Sapiens Stone'],
        artifact: 'catalog PDF',
        destDir: 'catalogs',
        filenameTemplate: '{BrandName}.pdf',
      });
      await dispatchDedicatedEngine(
        'Download Neolith, Sapiens Stone PDFs to workspace/catalogs/',
        vi.fn().mockResolvedValue(validSpec),
        { runSkill: vi.fn().mockResolvedValue({ success: false, output: '', error: 'no' }) },
      );

      const origin = captured.find(e => e.type === 'final_reply_origin') as Extract<
        TransparencyEventEnvelope,
        { type: 'final_reply_origin' }
      > | undefined;
      expect(origin?.data.origin).toBe('engine');
      expect(origin?.data.engine).toBe('web_download_multi_target');
    });
  });

  it('Tier 1 (web_download) wins when message could match multiple kinds', async () => {
    // This message contains "fetch" (api verb) AND comma-separated brands (download)
    const validSpec = JSON.stringify({
      kind: 'web_download_multi_target',
      targets: ['Neolith', 'SapienStone'],
      artifact: 'catalog PDF',
      minBytes: 7000000,
      destDir: 'catalogs',
      filenameTemplate: '{BrandName}.pdf',
    });
    const llmHandler = vi.fn().mockResolvedValue(validSpec);

    const result = await dispatchDedicatedEngine(
      'Download and fetch catalogs for Neolith, SapienStone PDFs to workspace/catalogs/',
      llmHandler,
      { runSkill: vi.fn().mockResolvedValue({ success: false, output: '', error: 'no' }) },
    );

    // Tier 1 (web_download) takes precedence
    expect(result.kind).toBe('web_download_multi_target');
  });
});
