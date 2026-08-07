// BD1/BD3: the relay itself. One JSON-RPC message per stdin line goes out as
// one HTTP POST; whatever comes back goes to stdout as one line.
//
// What it deliberately does NOT do (BD1): branch on method. No tool list is
// rewritten, no `initialize` is special-cased, nothing is added or removed
// from the traffic. The moment a relay starts interpreting MCP, the served
// behaviour has two authors and they can disagree — the failure mode the
// local-MCP design already rejected once, in the form of two servers
// answering for one database.
//
// What it DOES hold (BD3): the HTTP transport state, because the server is
// stateful and stdio has no headers. The real server issues an mcp-session-id
// on initialize and answers 400 without one and 404 for an unknown one
// (measured in @kozou/mcp 1.17.0), so the session id has to live somewhere,
// and the only place it can live is here. That is the whole of the state:
// no database handle, no schema cache, no credentials.
//
// Also measured, and the reason nothing here reads a response body to learn
// the protocol version: the server accepts requests with no
// mcp-protocol-version header and defaults to the version negotiated at
// initialize (SDK 1.29.0, validateProtocolVersion). Sending one would mean
// parsing the initialize RESULT, which is exactly the semantic interpretation
// BD1 rules out — so the bridge sends none, and the integration test asserts
// a full session works that way.
//
// Messages are relayed one at a time. Sequential ordering is what guarantees
// the session id exists before the second request needs it, and a describe
// server has no long-running call that would make head-of-line waiting
// matter. The cost, stated rather than discovered later: a message sent while
// an earlier one is still in flight waits for it — including a cancellation
// notification, which therefore cannot overtake the request it cancels.

export type RelayReply = {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
};

export type RelayTransport = {
  post(body: string, headers: Record<string, string>): Promise<RelayReply>;
  end(headers: Record<string, string>): Promise<RelayReply>;
};

export type RelayIo = {
  /** Write one JSON-RPC message to the client (newline appended here). */
  send(message: string): void;
  /** Human-readable diagnostics — stderr, which lands in the AI client's log. */
  log(message: string): void;
};

/** JSON-RPC error code for transport-level failures the bridge reports on the
 *  server's behalf. -32000..-32099 is the reserved implementation range. */
const TRANSPORT_ERROR = -32000;

export class Relay {
  private sessionId: string | undefined;

  constructor(
    private readonly transport: RelayTransport,
    private readonly io: RelayIo,
  ) {}

  /** Visible for tests: the only piece of state the bridge keeps. */
  get session(): string | undefined {
    return this.sessionId;
  }

  async handleLine(line: string): Promise<void> {
    const message = line.trim();
    if (message === '') return;

    let reply: RelayReply;
    try {
      reply = await this.transport.post(message, this.headers());
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.io.log(`kozou-bridge: cannot reach the local MCP server: ${detail}`);
      this.fail(message, `cannot reach the Kozou local MCP server: ${detail}`);
      return;
    }

    const session = reply.headers['mcp-session-id'];
    if (typeof session === 'string' && session !== '') this.sessionId = session;

    // 202 = the server accepted a notification or response and has nothing to
    // say back. Writing anything to stdout here would be a message the client
    // never asked for.
    if (reply.status === 202) return;

    if (reply.status < 200 || reply.status >= 300) {
      const detail = reply.body.trim();
      this.io.log(`kozou-bridge: server returned HTTP ${reply.status}${detail === '' ? '' : `: ${detail}`}`);
      this.fail(message, `Kozou local MCP server returned HTTP ${reply.status}${detail === '' ? '' : `: ${detail}`}`);
      return;
    }

    for (const payload of framesOf(reply)) {
      // Re-serialize compactly: the line protocol cannot carry the embedded
      // newlines a pretty-printed body would have.
      try {
        this.io.send(JSON.stringify(JSON.parse(payload)));
      } catch {
        this.io.log('kozou-bridge: server sent a body that is not JSON — dropping it');
        this.fail(message, 'Kozou local MCP server sent a response that is not JSON');
      }
    }
  }

  /** stdin closed: tell the server the session is over. Best effort — the
   *  client is already gone, and the app reclaims sessions on its own. */
  async close(): Promise<void> {
    if (this.sessionId === undefined) return;
    try {
      await this.transport.end(this.headers());
    } catch (err) {
      this.io.log(`kozou-bridge: session teardown failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.sessionId = undefined;
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      // Both types are required by the Streamable HTTP transport on POST.
      accept: 'application/json, text/event-stream',
      ...(this.sessionId !== undefined ? { 'mcp-session-id': this.sessionId } : {}),
    };
  }

  /** Report a failure as a JSON-RPC error to the request it belongs to. A
   *  message with no id is a notification: there is nothing to answer, so the
   *  stderr line above is the whole report. */
  private fail(request: string, message: string): void {
    const id = requestIdOf(request);
    if (id === null) return;
    this.io.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: TRANSPORT_ERROR, message } }));
  }
}

/** Feed newline-delimited input through a handler, one complete line at a
 *  time and never overlapping. Chunk boundaries are not message boundaries —
 *  a JSON-RPC message can arrive in pieces, and two can arrive together — so
 *  the buffer is what defines a message, not the read. */
export async function pumpLines(
  input: AsyncIterable<string>,
  onLine: (line: string) => Promise<void>,
): Promise<void> {
  let pending = '';
  for await (const chunk of input) {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) await onLine(line);
  }
  // A final line without a trailing newline is still a message.
  if (pending.trim() !== '') await onLine(pending);
}

/** The `id` of an outgoing message, or null when there is none to answer to
 *  (a notification, a batch, or something that is not JSON at all).
 *
 *  This is the one place the relay looks inside a message, and it looks at
 *  the JSON-RPC envelope only — never at `method` or `params`. Correlation is
 *  transport work: without it a failed request leaves the client waiting for
 *  a response that will never come. */
function requestIdOf(message: string): string | number | null {
  try {
    const parsed: unknown = JSON.parse(message);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const id = (parsed as { id?: unknown }).id;
    return typeof id === 'string' || typeof id === 'number' ? id : null;
  } catch {
    return null;
  }
}

/** The JSON-RPC payloads in a 2xx reply.
 *
 *  The server this bridge targets answers POSTs with a single JSON document
 *  (it constructs its transport with enableJsonResponse — measured in
 *  @kozou/mcp 1.17.0). The event-stream branch exists because the same
 *  transport can stream, and a relay that silently dropped those frames would
 *  hang the client rather than fail; it is exercised by a stub-server test,
 *  not by the real server. */
function framesOf(reply: RelayReply): string[] {
  const contentType = reply.headers['content-type'] ?? '';
  if (!contentType.includes('text/event-stream')) {
    const body = reply.body.trim();
    return body === '' ? [] : [body];
  }
  return reply.body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((payload) => payload !== '');
}
