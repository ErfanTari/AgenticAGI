export interface Chunk {
    code: string;
    chunkIndex: number;
    heading: string;
    text: string;
}
/**
 * Split markdown into heading-aware chunks.
 * Preserves heading context in each chunk.
 * Pure computation — no DB or network dependencies.
 */
export declare function chunkMarkdown(code: string, content: string): Chunk[];
