// Against real language servers: the bundled TypeScript 7 native server, and typescript-language-server with
// a TypeScript 5 project. Same-named symbols, strings and comments are the traps a text rename falls into.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import extension from '../src/index.ts';
import { findOnPath, warmupFile } from '../src/servers.ts';
import { Pool } from '../src/session.ts';
import { references } from '../src/ops.ts';

const require = createRequire(import.meta.url);

function project(withTs5: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-lsp-'));
  const put = (f: string, t: string) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), t); };
  put('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true }, include: ['src'] }));
  put('src/cart.ts', 'export class Cart {\n  items: number[] = [];\n  total(): number { return this.items.reduce((a, b) => a + b, 0); }\n}\n');
  put('src/invoice.ts', 'export class Invoice {\n  total(): number { return 0; }\n}\n');
  put('src/use.ts', "import { Cart } from './cart';\nimport { Invoice } from './invoice';\n// total is the cart total\nexport const label = 'total';\nexport function both(c: Cart, i: Invoice) { return c.total() + i.total(); }\nexport function twice(c: Cart) { return c.total() * 2; }\n");
  if (withTs5) { mkdirSync(join(dir, 'node_modules')); symlinkSync(dirname(require.resolve('typescript5/package.json')), join(dir, 'node_modules', 'typescript'), 'junction'); }
  return dir;
}

function harness() {
  const tools = new Map<string, any>(); const handlers = new Map<string, Function[]>();
  const pi: any = { registerTool: (t: any) => tools.set(t.name, t), on: (e: string, h: Function) => handlers.set(e, [...(handlers.get(e) ?? []), h]) };
  extension(pi);
  const lsp = tools.get('lsp');
  return {
    call: async (cwd: string, input: any) => (await lsp.execute('t', lsp.prepareArguments(input), undefined, undefined, { cwd })).content[0].text as string,
    emit: async (event: string, payload: any, cwd?: string) => { for (const h of handlers.get(event) ?? []) await h(payload, { cwd }); },
  };
}

const dirs: string[] = [];
const h = harness();
after(async () => { await h.emit('session_shutdown', {}); for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });

for (const [name, ts5] of [['TypeScript 7 native (bundled)', false], ['typescript-language-server + TypeScript 5', true]] as const) {
  test(`${name}: references, rename, diagnostics and edits by other tools`, { timeout: 120_000 }, async () => {
    const dir = project(ts5); dirs.push(dir);
    const refs = await h.call(dir, { action: 'references', path: 'src/cart.ts', symbol: 'total', line: null });
    assert.match(refs, ts5 ? /TypeScript 5\.\d+\.\d+ \(project, tsserver\)/ : /bundled with pi-lsp/);
    assert.match(refs, /3 reference\(s\)/);
    assert.match(refs, /src\/use\.ts:5:\d+ {2}export function both/);
    assert.doesNotMatch(refs, /invoice\.ts/);

    const def = await h.call(dir, { action: 'definition', path: 'src/use.ts', symbol: 'total', line: 6 });
    assert.match(def, /src\/cart\.ts:3:3/);

    const renamed = await h.call(dir, { action: 'rename', path: 'src/cart.ts', symbol: 'total', newName: 'subtotal' });
    assert.match(renamed, /Renamed total → subtotal: 3 edit\(s\) in 2 file\(s\)/);
    assert.match(renamed, /still spelled total[^\n]*\nsrc\/invoice\.ts:2 .*\nsrc\/use\.ts:3 .*\nsrc\/use\.ts:4 .*\nsrc\/use\.ts:5 .*i\.total\(\)/);
    const use = readFileSync(join(dir, 'src/use.ts'), 'utf8');
    assert.match(use, /c\.subtotal\(\) \+ i\.total\(\)/);
    assert.match(use, /label = 'total'/);
    assert.match(use, /\/\/ total is the cart total/);
    assert.match(readFileSync(join(dir, 'src/invoice.ts'), 'utf8'), /total\(\): number/);

    assert.match(await h.call(dir, { action: 'diagnostics', path: 'src/use.ts' }), /no diagnostics/);
    // Another tool breaks a file the server has not opened; diagnostics see the new text.
    writeFileSync(join(dir, 'src/use.ts'), use.replace('c.subtotal() * 2', 'c.total() * 2'));
    await h.emit('tool_result', { toolName: 'write', input: { path: join(dir, 'src/use.ts') }, isError: false });
    const diags = await h.call(dir, { action: 'diagnostics', path: 'src/use.ts' });
    assert.match(diags, /1 error\(s\)/);
    assert.match(diags, /use\.ts:6:\d+ error .*total/);

    // A file changed on disk after the server read it: references follow the new text.
    writeFileSync(join(dir, 'src/extra.ts'), "import { Cart } from './cart';\nexport const x = new Cart().subtotal();\n");
    await h.emit('tool_result', { toolName: 'write', input: { path: 'src/extra.ts' }, isError: false }, dir);
    const after = await h.call(dir, { action: 'references', path: 'src/cart.ts', symbol: 'subtotal' });
    assert.match(after, /extra\.ts:2/);

    assert.match(await h.call(dir, { action: 'hover', path: 'src/cart.ts', symbol: 'subtotal' }), /subtotal\(\): number/);
    assert.match(await h.call(dir, { action: 'symbols', path: 'src/cart.ts', query: 'Invoice' }), /invoice\.ts:1 {2}class Invoice/);
  });
}

