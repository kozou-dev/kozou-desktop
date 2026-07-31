#!/usr/bin/env node
// Artifact-level read-only verification, per SURFACE (see EGRESS.md item 8).
//
// The app used to be read-only as a whole, and this script proved it the
// simplest way there is: @kozou/api — the write surface — was absent from the
// production dependency tree. Row editing is an opt-in feature now, so that
// package IS a production dependency, and the guarantee is restated one level
// down: read-only is a property of each SURFACE, and the write path may be
// reachable from exactly one bundle.
//
//  1. WRITE REACHABILITY. The three bundles that must never be able to write —
//     the inspect worker, the MCP server worker, and the main process — are
//     bundled and scanned for the write entry points. The data worker is the
//     only bundle allowed to contain them; nothing here asserts anything about
//     it. Main is included deliberately: it is the only process holding the
//     credentials, so "main cannot write" is what keeps the write path behind
//     the worker fork it gates.
//  2. INSPECT WORKER. Additionally must not contain MCP server/transport or
//     execution code. It imports @kozou/mcp's describe pure functions (the AI
//     view), which legitimately pull in MCP SDK type/validation modules through
//     the describe output schemas — measured and accepted. What must stay
//     absent, and is asserted: the server/transport stack and every
//     execution-path identifier.
//  3. MCP SERVER WORKER. Legitimately contains the server/transport stack (that
//     is its job) — and, because @kozou/mcp's server module statically imports
//     its runtime-gated execution and OAuth code, the execution identifiers are
//     present in that bundle too, unreachable without the opt-in options. A
//     bundle scan therefore cannot prove read-only there. Instead: a SOURCE
//     tripwire asserts the worker never constructs the execution/OAuth options
//     (the only way to arm those code paths), and the runtime integration test
//     (test/mcpServer.integration.test.ts) asserts the served tool list has no
//     execution tool and that forcing it is refused.
//  4. SOURCE TRIPWIRE, whole of src/: nothing may start @kozou/api's HTTP
//     server or build its request listener. A marker scan cannot cover this
//     one — `externalizeDepsPlugin` ships node_modules whole, so the packaged
//     app contains that code whether or not anything can reach it, and
//     what the scans below prove is REACHABILITY, not absence from the artifact.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const outDir = mkdtempSync(join(tmpdir(), 'kozou-desktop-treeshake-'));

/** Bundle one entry with esbuild (not minified: identifiers survive, which is
 *  what the marker scans read) and return the bundle text. */
function bundle(entry, name) {
  const outFile = join(outDir, `${name}.bundle.js`);
  execFileSync(
    'pnpm',
    [
      'exec',
      'esbuild',
      entry,
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--external:electron',
      '--external:pg-native',
      `--outfile=${outFile}`,
    ],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  return readFileSync(outFile, 'utf8');
}

// The write path's entry points. `handleApiRequest` is the dispatcher the data
// worker calls; the three query builders are the statement writers themselves.
// Any of them appearing in a bundle means write code is reachable there.
const WRITE_MARKERS = [
  'handleApiRequest',
  'buildInsertQuery',
  'buildUpdateQuery',
  'buildDeleteQuery',
];

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
const EXECUTION_MARKERS = [
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

// -- 1..3. per-surface bundle scans -------------------------------------------
const SURFACES = [
  {
    label: 'inspect worker',
    name: 'inspectWorker',
    entry: 'src/worker/inspectWorker.ts',
    markers: [...WRITE_MARKERS, ...EXECUTION_MARKERS],
  },
  {
    label: 'MCP server worker',
    name: 'mcpServerWorker',
    entry: 'src/worker/mcpServerWorker.ts',
    // Write markers only: the execution identifiers are legitimately present
    // (see the header), and the runtime test is what pins read-only there.
    markers: WRITE_MARKERS,
  },
  {
    label: 'main process',
    name: 'main',
    entry: 'src/main/index.ts',
    markers: WRITE_MARKERS,
  },
];

let failed = false;
for (const surface of SURFACES) {
  const text = bundle(surface.entry, surface.name);
  const found = surface.markers.filter((m) => text.includes(m));
  if (found.length > 0) {
    console.error(`BUNDLE VIOLATION: markers present in ${surface.label} bundle: ${found.join(', ')}`);
    failed = true;
    continue;
  }
  console.log(
    `${surface.label} bundle: clean (${(text.length / 1024).toFixed(0)} KiB, ${surface.markers.length} markers absent)`,
  );
}

// Sanity check on the scans themselves: the markers must actually be findable
// in the one bundle that is allowed to contain them. Without this, a renamed
// upstream export would turn every scan above into a vacuous pass.
const dataBundle = bundle('src/worker/dataWorker.ts', 'dataWorker');
const missing = WRITE_MARKERS.filter((m) => !dataBundle.includes(m));
if (missing.length > 0) {
  console.error(
    `MARKER DRIFT: the data worker bundle does not contain ${missing.join(', ')} — ` +
      'the write markers no longer name real code, so the scans above prove nothing',
  );
  failed = true;
} else {
  console.log(`data worker bundle: contains all ${WRITE_MARKERS.length} write markers (scans are live)`);
}

// -- 4. worker source tripwire -------------------------------------------------
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
  failed = true;
} else {
  console.log(`worker sources (${workerFiles.length} files): no execution/OAuth option construction`);
}

// -- 5. whole-src tripwire: no HTTP server from @kozou/api ---------------------
// The app talks to @kozou/api in-process only. Starting its server (or building
// a request listener for one) would open a port that EGRESS.md says does not
// exist, in a process that holds the operator's credentials.
//
// The rule is deliberately the strictest one available: these names may not
// appear in src AT ALL. Narrower shapes were tried and each has an escape —
// matching `name(` misses `const s = api.startApiServer; s(...)`, matching
// `.name` misses `const { startApiServer: s } = api`, and matching the import
// specifier misses a namespace import. Every one of those still has to write
// the identifier somewhere, so the bare identifier is the one pattern with no
// bypass. Cost: a comment cannot mention these names either — say "the REST
// server entry point" instead. No src file needs them today.
const SERVER_ENTRY_POINTS = ['startApiServer', 'createApiRequestListener'];
const serverViolations = [];
for (const { file, text } of readSources(join(ROOT, 'src'))) {
  for (const name of SERVER_ENTRY_POINTS) {
    if (new RegExp(`\\b${name}\\b`).test(text)) {
      serverViolations.push(`${file}: mentions ${name}`);
    }
  }
}
if (serverViolations.length > 0) {
  console.error(
    `SOURCE VIOLATION: src must not start @kozou/api's HTTP server:\n  ${serverViolations.join('\n  ')}`,
  );
  failed = true;
} else {
  console.log(`src sources: no ${SERVER_ENTRY_POINTS.join('/')} usage`);
}

/** Every .ts / .svelte source under `dir`, recursively, as repo-relative paths. */
function readSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...readSources(full));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.svelte')) {
      out.push({ file: full.slice(ROOT.length), text: readFileSync(full, 'utf8') });
    }
  }
  return out;
}

process.exit(failed ? 1 : 0);
