/**
 * Phase 24 — Deterministic multi-target web download engine.
 * State lives in TargetRecord[], never in an LLM context.
 * Counters drive all retry decisions — no prompt injections.
 */
import { statSync } from 'node:fs';
import type { SkillResult } from './types.js';
import type { WebDownloadSpec } from '../schemas.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_SEARCHES_PER_TARGET = 2;
export const MAX_PAGES_PER_TARGET = 3;
export const MAX_DOWNLOADS_PER_TARGET = 3;
export const MAX_TOTAL_MS = 120_000;

const BANNED_DOMAINS = new Set([
  'issuu.com', 'fliphtml5.com', 'yumpu.com', 'calameo.com', 'joomag.com',
  'pubhtml5.com', 'pdf.archiexpo.com', 'archiexpo.com',
]);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TargetRecord {
  target: string;
  searches: number;
  pagesFetched: number;
  downloads: number;
  candidateUrls: string[];
  bannedUrls: Set<string>;
  status: 'pending' | 'ok' | 'skipped';
  filePath: string | null;
  skipReason: string | null;
}

export interface DownloadReport {
  ok: string[];
  skipped: Array<{ target: string; reason: string }>;
  ledger: TargetRecord[];
  totalMs: number;
}

export type SkillRunner = (name: string, input: Record<string, unknown>) => Promise<SkillResult>;

// ── Helpers ───────────────────────────────────────────────────────────────────

export function buildSearchQuery(target: string, artifact: string, attempt: number): string {
  if (attempt === 0) {
    return `${target} ${artifact} filetype:pdf`;
  }
  return `${target} official catalog PDF 2025 download`;
}

export function looksLikePdfUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return pathname.endsWith('.pdf');
  } catch {
    return url.toLowerCase().includes('.pdf');
  }
}

export function renderFilename(template: string, target: string): string {
  const safe = target.replace(/[^a-zA-Z0-9\s_\-]/g, '').replace(/\s+/g, '_');
  return template.replace(/\{BrandName\}/g, safe);
}

export function extractPdfLinksFromHtml(html: string, baseUrl: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  // Match href and src attributes
  const attrRe = /(?:href|src)=["']([^"']+\.pdf[^"']*?)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(html)) !== null) {
    try {
      const resolved = new URL(m[1], baseUrl).href;
      if (!seen.has(resolved)) { seen.add(resolved); results.push(resolved); }
    } catch { /* skip malformed */ }
  }

  // Also scan for anchor text near .pdf
  const textRe = /href=["']([^"']+)["'][^>]*>(?:[^<]{0,80}(?:catalog|catalogue|brochure|download)[^<]{0,80})<\/a>/gi;
  while ((m = textRe.exec(html)) !== null) {
    if (m[1].toLowerCase().includes('.pdf')) {
      try {
        const resolved = new URL(m[1], baseUrl).href;
        if (!seen.has(resolved)) { seen.add(resolved); results.push(resolved); }
      } catch { /* skip */ }
    }
  }

  return results;
}

function scorePage(url: string, record: TargetRecord): number {
  let score = 0;
  const lower = url.toLowerCase();
  const targetSlug = record.target.toLowerCase().replace(/\s+/g, '');
  if (lower.includes(targetSlug)) score += 3;
  for (const word of record.target.toLowerCase().split(/\s+/)) {
    if (word.length >= 3 && lower.includes(word)) score += 2;
  }
  try {
    const rawHost = new URL(url).hostname;
    const hostname = rawHost.replace(/^www\./, '');
    if (BANNED_DOMAINS.has(hostname) || BANNED_DOMAINS.has(rawHost)) score -= 5;
  } catch { /* skip */ }
  if (lower.includes('login') || lower.includes('signin') || lower.includes('register') || lower.includes('account')) score -= 3;
  return score;
}

export function rankCandidatePages(urls: string[], record: TargetRecord): string[] {
  return urls
    .filter(u => !record.bannedUrls.has(u))
    .map(u => ({ url: u, score: scorePage(u, record) }))
    .filter(({ score }) => score > -4)
    .sort((a, b) => b.score - a.score)
    .map(({ url }) => url);
}

