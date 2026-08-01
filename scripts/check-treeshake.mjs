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
//  5. COMMENT EMIT. The DDL generator must stay a pure renderer module: its
//     whole import graph inside src/ (no dependency, no Node builtin — so no
//     driver and no @kozou/api), absent from every process-side bundle, and
//     present in the built renderer. The third leg is what keeps the first two
//     from passing vacuously on a module nothing ships.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const outDir = mkdtempSync(join(tmpdir(), 'kozou-desktop-treeshake-'));

/** Bundle one entry with esbuild (not minified: identifiers survive, which is
 *  what the marker scans read). Returns the bundle text and its import graph —
 *  every file esbuild pulled in, as repo-relative paths. */
function bundle(entry, name, { platform = 'node', externals = ['electron', 'pg-native'] } = {}) {
  const outFile = join(outDir, `${name}.bundle.js`);
  const metaFile = join(outDir, `${name}.meta.json`);
  execFileSync(
    'pnpm',
    [
      'exec',
      'esbuild',
      entry,
      '--bundle',
      `--platform=${platform}`,
      '--format=esm',
      ...externals.map((mod) => `--external:${mod}`),
      `--outfile=${outFile}`,
      `--metafile=${metaFile}`,
    ],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  return {
    text: readFileSync(outFile, 'utf8'),
    inputs: Object.keys(JSON.parse(readFileSync(metaFile, 'utf8')).inputs),
  };
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
/** repo-relative input path -> the bundles that pulled it in. */
const processSideGraphs = new Map();
for (const surface of SURFACES) {
  const { text, inputs } = bundle(surface.entry, surface.name);
  processSideGraphs.set(surface.label, inputs);
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
const data = bundle('src/worker/dataWorker.ts', 'dataWorker');
const dataBundle = data.text;
processSideGraphs.set('data worker', data.inputs);
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

// -- 6. only the worker directory may hold a database driver ------------------
// The marker scans above prove that @kozou/api's write path is unreachable from
// main and from the read-only workers. They prove nothing about a hand-written
// write: `pg` is a production dependency now, so main could open its own pool
// and issue a DELETE with every marker scan still clean (measured — that is why
// this check exists). Confining the driver to src/worker/ is what makes "the
// write path lives in one process" a checkable statement rather than a habit.
const DRIVER_MODULES = ['pg', 'pg-pool', 'pg-native', 'pg-cursor', 'postgres'];
const driverViolations = [];
for (const { file, text } of readSources(join(ROOT, 'src'))) {
  if (file.startsWith('/src/worker/') || file.startsWith('src/worker/')) continue;
  for (const mod of DRIVER_MODULES) {
    const patterns = [
      new RegExp(`from\\s*['"]${mod}['"]`),
      new RegExp(`require\\s*\\(\\s*['"]${mod}['"]`),
      new RegExp(`import\\s*\\(\\s*['"]${mod}['"]`),
    ];
    if (patterns.some((re) => re.test(text))) {
      driverViolations.push(`${file}: imports the "${mod}" driver outside src/worker/`);
    }
  }
}
if (driverViolations.length > 0) {
  console.error(
    `SOURCE VIOLATION: a database driver outside the worker directory:\n  ${driverViolations.join('\n  ')}`,
  );
  failed = true;
} else {
  console.log('src sources: no database driver outside src/worker/');
}
if (serverViolations.length > 0) {
  console.error(
    `SOURCE VIOLATION: src must not start @kozou/api's HTTP server:\n  ${serverViolations.join('\n  ')}`,
  );
  failed = true;
} else {
  console.log(`src sources: no ${SERVER_ENTRY_POINTS.join('/')} usage`);
}

// -- 7. the COMMENT emit module is a pure renderer module ---------------------
// The feature's whole promise is that it GENERATES DDL and never runs it. That
// is a claim about what the generator can reach, so it is checked as one:
//
//   (a) its own import graph contains nothing but src/ — no dependency (so
//       neither `pg` nor @kozou/api) and no Node builtin, bundled for the
//       browser so a Node import fails the check rather than resolving;
//   (b) it is in no process-side bundle — main and the three workers are the
//       processes that hold a connection, and the generator has no business
//       being reachable from any of them;
//   (c) it IS in the built renderer. Without this leg (a) and (b) would keep
//       passing for a module that had quietly stopped shipping.
const EMIT_MODULE = 'src/renderer/src/lib/commentEmit.ts';
// Two ways the first leg can fail, and both have to be reported as the rule
// rather than as whatever went wrong underneath. A Node builtin (directly, or
// through a dependency that reaches one) makes the BROWSER bundle fail to
// resolve, so esbuild exits non-zero before there is a graph to inspect;
// anything else that resolves shows up as an input outside src/. Measured: an
// UNUSED import of either kind is elided before resolution and trips neither —
// correctly, since an unused import cannot make this module reach anything.
//
// NOTHING is externalized for this bundle, unlike the surface scans above.
// Measured: with `--external:electron`, a used `import { ipcRenderer } from
// 'electron'` survives in the output as an external import and never appears in
// the metafile inputs — so the graph check reported "no dependency" for a module
// importing Electron. With no externals, that import fails to resolve and the
// catch below reports it.
let emit = null;
try {
  emit = bundle(EMIT_MODULE, 'commentEmit', { platform: 'browser', externals: [] });
} catch {
  console.error(
    `EMIT VIOLATION: ${EMIT_MODULE} no longer bundles for the browser — it reaches a Node ` +
      'builtin, or a dependency that does. The DDL generator must stay a pure renderer module.',
  );
  failed = true;
}
if (emit !== null) {
  const emitForeignInputs = emit.inputs.filter((input) => !input.startsWith('src/'));
  if (emitForeignInputs.length > 0) {
    console.error(
      `EMIT VIOLATION: ${EMIT_MODULE} reaches outside src/: ${emitForeignInputs.join(', ')}`,
    );
    failed = true;
  } else {
    console.log(`comment emit: import graph is ${emit.inputs.length} src file(s), no dependency`);
  }
}

const emitOnProcessSide = [...processSideGraphs]
  .filter(([, inputs]) => inputs.includes(EMIT_MODULE))
  .map(([label]) => label);
if (emitOnProcessSide.length > 0) {
  console.error(
    `EMIT VIOLATION: ${EMIT_MODULE} is reachable from ${emitOnProcessSide.join(', ')} — ` +
      'the DDL generator belongs to the renderer, which holds no connection',
  );
  failed = true;
} else {
  console.log(`comment emit: absent from all ${processSideGraphs.size} process-side bundles`);
}

// The generator must also not reach the database THROUGH the preload bridge. No
// import-graph check can see that — a call on the injected `window.kozouDesktop`
// object adds no import at all — so it is a source rule instead, and the honest
// scope of the whole leg is stated in EGRESS.md rather than overclaimed.
const EMIT_BRIDGE_PATTERNS = [
  { re: /\bkozouDesktop\b/, label: 'the preload bridge' },
  { re: /\bwindow\b/, label: 'the renderer global' },
];
const emitSource = readFileSync(join(ROOT, EMIT_MODULE), 'utf8');
const bridgeUse = EMIT_BRIDGE_PATTERNS.filter(({ re }) => re.test(emitSource));
if (bridgeUse.length > 0) {
  console.error(
    `EMIT VIOLATION: ${EMIT_MODULE} names ${bridgeUse.map((b) => b.label).join(', ')} — the ` +
      'generator takes a relation and a string and returns a string; anything it can call is a ' +
      'way for it to reach what it must not',
  );
  failed = true;
} else {
  console.log('comment emit: no preload bridge, no renderer global');
}

// Provenance, at source level: something the renderer builds from has to import
// the module. The artifact scan below cannot establish this — it looks for
// strings, and a string can come from anywhere — so the two are checked
// separately and only both together mean "this module ships".
const emitImporters = readSources(join(ROOT, 'src/renderer')).filter(
  ({ file, text }) => !file.endsWith('lib/commentEmit.ts') && /['"][^'"]*commentEmit['"]/.test(text),
);
if (emitImporters.length === 0) {
  console.error(
    `EMIT VIOLATION: nothing under src/renderer/ imports ${EMIT_MODULE} — the generator is not ` +
      'wired into the UI, so the checks about where it may appear are about dead code',
  );
  failed = true;
} else {
  console.log(`comment emit: imported by ${emitImporters.length} renderer source(s)`);
}

// Marker strings, not identifiers: the renderer build minifies, which renames
// every function in this module but leaves its string literals alone. On its own
// this proves only that two strings ship — which is why it is paired with the
// source-level provenance check above.
const EMIT_ARTIFACT_MARKERS = ['COMMENT ON ', 'MATERIALIZED VIEW'];
const rendererDir = join(ROOT, 'out/renderer');
if (existsSync(rendererDir)) {
  const rendererJs = readSources(rendererDir, ['.js'])
    .map(({ text }) => text)
    .join('\n');
  const absent = EMIT_ARTIFACT_MARKERS.filter((m) => !rendererJs.includes(m));
  if (absent.length > 0) {
    console.error(
      `EMIT VIOLATION: the built renderer does not contain ${absent.join(', ')} — either the ` +
        'generator no longer ships or the statements changed shape. Both make the two checks ' +
        'above claims about a module the app does not use; update the markers or the import.',
    );
    failed = true;
  } else {
    console.log('comment emit: present in the built renderer (checks above are live)');
  }
} else if (process.env.CI) {
  console.error('EMIT VIOLATION: out/renderer missing in CI — run the build before check:treeshake');
  failed = true;
} else {
  console.warn('note: out/renderer not found — run `pnpm build` first for the emit reachability check');
}

/** Every source under `dir`, recursively, as repo-relative paths. */
function readSources(dir, extensions = ['.ts', '.svelte']) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...readSources(full, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      out.push({ file: full.slice(ROOT.length), text: readFileSync(full, 'utf8') });
    }
  }
  return out;
}

process.exit(failed ? 1 : 0);
