#!/usr/bin/env node
// Static egress checklist (see EGRESS.md): our own source must not reference
// network-capable Node/Electron modules or perform renderer-side network
// calls, and the production CSP must stay strict. Runtime verification (lsof
// while the app runs) is documented in EGRESS.md; this script keeps
// regressions out of CI.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/** token -> why it is forbidden */
const FORBIDDEN = new Map([
  ['autoUpdater', 'auto-update phones home; out of MVP scope'],
  ['crashReporter', 'crash upload is external egress'],
  ['setFeedURL', 'update feed configuration'],
  ['fetch(', 'no network calls from app code — the only peer is the user database'],
  ['XMLHttpRequest', 'no network calls from app code'],
  ['new WebSocket', 'no network calls from app code'],
  ['navigator.sendBeacon', 'telemetry beacon'],
  ['session.fetch', "Electron's session-level fetch bypasses the renderer CSP"],
  ['net.fetch', "Electron's net.fetch bypasses the renderer CSP"],
  ['net.request', "Electron's net.request is network capability"],
  ['shell.openExternal', 'no external navigation paths in M1 (reintroduce with an allowlist when docs links land)'],
]);

// Network-capable module specifiers — matched as whole import/require
// specifiers so both the `node:` prefix and the bare form are caught.
const NETWORK_MODULES = ['http', 'https', 'http2', 'net', 'tls', 'dgram'];
const NETWORK_MODULE_RE = new RegExp(
  `(?:from\\s*|require\\s*\\(\\s*|import\\s*\\(\\s*)['"](?:node:)?(?:${NETWORK_MODULES.join('|')})['"]`,
);

