// One running language server per project root, with the documents it has open kept in step with the disk.
// Source files created, changed or deleted on disk, by a tool or by any other program, are announced before
// the next request, so answers never come from stale text.
import { statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Connection, type Diagnostic, uriKey } from './connection.ts';
import { MAX_SOURCE_FILES, filesUnder } from './ops.ts';
import { type ServerSpec, serverFor } from './servers.ts';

const IDLE_MS = 10 * 60_000;
export const SOURCES: Record<ServerSpec['kind'], RegExp> = { typescript: /\.[cm]?[jt]sx?$/i, csharp: /\.cs$/i };

interface OpenDoc { version: number; mtimeMs: number; size: number }

// The root's source files as "mtime:size" by path, outside the folders a walk skips. Null when there are more
// than maxFiles: a partial list would pass for the whole project.
export function snapshot(root: string, sources: RegExp, maxFiles: number): Map<string, string> | null {
  const files = new Map<string, string>();
  for (const path of filesUnder(root)) {
    if (!sources.test(path)) continue;
    // Listed but gone by now, or a link to nothing: not a file of the project.
    let stat; try { stat = statSync(path); } catch { continue; }
    if (files.size >= maxFiles) return null;
    files.set(path, `${stat.mtimeMs}:${stat.size}`);
  }
  return files;
}

// What happened to each file between two snapshots: 1 created, 2 changed, 3 deleted. Unchanged files are absent.
export function changes(before: Map<string, string>, after: Map<string, string>): Map<string, number> {
  const found = new Map<string, number>();
  for (const [path, stamp] of after) { const old = before.get(path); if (old !== stamp) found.set(path, old === undefined ? 1 : 2); }
  for (const path of before.keys()) if (!after.has(path)) found.set(path, 3);
  return found;
}

export class Session {
  readonly spec: ServerSpec;
  readonly connection: Connection;
  capabilities: any = {};
  private readonly open = new Map<string, OpenDoc>();
  private readonly changed = new Set<string>();
  private readonly fresh = new Set<string>();
  private idle: NodeJS.Timeout | null = null;
  private readonly startedAt = Date.now();
  // The root's source files as the server last heard of them; null when there are too many to track.
  private known: Map<string, string> | null;

  constructor(spec: ServerSpec, readonly maxTracked = MAX_SOURCE_FILES) {
    this.spec = spec;
    // Taken before the server starts, not at the first request: a file that changes in between (the warm-up
    // starts the server with the session) is announced like any other.
    this.known = snapshot(spec.root, SOURCES[spec.kind], maxTracked);
    this.connection = new Connection(spec.command, spec.args, spec.root);
  }

