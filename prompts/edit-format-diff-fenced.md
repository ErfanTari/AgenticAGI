# Diff-Fenced Edit Format

Use this format for all `patch_file` edits. The file path goes inside the
opening fence, immediately after the language tag.

## Format

```<lang> path/to/file
<<<<<<< SEARCH
exact existing lines to find
=======
replacement lines
>>>>>>> REPLACE
```

## Rules

1. **SEARCH must match exactly** — character for character, including whitespace
   and indentation. Call `file_reader` on the file first to get the exact content.
2. **One block per logical edit.** Multiple edits to the same file: emit multiple
   blocks in order. They are applied sequentially.
3. **No variables or substitution** in commands inside blocks. Write literal paths.
4. **Empty SEARCH** = whole-file replacement (use sparingly).
5. If the patch fails, read the structured error in the output. It includes:
   - `classification` — what went wrong (not-found / ambiguous / whitespace-mismatch / no-op)
   - `nearestCandidates` — closest matching lines for guidance
   - `hint` — specific repair suggestion

## Example

```ts src/utils/format.ts
<<<<<<< SEARCH
function pad(n: number): string {
  return String(n).padStart(2, '0');
}
=======
function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}
>>>>>>> REPLACE
```
