// The bridge's outbound side: plain HTTP to one loopback address.
//
// BR-3 (no listeners) is what makes importing node:http acceptable here at
// all, and it is not something the import itself can express — this module
// only ever calls `request`. The static check in
// scripts/check-egress-static.mjs pins that (no server construction anywhere
// under src/bridge/), and the load-bearing evidence is the runtime test that
// observes the packaged bridge's own process holding zero listening sockets.

import { request } from 'node:http';
import { assertLoopbackTarget } from './loopback.js';

export type HttpReply = {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
};

export type RelayClient = {
  post(body: string, headers: Record<string, string>): Promise<HttpReply>;
  /** MCP session teardown (DELETE on the same endpoint). */
  end(headers: Record<string, string>): Promise<HttpReply>;
};

/** Bind a client to one target, refusing anything but loopback. The check
 *  runs again per request rather than once at construction: the guard belongs
 *  on the path that actually opens a socket, so no later change can route
 *  around it by handing this module a different URL. */
export function createRelayClient(target: string): RelayClient {
  assertLoopbackTarget(target);
  return {
    post: (body, headers) => send('POST', target, headers, body),
    end: (headers) => send('DELETE', target, headers),
  };
}

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
    req.on('error', reject);
    // Deliberately no timeout: the server's own per-statement budget already
    // bounds a describe call (up to five minutes by profile setting), and a
    // second uncoordinated deadline here would cut off work that is still
    // making progress. The AI client keeps its own timeout on the stdio side.
    if (body !== undefined) req.end(body);
    else req.end();
  });
}
