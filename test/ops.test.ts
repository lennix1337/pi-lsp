import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolError, applyTextEdits, applyWorkspaceEdit, formatDiagnostics, locate, offsetOf, textEdits } from '../src/ops.ts';

const r = (l1: number, c1: number, l2: number, c2: number) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });

test('locate finds the symbol as a whole word, on the requested line', () => {
  const text = 'const subtotal = 1;\nlet total = 2; // total\nfn(total, totals);\n';
  assert.deepEqual(locate(text, 'total').position, { line: 1, character: 4 });
  assert.equal(locate(text, 'total').occurrences, 3);
  assert.deepEqual(locate(text, 'total', 3).position, { line: 2, character: 3 });
  assert.deepEqual(locate(text, 'total', 2, 2).position, { line: 1, character: 18 });
  assert.throws(() => locate(text, 'total', 1), /not on line 1; it occurs on line\(s\) 2, 3/);
  assert.throws(() => locate(text, 'tot'), /does not occur as a whole word/);
  assert.throws(() => locate(text, ''), ToolError);
  assert.deepEqual(locate('a.$x = $x;', '$x').position, { line: 0, character: 2 });
});

test('offsetOf counts UTF-16 units per line and refuses positions past the end', () => {
  const text = 'ação\r\nx = 1\n';
  assert.equal(offsetOf(text, { line: 1, character: 2 }), 8);
  assert.equal(offsetOf(text, { line: 2, character: 0 }), text.length);
  assert.throws(() => offsetOf(text, { line: 5, character: 0 }), /past the end of the file/);
  assert.throws(() => offsetOf(text, { line: 1, character: 9 }), /past the end of its line/);
});

test('applyTextEdits applies edits of one line from the end and refuses overlaps', () => {
  const text = 'a.total + b.total\ntotal\r\n';
  const out = applyTextEdits(text, [{ range: r(0, 2, 0, 7), newText: 'sum' }, { range: r(0, 12, 0, 17), newText: 'sum' }, { range: r(1, 0, 1, 5), newText: 'sum' }]);
  assert.equal(out, 'a.sum + b.sum\nsum\r\n');
  assert.throws(() => applyTextEdits(text, [{ range: r(0, 0, 0, 5), newText: 'x' }, { range: r(0, 3, 0, 7), newText: 'y' }]), /overlapping/);
});

test('applyWorkspaceEdit writes no file when one edit of the set is bad', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-lsp-ops-'));
  try {
    const a = join(dir, 'a.ts'), b = join(dir, 'b.ts');
    writeFileSync(a, 'total\n'); writeFileSync(b, 'x\n');
    const files = new Map([[a, [{ range: r(0, 0, 0, 5), newText: 'sum' }]], [b, [{ range: r(7, 0, 7, 1), newText: 'y' }]]]);
    assert.throws(() => applyWorkspaceEdit(files), /past the end of the file/);
    assert.equal(readFileSync(a, 'utf8'), 'total\n');
    files.set(b, [{ range: r(0, 0, 0, 1), newText: 'y' }]);
    assert.deepEqual(applyWorkspaceEdit(files).map(f => f.edits), [1, 1]);
    assert.equal(readFileSync(a, 'utf8') + readFileSync(b, 'utf8'), 'sum\ny\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('formatDiagnostics lists errors first with their code, and says when a C# project is not restored', () => {
  const d = (line: number, severity: number, code: string | number, message: string) => ({ range: r(line, 0, line, 1), severity, code, message, source: 'lsp' });
  const out = formatDiagnostics('/p/a.ts', [d(4, 2, 6133, 'unused'), d(1, 1, 2339, "Property 'total' does not exist\nmore")], '/p');
  assert.equal(out, "a.ts: 1 error(s), 1 other.\na.ts:2:1 error TS2339: Property 'total' does not exist\na.ts:5:1 warning TS6133: unused");
  assert.match(formatDiagnostics('/p/a.cs', [d(0, 1, 'CS0518', "Predefined type 'System.Object' is not defined")], '/p'), /error CS0518: .*\n.*run `dotnet restore`/);
  assert.equal(formatDiagnostics('/p/a.ts', [], '/p'), 'a.ts: no diagnostics.');
});

test('textEdits merges changes and documentChanges, and refuses file operations', () => {
  const files = textEdits({ changes: { 'file:///c%3A/p/a.ts': [{ range: r(0, 0, 0, 1), newText: 'x' }] }, documentChanges: [{ textDocument: { uri: 'file:///c%3A/p/a.ts' }, edits: [{ range: r(1, 0, 1, 1), newText: 'y' }] }] });
  assert.equal(files.size, 1);
  assert.equal([...files.values()][0].length, 2);
  assert.throws(() => textEdits({ documentChanges: [{ kind: 'rename', oldUri: 'file:///a.ts', newUri: 'file:///b.ts' }] }), /wants to rename a file/);
});

test('uriKey spells one file the same way whatever the server encodes', async () => {
  const { uriKey } = await import('../src/connection.ts');
  const { pathToFileURL } = await import('node:url');
  const file = join(tmpdir(), 'pi-lsp-key', 'a b.ts');
  const plain = pathToFileURL(file).href;
  assert.equal(uriKey(plain.replace('a%20b', 'x/../a%20b')), uriKey(plain));
  assert.equal(uriKey(plain.replace('.ts', '%2Ets')), uriKey(plain));
  if (process.platform === 'win32') assert.equal(uriKey(plain.replace(/^file:\/\/\/([A-Za-z]):/, (_, d) => `file:///${d.toLowerCase()}%3A`)), uriKey(plain));
});
