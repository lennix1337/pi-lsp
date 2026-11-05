// A language server over stdio: Content-Length framed JSON-RPC, requests with timeouts, and the few
// server-to-client requests a server blocks on (configuration, capability registration, progress).
import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Diagnostic { range: Range; severity?: number; code?: string | number; message: string; source?: string }
export interface Position { line: number; character: number }
export interface Range { start: Position; end: Position }
export interface Location { uri: string; range: Range }

export class LspError extends Error {}

// Servers spell the same file differently (file:///c%3A/… vs file:///C:/…); diagnostics are keyed by this.
export function uriKey(uri: string): string {
  let path: string;
  try { path = resolve(fileURLToPath(uri)); } catch { return uri; }
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

export class Connection {
  readonly child: ChildProcess;
  private buffer = Buffer.alloc(0);
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly diagnosticListeners = new Map<string, Set<() => void>>();
  readonly diagnostics = new Map<string, Diagnostic[]>();
  readonly pushes = new Map<string, number>();
  private stderr = '';
  exited: string | null = null;

  constructor(command: string, args: string[], cwd: string) {
    this.child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    this.child.stdout!.on('data', (chunk: Buffer) => this.receive(chunk));
    this.child.stderr!.on('data', (chunk: Buffer) => { if (this.stderr.length < 20_000) this.stderr += chunk.toString(); });
    this.child.on('error', e => this.fail(`could not start ${command}: ${e.message}`));
    this.child.on('exit', code => this.fail(`${command} exited (code ${code})${this.stderr ? `: ${this.stderr.trim().slice(-400)}` : ''}`));
    this.child.stdin!.on('error', () => { /* reported by exit */ });
  }

  private fail(reason: string) {
    if (this.exited) return;
    this.exited = reason;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new LspError(reason)); }
    this.pending.clear();
  }

  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const head = this.buffer.indexOf('\r\n\r\n');
      if (head < 0) return;
      const length = /Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, head).toString('ascii'));
      if (!length) { this.buffer = this.buffer.subarray(head + 4); continue; }
      const end = head + 4 + Number(length[1]);
      if (this.buffer.length < end) return;
      const body = this.buffer.subarray(head + 4, end).toString('utf8');
      this.buffer = this.buffer.subarray(end);
      let message: any;
      try { message = JSON.parse(body); } catch { continue; }
      this.dispatch(message);
    }
  }

  private dispatch(message: any) {
    if (message.method && message.id !== undefined) { this.send({ jsonrpc: '2.0', id: message.id, result: this.answer(message.method, message.params) }); return; }
    if (message.method === 'textDocument/publishDiagnostics') {
      const key = uriKey(String(message.params?.uri ?? ''));
      this.diagnostics.set(key, message.params?.diagnostics ?? []);
      this.pushes.set(key, (this.pushes.get(key) ?? 0) + 1);
      for (const listener of this.diagnosticListeners.get(key) ?? []) listener();
      return;
    }
    if (message.id === undefined) return;
    const call = this.pending.get(message.id);
    if (!call) return;
    this.pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.reject(new LspError(message.error.message ?? JSON.stringify(message.error)));
    else call.resolve(message.result);
  }

  // Requests the server makes of us. A null result is a valid answer to each; configuration wants one item per request.
  private answer(method: string, params: any): unknown {
    if (method === 'workspace/configuration') return (params?.items ?? []).map(() => null);
    return null;
  }

  private send(message: unknown) {
    if (this.exited) throw new LspError(this.exited);
    const body = JSON.stringify(message);
    this.child.stdin!.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  }

  request<T = any>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.exited) return Promise.reject(new LspError(this.exited));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new LspError(`${method} timed out after ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e as Error); }
    });
  }

  notify(method: string, params: unknown) { this.send({ jsonrpc: '2.0', method, params }); }

  // Diagnostics pushed for uri after a change. Servers push in stages (syntax, then semantic), so this waits
  // until pushes stop for quietMs after the first one, or timeoutMs in all, and returns the last list.
  settledDiagnostics(uri: string, pushesBefore: number, timeoutMs: number, quietMs = 1_500): Promise<Diagnostic[]> {
    const key = uriKey(uri);
    return new Promise(done_ => {
      let quiet: NodeJS.Timeout | null = null;
      const listeners = this.diagnosticListeners.get(key) ?? new Set();
      this.diagnosticListeners.set(key, listeners);
      const done = () => { clearTimeout(total); if (quiet) clearTimeout(quiet); listeners.delete(onPush); done_(this.diagnostics.get(key) ?? []); };
      const onPush = () => { if (quiet) clearTimeout(quiet); quiet = setTimeout(done, quietMs); };
      const total = setTimeout(done, timeoutMs);
      listeners.add(onPush);
      if ((this.pushes.get(key) ?? 0) > pushesBefore) onPush();
    });
  }

  // Resolves once the process is gone: it holds its working folder open until then.
  async close() {
    if (this.exited) return;
    const gone = new Promise<void>(resolve => this.child.once('exit', () => resolve()));
    try { await this.request('shutdown', null, 3_000); this.notify('exit', null); } catch { /* killed below */ }
    const kill = setTimeout(() => { if (!this.exited) this.child.kill(); }, 1_500);
    await gone;
    clearTimeout(kill);
  }
}
