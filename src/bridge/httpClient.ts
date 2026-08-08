// The bridge's outbound side: plain HTTP to one loopback address.
//
// BR-3 (no listeners) is what makes importing node:http acceptable here at
// all, and it is not something the import itself can express — this module
// only ever calls `request`. The static check in
// scripts/check-egress-static.mjs pins that (no server construction anywhere
// under src/bridge/), and the load-bearing evidence is the runtime test that
// runs the bridge as its own process — bundled as it ships, though under the
// test runner's Node rather than the packaged app binary — and reads that
// process's socket table.

import { request, type ClientRequest } from 'node:http';
import { assertLoopbackTarget } from './loopback.js';
import { CLIENT_GONE } from './relay.js';

export type HttpReply = {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
};

export type RelayClient = {
  post(body: string, headers: Record<string, string>): Promise<HttpReply>;
  /** MCP session teardown (DELETE on the same endpoint). */
  end(headers: Record<string, string>): Promise<HttpReply>;
  /** The client that spawned this bridge has closed its end. Abandon whatever
   *  is in flight, refuse to start anything new, and bound whatever the
   *  shutdown still has to send. */
  disconnected(): void;
};

/** Raised instead of opening a socket once the client has gone.
 *
 *  Its own type, because the relay has to tell this apart from a server it
 *  could not reach: they are opposite diagnoses and only one of them is about
 *  the database side. */
export class ClientGoneError extends Error {
  constructor() {
    super('the AI client closed its end of the bridge before this request was sent');
    // The relay recognizes this by name rather than by identity: it is written
    // against a transport interface and does not import this module.
    this.name = CLIENT_GONE;
  }
}

/** How long a request may go without a single byte moving before the bridge
 *  gives up on it.
 *
 *  This is a socket inactivity deadline, not a total one: a reply that is
 *  still arriving keeps resetting it. That distinction matters less than it
 *  sounds, and the honest version is worth stating — the server sends nothing
 *  at all while a query runs, so for a single-reply request this bound applies
 *  to the query too, not only to a peer that has died.
 *
 *  It exists because nothing upstream provides one. An earlier comment here
 *  claimed the server's own per-statement budget already bounded a describe
 *  call; that was wrong. The five-minute ceiling it referred to
 *  (MAX_DATA_TIMEOUT_MS) belongs to the row-browsing worker, which this path
 *  does not use, and there is no statement_timeout anywhere in the @kozou
 *  packages the MCP server is built from (checked in 1.17.0). Without a
 *  deadline here there is none at all, and the measured consequence is a
 *  bridge that never exits: with a server that accepts a request and never
 *  answers, closing stdin left the process alive indefinitely.
 *
 *  Ten minutes is chosen to sit far above any describe this project has
 *  measured rather than to be tight. Cutting a slow-but-live introspection
 *  would be the worse failure of the two. */
const IDLE_TIMEOUT_MS = 600_000;

/** The same deadline once the client is gone. Nothing is waiting for the
 *  answer any more; the DELETE is a courtesy to the server, and a courtesy
 *  does not get ten minutes. */
const TEARDOWN_TIMEOUT_MS = 5_000;

export type Deadlines = {
  /** Socket inactivity budget while the client is still connected. */
  idleMs: number;
  /** The same budget once it is not. */
  teardownMs: number;
};

/** What the bridge itself runs with. Tests pass shorter ones: a ten-minute
 *  deadline can be asserted to exist but not to fire, and a guard that cannot
 *  observe the thing it guards is not one.
 *
 *  That leaves these two values watched by nobody, which is not a small gap:
 *  `timeout: 0` means *no deadline* to node:http, so the failure the section
 *  above describes was one character away with every deadline test green
 *  (measured). One assertion in bridgeRelay.test.ts now pins that they are
 *  non-zero and correctly ordered — the shape of the values, since the
 *  behaviour is what the injected ones are for. */
export const DEFAULT_DEADLINES: Deadlines = { idleMs: IDLE_TIMEOUT_MS, teardownMs: TEARDOWN_TIMEOUT_MS };

/** Bind a client to one target, refusing anything but loopback. The check
 *  runs again per request rather than once at construction: the guard belongs
 *  on the path that actually opens a socket, so no later change can route
 *  around it by handing this module a different URL. */
export function createRelayClient(target: string, deadlines: Deadlines = DEFAULT_DEADLINES): RelayClient {
  assertLoopbackTarget(target);
  const inFlight = new Set<ClientRequest>();
  let deadlineMs = deadlines.idleMs;
  let gone = false;
  const options = (): SendOptions => ({ inFlight, deadlineMs });
  return {
    // Cancelling what is in flight is only half of it. The relay sends one
    // message at a time, so a client that quits with several calls outstanding
    // leaves the rest queued behind the cancelled one — and without this gate
    // each of those still opened a socket and ran an introspection query for a
    // conversation nobody was in. Measured: three requests written together
    // and then stdin closed produced three POSTs, two of them issued after the
    // client had provably gone, and the process outlived it by one teardown
    // deadline per queued request.
    post: (body, headers) => (gone ? Promise.reject(new ClientGoneError()) : send('POST', target, headers, options(), body)),
    // The DELETE is exempt on purpose: it is the one message whose whole point
    // is to be sent after the client has gone.
    end: (headers) => send('DELETE', target, headers, options()),
    disconnected: () => {
      gone = true;
      deadlineMs = deadlines.teardownMs;
      for (const req of inFlight) req.destroy(new Error('the AI client closed its end of the bridge'));
    },
  };
}

type SendOptions = { inFlight: Set<ClientRequest>; deadlineMs: number };

/** Request options for a validated target.
 *
 *  The bracket strip is load-bearing rather than cosmetic: WHATWG serializes
 *  an IPv6 host as "[::1]", and `http.request` treats that literally and
 *  fails to resolve it (measured: getaddrinfo ENOTFOUND [::1]). BR-1 allows
 *  ::1, so the client has to be able to reach what the guard permits. */
export function requestOptionsFor(url: URL): { host: string; port: string; path: string } {
  const host = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  return { host, port: url.port, path: `${url.pathname}${url.search}` };
}

function send(
  method: 'POST' | 'DELETE',
  target: string,
  headers: Record<string, string>,
  { inFlight, deadlineMs }: SendOptions,
  body?: string,
): Promise<HttpReply> {
  const url = assertLoopbackTarget(target);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        // Host and port come from the validated URL; node:http does not
        // follow redirects, so a 3xx is reported to the caller as-is and
        // never becomes a second connection to somewhere else.
        ...requestOptionsFor(url),
        method,
        headers,
        timeout: deadlineMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | undefined>,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );
    inFlight.add(req);
    // node:http reports the inactivity deadline as an event and leaves the
    // socket open; destroying it is what turns the deadline into a failure
    // the caller hears about, via the 'error' below.
    req.on('timeout', () => req.destroy(new Error(`no response within ${deadlineMs}ms`)));
    req.on('error', reject);
    req.on('close', () => inFlight.delete(req));
    if (body !== undefined) req.end(body);
    else req.end();
  });
}
