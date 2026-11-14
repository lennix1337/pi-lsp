import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCES, Session, changes, snapshot } from '../src/session.ts';

interface Fake { root: string; session: Session; sent: Array<{ method: string; params: any }> }

// A session over a process that never answers: flush() only needs somewhere to send its notifications.
// `files` exist before the server starts; `limit` is the most source files the session tracks.
async function fake(files: string[], body: (f: Fake) => void, limit?: number) {
  const root = mkdtempSync(join(tmpdir(), 'pi-lsp-session-'));
  for (const f of files) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), 'export const x = 1;\n'); }
  const session = new Session({
    key: 'fake', kind: 'typescript', root, command: process.execPath, args: ['-e', 'setTimeout(() => {}, 20000)'],
    languageId: () => 'typescript', note: 'fake',
  }, limit);
  const sent: Fake['sent'] = [];
  (session.connection as any).notify = (method: string, params: any) => { sent.push({ method, params }); };
  try {
    body({ root, session, sent });
  } finally {
    // The folder is the child's working directory, which Windows keeps locked until the process is gone:
    // removing it earlier fails with EPERM, and that error would replace an assertion that failed above.
    const child = (session.connection as any).child;
    const gone = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await gone;
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

const name = (uri: string) => basename(fileURLToPath(uri));
// What the server was told, as "file:type" (1 created, 2 changed, 3 deleted), and which documents were opened or closed.
const watched = (sent: Fake['sent']) => sent.filter(m => m.method === 'workspace/didChangeWatchedFiles').flatMap(m => m.params.changes.map((c: any) => `${name(c.uri)}:${c.type}`));
const documents = (sent: Fake['sent'], method: string) => sent.filter(m => m.method === method).map(m => name(m.params.textDocument.uri));

// A server that ignores watched-file events (typescript-language-server without dynamic registration) only
// learns about a file another tool created if the client opens it; non-source files stay closed.
test('flush opens source files created by other tools and leaves other files closed', async () => {
  await fake([], ({ root, session, sent }) => {
    writeFileSync(join(root, 'extra.ts'), 'export const x = 1;\n');
    writeFileSync(join(root, 'notes.md'), '# notes\n');
    session.markChanged(join(root, 'extra.ts'));
    session.markChanged(join(root, 'notes.md'));
    session.flush();
    const opened = sent.filter(m => m.method === 'textDocument/didOpen').map(m => m.params.textDocument.uri as string);
    assert.equal(opened.length, 1);
    assert.match(opened[0], /extra\.ts$/);
    const event = sent.find(m => m.method === 'workspace/didChangeWatchedFiles');
    assert.deepEqual(event?.params.changes.map((c: any) => c.type), [1, 1]);
  });
});

// git, a formatter or a generator leave no tool result. The server may be up long before the first question
// (the warm-up starts it with the session), so what counts is the disk since the server started.
test('a file another program created after the server started is announced before the first request', async () => {
  await fake(['a.ts'], ({ root, session, sent }) => {
    writeFileSync(join(root, 'late.ts'), 'export const late = 1;\n');
    session.flush();
    assert.deepEqual(watched(sent), ['late.ts:1']);
    assert.deepEqual(documents(sent, 'textDocument/didOpen'), ['late.ts']);
  });
});

test('files another program changed or deleted are announced as such, once, and unchanged files not at all', async () => {
  await fake(['a.ts', 'b.ts', 'c.ts'], ({ root, session, sent }) => {
    session.sync(join(root, 'b.ts'));
    session.flush();
    assert.deepEqual(watched(sent), [], 'nothing changed yet');
    writeFileSync(join(root, 'a.ts'), 'export const a = "another text";\n');
    rmSync(join(root, 'b.ts'));
    session.flush();
    assert.deepEqual(watched(sent).sort(), ['a.ts:2', 'b.ts:3']);
    assert.deepEqual(documents(sent, 'textDocument/didClose'), ['b.ts'], 'the deleted file was open');
    assert.deepEqual(documents(sent, 'textDocument/didOpen'), ['b.ts'], 'a changed file is announced, not opened');
    sent.length = 0;
    session.flush();
    assert.deepEqual(watched(sent), [], 'each change is announced once');
  });
});

test('a change that edit or write also reported is announced once, however the path was spelled', async () => {
  await fake([], ({ root, session, sent }) => {
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'late.ts'), 'export const late = 1;\n');
    session.markChanged(`${root}/sub/../late.ts`);
    session.flush();
    assert.deepEqual(watched(sent), ['late.ts:1']);
    session.sync(`${root}/sub/../late.ts`);
    assert.deepEqual(documents(sent, 'textDocument/didOpen'), ['late.ts'], 'the document is opened once');
  });
});

test('a root with more source files than the limit is not scanned at all, and the session says so', async () => {
  await fake(['a.ts', 'b.ts', 'c.ts'], ({ root, session, sent }) => {
    assert.equal(session.tracksExternalChanges, false);
    writeFileSync(join(root, 'late.ts'), 'export const late = 1;\n');
    session.flush();
    assert.deepEqual(watched(sent), [], 'no partial scan');
    session.markChanged(join(root, 'late.ts'));
    session.flush();
    assert.deepEqual(watched(sent), ['late.ts:1'], 'edit and write still reach the server');
  }, 2);
  await fake(['a.ts', 'b.ts', 'c.ts'], ({ session }) => assert.equal(session.tracksExternalChanges, true, 'exactly at the limit'), 3);
});

test('snapshot lists the source files outside dependency, build and hidden folders, or nothing above the limit', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-lsp-snapshot-'));
  const put = (f: string, text = 'export const x = 1;\n') => { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), text); };
  const listed = (files: Map<string, unknown>) => [...files.keys()].map(p => relative(root, p).replace(/\\/g, '/')).sort();
  try {
    for (const f of ['src/a.ts', 'src/deep/b.tsx', 'types.d.ts', 'notes.md', 'node_modules/dep/index.ts', 'dist/a.js', '.cache/c.ts']) put(f);
    assert.deepEqual(listed(snapshot(root, SOURCES.typescript, 3)!), ['src/a.ts', 'src/deep/b.tsx', 'types.d.ts']);
    assert.equal(snapshot(root, SOURCES.typescript, 2), null, 'one file more than the limit');
    assert.deepEqual(listed(snapshot(root, SOURCES.csharp, 3)!), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('changes tells created, changed and deleted files apart and leaves unchanged ones out', () => {
  const before = new Map([['kept.ts', '10:5'], ['edited.ts', '10:5'], ['touched.ts', '10:5'], ['removed.ts', '10:5']]);
  const after = new Map([['kept.ts', '10:5'], ['edited.ts', '10:6'], ['touched.ts', '11:5'], ['added.ts', '12:1']]);
  assert.deepEqual([...changes(before, after)].sort(), [['added.ts', 1], ['edited.ts', 2], ['removed.ts', 3], ['touched.ts', 2]]);
  assert.equal(changes(after, after).size, 0);
});
