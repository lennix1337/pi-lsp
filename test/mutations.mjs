// Each guard, removed in a disposable copy, must make a test fail an assertion.
import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const cases = [
  ['whole-word', 'src/ops.ts', "if (!IDENT.test(before) && !IDENT.test(after)) hits.push(", 'hits.push(', 'locate finds the symbol', 'ops'],
  ['overlap', 'src/ops.ts', "if (spans[i].to > spans[i - 1].from) throw", 'if (false) throw', 'applyTextEdits applies', 'ops'],
  ['file-ops', 'src/ops.ts', 'if (change.kind) throw', 'if (false) throw', 'textEdits merges', 'ops'],
  ['all-or-none', 'src/ops.ts', "    const before = readFileSync(path, 'utf8');\n    return {", "    const before = readFileSync(path, 'utf8');\n    writeFileSync(path, before.replace('total', 'sum'), 'utf8');\n    return {", 'writes no file', 'ops'],
  ['no-syntax-server', 'src/servers.ts', ", useSyntaxServer: 'never'", '', 'typescript-language-server', 'server'],
  ['created-event', 'src/session.ts', '(s.birthtimeMs || s.ctimeMs) >= this.startedAt ? 1 : 2', '(s.birthtimeMs || s.ctimeMs) >= this.startedAt ? 2 : 2', 'flush opens source files', 'session'],
  ['open-created', 'src/session.ts', 'if (type === 1 && SOURCES[this.spec.kind].test(path))', 'if (false)', 'flush opens source files', 'session'],
  ['source-only', 'src/session.ts', 'if (type === 1 && SOURCES[this.spec.kind].test(path))', 'if (type === 1)', 'flush opens source files', 'session'],
  ['changed-event', 'src/session.ts', "if (events.length) this.connection.notify('workspace/didChangeWatchedFiles'", "if (false) this.connection.notify('workspace/didChangeWatchedFiles'", 'flush opens source files', 'session'],
  ['external-scan', 'src/session.ts', 'const found = this.scan();', 'const found = new Map<string, number>();', 'created after the server started', 'session'],
  ['external-deleted', 'src/session.ts', 'if (!after.has(path)) found.set(path, 3);', 'if (false) found.set(path, 3);', 'changed or deleted', 'session'],
  ['external-once', 'src/session.ts', 'this.changed.add(resolve(path));', 'this.changed.add(path);', 'however the path was spelled', 'session'],
  ['external-one-document', 'src/session.ts', '    path = resolve(path);\n', '', 'however the path was spelled', 'session'],
  ['external-cap', 'src/session.ts', 'if (files.size >= maxFiles) return null;', '', 'more source files than the limit is not scanned', 'session'],
  ['external-cap-notice', 'src/index.ts', "session.tracksExternalChanges ? ''", "true ? ''", 'outside changes are not tracked', 'server'],
  ['uri-key', 'src/connection.ts', "return process.platform === 'win32' ? path.toLowerCase() : path;", 'return uri;', 'uriKey spells', 'ops'],
  ['comment-skip', 'src/ops.ts', 'line === undefined ? (code.length ? code : hits)', 'line === undefined ? hits', 'only appears in a comment', 'ops'],
  ['comment-quotes', 'src/ops.ts', "else if (c === '\"' || c === \"'\" || c === '`') quote = c;", 'else if (false) quote = c;', 'only appears in a comment', 'ops'],
  ['prewarm-load', 'src/session.ts', "await session.connection.request('textDocument/documentSymbol'", "void ('textDocument/documentSymbol'", 'warmed-up', 'server'],
  ['warmup-project-only', 'src/servers.ts', "['tsconfig.json', 'jsconfig.json'].some", "['tsconfig.json', 'jsconfig.json', 'package.json'].some", 'package.json alone', 'warmup'],
  ['warmup-no-declarations', 'src/servers.ts', "!/\\.d\\.[mc]?ts$/i.test(n) && ", '', 'src first', 'warmup'],
  ['rename-leftovers', 'src/index.ts', '\\n${formatLeftovers(String(input.symbol), left, cwd)}', '', 'references, rename', 'server'],
  ['leftovers-whole-word', 'src/ops.ts', '(?<![\\\\p{L}\\\\p{N}_$])', '', 'still spelled', 'ops'],
  ['leftovers-skip-deps', 'src/ops.ts', '!SKIPPED_DIRS.has(e.name)', 'true', 'still spelled', 'ops'],
];
let killed = 0;
let failed = false;
for (const [name, file, before, after, pattern, test] of cases) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-lsp-mutant-'));
  try {
    for (const d of ['src', 'test']) cpSync(join(root, d), join(dir, d), { recursive: true });
    cpSync(join(root, 'package.json'), join(dir, 'package.json'));
    symlinkSync(resolve(root, 'node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const path = join(dir, file);
    const source = readFileSync(path, 'utf8');
    assert.equal(source.split(before).length, 2, `unique mutation ${name}`);
    writeFileSync(path, source.replace(before, after));
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', `--test-name-pattern=${pattern}`, `test/${test}.test.ts`], { cwd: dir, encoding: 'utf8', timeout: 180_000 });
    assert.equal(result.error, undefined, `${name}: process must run, not time out`);
    if (result.status === 0) { console.log(`${name}: survived`); failed = true; continue; }
    assert.match(result.stdout + result.stderr, /AssertionError/, `${name}: must fail an assertion, not crash`);
    killed++;
    console.log(`${name}: killed by assertion`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
console.log(`${killed}/${cases.length} guard mutants killed; disposable copies only`);
if (failed) process.exitCode = 1;
