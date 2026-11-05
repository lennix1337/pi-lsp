# pi-lsp

One `lsp` tool (references, definition, rename, hover, diagnostics, symbols) over the project's language
server. Read README.md for the contract.

Rules for changes:
- Rename computes every file before writing any; a bad edit, an overlap or a file operation leaves all files untouched.
- Answers never come from stale text: changed files are synced before each request.
- Tests run against real servers (bundled TypeScript 7 and typescript-language-server with TypeScript 5); no mocked server.
- Every guard has a mutant in `test/mutations.mjs` that a test kills.
- Adoption in the live stack follows the lsp bench in lennix1337/dotfiles (`payload/tools/bench/waste`, `--set lsp`).
