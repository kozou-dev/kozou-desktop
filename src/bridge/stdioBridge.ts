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
// only. Nothing here starts the app either (BR-4): when no locator is
// published, this answers every request with a JSON-RPC error saying so and
// waits for the client to close, which is BD4.

import { createRelayClient, type RelayClient } from './httpClient.js';
import { readFileText, readLocator, resolveUserDataDir } from './locator.js';
import { Relay, pumpLines, serveUnavailable, type RelayIo } from './relay.js';

const USAGE = 'usage: <kozou binary> stdioBridge.js --id <locator id>';

export function parseBridgeArgs(argv: readonly string[]): { id: string } {
  if (argv.length !== 2 || argv[0] !== '--id') throw new Error(USAGE);
  const id = argv[1];
  if (id === undefined || id === '') throw new Error(USAGE);
  return { id };
}

async function main(): Promise<void> {
  const { id } = parseBridgeArgs(process.argv.slice(2));
  const io: RelayIo = {
    send: (message) => void process.stdout.write(`${message}\n`),
    log: (message) => void process.stderr.write(`${message}\n`),
  };
  // stdout belongs to another process and that process can vanish mid-write.
  // Without a handler the first write after it does is an unhandled 'error'
  // event, which ends the bridge with a Node stack trace in the client's log —
  // measured, and made likelier by the cancellation below, which answers an
  // abandoned request precisely when the client is the thing that left.
  //
  // A broken pipe carries the same news as stdin's EOF: the client has gone.
  // So it is acted on the same way rather than merely noted — cancel what is
  // in flight, stop reading, let the process end. Setting an exit code was not
  // enough on its own: measured, that left the bridge running and issuing
  // requests into a stdout with no reader, one stderr line per failed write.
  // The pipe is reported once, however many writes fail into it afterwards.
  let left = false;
  let cancelInFlight = (): void => {};
  const clientLeft = (reason: string): void => {
    if (left) return;
    left = true;
    io.log(reason);
    process.exitCode = 1;
    cancelInFlight();
    // The pump owns stdin, so destroying it is what ends the wait. The
    // premature close it raises is ours, and is swallowed where it is awaited.
    process.stdin.destroy();
  };
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    clientLeft(
      err.code === 'EPIPE'
        ? 'kozou-bridge: the AI client closed the connection before this reply could be written'
        : `kozou-bridge: cannot write to the AI client: ${err.message}`,
    );
  });
  process.stdin.setEncoding('utf8');

  let client: RelayClient;
  try {
    const { locator } = readLocator(id, readFileText, resolveUserDataDir());
    // The host is this app's own bind address, not something the locator gets
    // to choose (see EGRESS.md: the server listens on 127.0.0.1 only).
    client = createRelayClient(`http://127.0.0.1:${locator.port}${locator.path}`);
  } catch (err) {
    // BD4. Nothing is started here to recover — not the app, not a server. The
    // failure is reported in the only two places the client can see it: its
    // log (stderr) and the exchange itself (a JSON-RPC error per request).
    await ownEndOnly(serveUnavailable(process.stdin, err instanceof Error ? err.message : String(err), io), () => left);
    process.exitCode = 1;
    return;
  }

  cancelInFlight = () => client.disconnected();
  const relay = new Relay(client, io);
  // The client closing its end is the one signal that no answer is wanted any
  // more. Without this, a server that accepts a request and never replies
  // holds the relay inside that request while stdin is already at EOF, and the
  // process outlives the client that owns it — measured before this existed.
  // The deadline in the client is the guarantee; this is what makes the
  // ordinary case immediate rather than deadline-long.
  process.stdin.on('end', () => client.disconnected());
  await ownEndOnly(pumpLines(process.stdin, (line) => relay.handleLine(line)), () => left);
  await relay.close();
}

/** Await a read of stdin, swallowing only the failure this process caused by
 *  destroying stdin itself. Anything else is a real read failure and is left
 *  to the handler at the bottom of the file. */
async function ownEndOnly(reading: Promise<void>, weEndedIt: () => boolean): Promise<void> {
  try {
    await reading;
  } catch (err) {
    if (!weEndedIt()) throw err;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`kozou-bridge: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
