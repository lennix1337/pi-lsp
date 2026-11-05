# pi-lsp

Compiler-backed code navigation for [Pi](https://github.com/earendil-works/pi): one `lsp` tool that asks the
project's language server about a symbol by name.

| action | what it returns |
|---|---|
| `references` | every use of the symbol across the project, with file, line and the line's text |
| `definition` | where it is declared |
| `rename` | renames it everywhere and writes the files (all or none); same-named symbols, strings and comments are left alone |
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

One server runs per project root and stops after 10 idle minutes or when the session ends. Files changed by
`edit` and `write` are sent to the server before its next answer; files open in the server are compared with
the disk on every call.

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
