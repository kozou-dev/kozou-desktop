// Entry point for the stdio bridge: the process an AI client that only
// speaks stdio (Claude Desktop) spawns to reach a local MCP server this app
// is already running.
//
// It is started as `<app binary> <this script> --id <locator id>` with
// ELECTRON_RUN_AS_NODE=1, so the app's own Electron binary runs it as Node
// and nothing extra has to be installed or downloaded (measured: the binary
// runs a script from inside app.asar in that mode).
//
// The id names a locator file, never a server: the port and the capability
// path are resolved from disk at start, so a port reassignment does not
// invalidate a config the user has already pasted, and a deleted profile
// fails loudly instead of silently reconnecting to a different database.
//
// Ownership of this process belongs to the client that spawned it. The app
// does not track it, restart it, or count it — the app owns the real server
// only. Nothing here starts the app either (BR-4): if no locator is
// published, this exits with an explanation.

import { createRelayClient } from './httpClient.js';
import { readFileText, readLocator, resolveUserDataDir } from './locator.js';
import { Relay, pumpLines } from './relay.js';

const USAGE = 'usage: <kozou binary> stdioBridge.js --id <locator id>';

export function parseBridgeArgs(argv: readonly string[]): { id: string } {
  if (argv.length !== 2 || argv[0] !== '--id') throw new Error(USAGE);
  const id = argv[1];
  if (id === undefined || id === '') throw new Error(USAGE);
  return { id };
}

async function main(): Promise<void> {
  const { id } = parseBridgeArgs(process.argv.slice(2));
  const { locator } = readLocator(id, readFileText, resolveUserDataDir());
  // The host is this app's own bind address, not something the locator gets
  // to choose (see EGRESS.md: the server listens on 127.0.0.1 only).
  const client = createRelayClient(`http://127.0.0.1:${locator.port}${locator.path}`);
  const relay = new Relay(client, {
    send: (message) => void process.stdout.write(`${message}\n`),
    log: (message) => void process.stderr.write(`${message}\n`),
  });

  process.stdin.setEncoding('utf8');
  await pumpLines(process.stdin, (line) => relay.handleLine(line));
  await relay.close();
}

main().catch((err: unknown) => {
  process.stderr.write(`kozou-bridge: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
