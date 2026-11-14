# pi-lsp

Compiler-backed code navigation for [Pi](https://github.com/earendil-works/pi): one `lsp` tool that asks the
project's language server about a symbol by name.

| action | what it returns |
|---|---|
| `references` | every use of the symbol across the project, with file, line and the line's text |
| `definition` | where it is declared |
| `rename` | renames it everywhere and writes the files (all or none); same-named symbols, strings and comments are left alone and listed as leftovers, so no grep is needed to check what still uses the old name |
| `hover` | its type and docs |
| `diagnostics` | compiler errors and warnings of one file, after the latest edits |
| `symbols` | declarations whose name matches `query` |

The model names the symbol as written (`symbol: "total"`), plus `line` when the file has several of that
name; it never counts columns.

## Servers

- **TypeScript / JavaScript**: the project's own compiler. TypeScript 7+ runs its native server
  (`tsc --lsp --stdio`); TypeScript 5 and older go through `typescript-language-server` with the project's
  `tsserver` (the partial "syntax server" is turned off, so references never come from the open file alone).
  Files outside any project with TypeScript use the bundled TypeScript 7.
- **C#**: `csharp-ls` from the solution (`.sln`/`.slnx`) or project folder. Install it with
  `dotnet tool install -g csharp-ls`; without it, the tool says so.

The TypeScript project of the session's folder is loaded when the session starts, so the first answer skips the ~2.5 s cold start. One server runs per project root and stops after 10 idle minutes or when the session ends.

Before each answer the server is told which source files were created, changed or deleted on disk since its
last one, whoever did it: `edit` and `write`, but also git, a formatter, a generator or another session. The
project's source files are compared with the disk on every call (dependency, build and hidden folders are
skipped). A project with more than 5000 source files is not scanned: there only `edit` and `write` changes
and the files open in the server are tracked, and every answer says so.

## Install

```sh
pi install git:github.com/lennix1337/pi-lsp
```

## Develop

```sh
npm ci
npm run verify      # typecheck and tests against real servers
npm run mutations   # each guard, removed, must fail a test
```

Adoption in the live stack follows the `--set lsp` bench in lennix1337/dotfiles
(`payload/tools/bench/waste`): the same tasks with and without this package.
