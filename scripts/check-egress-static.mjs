#!/usr/bin/env node
// Static egress checklist (see EGRESS.md): our own source must not reference
// network-capable Electron modules or perform renderer-side network calls.
// Runtime verification (lsof while the app runs) is documented in EGRESS.md;
// this script keeps regressions out of CI.

import { readFileSync, readdirSync, statSync } from 'node:fs';
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
]);

const SCAN_DIRS = ['src'];
const EXTENSIONS = new Set(['.ts', '.svelte', '.html', '.css']);

let failures = 0;

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
      if (text.includes(token)) {
        console.error(`EGRESS VIOLATION ${full}: "${token}" (${why})`);
        failures++;
      }
    }
  }
}

for (const dir of SCAN_DIRS) scan(join(ROOT, dir));

// The renderer must declare a CSP.
const indexHtml = readFileSync(join(ROOT, 'src/renderer/index.html'), 'utf8');
if (!indexHtml.includes('Content-Security-Policy')) {
  console.error('EGRESS VIOLATION src/renderer/index.html: missing Content-Security-Policy meta');
  failures++;
}
// The main process must keep the spellchecker (dictionary auto-download) off.
const mainSrc = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8');
if (!mainSrc.includes('setSpellCheckerEnabled(false)') || !mainSrc.includes('spellcheck: false')) {
  console.error('EGRESS VIOLATION src/main/index.ts: spellchecker hardening missing');
  failures++;
}

if (failures > 0) {
  console.error(`\n${failures} egress violation(s).`);
  process.exit(1);
}
console.log('egress static checks: OK');