function scorePdfLink(url: string, spec: WebDownloadSpec, record: TargetRecord): number {
  let score = 0;
  const lower = url.toLowerCase();
  for (const kw of spec.artifact.toLowerCase().split(/\s+/)) {
    if (kw.length >= 3 && lower.includes(kw)) score += 2;
  }
  if (lower.includes(record.target.toLowerCase())) score += 1;
  try {
    const rawHost = new URL(url).hostname;
    const hostname = rawHost.replace(/^www\./, '');
    if (BANNED_DOMAINS.has(hostname) || BANNED_DOMAINS.has(rawHost)) score -= 10;
  } catch { /* skip */ }
  return score;
}

export function rankPdfLinks(links: string[], spec: WebDownloadSpec, record: TargetRecord): string[] {
  return links
    .filter(u => !record.bannedUrls.has(u))
    .map(u => ({ url: u, score: scorePdfLink(u, spec, record) }))
    .filter(({ score }) => score > -4) // drop flipbook/banned domains
    .sort((a, b) => b.score - a.score)
    .map(({ url }) => url);
}

function parseSearchResults(output: string): string[] {
  // Extract URLs from web_search output — look for lines starting with "URL:"
  const urls: string[] = [];
  for (const line of output.split('\n')) {
    const m = line.match(/URL:\s*(https?:\/\/\S+)/i);
    if (m) urls.push(m[1].trim());
    // Also match bare https:// lines
    const bare = line.match(/^\s*(https?:\/\/\S+)\s*$/);
    if (bare) urls.push(bare[1].trim());
  }
  return [...new Set(urls)];
}

function extractWorkspacePath(output: string): string | null {
  const m = output.match(/WORKSPACE_PATH:\s*(.+)/);
  return m ? m[1].trim() : null;
}

export async function validatePdf(
  filePath: string,
  minBytes: number,
  runSkill: SkillRunner,
): Promise<{ ok: boolean; reason: string }> {
  // Check size first (fast)
  try {
    const stat = statSync(filePath.startsWith('/') ? filePath : `${process.cwd()}/workspace/${filePath}`);
    if (stat.size < minBytes) {
      return { ok: false, reason: `file too small: ${stat.size} < ${minBytes}` };
    }
  } catch {
    // File may be referenced as workspace-relative; let read_pdf try
  }

  // Validate via read_pdf
  const pdfResult = await runSkill('read_pdf', { path: filePath });
  if (!pdfResult.success) {
    return { ok: false, reason: `read_pdf failed: ${pdfResult.error ?? 'unknown'}` };
  }

  return { ok: true, reason: '' };
}

export function buildReport(ledger: TargetRecord[], totalMs: number): DownloadReport {
  const ok: string[] = [];
  const skipped: Array<{ target: string; reason: string }> = [];
  for (const r of ledger) {
    if (r.status === 'ok') {
      ok.push(r.target);
    } else {
      skipped.push({ target: r.target, reason: r.skipReason ?? 'unknown' });
    }
  }
  return { ok, skipped, ledger, totalMs };
}

export function renderFinalMessage(report: DownloadReport, spec: WebDownloadSpec): string {
  const lines: string[] = ['FINAL_STATUS:'];
  lines.push(`ok=[${report.ok.join(', ') || 'none'}]`);
  if (report.skipped.length > 0) {
    lines.push('skipped=[');
    for (const s of report.skipped) {
      lines.push(`  ${s.target}: ${s.reason}`);
    }
    lines.push(']');
  } else {
    lines.push('skipped=[]');
  }
  if (report.ok.length > 0) {
    lines.push(`Files saved to: ${spec.destDir}`);
  }
  lines.push(`Duration: ${Math.round(report.totalMs / 1000)}s`);
  return lines.join('\n');
}

// ── Main engine ───────────────────────────────────────────────────────────────

