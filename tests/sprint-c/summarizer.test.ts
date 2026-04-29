import { describe, it, expect } from 'vitest';
import { extractSummary } from '../../core/subagents/summarizer.js';

describe('summarizer — extractSummary', () => {
  it('parses JSON block at end of message', () => {
    const msg = `I found the relevant files.

\`\`\`json
{
  "files": [{ "path": "core/foo.ts", "relevance": "entry point" }],
  "narrative": "Found the main entry point."
}
\`\`\``;
    const result = extractSummary('explore', msg, []);
    expect(result.narrative).toBe('Found the main entry point.');
    expect(result.files).toHaveLength(1);
    expect(result.files![0].path).toBe('core/foo.ts');
  });

  it('fallback for explore: builds files list from file_reader history', () => {
    const result = extractSummary('explore', 'No JSON here', [
      { skill: 'file_reader', args: { filePath: 'core/bar.ts' } },
      { skill: 'grep_workspace', args: { pattern: 'handleX' } },
    ]);
    expect(result.files).toHaveLength(1);
    expect(result.files![0].path).toBe('core/bar.ts');
    expect(result.narrative.length).toBeGreaterThan(0);
  });

  it('fallback for task: builds artifacts lists from tool history', () => {
    const result = extractSummary('task', 'Done implementing', [
      { skill: 'file_writer', args: { path: 'src/new.ts' } },
      { skill: 'patch_file', args: { filePath: 'src/existing.ts' } },
    ]);
    expect(result.artifactsCreated).toContain('src/new.ts');
    expect(result.artifactsModified).toContain('src/existing.ts');
    expect(result.verificationStatus).toBe('unverified');
  });

  it('fallback for plan: returns narrative only', () => {
    const result = extractSummary('plan', 'Plan narrative text goes here', []);
    expect(result.narrative).toBeTruthy();
    expect(result.milestones).toBeUndefined();
  });
});
