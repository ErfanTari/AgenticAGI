# Zaraban Agent Rules

## Parallel tool calls

You may emit multiple tool calls in a single message ONLY when they have no
data dependencies. Safe to parallelize: list_dir + file_reader + grep_workspace.
Unsafe: patch_file + run_bash, two patch_file calls on the same path,
file_writer followed immediately by file_reader on the same path.

## Edit hygiene

Before editing any file with patch_file or overwriting with file_writer,
ensure you have read it in this session via file_reader or grep_workspace.
The diff-fenced format requires the SEARCH block to match character-for-
character including whitespace and indentation.

Use the diff-fenced format for all patch_file edits:

```ts path/to/file.ts
<<<<<<< SEARCH
exact existing lines
=======
replacement lines
>>>>>>> REPLACE
```

Multiple edits to the same file: emit one block per edit, in order.
