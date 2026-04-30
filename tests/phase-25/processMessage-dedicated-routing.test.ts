/**
 * End-to-end routing test: prove the dedicated engine is hit for the actual
 * user query that motivated this fix.
 *
 * The original problem: the quick-complexity LLM call inside processMessage
 * could rate a multi-target download as LOW/MEDIUM and route to QueryLoop,
 * never reaching the deterministic engine. The fix hoists the dedicated-engine
 * dispatcher BEFORE the quick-complexity check.
 *
 * This test does NOT verify implementation details. It verifies behavior:
 *   1. For the user's exact porcelain message → engine path is taken
 *   2. For a single-sentence form → engine path is still taken (the bug)
 *   3. For an unrelated question → dispatcher does NOT fire (no false positive)
 *
 * We mock the LLM (to return spec JSON) and intercept transparency events
 * to confirm the route taken.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { transparency } from '../../core/transparency.js';
import type { LLMHandler } from '../../core/types.js';

// ── Mock the skill runner so we don't actually hit the network ───────────────
vi.mock('../../core/skills/runner.js', () => ({
  runSkill: vi.fn(async (name: string) => {
    // Return failed search to force the engine to skip every brand quickly
    return {
      success: false,
      output: '',
      error: `mocked: ${name} unavailable in test`,
      skill: name,
    };
  }),
}));

import { processMessage } from '../../core/agent.js';

interface RouteEvent { type: string; data?: { path?: string; reason?: string } }

function captureRouteEvents(): { events: RouteEvent[]; cleanup: () => void } {
  const events: RouteEvent[] = [];
  const cleanup = transparency.on((event: unknown) => {
    const e = event as RouteEvent;
    if (e.type === 'route' || e.type?.startsWith('web_download_') ||
        e.type?.startsWith('file_batch_') || e.type?.startsWith('api_paginated_')) {
      events.push(e);
    }
  });
  return { events, cleanup };
}

// Mock LLM that returns canned web_download spec JSON (only called if
// processMessage actually reaches the spec extractor)
const validWebDownloadSpec = JSON.stringify({
  kind: 'web_download_multi_target',
  targets: ['Neolith', 'Living Ceramics', 'Sapiens Stone'],
  artifact: '2025/2026 general catalog PDF',
  minBytes: 7340032, // 7 MiB
  destDir: 'Porcelain_PDF/catalogs',
  filenameTemplate: '{BrandName}_generalcatalog.pdf',
});

describe('processMessage → dedicated engine routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transparency.enable();
  });

  afterEach(() => {
    transparency.disable();
  });

  it("routes the user's exact porcelain message to web_download_engine (not QueryLoop)", async () => {
    const message = `Download the 2025/2026 general catalogs for these 3 porcelain slab brands: Neolith, Living Ceramics, Sapiens Stone. For each brand: search for its catalog page, fetch the downloads page to find a direct PDF link, then download the PDF to workspace/Porcelain_PDF/catalogs/ using filename [BrandName]_generalcatalog.pdf. General catalogs are typically 7MB or larger — skip anything smaller (likely a flyer). Report FINAL_STATUS: ok=[] skipped=[] for all three brands.`;

    const llmHandler: LLMHandler = vi.fn().mockResolvedValue(validWebDownloadSpec);
    const { events, cleanup } = captureRouteEvents();

    const result = await processMessage(message, [], { llmHandler });

    cleanup();

    // The engine was activated
    const engineRoute = events.find(e => e.type === 'route' && e.data?.path === 'web_download_engine');
    expect(engineRoute, 'expected route event with path=web_download_engine').toBeDefined();

    // The engine ran (start event fired)
    const engineStart = events.find(e => e.type === 'web_download_engine_start');
    expect(engineStart, 'expected web_download_engine_start event').toBeDefined();

    // The reply is a FINAL_STATUS report (the engine's deterministic output),
    // NOT a QueryLoop free-form summary
    expect(result.reply).toContain('FINAL_STATUS:');
    // All 3 brands should have been skipped (since web_search is mocked to fail)
    expect(result.reply).toContain('Neolith');
    expect(result.reply).toContain('Living Ceramics');
    expect(result.reply).toContain('Sapiens Stone');

    // The LLM was called exactly once — to extract the spec.
    // QueryLoop / planner / decomposition would have called it many more times.
    expect(llmHandler).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("Bug-1 regression (Qwen 3.6 trace): mixed-case lowercase brand list routes to web_download_engine", async () => {
    // The exact failing user message from the Qwen 3.6 trace. Before Phase 25.4
    // the CATALOG_TARGET_LIST_RE required uppercase first letters, so "iris
    // ceramic" and "fiandre" failed detection; the dispatcher returned handled:false
    // and the request fell through to the file/download intent classifier in
    // handleAgenticUnits, which routed to QueryLoop. The diag captured 33
    // iterations and a FINAL_STATUS line written by the LLM (not the engine).
    const message = `Download the 2025/2026 general catalogs for these 3 porcelain slab brands: Porselanosa, iris ceramic, fiandre. For each brand: search for its catalog page, fetch the downloads page to find a direct PDF link, then download the PDF to workspace/Porcelain_PDF/catalogs/ using filename {BrandName}_generalcatalog.pdf. General catalogs are typically 7MB or larger — skip anything smaller (likely a flyer).`;

    const validSpec = JSON.stringify({
      kind: 'web_download_multi_target',
      targets: ['Porselanosa', 'iris ceramic', 'fiandre'],
      artifact: '2025/2026 general catalog PDF',
      minBytes: 7340032,
      destDir: 'Porcelain_PDF/catalogs',
      filenameTemplate: '{BrandName}_generalcatalog.pdf',
    });
    const llmHandler: LLMHandler = vi.fn().mockResolvedValue(validSpec);
    const { events, cleanup } = captureRouteEvents();

    const result = await processMessage(message, [], { llmHandler });

    cleanup();

    const engineRoute = events.find(e => e.type === 'route' && e.data?.path === 'web_download_engine');
    expect(engineRoute, 'expected route event with path=web_download_engine for the Qwen 3.6 trace').toBeDefined();
    const queryLoopRoute = events.find(e => e.type === 'route' && e.data?.path === 'query_loop');
    expect(queryLoopRoute, 'must NOT route to query_loop for canonical multi-target download').toBeUndefined();

    expect(result.reply).toContain('FINAL_STATUS:');
    expect(result.reply).toContain('Porselanosa');
    expect(result.reply).toContain('iris ceramic');
    expect(result.reply).toContain('fiandre');
  }, 30_000);

  it('routes a one-sentence download message (regression: bug was bypass via quick-complexity)', async () => {
    // This is the case the OLD code failed: single-sentence, no "then"/"and then",
    // so isLikelyCompoundMessage returned false → quick-complexity LLM call →
    // LOW/MEDIUM → routed to QueryLoop, bypassing the engine entirely.
    const message = 'Download Neolith, Living Ceramics, Sapiens Stone 2025 catalog PDFs to workspace/Porcelain_PDF/catalogs/';

    const llmHandler: LLMHandler = vi.fn().mockResolvedValue(validWebDownloadSpec);
    const { events, cleanup } = captureRouteEvents();

    const result = await processMessage(message, [], { llmHandler });

    cleanup();

    const engineRoute = events.find(e => e.type === 'route' && e.data?.path === 'web_download_engine');
    expect(engineRoute, 'expected web_download_engine route — bypass should be closed').toBeDefined();

    expect(result.reply).toContain('FINAL_STATUS:');
    // LLM called exactly once for spec extraction
    expect(llmHandler).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('does NOT route a normal question to a dedicated engine (no false positive)', async () => {
    const message = 'What is the capital of France?';

    // This handler will be called many times by the normal pipeline
    // (intake, decomposition, complexity, query loop). We want to verify
    // the dedicated dispatcher did NOT fire.
    const llmHandler: LLMHandler = vi.fn().mockResolvedValue('Paris is the capital of France.');
    const { events, cleanup } = captureRouteEvents();

    await processMessage(message, [], { llmHandler });

    cleanup();

    const engineRoute = events.find(e =>
      e.type === 'route' && (
        e.data?.path === 'web_download_engine' ||
        e.data?.path === 'file_batch_transform_engine' ||
        e.data?.path === 'api_paginated_collect_engine'
      )
    );
    expect(engineRoute, 'no engine should have been routed for a question').toBeUndefined();

    // No engine start events
    const engineStart = events.find(e =>
      e.type === 'web_download_engine_start' ||
      e.type === 'file_batch_engine_start' ||
      e.type === 'api_paginated_collect_engine_start'
    );
    expect(engineStart).toBeUndefined();
  }, 30_000);

  it('falls through gracefully when spec extraction fails (returns null spec)', async () => {
    const message = 'Download Neolith, Sapiens Stone 2025 catalog PDFs to workspace/catalogs/';

    // LLM returns garbage that cannot be parsed as a spec
    const llmHandler: LLMHandler = vi.fn().mockResolvedValue('Sorry, I cannot help with that request.');

    const { events, cleanup } = captureRouteEvents();
    const result = await processMessage(message, [], { llmHandler });
    cleanup();

    // The dispatcher SHOULD have fired (regex matched) but returned handled:false
    // because spec extraction failed. The route event for web_download_engine
    // should still have been emitted (we attempted), but the FINAL_STATUS
    // should NOT be in the reply (engine never ran).
    expect(result.reply).not.toContain('FINAL_STATUS:');

    // Whether the message reaches QueryLoop or another tier, the test asserts
    // we did NOT crash — graceful degradation.
    expect(result.reply).toBeTruthy();
    expect(result.reply.length).toBeGreaterThan(0);
  }, 30_000);
});
