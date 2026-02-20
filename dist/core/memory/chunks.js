const MAX_CHUNK_CHARS = 2048; // ~512 tokens at 4 chars/token
const OVERLAP_CHARS = 512; // ~128 tokens overlap
/**
 * Strip YAML frontmatter from markdown content.
 */
function stripFrontmatter(content) {
    const match = content.match(/^---\n[\s\S]*?\n---\n?/);
    return match ? content.slice(match[0].length) : content;
}
/**
 * Split markdown into heading-aware chunks.
 * Preserves heading context in each chunk.
 * Pure computation — no DB or network dependencies.
 */
export function chunkMarkdown(code, content) {
    const stripped = stripFrontmatter(content).trim();
    if (!stripped)
        return [];
    // Split by headings (# through ####)
    const sections = [];
    const headingRegex = /^(#{1,4})\s+(.+)$/gm;
    let lastIdx = 0;
    let currentHeading = '';
    let match;
    while ((match = headingRegex.exec(stripped)) !== null) {
        // Collect text before this heading
        const textBefore = stripped.slice(lastIdx, match.index).trim();
        if (textBefore) {
            sections.push({ heading: currentHeading, text: textBefore });
        }
        currentHeading = match[2];
        lastIdx = match.index + match[0].length;
    }
    // Remaining text after last heading
    const remaining = stripped.slice(lastIdx).trim();
    if (remaining) {
        sections.push({ heading: currentHeading, text: remaining });
    }
    // If no headings found, treat entire content as one section
    if (sections.length === 0) {
        sections.push({ heading: '', text: stripped });
    }
    // Split large sections into smaller chunks with overlap
    const chunks = [];
    let chunkIndex = 0;
    for (const section of sections) {
        const text = section.text;
        if (text.length <= MAX_CHUNK_CHARS) {
            chunks.push({ code, chunkIndex, heading: section.heading, text });
            chunkIndex++;
        }
        else {
            // Split by paragraphs first
            const paragraphs = text.split(/\n\n+/);
            let buffer = '';
            for (const para of paragraphs) {
                if (buffer.length + para.length + 2 > MAX_CHUNK_CHARS && buffer) {
                    chunks.push({ code, chunkIndex, heading: section.heading, text: buffer.trim() });
                    chunkIndex++;
                    // Overlap: keep tail of previous buffer
                    const overlapStart = Math.max(0, buffer.length - OVERLAP_CHARS);
                    buffer = buffer.slice(overlapStart) + '\n\n' + para;
                }
                else {
                    buffer += (buffer ? '\n\n' : '') + para;
                }
            }
            if (buffer.trim()) {
                chunks.push({ code, chunkIndex, heading: section.heading, text: buffer.trim() });
                chunkIndex++;
            }
        }
    }
    return chunks;
}
