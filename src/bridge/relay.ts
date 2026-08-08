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
//
// Only JSON replies are relayed. The server this targets answers with a
// single JSON document (it constructs its transport with enableJsonResponse,
// read in @kozou/mcp 1.17.0), so an event-stream reply means the contract
// this bridge was built against no longer holds — and it is reported as a
// failure rather than half-parsed. The match is on the lowercase spelling
// only, so a server answering `Text/Event-Stream` — legal, since only header
// *names* are case-insensitively normalized — is refused one step later as a
// body that is not JSON: the wrong sentence, though nothing is relayed either
// way. An earlier version had a branch that split
// a buffered body on `data:` lines; it forwarded nothing incrementally, could
// not serve a stream the server held open, and was exercised only by a stub.
// Keeping it would have advertised a compatibility that did not exist.

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

/** The `name` a transport sets on the error it raises when it refuses to send
 *  because the client has gone. Matched by name so this module keeps knowing
 *  nothing about the transport behind the interface. */
export const CLIENT_GONE = 'ClientGoneError';

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
      // Two opposite diagnoses share this path, and saying the wrong one sends
      // whoever reads the log to the wrong side of the bridge.
      if (err instanceof Error && err.name === CLIENT_GONE) {
        this.io.log(`kozou-bridge: ${detail}`);
        this.fail(message, detail);
        return;
      }
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

    if ((reply.headers['content-type'] ?? '').includes('text/event-stream')) {
      this.io.log('kozou-bridge: server answered with an event stream, which this bridge does not read');
      this.fail(message, 'Kozou local MCP server answered with an event stream; this bridge relays JSON replies only');
      return;
    }

    const payload = reply.body.trim();
    if (payload === '') return;
    // Re-serialize compactly: the line protocol cannot carry the embedded
    // newlines a pretty-printed body would have.
    try {
      this.io.send(JSON.stringify(JSON.parse(payload)));
    } catch {
      this.io.log('kozou-bridge: server sent a body that is not JSON — dropping it');
      this.fail(message, 'Kozou local MCP server sent a response that is not JSON');
    }
  }

  /** stdin closed: tell the server the session is over.
   *
   *  This is the only thing that ends a session. The server holds each
   *  initialized transport in a map and drops it when that transport closes;
   *  there is no idle expiry in it (read in @kozou/mcp 1.17.0). So a bridge
   *  killed without a clean EOF — SIGKILL, an EPIPE on stdout — leaves its
   *  session behind until the app stops that profile's server. Not addressed
   *  here; recorded so it is not mistaken for handled. */
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
    const reply = errorReplyFor(request, message);
    if (reply !== null) this.io.send(reply);
  }
}

/** Answer every request with the same transport error, until the client goes
 *  away.
 *
 *  This is what BD4 looks like from the client's side. The bridge cannot reach
 *  a server — no locator is published, or the one on disk does not parse — and
 *  the thing it must not do is start the app (BR-4). Exiting immediately was
 *  the earlier behaviour and it is not enough: the client sees a process that
 *  died without answering, and the reason is only in a log file it wrote
 *  somewhere. A JSON-RPC error carries the reason into the conversation.
 *
 *  It keeps answering rather than exiting after the first one because the
 *  client owns this process's lifetime (§3): what happens after `initialize`
 *  fails is the client's decision, and a bridge that vanished mid-exchange
 *  would be a second, less legible failure on top of the first. */
export async function serveUnavailable(
  input: AsyncIterable<string>,
  reason: string,
  io: RelayIo,
): Promise<void> {
  io.log(`kozou-bridge: ${reason}`);
  await pumpLines(input, (line) => {
    const reply = errorReplyFor(line, reason);
    if (reply !== null) io.send(reply);
    return Promise.resolve();
  });
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

/** The serialized JSON-RPC error answering `request`, or null when there is
 *  nothing this bridge can answer it into.
 *
 *  This is the one place the relay looks inside a message, and it looks at the
 *  JSON-RPC envelope only — never at `method` or `params`. Correlation is
 *  transport work: without it a failed request leaves the client waiting for a
 *  response that will never come.
 *
 *  **A failed batch is not answered, and that is a stated gap rather than an
 *  oversight.** An earlier version of this function answered every id in a
 *  batch with an array of errors. Measured against the client stack this
 *  bridge exists for: `@modelcontextprotocol/sdk` 1.29.0 deserializes a stdio
 *  line with a schema that is a union of four *object* shapes and has no batch
 *  variant, so that array made the client's transport throw. MCP 2025-06-18
 *  removed batching outright. Answering would trade "the client waits" for
 *  "the client's transport throws", and claiming batch support the reachable
 *  clients cannot read is the same advertisement of a compatibility that does
 *  not exist that cost the event-stream branch its place. A batch that fails
 *  in transport is therefore reported on stderr only.
 *
 *  What this does not filter, stated because the sentence above is about what
 *  is owed rather than what arrives: a member carrying `result` or `error` is
 *  a *response*, which is owed nothing, and it is answered anyway. */
export function errorReplyFor(request: string, message: string): string | null {
  const id = answerableIdOf(request);
  if (id === null) return null;
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code: TRANSPORT_ERROR, message } });
}

/** The `id` of a message a response can be addressed to, or null when there is
 *  none: a notification carries no id, a batch cannot be answered at all (see
 *  above), and a body that is not JSON has no envelope to read. */
function answerableIdOf(message: string): string | number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const id = (parsed as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}
