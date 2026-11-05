import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type ExtensionAPI, withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { LspError, uriKey } from './connection.ts';
import { ToolError, applyWorkspaceEdit, definition, formatDiagnostics, formatLocations, formatRename, formatSymbols, hover, locate, references, textEdits } from './ops.ts';
import { Pool } from './session.ts';

const REQUEST_MS = 60_000;

const schema = Type.Object({
  action: Type.Union([Type.Literal('references'), Type.Literal('definition'), Type.Literal('rename'), Type.Literal('hover'), Type.Literal('diagnostics'), Type.Literal('symbols')], {
    description: 'references: every use of the symbol across the project. definition: where it is declared. rename: rename it everywhere (writes the files). hover: its type and docs. diagnostics: compiler errors of the file. symbols: search declarations by name (query).',
  }),
  path: Type.String({ description: 'File that contains the symbol (relative or absolute). For symbols, any file of the project.' }),
  symbol: Type.Optional(Type.String({ description: 'The name as written in that file, e.g. "total". Required except for diagnostics and symbols.' })),
  line: Type.Optional(Type.Integer({ minimum: 1, description: 'Line (1-based) where the symbol occurs, to pick one of several same-named symbols in the file. Default: its first occurrence.' })),
  occurrence: Type.Optional(Type.Integer({ minimum: 1, description: 'Which occurrence on that line (1-based), when it appears more than once.' })),
  newName: Type.Optional(Type.String({ description: 'New name, for rename.' })),
  query: Type.Optional(Type.String({ description: 'Name or prefix to search, for symbols.' })),
});

const resolvePath = (path: string, cwd: string) => { const p = path.startsWith('@') ? path.slice(1) : path; return isAbsolute(p) ? p : resolve(cwd, p); };
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }], details: {} });

// Hold every file's mutation queue for the whole rename, so no other edit interleaves.
function withFiles<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  return [...paths].sort().reduceRight<() => Promise<T>>((inner, path) => () => withFileMutationQueue(path, inner), fn)();
}

export default function extension(pi: ExtensionAPI) {
  const pool = new Pool();

  pi.on('tool_result', (event: any, ctx: any) => {
    if ((event.toolName === 'edit' || event.toolName === 'write') && typeof event.input?.path === 'string' && !event.isError) {
      void pool.fileChanged(resolvePath(event.input.path, ctx?.cwd || process.cwd()));
    }
  });
  pi.on('session_shutdown', () => pool.closeAll());

  pi.registerTool({
    name: 'lsp',
    label: 'LSP',
    description: 'Ask the project\'s language server (TypeScript/JavaScript, C#) about a symbol by name: every reference, its definition, its type, a project-wide rename that understands scope (same-named symbols elsewhere are left alone), compiler diagnostics of a file, or a declaration search.',
    promptSnippet: 'Compiler-backed references, definition, rename, hover, diagnostics and symbol search (TS/JS, C#)',
    promptGuidelines: [
      'For renaming a function, method, class, variable or property in TS/JS or C# code, use lsp rename instead of editing each use: it changes exactly the uses of that symbol, not same-named text elsewhere.',
      'For "who calls / where is X used" in TS/JS or C#, use lsp references; text search also hits comments, strings and same-named symbols.',
    ],
    parameters: schema,
    prepareArguments: (input: any) => {
      if (input && typeof input === 'object') for (const k of Object.keys(input)) if (input[k] === null) delete input[k];
      return input;
    },
    async execute(_id: string, input: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      const cwd = ctx?.cwd || process.cwd();
      const path = resolvePath(String(input.path), cwd);
      try {
        const session = await pool.forFile(path);
        if (signal?.aborted) throw new ToolError('Operation aborted');
        const pushesBefore = session.connection.pushes.get(uriKey(pathToFileURL(path).href)) ?? 0;
        session.flush();
        const head = `[${session.spec.note}]`;
        if (input.action === 'diagnostics') return text(`${head}\n${formatDiagnostics(path, await session.diagnostics(path, REQUEST_MS, pushesBefore), cwd)}`);
        if (input.action === 'symbols') {
          if (!input.query) throw new ToolError('query is required for symbols.');
          session.sync(path);
          const found = await session.connection.request('workspace/symbol', { query: input.query }, REQUEST_MS);
          return text(`${head}\n${formatSymbols(found, cwd) || `No declarations match "${input.query}".`}`);
        }
        const uri = session.sync(path);
        const where = locate(readFileSync(path, 'utf8'), String(input.symbol ?? ''), input.line, input.occurrence);
        const at = `${input.symbol} at line ${where.line}${where.lines.length > 1 && input.line === undefined ? ` (first of lines ${where.lines.slice(0, 12).join(', ')}; pass line to pick another)` : ''}`;
        if (input.action === 'references') {
          const found = await references(session, uri, where.position, REQUEST_MS);
          return text(`${head} ${found.length} reference(s) to ${at}, declaration included:\n${formatLocations(found, cwd)}`);
        }
        if (input.action === 'definition') {
          const found = await definition(session, uri, where.position, REQUEST_MS);
          return text(found.length ? `${head} definition of ${at}:\n${formatLocations(found, cwd)}` : `${head} No definition found for ${at}.`);
        }
        if (input.action === 'hover') {
          const info = await hover(session, uri, where.position, REQUEST_MS);
          return text(`${head} ${at}:\n${info || 'no type information.'}`);
        }
        if (input.action === 'rename') {
          const newName = String(input.newName ?? '').trim();
          if (!newName) throw new ToolError('newName is required for rename.');
          const edit = await session.connection.request('textDocument/rename', { textDocument: { uri }, position: where.position, newName }, REQUEST_MS);
          const files = textEdits(edit);
          if (!files.size) throw new ToolError(`The server cannot rename ${at} (no edits returned): check that the line points at the symbol itself.`);
          const applied = await withFiles([...files.keys()], async () => applyWorkspaceEdit(files));
          for (const f of applied) await pool.fileChanged(f.path);
          return text(`${head} ${formatRename(String(input.symbol), newName, applied, cwd)}`);
        }
        throw new ToolError(`Unknown action ${input.action}.`);
      } catch (e) {
        if (e instanceof ToolError || e instanceof LspError) throw new Error(e.message);
        throw e;
      }
    },
  } as any);
}
