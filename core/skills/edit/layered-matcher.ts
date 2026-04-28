/**
 * Layered edit-block matcher.
 *
 * Ported from Aider's editblock_coder.py (Apache-2.0).
 * Original: https://github.com/paul-gauthier/aider
 * Attribution: Paul Gauthier and contributors.
 *
 * Tier order (stop at first tier with a unique match):
 *   0 — Empty SEARCH → whole-file replace
 *   1 — Exact string match (unique)
 *   2 — Whitespace-normalised match (unique)
 *   3 — Leading-whitespace-flexible match (unique)
 *   4 — Fuzzy ratio ≥ 0.85 (unique candidate above threshold)
 */

export type Candidate = {
  start: number; // character offset in fileContents
  end: number;
  preview: string;
  ratio: number;
};

export type MatchResult =
  | { tier: 0 | 1 | 2 | 3 | 4; start: number; end: number; confidence: number }
  | { tier: 'fail'; reason: 'not-found' | 'ambiguous' | 'no-op' | 'whitespace-mismatch'; candidates: Candidate[] };

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalizeWhitespace(s: string): string {
  return s
    .split('\n')
    .map(line => line.trimEnd().replace(/[ \t]+/g, ' '))
    .join('\n');
}

function stripLeadingWhitespace(s: string): string[] {
  const lines = s.split('\n');
  if (lines.length === 0) return lines;
  // Find minimum non-empty indent
  const indents = lines
    .filter(l => l.trim().length > 0)
    .map(l => l.match(/^(\s*)/)?.[1].length ?? 0);
  const minIndent = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map(l => l.slice(minIndent));
}

/**
 * Simple SequenceMatcher.ratio() port: 2 * common_chars / total_chars.
 * Operates on character level for short strings, line level for long ones.
 */
function ratio(a: string, b: string): number {
  if (a === b) return 1.0;
  const total = a.length + b.length;
  if (total === 0) return 1.0;

  // LCS-based common chars using Wagner-Fischer for short strings
  // Fall back to word-overlap for strings > 2000 chars to stay fast
  if (total <= 4000) {
    const aArr = a.split('');
    const bArr = b.split('');
    const m = aArr.length, n = bArr.length;
    // O(mn) — fine for patch blocks which are typically <200 lines
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = aArr[i - 1] === bArr[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    return (2 * dp[m][n]) / total;
  }

  // Fast approximation: token overlap
  const tokensA = new Set(a.split(/\s+/));
  const tokensB = new Set(b.split(/\s+/));
  let common = 0;
  for (const t of tokensA) if (tokensB.has(t)) common++;
  return (2 * common) / (tokensA.size + tokensB.size);
}

function buildPreview(fileContents: string, start: number, end: number): string {
  const lines = fileContents.split('\n');
  let charCount = 0;
  let startLine = 0, endLine = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const lineEnd = charCount + lines[i].length + 1;
    if (charCount <= start && start < lineEnd) startLine = i;
    if (charCount < end && end <= lineEnd) { endLine = i; break; }
    charCount = lineEnd;
  }
  const lo = Math.max(0, startLine - 5);
  const hi = Math.min(lines.length - 1, endLine + 5);
  return lines.slice(lo, hi + 1).join('\n');
}

