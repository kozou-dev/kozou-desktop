#!/usr/bin/env node
// Artifact-level read-only verification (see EGRESS.md item 8):
//
//  1. The production dependency tree must not contain @kozou/api (the write
//     surface) — checked via pnpm.
//  2. The fully bundled INSPECT worker must not contain MCP server/transport
//     or execution code. It imports @kozou/mcp's describe pure functions
//     (the AI view), which legitimately pull in MCP SDK type/validation
//     modules through the describe output schemas — measured and accepted.
//     What must stay absent, and is asserted below: the MCP server/transport
//     stack and every execution-path identifier.
//  3. The MCP SERVER worker legitimately contains the server/transport stack
//     (that is its job) — and, because @kozou/mcp's server module statically
//     imports its runtime-gated execution and OAuth code, the execution
//     identifiers are present in that bundle too, unreachable without the
//     opt-in options. A bundle scan therefore cannot prove read-only there.
//     Instead: a SOURCE tripwire asserts the worker never constructs the
//     execution/OAuth options (the only way to arm those code paths), and
//     the runtime integration test (test/mcpServer.integration.test.ts)
//     asserts the served tool list has no execution tool and that forcing it
//     is refused.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
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

// -- 2. bundled inspect-worker check ------------------------------------------
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
  console.error(`BUNDLE VIOLATION: markers present in inspect worker bundle: ${found.join(', ')}`);
  process.exit(1);
}
console.log(`inspect worker bundle: clean (${(bundle.length / 1024).toFixed(0)} KiB, markers absent)`);

// -- 3. worker source tripwire -------------------------------------------------
// The execution capability and the OAuth resource-server mode are armed
// exclusively through two option keys passed to startHttpServer. The worker
// directory is the only place the app talks to @kozou/mcp's server, so a
// source scan over ALL worker sources is a meaningful tripwire (the
// load-bearing guarantee is the runtime integration test — see the header
// comment). Patterns cover the construction shapes: explicit key,
// assignment, object shorthand, and quoted/computed keys.
const workerDir = join(ROOT, 'src/worker');
const workerFiles = readdirSync(workerDir).filter((f) => f.endsWith('.ts'));
const FORBIDDEN_SOURCE_PATTERNS = [
  { re: /\bexecution\s*[:=]/, label: 'execution option construction' },
  { re: /\bauth\s*[:=]/, label: 'OAuth option construction' },
  { re: /[{,]\s*execution\s*[,}]/, label: 'execution shorthand option' },
  { re: /[{,]\s*auth\s*[,}]/, label: 'OAuth shorthand option' },
  { re: /['"]execution['"]/, label: 'quoted/computed execution key' },
  { re: /['"]auth['"]/, label: 'quoted/computed OAuth key' },
  { re: /McpExecution/, label: 'execution type import' },
  { re: /McpHttpAuthOptions/, label: 'OAuth type import' },
];
const sourceViolations = [];
for (const file of workerFiles) {
  const text = readFileSync(join(workerDir, file), 'utf8');
  for (const { re, label } of FORBIDDEN_SOURCE_PATTERNS) {
    if (re.test(text)) sourceViolations.push(`src/worker/${file}: ${label} (${re})`);
  }
}
if (sourceViolations.length > 0) {
  console.error(`SOURCE VIOLATION: worker source constructs a forbidden option:\n  ${sourceViolations.join('\n  ')}`);
  process.exit(1);
}
console.log(`worker sources (${workerFiles.length} files): no execution/OAuth option construction`);