  async start(timeoutMs: number) {
    const rootUri = pathToFileURL(this.spec.root).href;
    const result = await this.connection.request('initialize', {
      processId: process.pid, rootUri, rootPath: this.spec.root, workspaceFolders: [{ uri: rootUri, name: 'root' }],
      initializationOptions: this.spec.initializationOptions,
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        workspace: { workspaceEdit: { documentChanges: true }, didChangeWatchedFiles: { dynamicRegistration: false }, workspaceFolders: true, configuration: true, symbol: {} },
        textDocument: {
          synchronization: { didSave: false }, references: {}, definition: { linkSupport: false }, rename: { prepareSupport: false },
          hover: { contentFormat: ['markdown', 'plaintext'] }, publishDiagnostics: {}, diagnostic: {},
        },
      },
    }, timeoutMs);
    this.capabilities = result?.capabilities ?? {};
    this.connection.notify('initialized', {});
  }

  get alive() { return !this.connection.exited; }

  touch(onIdle: () => void) {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(onIdle, IDLE_MS);
    this.idle.unref();
  }

  // False when the root has more source files than the limit: only what edit and write report reaches the server.
  get tracksExternalChanges() { return this.known !== null; }

  // Another tool wrote this file; tell the server before it answers again. One spelling per file, so a
  // change a tool reported and the scan also found is one change.
  markChanged(path: string) { this.changed.add(resolve(path)); }

  // Open the file, or send its new text when it changed on disk since the server last saw it.
  sync(path: string): string {
    path = resolve(path);
    const uri = pathToFileURL(path).href;
    const stat = statSync(path);
    const doc = this.open.get(path);
    if (doc && doc.mtimeMs === stat.mtimeMs && doc.size === stat.size) return uri;
    const text = readFileSync(path, 'utf8');
    if (!doc) {
      this.connection.notify('textDocument/didOpen', { textDocument: { uri, languageId: this.spec.languageId(path), version: 1, text } });
      this.open.set(path, { version: 1, mtimeMs: stat.mtimeMs, size: stat.size });
    } else {
      doc.version += 1; doc.mtimeMs = stat.mtimeMs; doc.size = stat.size;
      this.connection.notify('textDocument/didChange', { textDocument: { uri, version: doc.version }, contentChanges: [{ text }] });
    }
    this.fresh.add(uri);
    return uri;
  }

  // Flush changes made by other tools and other programs: a watched-file event for each, new text for open
  // documents, and a close for an open document that was deleted.
  flush() {
    const events: Array<{ uri: string; type: number }> = [];
    const found = this.scan();
    for (const path of new Set([...this.changed, ...found.keys()])) {
      const uri = pathToFileURL(path).href;
      const type = found.get(path) ?? this.watchedChange(path);
      events.push({ uri, type });
      if (type === 3 && this.open.delete(path)) this.connection.notify('textDocument/didClose', { textDocument: { uri } });
      // typescript-language-server drops watched-file events from a client without dynamic registration and
      // leaves new files to tsserver's own watcher, which on Linux can lag the next request: open them instead.
      if (type === 1 && SOURCES[this.spec.kind].test(path)) { try { this.sync(path); } catch { /* gone again */ } }
    }
    this.changed.clear();
    for (const path of this.open.keys()) { try { this.sync(path); } catch { /* deleted */ } }
    if (events.length) this.connection.notify('workspace/didChangeWatchedFiles', { changes: events });
  }

  // What happened to the root's source files since the last call. git, a formatter, a generator or another
  // session leave no tool result, so the disk is the only place that tells.
  private scan(): Map<string, number> {
    if (!this.known) return new Map();
    const now = snapshot(this.spec.root, SOURCES[this.spec.kind], this.maxTracked);
    const found = now ? changes(this.known, now) : new Map<string, number>();
    this.known = now;
    return found;
  }

  // For a file the scan does not cover (not a source file, or a root over the limit): 1 created (after this
  // server started, so it cannot know it), 2 changed, 3 deleted.
  private watchedChange(path: string): number {
    // A filesystem without birth times reports 0; the change time is then the closest bound.
    try { const s = statSync(path); return (s.birthtimeMs || s.ctimeMs) >= this.startedAt ? 1 : 2; } catch { return 3; }
  }

  async diagnostics(path: string, timeoutMs: number, pushesBefore: number): Promise<Diagnostic[]> {
    const uri = this.sync(path);
    if (this.capabilities.diagnosticProvider) {
      const report = await this.connection.request('textDocument/diagnostic', { textDocument: { uri } }, timeoutMs);
      return report?.items ?? [];
    }
    const pushed = this.connection.diagnostics.get(uriKey(uri));
    if (pushed && !this.fresh.has(uri)) return pushed;
    this.fresh.delete(uri);
    return this.connection.settledDiagnostics(uri, pushesBefore, Math.min(timeoutMs, 10_000));
  }

  close() { if (this.idle) clearTimeout(this.idle); return this.connection.close(); }
}

export class Pool {
  private readonly sessions = new Map<string, Promise<Session>>();
  constructor(private readonly startTimeoutMs = 60_000, private readonly maxTracked = MAX_SOURCE_FILES) {}

  async forFile(path: string): Promise<Session> {
    const spec = await serverFor(path);
    let pending = this.sessions.get(spec.key);
    if (pending) {
      const session = await pending.catch(() => null);
      if (session?.alive) { session.touch(() => this.drop(spec.key)); return session; }
      this.sessions.delete(spec.key);
    }
    pending = (async () => { const s = new Session(spec, this.maxTracked); await s.start(this.startTimeoutMs); return s; })();
    this.sessions.set(spec.key, pending);
    pending.catch(() => this.sessions.delete(spec.key));
    const session = await pending;
    session.touch(() => this.drop(spec.key));
    return session;
  }

  // Start the server and let it load the project while the model is still thinking: the first answer of a
  // cold tsserver waits seconds for the project to load, later ones milliseconds.
  async prewarm(file: string, timeoutMs = 60_000) {
    const session = await this.forFile(file);
    const uri = session.sync(file);
    await session.connection.request('textDocument/documentSymbol', { textDocument: { uri } }, timeoutMs);
    return session;
  }

  // A file another tool changed: every live server learns of it before its next answer.
  async fileChanged(path: string) {
    for (const pending of this.sessions.values()) { const s = await pending.catch(() => null); if (s?.alive) s.markChanged(path); }
  }

  private drop(key: string) { const p = this.sessions.get(key); this.sessions.delete(key); p?.then(s => s.close(), () => undefined); }

  async closeAll() { const all = [...this.sessions.keys()]; await Promise.all(all.map(k => { const p = this.sessions.get(k)!; this.sessions.delete(k); return p.then(s => s.close(), () => undefined); })); }
}
