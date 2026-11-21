


import { statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Connection, type Diagnostic, uriKey } from './connection.ts';
import { MAX_SOURCE_FILES, filesUnder } from './ops.ts';
import { type ServerSpec, serverFor } from './servers.ts';

const IDLE_MS = 10 * 60_000;
export const SOURCES: Record<ServerSpec['kind'], RegExp> = { typescript: /\.[cm]?[jt]sx?$/i, csharp: /\.cs$/i };

interface OpenDoc { version: number; mtimeMs: number; size: number }

// external: A partial source snapshot would misrepresent project changes.

export function snapshot(root: string, sources: RegExp, maxFiles: number): Map<string, string> | null {
  const files = new Map<string, string>();
  for (const path of filesUnder(root)) {
    if (!sources.test(path)) continue;

    let stat; try { stat = statSync(path); } catch { continue; }
    if (files.size >= maxFiles) return null;
    files.set(path, `${stat.mtimeMs}:${stat.size}`);
  }
  return files;
}


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

  private known: Map<string, string> | null;

  constructor(spec: ServerSpec, readonly maxTracked = MAX_SOURCE_FILES) {
    this.spec = spec;
    // external: Files may change while the server warms up before the first request.

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


  get tracksExternalChanges() { return this.known !== null; }



  markChanged(path: string) { this.changed.add(resolve(path)); }


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



  flush() {
    const events: Array<{ uri: string; type: number }> = [];
    const found = this.scan();
    for (const path of new Set([...this.changed, ...found.keys()])) {
      const uri = pathToFileURL(path).href;
      const type = found.get(path) ?? this.watchedChange(path);
      events.push({ uri, type });
      if (type === 3 && this.open.delete(path)) this.connection.notify('textDocument/didClose', { textDocument: { uri } });
      // external: typescript-language-server can drop watched-file events without dynamic registration, and Linux watchers may lag.

      if (type === 1 && SOURCES[this.spec.kind].test(path)) { try { this.sync(path); } catch {  } }
    }
    this.changed.clear();
    for (const path of this.open.keys()) { try { this.sync(path); } catch {  } }
    if (events.length) this.connection.notify('workspace/didChangeWatchedFiles', { changes: events });
  }



  private scan(): Map<string, number> {
    if (!this.known) return new Map();
    const now = snapshot(this.spec.root, SOURCES[this.spec.kind], this.maxTracked);
    const found = now ? changes(this.known, now) : new Map<string, number>();
    this.known = now;
    return found;
  }



  private watchedChange(path: string): number {
    // external: A filesystem without birth times reports zero; use change time instead.
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

  // external: Cold tsserver may take seconds to load the project.

  async prewarm(file: string, timeoutMs = 60_000) {
    const session = await this.forFile(file);
    const uri = session.sync(file);
    await session.connection.request('textDocument/documentSymbol', { textDocument: { uri } }, timeoutMs);
    return session;
  }


  async fileChanged(path: string) {
    for (const pending of this.sessions.values()) { const s = await pending.catch(() => null); if (s?.alive) s.markChanged(path); }
  }

  private drop(key: string) { const p = this.sessions.get(key); this.sessions.delete(key); p?.then(s => s.close(), () => undefined); }

  async closeAll() { const all = [...this.sessions.keys()]; await Promise.all(all.map(k => { const p = this.sessions.get(k)!; this.sessions.delete(k); return p.then(s => s.close(), () => undefined); })); }
}
