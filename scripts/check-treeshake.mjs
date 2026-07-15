#!/usr/bin/env node
// Artifact-level read-only verification (see EGRESS.md item 7):
//
//  1. The production dependency tree must not contain @kozou/api (the write
//     surface) — checked via pnpm.
//  2. A fully bundled worker must not contain MCP server/execution code.
//     In M1 the worker does not import @kozou/mcp at all, so the bundle must
//     be free of any MCP SDK marker. When the AI view lands in M2 and the
//     worker starts importing @kozou/mcp's describe pure functions, revisit
//     the markers: assert the `call` execution tool is tree-shaken (and if it
//     cannot be, weaken the documented claim from "not bundled" to "no
//     execution path is invocable" — never overstate).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

// -- 1. dependency-tree check ------------------------------------------------
const ls = execFileSync('pnpm', ['ls', '@kozou/api', '--prod', '--depth', 'Infinity', '--json'], {
  cwd: ROOT,
  encoding: 'utf8',
});
const entries = JSON.parse(ls);
const hasApi = entries.some((e) => e.dependencies && Object.keys(e.dependencies).length > 0);
if (hasApi) {
  console.error('TREE VIOLATION: @kozou/api found in the production dependency tree');
  process.exit(1);
}
console.log('dependency tree: no @kozou/api in production deps');

// -- 2. bundled-worker check -------------------------------------------------
const outDir = mkdtempSync(join(tmpdir(), 'kozou-desktop-treeshake-'));
const outFile = join(outDir, 'worker.bundle.js');
execFileSync(
  'pnpm',
  [
    'exec',
    'esbuild',
    'src/worker/inspectWorker.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--external:electron',
    '--external:pg-native',
    `--outfile=${outFile}`,
  ],
  { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
);
const bundle = readFileSync(outFile, 'utf8');

// Genuine execution-path markers: these strings live in the role-switching /
// execution runtime (@kozou/api REST writes, @kozou/mcp `call`), not in the
// compiler. Note `allowPublicExecute` is deliberately NOT a marker — it is a
// compile-time exposure-decision identifier inside @kozou/core (feeds
// FunctionContext.publicCallable) and is legitimately present in a
// describe-only bundle.
const MARKERS = [
  'modelcontextprotocol', // MCP server stack
  'executionRole',
  'SET LOCAL ROLE',
  'set_config',
  'runInRoleTransaction',
  'request.jwt.claims',
];
const found = MARKERS.filter((m) => bundle.includes(m));
if (found.length > 0) {
  console.error(`BUNDLE VIOLATION: markers present in worker bundle: ${found.join(', ')}`);
  process.exit(1);
}
console.log(`worker bundle: clean (${(bundle.length / 1024).toFixed(0)} KiB, markers absent)`);