// `import { net } from 'electron'` (ESM) or `const { net } = require('electron')`
// (CJS) would not hit a simple token — catch both structurally.
const ELECTRON_NET_IMPORT_RE =
  /(?:import\s*(?:type\s*)?{[^}]*\bnet\b[^}]*}\s*from\s*['"]electron['"])|(?:{[^}]*\bnet\b[^}]*}\s*=\s*require\s*\(\s*['"]electron['"]\s*\))/;

const SCAN_DIRS = ['src'];
const EXTENSIONS = new Set(['.ts', '.svelte', '.html', '.css', '.js', '.mjs', '.cjs']);

// The stdio bridge is the one part of the app whose whole job is an outbound
// HTTP call (to 127.0.0.1, see src/bridge/loopback.ts), so the blanket
// "no network module" rule cannot apply to it. What replaces it is narrower
// and, unlike the blanket rule, aimed at the actual invariant BR-3: the
// bridge must not LISTEN.
//
// This is the auxiliary check, not the load-bearing one. A specifier scan
// cannot tell a client from a server — both use the same module — so the
// evidence that the bridge holds no listening socket is the runtime
// observation in test/bridgeProcess.test.ts, which reads the real process's
// sockets. What is checkable statically is kept here: only one file may
// import the module at all, and no bridge file may name a server-construction
// or listener API.
//
// BR-4 gets the same two-layer treatment, for the same reason. "Does not
// start the app" is a statement about what the process does, so the evidence
// is again the runtime one — bridgeProcess.test.ts reads the bridge's child
// PIDs, with a positive control that a process which DOES start a child is
// caught by that detector. The tokens below are the cheap half: they are
// API-shaped rather than prose-shaped on purpose, because the bridge's own
// comments have to be able to say the word "spawn" while explaining that the
// CLIENT is what spawns it.
const BRIDGE_DIR = 'src/bridge';
/** The single bridge file allowed to import a network module. */
const BRIDGE_HTTP_CLIENT = 'src/bridge/httpClient.ts';
const BRIDGE_SERVER_TOKENS = [
  ['createServer', 'server construction'],
  ['.listen(', 'binding a listener'],
  ['Server(', 'server construction'],
  ['node:net', 'raw socket module'],
  ['node:tls', 'raw socket module'],
  ['node:http2', 'server-capable module'],
  ['node:dgram', 'datagram module'],
  ['WebSocket', 'bidirectional socket'],
];
/** BR-4: nothing in the bridge may start another process. */
const BRIDGE_SPAWN_TOKENS = [
  ['child_process', 'process-starting module'],
  ['worker_threads', 'thread-starting module'],
  ['spawn(', 'starting a process'],
  ['spawnSync', 'starting a process'],
  ['execFile', 'starting a process'],
  ['execSync', 'starting a process'],
  ['.fork(', 'starting a process'],
  ['openExternal', 'handing a URL to another application'],
];
/** The bridge runs as plain Node, not inside the app. */
const ELECTRON_IMPORT_RE = /from\s+['"]electron(\/|['"])|require\(\s*['"]electron(\/|['"])/;

let failures = 0;
const violation = (msg) => {
  console.error(`EGRESS VIOLATION ${msg}`);
  failures++;
};

function scan(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      scan(full);
      continue;
    }
    if (![...EXTENSIONS].some((ext) => full.endsWith(ext))) continue;
    const text = readFileSync(full, 'utf8');
    const relative = full.slice(ROOT.length);
    const inBridge = relative.startsWith(BRIDGE_DIR);
    for (const [token, why] of FORBIDDEN) {
      if (text.includes(token)) violation(`${full}: "${token}" (${why})`);
    }
    if (inBridge) {
      for (const [token, why] of BRIDGE_SERVER_TOKENS) {
        if (text.includes(token)) violation(`${full}: "${token}" (${why}) — the bridge never listens`);
      }
      for (const [token, why] of BRIDGE_SPAWN_TOKENS) {
        if (text.includes(token)) violation(`${full}: "${token}" (${why}) — the bridge never starts the app (BR-4)`);
      }
      if (ELECTRON_IMPORT_RE.test(text)) {
        violation(`${full}: imports electron — the bridge runs as plain Node, outside the app`);
      }
      if (relative !== BRIDGE_HTTP_CLIENT && NETWORK_MODULE_RE.test(text)) {
        violation(`${full}: only ${BRIDGE_HTTP_CLIENT} may import a network module in the bridge`);
      }
    } else if (NETWORK_MODULE_RE.test(text)) {
      violation(`${full}: imports a network-capable module (http/https/http2/net/tls/dgram)`);
    }
    if (ELECTRON_NET_IMPORT_RE.test(text)) {
      violation(`${full}: imports Electron's net module (network capability)`);
    }
  }
}

// The carve-out above is only sound while the file it names exists and does
// what it says: if httpClient.ts is renamed or deleted, every other bridge
// file silently inherits permission to import node:http.
if (!existsSync(join(ROOT, BRIDGE_HTTP_CLIENT))) {
  violation(`${BRIDGE_HTTP_CLIENT} is missing — the bridge network-module carve-out now names nothing`);
}

for (const dir of SCAN_DIRS) scan(join(ROOT, dir));

// The renderer must declare a CSP (dev HTML may allow localhost for HMR).
const indexHtml = readFileSync(join(ROOT, 'src/renderer/index.html'), 'utf8');
if (!indexHtml.includes('Content-Security-Policy')) {
  violation('src/renderer/index.html: missing Content-Security-Policy meta');
}

// The BUILT renderer CSP must be strict: default-src 'self' and no localhost
// escape hatch (the dev-only HMR allowance must not ship).
const builtIndex = join(ROOT, 'out/renderer/index.html');
if (existsSync(builtIndex)) {
  const built = readFileSync(builtIndex, 'utf8');
  const csp = built.match(/Content-Security-Policy" content="([^"]*)"/)?.[1] ?? '';
  if (!csp.includes("default-src 'self'")) {
    violation("out/renderer/index.html: production CSP lacks default-src 'self'");
  }
  for (const banned of ['localhost', 'ws:', 'http://', '*']) {
    if (csp.includes(banned)) {
      violation(`out/renderer/index.html: production CSP contains "${banned}"`);
    }
  }
} else if (process.env.CI) {
  // In CI the build step precedes this check; a missing artifact means the
  // pipeline was reordered and the production CSP silently went unverified.
  violation('out/renderer/index.html missing in CI — run the build before check:egress');
} else {
  console.warn('note: out/renderer/index.html not found — run `pnpm build` first for the production CSP check');
}

// The main process must keep the spellchecker (dictionary auto-download) off.
const mainSrc = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8');
if (!mainSrc.includes('setSpellCheckerEnabled(false)') || !mainSrc.includes('spellcheck: false')) {
  violation('src/main/index.ts: spellchecker hardening missing');
}

if (failures > 0) {
  console.error(`\n${failures} egress violation(s).`);
  process.exit(1);
}
console.log('egress static checks: OK');
