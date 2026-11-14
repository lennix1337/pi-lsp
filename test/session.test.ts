import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/session.ts';

// A server that ignores watched-file events (typescript-language-server without dynamic registration) only
// learns about a file another tool created if the client opens it; non-source files stay closed.
test('flush opens source files created by other tools and leaves other files closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-lsp-session-'));
  const session = new Session({
    key: 'fake', kind: 'typescript', root, command: process.execPath, args: ['-e', 'setTimeout(() => {}, 20000)'],
    languageId: () => 'typescript', note: 'fake',
  });
  const sent: Array<{ method: string; params: any }> = [];
  (session.connection as any).notify = (method: string, params: any) => { sent.push({ method, params }); };
  try {
    writeFileSync(join(root, 'extra.ts'), 'export const x = 1;\n');
    writeFileSync(join(root, 'notes.md'), '# notes\n');
    session.markChanged(join(root, 'extra.ts'));
    session.markChanged(join(root, 'notes.md'));
    session.flush();
    const opened = sent.filter(m => m.method === 'textDocument/didOpen').map(m => m.params.textDocument.uri as string);
    assert.equal(opened.length, 1);
    assert.match(opened[0], /extra\.ts$/);
    const watched = sent.find(m => m.method === 'workspace/didChangeWatchedFiles');
    assert.deepEqual(watched?.params.changes.map((c: any) => c.type), [1, 1]);
  } finally {
    // The folder is the child's working directory, which Windows keeps locked until the process is gone:
    // removing it earlier fails with EPERM, and that error would replace an assertion that failed above.
    const child = (session.connection as any).child;
    const gone = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await gone;
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
