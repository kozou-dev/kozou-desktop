#!/usr/bin/env node
// Artifact-level read-only verification (see EGRESS.md item 7):
//
//  1. The production dependency tree must not contain @kozou/api (the write
//     surface) — checked via pnpm.
//  2. A fully bundled worker must not contain MCP server/transport or
//     execution code. The worker imports @kozou/mcp's describe pure
//     functions (the AI view), which legitimately pull in MCP SDK
//     type/validation modules through the describe output schemas — measured
//     and accepted. What must stay absent, and is asserted below: the MCP
//     server/transport stack and every execution-path identifier.

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

// Genuine execution-path and server-stack markers: these identifiers live in
// the role-switching / execution runtime (@kozou/api REST writes, @kozou/mcp
// `call`) and in the MCP server/transport — never in the describe functions.
// Deliberately NOT markers: `allowPublicExecute` (a compile-time
// exposure-decision identifier inside @kozou/core) and the bare string
// `modelcontextprotocol` (SDK type/validation modules are reachable from the
// describe output schemas by design; docs URLs mention the name too).
// (Module *path comments* like "// node_modules/.../startHttpServer.js" can
// survive when tree-shaking keeps a single exported constant from a module —
// so markers are functional identifiers, not file names.)
const MARKERS = [
  // MCP server/transport stack
  'McpServer',
  'StreamableHTTP',
  'createServer',
  '"node:http"',
  // execution runtime
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
