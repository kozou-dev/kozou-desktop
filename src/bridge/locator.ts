// BR-2, filesystem leg: the only module in the bridge that touches a disk.
//
// What it may open is arithmetic rather than policy: the path is
// <base>/mcp-locators/<id>.json, where <id> has already been checked against
// /^[0-9a-f]{32}$/. No ARGUMENT reaches the profile store — no separator
// survives the id check, and the directory and the extension are constants.
//
// Two ways that is narrower than "the bridge cannot read the profile store",
// both worth stating rather than discovering:
//
//   - <base> comes from the environment when KOZOU_DESKTOP_USER_DATA is set,
//     and unlike main (which honours it in development only) this process has
//     no way to know it is packaged. Whoever writes the AI client's config
//     chooses it — the same party that chooses to spawn this at all;
//   - readFileSync follows symlinks, so a link left at the locator's own name
//     would be read whole before parseLocator rejected its shape.
//
// Both require write access to the user's own files, which is also what
// reading the profile store directly requires — so this is about the accuracy
// of the claim, not about a new capability. The honest statement is: no
// EXPRESSION in this module names anything but the locator.
//
// (The check in scripts/check-treeshake.mjs forbids naming the profile store
// even in a comment, for the same reason the API-server tripwire does: a bare
// identifier is the one pattern with no bypass.)
//
// The scope of that claim, stated plainly: it is about the code in this
// repository. It is not a syscall-level sandbox, and nothing here would stop
// a future edit from adding a second read — which is why the checks in
// scripts/check-treeshake.mjs pin this module as the only fs importer under
// src/bridge/, and why the relay's own tests assert the exact set of paths it
// asks for.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BRIDGE_ID_RE, LOCATOR_DIR_NAME, locatorFileName, parseLocator, type McpLocator } from '../shared/mcpLocator.js';

/** Where the app keeps its per-user state, as Electron computes it for the
 *  app name pinned in main (`kozou-desktop`).
 *
 *  KOZOU_DESKTOP_USER_DATA mirrors the override main honours in development
 *  and is how the tests point a bridge at a temporary directory. It can only
 *  name another directory belonging to the same user, and whatever it names
 *  must still parse as a locator.
 *
 *  Only the macOS branch is exercised (built and run) here; the other two
 *  follow Electron's documented rule and are untested in this repository. */
export function resolveUserDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const override = env.KOZOU_DESKTOP_USER_DATA;
  if (override !== undefined && override !== '') return override;
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'kozou-desktop');
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'kozou-desktop');
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'kozou-desktop');
}

/** The one path this bridge may read, for the id it was started with. */
export function locatorPathFor(id: string, userDataDir: string): string {
  if (!BRIDGE_ID_RE.test(id)) throw new Error('bridge id must be 32 lowercase hex characters');
  return join(userDataDir, LOCATOR_DIR_NAME, locatorFileName(id));
}

export type LocatorLookup = {
  path: string;
  locator: McpLocator;
};

/** Read and validate the locator. A missing file is reported as its own
 *  condition: it is the shape "the app is not serving this profile" takes,
 *  and the bridge has to be able to say so. */
export function readLocator(id: string, readFile: (path: string) => string, userDataDir: string): LocatorLookup {
  const path = locatorPathFor(id, userDataDir);
  let text: string;
  try {
    text = readFile(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        `no local MCP server is published for this entry (${path} does not exist). ` +
          'Start Kozou and start this profile\'s server, then reconnect.',
      );
    }
    throw new Error(`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { path, locator: parseLocator(text, id) };
}

/** The default reader: plain UTF-8, no options, no directory listing. */
export function readFileText(path: string): string {
  return readFileSync(path, 'utf8');
}