export async function runWebDownloadMultiTarget(
  spec: WebDownloadSpec,
  runSkill: SkillRunner,
  emitEvent?: (event: unknown) => void,
): Promise<DownloadReport> {
  const emit = emitEvent ?? (() => {});
  const startMs = Date.now();

  const ledger: TargetRecord[] = spec.targets.map(target => ({
    target,
    searches: 0,
    pagesFetched: 0,
    downloads: 0,
    candidateUrls: [],
    bannedUrls: new Set(),
    status: 'pending',
    filePath: null,
    skipReason: null,
  }));

  emit({ type: 'web_download_engine_start', data: { targets: spec.targets, spec } });

  for (const record of ledger) {
    emit({ type: 'web_download_target_start', data: { target: record.target } });

    // ── Phase 1: Discover PDF URLs ──────────────────────────────────────────

    while (record.candidateUrls.length === 0 && record.searches < MAX_SEARCHES_PER_TARGET) {
      if (Date.now() - startMs > MAX_TOTAL_MS) break;

      const query = buildSearchQuery(record.target, spec.artifact, record.searches);
      emit({ type: 'web_download_search', data: { target: record.target, query, searchCount: record.searches + 1 } });

      const searchResult = await runSkill('web_search', { query });
      record.searches++;

      if (!searchResult.success) continue;

      const pageUrls = rankCandidatePages(parseSearchResults(searchResult.output), record);

      for (const pageUrl of pageUrls) {
        if (record.pagesFetched >= MAX_PAGES_PER_TARGET) break;
        if (Date.now() - startMs > MAX_TOTAL_MS) break;
        if (record.bannedUrls.has(pageUrl)) continue;

        // Direct PDF URL — add as candidate without fetching
        if (looksLikePdfUrl(pageUrl)) {
          if (!record.candidateUrls.includes(pageUrl)) record.candidateUrls.push(pageUrl);
          continue;
        }

        emit({ type: 'web_download_fetch', data: { target: record.target, url: pageUrl, fetchCount: record.pagesFetched + 1 } });
        const fetchResult = await runSkill('web_fetch', { url: pageUrl, extract_links_matching: '.pdf' });
        record.pagesFetched++;

        if (!fetchResult.success) {
          record.bannedUrls.add(pageUrl);
          continue;
        }

        const pdfLinks = extractPdfLinksFromHtml(fetchResult.output, pageUrl);
        const ranked = rankPdfLinks(pdfLinks, spec, record);
        for (const u of ranked) {
          if (!record.candidateUrls.includes(u)) record.candidateUrls.push(u);
        }
      }
    }

    if (record.candidateUrls.length === 0) {
      record.status = 'skipped';
      record.skipReason = `no PDF candidates found after ${record.searches} search(es) / ${record.pagesFetched} page(s)`;
      emit({ type: 'web_download_target_done', data: { target: record.target, status: 'skipped', filePath: null, skipReason: record.skipReason } });
      continue;
    }

    // ── Phase 2: Download and validate ─────────────────────────────────────

    for (const pdfUrl of record.candidateUrls.slice(0, MAX_DOWNLOADS_PER_TARGET)) {
      if (record.downloads >= MAX_DOWNLOADS_PER_TARGET) break;
      if (Date.now() - startMs > MAX_TOTAL_MS) {
        record.skipReason = 'timeout';
        break;
      }
      if (record.bannedUrls.has(pdfUrl)) continue;

      const filename = renderFilename(spec.filenameTemplate, record.target);
      emit({ type: 'web_download_attempt', data: { target: record.target, url: pdfUrl, downloadCount: record.downloads + 1 } });

      const dlResult = await runSkill('download_file', {
        url: pdfUrl,
        destDir: spec.destDir,
        filename,
      });
      record.downloads++;

      if (!dlResult.success) {
        record.bannedUrls.add(pdfUrl);
        record.skipReason = dlResult.error ?? 'download failed';
        continue;
      }

      // Extract workspace-relative path from output
      const filePath = extractWorkspacePath(dlResult.output) ?? `${spec.destDir}/${filename}`;
      const valid = await validatePdf(filePath, spec.minBytes, runSkill);

      if (valid.ok) {
        record.status = 'ok';
        record.filePath = filePath;
        record.skipReason = null;
        break;
      }

      record.bannedUrls.add(pdfUrl);
      record.skipReason = valid.reason;
    }

    if (record.status !== 'ok') {
      record.status = 'skipped';
      if (!record.skipReason) record.skipReason = 'no valid PDF after all attempts';
    }

    emit({ type: 'web_download_target_done', data: { target: record.target, status: record.status, filePath: record.filePath, skipReason: record.skipReason } });
  }

  const report = buildReport(ledger, Date.now() - startMs);
  emit({ type: 'web_download_engine_done', data: { ok: report.ok, skipped: report.skipped.length, totalMs: report.totalMs } });
  return report;
}
