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
  ["'node:http", 'Node HTTP client/server is network capability'],
  ['"node:http', 'Node HTTP client/server is network capability'],
  ["'node:net", 'raw sockets are network capability'],
  ['"node:net', 'raw sockets are network capability'],
  ["'node:tls", 'raw TLS sockets are network capability'],
  ['"node:tls', 'raw TLS sockets are network capability'],
  ["'node:dgram", 'UDP sockets are network capability'],
  ['"node:dgram', 'UDP sockets are network capability'],
  ['session.fetch', "Electron's session-level fetch bypasses the renderer CSP"],
  ['net.fetch', "Electron's net.fetch bypasses the renderer CSP"],
  ['shell.openExternal', 'no external navigation paths in M1 (reintroduce with an allowlist when docs links land)'],
]);

// `import { net } from 'electron'` would not hit a simple token — catch it
// structurally (covers aliased destructuring like `net as anything`).
const ELECTRON_NET_IMPORT_RE = /import\s*(?:type\s*)?{[^}]*\bnet\b[^}]*}\s*from\s*['"]electron['"]/;

const SCAN_DIRS = ['src'];
const EXTENSIONS = new Set(['.ts', '.svelte', '.html', '.css', '.js', '.mjs', '.cjs']);

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
    for (const [token, why] of FORBIDDEN) {
      if (text.includes(token)) violation(`${full}: "${token}" (${why})`);
    }
    if (ELECTRON_NET_IMPORT_RE.test(text)) {
      violation(`${full}: imports Electron's net module (network capability)`);
    }
  }
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