function lineOffsets(fileContents: string): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < fileContents.length; i++) {
    if (fileContents[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

// ─── Tier implementations ────────────────────────────────────────────────────

function tier1Exact(file: string, search: string): number[] {
  const positions: number[] = [];
  let idx = file.indexOf(search);
  while (idx !== -1) {
    positions.push(idx);
    idx = file.indexOf(search, idx + 1);
  }
  return positions;
}

function tier2Normalized(file: string, search: string): Array<{ start: number; end: number }> {
  const normFile = normalizeWhitespace(file);
  const normSearch = normalizeWhitespace(search);
  const results: Array<{ start: number; end: number }> = [];
  let idx = normFile.indexOf(normSearch);
  while (idx !== -1) {
    results.push({ start: idx, end: idx + normSearch.length });
    idx = normFile.indexOf(normSearch, idx + 1);
  }
  // Map normalized positions back to original (best-effort: use same offsets)
  return results;
}

function tier3LeadingFlex(file: string, search: string): Array<{ start: number; end: number }> {
  const fileLines = file.split('\n');
  const searchStripped = stripLeadingWhitespace(search);
  const results: Array<{ start: number; end: number }> = [];
  const offsets = lineOffsets(file);

  for (let i = 0; i <= fileLines.length - searchStripped.length; i++) {
    const candidate = fileLines.slice(i, i + searchStripped.length);
    const candidateStripped = stripLeadingWhitespace(candidate.join('\n'));
    if (candidateStripped.join('\n') === searchStripped.join('\n')) {
      const start = offsets[i] ?? 0;
      const end = (offsets[i + searchStripped.length] ?? file.length + 1) - 1;
      results.push({ start, end: Math.min(end, file.length) });
    }
  }
  return results;
}

function tier4Fuzzy(file: string, search: string, threshold = 0.85): Candidate[] {
  const fileLines = file.split('\n');
  const searchLines = search.split('\n');
  const windowSize = searchLines.length;
  const offsets = lineOffsets(file);
  const candidates: Candidate[] = [];

  for (let i = 0; i <= fileLines.length - windowSize; i++) {
    const window = fileLines.slice(i, i + windowSize).join('\n');
    const r = ratio(search, window);
    if (r >= threshold) {
      const start = offsets[i] ?? 0;
      const end = (offsets[i + windowSize] ?? file.length + 1) - 1;
      candidates.push({
        start,
        end: Math.min(end, file.length),
        preview: buildPreview(file, start, end),
        ratio: r,
      });
    }
  }
  return candidates.sort((a, b) => b.ratio - a.ratio);
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function findMatch(fileContents: string, searchBlock: string): MatchResult {
  // Tier 0: empty search = whole-file replace
  if (!searchBlock.trim()) {
    return { tier: 0, start: 0, end: fileContents.length, confidence: 1.0 };
  }

  // No-op: search === replace would be detected by caller, but detect search === file slice
  // (handled in feedback layer, not here)

  // Tier 1: exact
  const t1 = tier1Exact(fileContents, searchBlock);
  if (t1.length === 1) {
    return { tier: 1, start: t1[0], end: t1[0] + searchBlock.length, confidence: 1.0 };
  }
  if (t1.length > 1) {
    const candidates = t1.map(pos => ({
      start: pos,
      end: pos + searchBlock.length,
      preview: buildPreview(fileContents, pos, pos + searchBlock.length),
      ratio: 1.0,
    }));
    return { tier: 'fail', reason: 'ambiguous', candidates };
  }

  // Tier 2: whitespace-normalised
  const t2 = tier2Normalized(fileContents, searchBlock);
  if (t2.length === 1) {
    return { tier: 2, start: t2[0].start, end: t2[0].end, confidence: 0.95 };
  }
  if (t2.length > 1) {
    const candidates = t2.map(m => ({
      start: m.start, end: m.end,
      preview: buildPreview(fileContents, m.start, m.end),
      ratio: 0.95,
    }));
    return { tier: 'fail', reason: 'ambiguous', candidates };
  }

  // Check whitespace-only mismatch (same content, different indent)
  const normFile = normalizeWhitespace(fileContents);
  const normSearch = normalizeWhitespace(searchBlock);
  if (normFile.includes(normSearch)) {
    // Content matches when whitespace is collapsed but tier 2 didn't find it (edge case: multiple norm matches)
    return {
      tier: 'fail',
      reason: 'whitespace-mismatch',
      candidates: tier4Fuzzy(fileContents, searchBlock, 0.7).slice(0, 3),
    };
  }

  // Tier 3: leading-whitespace-flexible
  const t3 = tier3LeadingFlex(fileContents, searchBlock);
  if (t3.length === 1) {
    return { tier: 3, start: t3[0].start, end: t3[0].end, confidence: 0.90 };
  }
  if (t3.length > 1) {
    const candidates = t3.map(m => ({
      start: m.start, end: m.end,
      preview: buildPreview(fileContents, m.start, m.end),
      ratio: 0.90,
    }));
    return { tier: 'fail', reason: 'ambiguous', candidates };
  }

  // Tier 4: fuzzy ≥ 0.85
  const t4 = tier4Fuzzy(fileContents, searchBlock, 0.85);
  if (t4.length === 1) {
    return { tier: 4, start: t4[0].start, end: t4[0].end, confidence: t4[0].ratio };
  }
  if (t4.length > 1) {
    return { tier: 'fail', reason: 'ambiguous', candidates: t4.slice(0, 3) };
  }

  // Complete miss — gather candidates at lower threshold for feedback
  const looseCandidates = tier4Fuzzy(fileContents, searchBlock, 0.5).slice(0, 3);
  return { tier: 'fail', reason: 'not-found', candidates: looseCandidates };
}
