// The lsp tool's actions: find a symbol's position by name, ask the server, and turn answers into short text
// with paths and line text. Rename writes the server's edits to disk itself, all files or none.
import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Diagnostic, Location, Position, Range } from './connection.ts';
import type { Session } from './session.ts';

export const MAX_LISTED = 120;
const IDENT = /[\p{L}\p{N}_$]/u;

export class ToolError extends Error {}

export interface Located { position: Position; line: number; occurrences: number; lines: number[] }

// The position of `symbol` in text: on `line` (1-based) when given, else its first occurrence as a whole word.
export function locate(text: string, symbol: string, line?: number, occurrence = 1): Located {
  if (!symbol) throw new ToolError('symbol is required: the name to look up, as written in the file.');
  const lines = text.split('\n');
  const hits: Position[] = [];
  lines.forEach((content, index) => {
    for (let at = content.indexOf(symbol); at >= 0; at = content.indexOf(symbol, at + 1)) {
      const before = at > 0 ? content[at - 1] : '', after = content[at + symbol.length] ?? '';
      if (!IDENT.test(before) && !IDENT.test(after)) hits.push({ line: index, character: at });
    }
  });
  const hitLines = [...new Set(hits.map(h => h.line + 1))];
  if (!hits.length) throw new ToolError(`"${symbol}" does not occur as a whole word in this file.`);
  const pool = line === undefined ? hits : hits.filter(h => h.line === line - 1);
  if (!pool.length) throw new ToolError(`"${symbol}" is not on line ${line}; it occurs on line(s) ${hitLines.slice(0, 20).join(', ')}.`);
  const pick = pool[Math.min(Math.max(occurrence, 1), pool.length) - 1];
  return { position: pick, line: pick.line + 1, occurrences: hits.length, lines: hitLines };
}

const fileOf = (uri: string) => { try { return fileURLToPath(uri); } catch { return uri; } };
const shown = (path: string, cwd: string) => { const r = relative(cwd, path).replace(/\\/g, '/'); return r.startsWith('..') || /^[A-Za-z]:/.test(r) ? path.replace(/\\/g, '/') : r; };

function lineText(cache: Map<string, string[]>, path: string, line: number) {
  let lines = cache.get(path);
  if (!lines) { try { lines = readFileSync(path, 'utf8').split('\n'); } catch { lines = []; } cache.set(path, lines); }
  return (lines[line] ?? '').trim().slice(0, 160);
}

