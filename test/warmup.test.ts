import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { warmupFile } from '../src/servers.ts';

function tree(files: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-lsp-warm-'));
  for (const f of files) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), ''); }
  return dir;
}

test('warm-up picks a source file of a TypeScript project, src first, never declarations or configs', () => {
  const dir = tree(['tsconfig.json', 'vite.config.ts', 'index.d.ts', 'src/a.d.ts', 'src/a.config.ts', 'src/a.md', 'src/cart.ts']);
  try { assert.equal(warmupFile(dir), join(dir, 'src', 'cart.ts')); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('warm-up falls back to the project folder itself, and to a jsconfig project', () => {
  const dir = tree(['jsconfig.json', 'eslint.config.js', 'main.js']);
  try { assert.equal(warmupFile(dir), join(dir, 'main.js')); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no warm-up outside a TypeScript project: a package.json alone (a home folder) starts nothing', () => {
  const dir = tree(['package.json', 'src/cart.ts']);
  try { assert.equal(warmupFile(dir), null); } finally { rmSync(dir, { recursive: true, force: true }); }
});
