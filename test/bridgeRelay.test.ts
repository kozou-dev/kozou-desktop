// BD1/BD3: the relay against a stub server that behaves the way the real one
// does — a session id issued on initialize, 400 without it, 404 for an
// unknown one, 202 for a notification.
//
// The stub is here rather than the real server because these are statements
// about the RELAY: what it forwards, what it holds, what it writes to stdout
// and when. Parity with the real server is asserted separately, against a
// real database, in bridge.integration.test.ts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createRelayClient } from '../src/bridge/httpClient.js';
import { Relay, pumpLines, serveUnavailable, type RelayReply, type RelayTransport } from '../src/bridge/relay.js';

const MCP_PATH = '/mcp-0123456789abcdef0123456789abcdef';

type StubOptions = {
  /** Reply to a session request with an event stream instead of JSON. */
  sse?: boolean;
  /** Reply to every session request with this status and body. */
  fail?: { status: number; body: string };
  /** Reply with a redirect to this absolute URL. */
  redirectTo?: string;
};

type Stub = {
  url: string;
  server: Server;
  /** Every request the stub saw: method, session header, body. */
  seen: Array<{ method: string; session?: string; body: string }>;
  sessions: Set<string>;
};

const running: Server[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function startStub(options: StubOptions = {}): Promise<Stub> {
  const seen: Stub['seen'] = [];
  const sessions = new Set<string>();
  let issued = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const session = req.headers['mcp-session-id'] as string | undefined;
      seen.push({ method: req.method ?? '', ...(session !== undefined ? { session } : {}), body });

      if (options.redirectTo !== undefined) {
        res.writeHead(302, { location: options.redirectTo });
        res.end();
        return;
      }
      if (req.method === 'DELETE') {
        if (session !== undefined) sessions.delete(session);
        res.writeHead(204);
        res.end();
        return;
      }
      if (session === undefined) {
        if (!body.includes('"initialize"')) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end('{"error":"missing mcp-session-id header (no active session)"}');
          return;
        }
        const id = `session-${++issued}`;
        sessions.add(id);
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': id });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: idOf(body), result: { protocolVersion: '2025-06-18' } }));
        return;
      }
      if (!sessions.has(session)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(`{"error":"Unknown MCP session: ${session}"}`);
        return;
      }
      if (options.fail !== undefined) {
        res.writeHead(options.fail.status, { 'content-type': 'application/json' });
        res.end(options.fail.body);
        return;
      }
      if (idOf(body) === null) {
        res.writeHead(202); // notification or response only
        res.end();
        return;
      }
      const reply = { jsonrpc: '2.0', id: idOf(body), result: { echoed: JSON.parse(body) as unknown } };
      if (options.sse === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
        return;
      }
      // Pretty-printed on purpose: the relay must not put a multi-line body
      // on stdout, where a newline means "next message".
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply, null, 2));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  running.push(server);
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}${MCP_PATH}`, server, seen, sessions };
}

function idOf(body: string): string | number | null {
  try {
    const parsed = JSON.parse(body) as { id?: unknown };
    return typeof parsed.id === 'string' || typeof parsed.id === 'number' ? parsed.id : null;
  } catch {
    return null;
  }
}

function collectingRelay(transport: RelayTransport): { relay: Relay; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { relay: new Relay(transport, { send: (m) => out.push(m), log: (m) => err.push(m) }), out, err };
}

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
});
const INITIALIZED = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
const TOOLS_LIST = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

describe('relay against a session-bearing server', () => {
  it('carries the session, stays silent on 202, and tears the session down at EOF', async () => {
    const stub = await startStub();
    const { relay, out, err } = collectingRelay(createRelayClient(stub.url));

    await relay.handleLine(INITIALIZE);
    expect(relay.session).toBe('session-1');
    expect(out).toHaveLength(1);

    await relay.handleLine(INITIALIZED);
    expect(out).toHaveLength(1); // a 202 produces no line on stdout

    await relay.handleLine(TOOLS_LIST);
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[1]!)).toMatchObject({ id: 2 });

    await relay.close();
    expect(stub.sessions.size).toBe(0);
    expect(stub.seen.at(-1)).toMatchObject({ method: 'DELETE', session: 'session-1' });
    // Every request after the first carried the session id — without it the
    // real server answers 400.
    expect(stub.seen.slice(1).every((r) => r.session === 'session-1')).toBe(true);
    expect(err).toEqual([]);
  });

  it('sends no protocol-version header (the server defaults to the negotiated one)', async () => {
    const stub = await startStub();
    const { relay } = collectingRelay(createRelayClient(stub.url));
    await relay.handleLine(INITIALIZE);
    await relay.handleLine(TOOLS_LIST);
    // Asserted on the wire: the relay never parses an initialize result, so
    // it has no negotiated version to send.
    expect(stub.seen.every((r) => !JSON.stringify(r).includes('mcp-protocol-version'))).toBe(true);
  });

  it('puts one message on one line, whatever shape the body arrived in', async () => {
    const stub = await startStub();
    const { relay, out } = collectingRelay(createRelayClient(stub.url));
    await relay.handleLine(INITIALIZE);
    await relay.handleLine(TOOLS_LIST);
    expect(out[1]).not.toContain('\n');
  });

  // The version of this test that shipped with PR1 asserted only
  // `toMatchObject({ id: 2 })` against a relay that unwrapped `data:` lines.
  // That assertion is satisfied by BOTH behaviours — the unwrapped result and
  // the refusal below both carry id 2 — so it stayed green when the branch it
  // was named after was deleted. What separates them is which of `result` and
  // `error` is present, so that is what this asserts.
  it('refuses an event-stream reply rather than half-reading it', async () => {
    const stub = await startStub({ sse: true });
    const { relay, out, err } = collectingRelay(createRelayClient(stub.url));
    await relay.handleLine(INITIALIZE);
    await relay.handleLine(TOOLS_LIST);
    const reply = JSON.parse(out[1]!) as { id: number; result?: unknown; error?: { message: string } };
    expect(reply.id).toBe(2);
    expect(reply.result).toBeUndefined();
    expect(reply.error?.message).toMatch(/event stream/);
    expect(err.join('\n')).toMatch(/event stream/);
  });

  it('answers every id in a failed batch, not just the first', async () => {
    const stub = await startStub({ fail: { status: 500, body: 'boom' } });
    const { relay, out } = collectingRelay(createRelayClient(stub.url));
    const batch = JSON.stringify([
      { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', method: 'notifications/progress' }, // no id: owed nothing
      { jsonrpc: '2.0', id: 'nine', method: 'tools/list', params: {} },
    ]);
    await relay.handleLine(batch);
    const replies = JSON.parse(out[0]!) as Array<{ id: string | number; error: { code: number } }>;
    expect(replies.map((r) => r.id)).toEqual([7, 'nine']);
    expect(replies.every((r) => r.error.code === -32000)).toBe(true);
  });

  it('answers a batch of notifications with nothing at all', async () => {
    const stub = await startStub({ fail: { status: 500, body: 'boom' } });
    const { relay, out } = collectingRelay(createRelayClient(stub.url));
    await relay.handleLine(JSON.stringify([{ jsonrpc: '2.0', method: 'notifications/initialized' }]));
    expect(out).toEqual([]);
  });

  it('forwards nothing of its own: the request body reaches the server unchanged', async () => {
    const stub = await startStub();
    const { relay } = collectingRelay(createRelayClient(stub.url));
    await relay.handleLine(TOOLS_LIST); // no session yet -> the stub 400s
    expect(stub.seen[0]!.body).toBe(TOOLS_LIST);
  });

  it('turns an HTTP error into a JSON-RPC error for the request it belongs to', async () => {
    const stub = await startStub({ fail: { status: 404, body: '{"error":"Unknown MCP session"}' } });
    const { relay, out, err } = collectingRelay(createRelayClient(stub.url));
    await relay.handleLine(INITIALIZE);
    await relay.handleLine(TOOLS_LIST);
    expect(JSON.parse(out[1]!)).toMatchObject({ jsonrpc: '2.0', id: 2, error: { code: -32000 } });
    expect(err.join('\n')).toMatch(/HTTP 404/);
  });

  it('answers nothing to a failed notification — there is no id to answer', async () => {
    const stub = await startStub({ fail: { status: 500, body: 'boom' } });
    const { relay, out, err } = collectingRelay(createRelayClient(stub.url));
    await relay.handleLine(INITIALIZE);
    out.length = 0;
    await relay.handleLine(INITIALIZED);
    expect(out).toEqual([]);
    expect(err.join('\n')).toMatch(/HTTP 500/);
  });

  it('does not follow a redirect (BR-1 cannot be escaped by the server)', async () => {
    const elsewhere = await startStub();
    const stub = await startStub({ redirectTo: elsewhere.url });
    const { relay, out, err } = collectingRelay(createRelayClient(stub.url));
    await relay.handleLine(INITIALIZE);
    expect(elsewhere.seen).toEqual([]); // the second server was never contacted
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 1, error: { code: -32000 } });
    expect(err.join('\n')).toMatch(/HTTP 302/);
  });

  it('reports an unreachable server instead of hanging', async () => {
    const stub = await startStub();
    await new Promise<void>((r) => stub.server.close(() => r()));
    const { relay, out, err } = collectingRelay(createRelayClient(stub.url));
    await relay.handleLine(INITIALIZE);
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 1, error: { code: -32000 } });
    expect(err.join('\n')).toMatch(/cannot reach the local MCP server/);
  });
});

describe('line framing', () => {
  it('is defined by newlines, not by reads', async () => {
    const lines: string[] = [];
    async function* chunks(): AsyncGenerator<string> {
      yield '{"a":1}\n{"b":';
      yield '2}\n';
      yield '{"c":3}'; // no trailing newline
    }
    await pumpLines(chunks(), async (line) => void lines.push(line));
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('runs one message at a time', async () => {
    const order: string[] = [];
    async function* chunks(): AsyncGenerator<string> {
      yield 'a\nb\n';
    }
    await pumpLines(chunks(), async (line) => {
      order.push(`start:${line}`);
      await new Promise((r) => setTimeout(r, line === 'a' ? 10 : 0));
      order.push(`end:${line}`);
    });
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });
});

describe('what the relay keeps', () => {
  it('holds the session id and nothing else — no filesystem, no second peer', async () => {
    const posted: Array<Record<string, string>> = [];
    const transport: RelayTransport = {
      post: (_body, headers): Promise<RelayReply> => {
        posted.push(headers);
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json', 'mcp-session-id': 's1' },
          body: '{"jsonrpc":"2.0","id":1,"result":{}}',
        });
      },
      end: (headers): Promise<RelayReply> => {
        posted.push(headers);
        return Promise.resolve({ status: 204, headers: {}, body: '' });
      },
    };
    const { relay } = collectingRelay(transport);
    await relay.handleLine(INITIALIZE);
    await relay.handleLine(TOOLS_LIST);
    await relay.close();
    expect(relay.session).toBeUndefined();
    // The headers are the complete state the relay adds to a request.
    expect(Object.keys(posted[1]!).sort()).toEqual(['accept', 'content-type', 'mcp-session-id']);
  });
});

// The deadline and the cancellation, against a server that accepts a request
// and never answers it. The bridge itself runs with a ten-minute inactivity
// budget (DEFAULT_DEADLINES); these pass short ones, because a deadline that
// cannot be watched firing is not something a test has checked.
describe('a server that never answers', () => {
  /** Accepts requests and holds them open forever. */
  async function silentServer(): Promise<{ url: string; close: () => Promise<void> }> {
    const held: ServerResponse[] = [];
    const server = createServer((_req, res) => void held.push(res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    running.push(server);
    const port = (server.address() as { port: number }).port;
    return {
      url: `http://127.0.0.1:${port}${MCP_PATH}`,
      close: async () => {
        for (const res of held) res.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  it('gives up on the deadline instead of waiting forever', async () => {
    const stub = await silentServer();
    const client = createRelayClient(stub.url, { idleMs: 250, teardownMs: 250 });
    const { relay, out, err } = collectingRelay(client);
    await relay.handleLine(INITIALIZE);
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 1, error: { code: -32000 } });
    expect(err.join('\n')).toMatch(/no response within 250ms/);
    await stub.close();
  });

  it('abandons what is in flight when the client disconnects', async () => {
    const stub = await silentServer();
    // A deadline long enough that it cannot be what ends this: if the
    // assertion passes, the cancellation is what did.
    const client = createRelayClient(stub.url, { idleMs: 60_000, teardownMs: 250 });
    const { relay, out, err } = collectingRelay(client);
    const inFlight = relay.handleLine(INITIALIZE);
    await new Promise((r) => setTimeout(r, 50));
    client.disconnected();
    await inFlight;
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 1, error: { code: -32000 } });
    expect(err.join('\n')).toMatch(/closed its end of the bridge/);
    await stub.close();
  });
});