test('C#: csharp-ls renames one class\'s method and leaves the same-named one alone', { timeout: 300_000, skip: findOnPath('csharp-ls') ? false : 'csharp-ls not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-lsp-cs-')); dirs.push(dir);
  writeFileSync(join(dir, 'Shop.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><OutputType>Library</OutputType></PropertyGroup></Project>');
  writeFileSync(join(dir, 'Cart.cs'), 'namespace Shop;\npublic class Cart { public int Total() => 1; }\npublic class Invoice { public int Total() => 2; }\n');
  writeFileSync(join(dir, 'Use.cs'), 'namespace Shop;\npublic static class Use { public static int Both(Cart c, Invoice i) => c.Total() + i.Total(); public static string Label = "Total"; }\n');
  execFileSync('dotnet', ['restore', '-v', 'q'], { cwd: dir, stdio: 'ignore' });
  assert.match(await h.call(dir, { action: 'references', path: 'Cart.cs', symbol: 'Total' }), /2 reference\(s\)[\s\S]*Use\.cs:2:74/);
  assert.match(await h.call(dir, { action: 'rename', path: 'Cart.cs', symbol: 'Total', newName: 'Subtotal' }), /2 edit\(s\) in 2 file\(s\)/);
  assert.match(readFileSync(join(dir, 'Use.cs'), 'utf8'), /c\.Subtotal\(\) \+ i\.Total\(\); public static string Label = "Total"/);
  assert.match(await h.call(dir, { action: 'diagnostics', path: 'Use.cs' }), /no diagnostics/);
});

test('errors explain what to pass next', async () => {
  const dir = project(false); dirs.push(dir);
  await assert.rejects(h.call(dir, { action: 'references', path: 'src/cart.ts', symbol: 'total', line: 1 }), /not on line 1; it occurs on line\(s\) 3/);
  await assert.rejects(h.call(dir, { action: 'rename', path: 'src/cart.ts', symbol: 'total' }), /newName is required/);
  await assert.rejects(h.call(dir, { action: 'references', path: 'notes.md', symbol: 'x' }), /No language server for \.md/);
});

test('a warmed-up server answers the first question without the project-load wait a cold one has', { timeout: 120_000 }, async () => {
  const time = async (warm: boolean) => {
    const dir = project(true); dirs.push(dir);
    const file = join(dir, 'src', 'cart.ts');
    const pool = new Pool();
    try {
      if (warm) assert.equal(warmupFile(dir), file), await pool.prewarm(file);
      const session = await pool.forFile(file);
      const started = Date.now();
      const found = await references(session, session.sync(file), { line: 2, character: 2 }, 60_000);
      assert.equal(found.length, 3);
      return Date.now() - started;
    } finally { await pool.closeAll(); }
  };
  const cold = await time(false), warm = await time(true);
  assert.ok(warm * 3 < cold, `warm ${warm} ms vs cold ${cold} ms`);
});
