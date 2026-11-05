// One running language server per project root, with the documents it has open kept in step with the disk.
// Files changed by other tools are announced before the next request, so answers never come from stale text.
import { statSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Connection, type Diagnostic, uriKey } from './connection.ts';
import { type ServerSpec, serverFor } from './servers.ts';

const IDLE_MS = 10 * 60_000;

interface OpenDoc { version: number; mtimeMs: number; size: number }

export class Session {
  readonly spec: ServerSpec;
  readonly connection: Connection;
  capabilities: any = {};
  private readonly open = new Map<string, OpenDoc>();
  private readonly changed = new Set<string>();
  private readonly fresh = new Set<string>();
  private idle: NodeJS.Timeout | null = null;
  private readonly startedAt = Date.now();

  constructor(spec: ServerSpec) {
    this.spec = spec;
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

  // Another tool wrote this file; tell the server before it answers again.
  markChanged(path: string) { this.changed.add(path); }

  // Open the file, or send its new text when it changed on disk since the server last saw it.
  sync(path: string): string {
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

  // Flush changes made by other tools: a watched-file event for each, new text for open documents, and a
  // close for an open document that was deleted.
  flush() {
    const events: Array<{ uri: string; type: number }> = [];
    for (const path of this.changed) {
      const uri = pathToFileURL(path).href;
      const type = this.watchedChange(path);
      events.push({ uri, type });
      if (type === 3 && this.open.delete(path)) this.connection.notify('textDocument/didClose', { textDocument: { uri } });
    }
    this.changed.clear();
    for (const path of this.open.keys()) { try { this.sync(path); } catch { /* deleted */ } }
    if (events.length) this.connection.notify('workspace/didChangeWatchedFiles', { changes: events });
  }

  // 1 created (after this server started, so it cannot know it), 2 changed, 3 deleted.
  private watchedChange(path: string): number {
    try { return statSync(path).birthtimeMs >= this.startedAt ? 1 : 2; } catch { return 3; }
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
  constructor(private readonly startTimeoutMs = 60_000) {}

  async forFile(path: string): Promise<Session> {
    const spec = await serverFor(path);
    let pending = this.sessions.get(spec.key);
    if (pending) {
      const session = await pending.catch(() => null);
      if (session?.alive) { session.touch(() => this.drop(spec.key)); return session; }
      this.sessions.delete(spec.key);
    }
    pending = (async () => { const s = new Session(spec); await s.start(this.startTimeoutMs); return s; })();
    this.sessions.set(spec.key, pending);
    pending.catch(() => this.sessions.delete(spec.key));
    const session = await pending;
    session.touch(() => this.drop(spec.key));
    return session;
  }

  // A file another tool changed: every live server learns of it before its next answer.
  async fileChanged(path: string) {
    for (const pending of this.sessions.values()) { const s = await pending.catch(() => null); if (s?.alive) s.markChanged(path); }
  }

  private drop(key: string) { const p = this.sessions.get(key); this.sessions.delete(key); p?.then(s => s.close(), () => undefined); }

  async closeAll() { const all = [...this.sessions.keys()]; await Promise.all(all.map(k => { const p = this.sessions.get(k)!; this.sessions.delete(k); return p.then(s => s.close(), () => undefined); })); }
}
