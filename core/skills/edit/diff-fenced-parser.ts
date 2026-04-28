/**
 * Diff-fenced format parser.
 *
 * Accepts the Aider diff-fenced format where the file path appears
 * inside the opening fence, immediately after the language tag:
 *
 *   ```ts path/to/file.ts
 *   <<<<<<< SEARCH
 *   old lines
 *   =======
 *   new lines
 *   >>>>>>> REPLACE
 *   ```
 *
 * Multiple blocks per file and multiple files in one response are supported.
 */

export type EditBlock = {
  filePath: string;
  language: string;
  search: string;
  replace: string;
  blockIndex: number;
};

// Marker patterns — trim trailing whitespace (Gemma 4 sometimes adds a space)
const SEARCH_MARKER = /^<{7} SEARCH\s*$/;
const SEP_MARKER = /^={7}\s*$/;
const REPLACE_MARKER = /^>{7} REPLACE\s*$/;

function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function parseDiffFenced(modelOutput: string): EditBlock[] {
  const normalized = normalizeLineEndings(modelOutput);
  const blocks: EditBlock[] = [];
  let blockIndex = 0;

  // Match every opening fence: ```<lang> <path>
  // Non-greedy scan through the whole string
  const FENCE_OPEN = /^```(\w+)\s+(\S+)\s*$/gm;
  let match: RegExpExecArray | null;

  while ((match = FENCE_OPEN.exec(normalized)) !== null) {
    const language = match[1];
    const filePath = match[2];
    const afterFence = normalized.slice(match.index + match[0].length + 1); // +1 for \n

    // Find closing ``` (may be missing — best-effort recovery)
    const FENCE_CLOSE = /^```\s*$/m;
    const closeMatch = FENCE_CLOSE.exec(afterFence);
    const fenceBody = closeMatch ? afterFence.slice(0, closeMatch.index) : afterFence;

    if (!closeMatch) {
      console.warn(`[diff-fenced-parser] No closing fence found for ${filePath} at block ${blockIndex} — best-effort recovery`);
    }

    // Extract SEARCH / REPLACE sections from fenceBody
    const lines = fenceBody.split('\n');
    let state: 'before' | 'search' | 'replace' = 'before';
    const searchLines: string[] = [];
    const replaceLines: string[] = [];

    for (const line of lines) {
      if (state === 'before') {
        if (SEARCH_MARKER.test(line)) { state = 'search'; continue; }
      } else if (state === 'search') {
        if (SEP_MARKER.test(line)) { state = 'replace'; continue; }
        searchLines.push(line);
      } else {
        if (REPLACE_MARKER.test(line)) break;
        replaceLines.push(line);
      }
    }

    if (state === 'before') {
      // No SEARCH marker found inside this fence — skip (not a diff block)
      continue;
    }

    // Trim trailing newline artifact from last push
    const search = searchLines.join('\n').replace(/\n$/, '');
    const replace = replaceLines.join('\n').replace(/\n$/, '');

    blocks.push({ filePath, language, search, replace, blockIndex });
    blockIndex++;

    // Advance past the fence body so we don't re-parse overlapping regions
    if (closeMatch) {
      FENCE_OPEN.lastIndex = match.index + match[0].length + 1 + closeMatch.index + closeMatch[0].length;
    }
  }

  return blocks;
}