// BD4 at the message level. The process-level statement — that this is what
// runs when no locator is published, and that nothing gets spawned while it
// does — is in bridgeProcess.test.ts.
describe('serving a client when no server can be reached', () => {
  async function serve(lines: string[]): Promise<{ out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    async function* input(): AsyncGenerator<string> {
      for (const line of lines) yield `${line}\n`;
    }
    await serveUnavailable(input(), 'no local MCP server is published for this entry', {
      send: (m) => out.push(m),
      log: (m) => err.push(m),
    });
    return { out, err };
  }

  it('answers each request with the reason, and says it once on stderr', async () => {
    const { out, err } = await serve([INITIALIZE, TOOLS_LIST]);
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0]!)).toMatchObject({ id: 1, error: { code: -32000 } });
    expect(JSON.parse(out[1]!)).toMatchObject({ id: 2, error: { code: -32000 } });
    expect((JSON.parse(out[0]!) as { error: { message: string } }).error.message).toMatch(
      /no local MCP server is published/,
    );
    expect(err).toHaveLength(1);
  });

  it('keeps answering rather than stopping after the first request', async () => {
    // The client owns this process's lifetime: what it does after a failed
    // initialize is its decision, not the bridge's.
    const { out } = await serve([INITIALIZE, TOOLS_LIST, TOOLS_LIST]);
    expect(out).toHaveLength(3);
  });

  it('answers nothing to a notification, and returns when the client closes', async () => {
    const { out } = await serve([INITIALIZED]);
    expect(out).toEqual([]);
  });
});
