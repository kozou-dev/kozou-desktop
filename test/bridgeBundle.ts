// Shared test helper: build the stdio bridge the way it ships (one file, no
// dependencies) and publish a locator pointing at a given server.
//
// Not a suite — vitest collects *.test.ts only.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCATOR_DIR_NAME, serializeLocator } from '../src/shared/mcpLocator.js';

const ROOT = new URL('..', import.meta.url).pathname;

/** Bundle src/bridge/stdioBridge.ts to a temporary .mjs and return its path. */
export function buildBridgeBundle(): string {
  const outFile = join(mkdtempSync(join(tmpdir(), 'kozou-desktop-bridge-')), 'stdioBridge.mjs');
  execFileSync(
    'pnpm',
    [
      'exec',
      'esbuild',
      'src/bridge/stdioBridge.ts',
      '--bundle',
      '--platform=node',
      '--format=esm',
      `--outfile=${outFile}`,
    ],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  return outFile;
}

/** A temporary userData directory holding one published locator. */
export function publishLocator(entry: { id: string; port: number; path: string }): string {
  const userData = mkdtempSync(join(tmpdir(), 'kozou-desktop-userdata-'));
  mkdirSync(join(userData, LOCATOR_DIR_NAME), { recursive: true });
  writeFileSync(
    join(userData, LOCATOR_DIR_NAME, `${entry.id}.json`),
    serializeLocator({ v: 1, ...entry, generation: '0011223344556677' }),
  );
  return userData;
}

/** process.env without the undefined values, for APIs that want strings. */
export function stringEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return { ...env, ...extra };
}