export function formatLocations(locations: Location[], cwd: string, max = MAX_LISTED): string {
  const cache = new Map<string, string[]>();
  const sorted = [...locations].sort((a, b) => a.uri.localeCompare(b.uri) || a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
  const out = sorted.slice(0, max).map(l => { const p = fileOf(l.uri); return `${shown(p, cwd)}:${l.range.start.line + 1}:${l.range.start.character + 1}  ${lineText(cache, p, l.range.start.line)}`; });
  if (sorted.length > max) {
    const rest = new Map<string, number>();
    for (const l of sorted.slice(max)) { const p = shown(fileOf(l.uri), cwd); rest.set(p, (rest.get(p) ?? 0) + 1); }
    out.push(`… ${sorted.length - max} more: ${[...rest].map(([p, n]) => `${p} (${n})`).join(', ')}`);
  }
  return out.join('\n');
}

const asLocations = (result: any): Location[] => (Array.isArray(result) ? result : result ? [result] : [])
  .map((l: any) => l.targetUri ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : l)
  .filter((l: any) => l?.uri && l?.range);

export async function references(session: Session, uri: string, position: Position, timeoutMs: number) {
  return asLocations(await session.connection.request('textDocument/references', { textDocument: { uri }, position, context: { includeDeclaration: true } }, timeoutMs));
}

export async function definition(session: Session, uri: string, position: Position, timeoutMs: number) {
  return asLocations(await session.connection.request('textDocument/definition', { textDocument: { uri }, position }, timeoutMs));
}

export async function hover(session: Session, uri: string, position: Position, timeoutMs: number): Promise<string> {
  const result = await session.connection.request('textDocument/hover', { textDocument: { uri }, position }, timeoutMs);
  const parts = result?.contents === undefined ? [] : Array.isArray(result.contents) ? result.contents : [result.contents];
  return parts.map((p: any) => typeof p === 'string' ? p : p.value ?? '').filter(Boolean).join('\n\n').trim();
}

const SEVERITY = ['', 'error', 'warning', 'info', 'hint'];

export function formatDiagnostics(path: string, diagnostics: Diagnostic[], cwd: string): string {
  const name = shown(path, cwd);
  if (!diagnostics.length) return `${name}: no diagnostics.`;
  const sorted = [...diagnostics].sort((a, b) => (a.severity ?? 1) - (b.severity ?? 1) || a.range.start.line - b.range.start.line);
  const errors = diagnostics.filter(d => (d.severity ?? 1) === 1).length;
  const lines = sorted.slice(0, MAX_LISTED).map(d => `${name}:${d.range.start.line + 1}:${d.range.start.character + 1} ${SEVERITY[d.severity ?? 1] ?? 'error'}${d.code !== undefined ? ` ${typeof d.code === 'number' ? `TS${d.code}` : d.code}` : ''}: ${d.message.split('\n')[0]}`);
  if (sorted.length > MAX_LISTED) lines.push(`… ${sorted.length - MAX_LISTED} more`);
  // C# without restored packages reports even System.Object as missing.
  const unrestored = diagnostics.some(d => d.code === 'CS0518') ? '\nThe project has no restored packages (CS0518): run `dotnet restore`, then ask again.' : '';
  return `${name}: ${errors} error(s), ${diagnostics.length - errors} other.\n${lines.join('\n')}${unrestored}`;
}

interface TextEdit { range: Range; newText: string }

// Text edits per file from a WorkspaceEdit. File creations, renames or deletions are refused: rename here
// changes text only.
export function textEdits(edit: any): Map<string, TextEdit[]> {
  const files = new Map<string, TextEdit[]>();
  const add = (uri: string, edits: TextEdit[]) => { const p = fileOf(uri); files.set(p, [...(files.get(p) ?? []), ...edits]); };
  for (const change of edit?.documentChanges ?? []) {
    if (change.kind) throw new ToolError(`The server's rename also wants to ${change.kind} a file (${change.uri ?? change.oldUri}); not applied. Rename that file yourself, then retry.`);
    add(change.textDocument.uri, change.edits ?? []);
  }
  for (const [uri, edits] of Object.entries(edit?.changes ?? {})) add(uri, edits as TextEdit[]);
  return files;
}

export function offsetOf(text: string, position: Position): number {
  let start = 0;
  for (let line = 0; line < position.line; line++) {
    const next = text.indexOf('\n', start);
    if (next < 0) throw new ToolError(`Edit position line ${position.line + 1} is past the end of the file.`);
    start = next + 1;
  }
  const end = text.indexOf('\n', start);
  const width = (end < 0 ? text.length : end) - start;
  if (position.character > width + 1) throw new ToolError(`Edit position ${position.line + 1}:${position.character + 1} is past the end of its line.`);
  return start + position.character;
}

export function applyTextEdits(text: string, edits: TextEdit[]): string {
  const spans = edits.map(e => ({ from: offsetOf(text, e.range.start), to: offsetOf(text, e.range.end), text: e.newText })).sort((a, b) => b.from - a.from || b.to - a.to);
  for (let i = 1; i < spans.length; i++) if (spans[i].to > spans[i - 1].from) throw new ToolError('The server returned overlapping edits; nothing was changed.');
  let out = text;
  for (const s of spans) out = out.slice(0, s.from) + s.text + out.slice(s.to);
  return out;
}

// Compute every file first, then write: a bad edit in one file leaves all files untouched.
export function applyWorkspaceEdit(files: Map<string, TextEdit[]>): Array<{ path: string; edits: number; lines: number[] }> {
  const planned = [...files].map(([path, edits]) => {
    const before = readFileSync(path, 'utf8');
    return { path, after: applyTextEdits(before, edits), edits: edits.length, lines: [...new Set(edits.map(e => e.range.start.line + 1))].sort((a, b) => a - b) };
  });
  for (const p of planned) writeFileSync(p.path, p.after, 'utf8');
  return planned.map(({ path, edits, lines }) => ({ path, edits, lines }));
}

export function formatRename(symbol: string, newName: string, applied: Array<{ path: string; edits: number; lines: number[] }>, cwd: string) {
  const total = applied.reduce((n, f) => n + f.edits, 0);
  return `Renamed ${symbol} → ${newName}: ${total} edit(s) in ${applied.length} file(s).\n${applied.map(f => `${shown(f.path, cwd)}: line(s) ${f.lines.join(', ')}`).join('\n')}`;
}

export function formatSymbols(result: any[], cwd: string, max = MAX_LISTED): string {
  const KIND: Record<number, string> = { 5: 'class', 6: 'method', 7: 'property', 8: 'field', 9: 'constructor', 10: 'enum', 11: 'interface', 12: 'function', 13: 'variable', 14: 'constant', 22: 'enum member', 23: 'struct', 26: 'type' };
  const list = (result ?? []).filter(s => s?.location?.uri);
  const out = list.slice(0, max).map(s => `${shown(fileOf(s.location.uri), cwd)}:${(s.location.range?.start.line ?? 0) + 1}  ${KIND[s.kind] ?? 'symbol'} ${s.containerName ? `${s.containerName}.` : ''}${s.name}`);
  if (list.length > max) out.push(`… ${list.length - max} more`);
  return out.join('\n');
}
