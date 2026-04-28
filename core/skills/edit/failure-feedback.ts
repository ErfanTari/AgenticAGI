import type { EditBlock } from './diff-fenced-parser.js';
import type { Candidate, MatchResult } from './layered-matcher.js';

export type PatchFailure = {
  classification: 'no-op' | 'ambiguous' | 'not-found' | 'whitespace-mismatch';
  failedBlocks: { search: string; replace: string; filePath: string }[];
  matchCount: number;
  nearestCandidates: Candidate[];
  surroundingLines: { before: string[]; after: string[] };
  hint: string;
};

function detectIndentStyle(fileContents: string): string {
  const lines = fileContents.split('\n').filter(l => l.match(/^\s+\S/));
  let tabs = 0, spaces2 = 0, spaces4 = 0;
  for (const line of lines.slice(0, 50)) {
    if (line.startsWith('\t')) { tabs++; continue; }
    const m = line.match(/^( +)/);
    if (m) {
      if (m[1].length % 4 === 0) spaces4++;
      else if (m[1].length % 2 === 0) spaces2++;
    }
  }
  if (tabs > spaces2 && tabs > spaces4) return 'tabs';
  if (spaces4 >= spaces2) return '4-space';
  return '2-space';
}

function surroundingLines(fileContents: string, candidate: Candidate | undefined): { before: string[]; after: string[] } {
  if (!candidate) return { before: [], after: [] };
  const lines = fileContents.split('\n');
  const offsets: number[] = [0];
  for (let i = 0; i < fileContents.length; i++) {
    if (fileContents[i] === '\n') offsets.push(i + 1);
  }
  let startLine = 0;
  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i] <= candidate.start) startLine = i;
    else break;
  }
  const before = lines.slice(Math.max(0, startLine - 5), startLine);
  const after = lines.slice(startLine + 1, startLine + 6);
  return { before, after };
}

export function buildFailureFeedback(
  block: EditBlock,
  fileContents: string,
  matchResult: MatchResult & { tier: 'fail' },
): PatchFailure {
  const { reason, candidates } = matchResult;
  const top = candidates[0];
  const matchCount = reason === 'ambiguous' ? candidates.length : 0;
  const filePath = block.filePath;

  let hint: string;
  if (reason === 'no-op') {
    hint = `SEARCH and REPLACE are identical; this edit makes no change.`;
  } else if (reason === 'ambiguous') {
    hint = `SEARCH matches ${matchCount} locations. Add more surrounding context to disambiguate.`;
  } else if (reason === 'whitespace-mismatch') {
    const style = detectIndentStyle(fileContents);
    hint = `SEARCH matches except for whitespace differences. Indentation in \`${filePath}\` uses ${style}; match it exactly.`;
  } else if (reason === 'not-found') {
    if (!top || top.ratio < 0.6) {
      hint = `The SEARCH block does not appear in \`${filePath}\`. Verify the file contents with file_reader before retrying.`;
    } else {
      hint = `Closest match is at line ${top.start} but differs. Adjust SEARCH to match exactly.`;
    }
  } else {
    hint = `Patch failed for \`${filePath}\`.`;
  }

  return {
    classification: reason,
    failedBlocks: [{ search: block.search, replace: block.replace, filePath }],
    matchCount,
    nearestCandidates: candidates.slice(0, 3),
    surroundingLines: surroundingLines(fileContents, top),
    hint,
  };
}
