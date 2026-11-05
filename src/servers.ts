// Which language server answers for a file, and from which project root. TypeScript and JavaScript use the
// project's own compiler: TypeScript 7+ ships a native server (`tsc --lsp --stdio`); older versions go through
// typescript-language-server with the project's tsserver. A file outside any project gets the bundled
// TypeScript 7. C# uses csharp-ls from the solution or project folder.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, extname, join, parse } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ServerSpec { key: string; kind: 'typescript' | 'csharp'; root: string; command: string; args: string[]; initializationOptions?: unknown; languageId: (path: string) => string; note: string }

const TS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const require = createRequire(import.meta.url);

function upwards(start: string, found: (dir: string) => boolean): string | null {
  for (let dir = start; ; dir = dirname(dir)) {
    if (found(dir)) return dir;
    if (dirname(dir) === dir) return null;
  }
}

const has = (dir: string, ...names: string[]) => names.some(n => existsSync(join(dir, n)));

function tsLanguageId(path: string) {
  const ext = extname(path).toLowerCase();
  if (ext === '.tsx') return 'typescriptreact';
  if (ext === '.jsx') return 'javascriptreact';
  return ext.endsWith('ts') ? 'typescript' : 'javascript';
}

function typescriptAt(root: string): { dir: string; version: string } | null {
  const dir = upwards(root, d => existsSync(join(d, 'node_modules', 'typescript', 'package.json')));
  if (!dir) return null;
  const pkg = join(dir, 'node_modules', 'typescript');
  return { dir: pkg, version: JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version };
}

async function nativeExe(typescriptDir: string): Promise<string> {
  const mod = await import(pathToFileURL(join(typescriptDir, 'lib', 'getExePath.js')).href);
  return mod.default();
}

async function typescriptServer(file: string): Promise<ServerSpec> {
  const start = dirname(file);
  const root = upwards(start, d => has(d, 'tsconfig.json', 'jsconfig.json')) ?? upwards(start, d => has(d, 'package.json')) ?? start;
  const local = typescriptAt(root);
  if (local && Number(local.version.split('.')[0]) >= 7) {
    return { key: `ts7:${root}`, kind: 'typescript', root, command: await nativeExe(local.dir), args: ['--lsp', '--stdio'], languageId: tsLanguageId, note: `TypeScript ${local.version} (project, native)` };
  }
  if (local) {
    const cli = join(dirname(require.resolve('typescript-language-server/package.json')), 'lib', 'cli.mjs');
    return {
      key: `tsls:${root}`, kind: 'typescript', root, command: process.execPath, args: [cli, '--stdio'],
      // The syntax server answers project-wide requests from the open file alone until the project loads; never use it.
      initializationOptions: { tsserver: { path: join(local.dir, 'lib', 'tsserver.js'), useSyntaxServer: 'never' }, preferences: { includeCompletionsForModuleExports: false } },
      languageId: tsLanguageId, note: `TypeScript ${local.version} (project, tsserver)`,
    };
  }
  const bundled = dirname(require.resolve('typescript/package.json'));
  const version = JSON.parse(readFileSync(join(bundled, 'package.json'), 'utf8')).version;
  return { key: `ts7:${root}`, kind: 'typescript', root, command: await nativeExe(bundled), args: ['--lsp', '--stdio'], languageId: tsLanguageId, note: `TypeScript ${version} (bundled with pi-lsp; the project has none)` };
}

export function findOnPath(name: string, env = process.env): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const home = env.USERPROFILE ?? env.HOME;
  if (home) dirs.push(join(home, '.dotnet', 'tools'));
  for (const dir of dirs) for (const ext of exts) if (existsSync(join(dir, name + ext))) return join(dir, name + ext);
  return null;
}

function csharpServer(file: string): ServerSpec {
  const start = dirname(file);
  const listed = (d: string) => { try { return readdirSync(d); } catch { return []; } };
  const root = upwards(start, d => listed(d).some(n => /\.slnx?$/i.test(n))) ?? upwards(start, d => listed(d).some(n => /\.csproj$/i.test(n))) ?? start;
  const exe = findOnPath('csharp-ls');
  if (!exe) throw new Error('No C# language server: install it with `dotnet tool install -g csharp-ls`, then call lsp again.');
  const solution = listed(root).find(n => /\.slnx?$/i.test(n));
  return { key: `cs:${root}`, kind: 'csharp', root, command: exe, args: solution ? ['--solution', solution] : [], languageId: () => 'csharp', note: `csharp-ls (${solution ?? 'project folder'})` };
}

export async function serverFor(file: string): Promise<ServerSpec> {
  const ext = extname(file).toLowerCase();
  if (TS_EXT.has(ext)) return typescriptServer(file);
  if (ext === '.cs') return csharpServer(file);
  throw new Error(`No language server for ${ext || parse(file).base} files; lsp covers TypeScript/JavaScript and C#.`);
}
