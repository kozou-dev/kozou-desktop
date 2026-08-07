// Parity: the same MCP client, once over stdio through the bridge and once
// straight at the loopback server, against the same real database.
//
// This is the test the relay's own suites cannot be: the client is the SDK's
// (so the session handshake is a real one, not the stub's imitation), the
// server is the one the app runs, and the assertion is that the two routes
// answer the same. If the bridge ever starts interpreting MCP — rewriting a
// tool list, dropping a field, adding one — this is where it shows.
//
// It also settles two readings with measurements: the server issues a session
// id the bridge must carry, and it accepts requests with no
// mcp-protocol-version header.
//
// Requires a reachable PostgreSQL: set KOZOU_TEST_DATABASE_URL (the CI job
// provisions postgres:16 + fixtures/contract.sql — same as contract.test.ts).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMcpServer } from '../src/worker/runMcpServer.js';
import { buildBridgeBundle, publishLocator, stringEnv } from './bridgeBundle.js';
import type { HttpServerHandle } from '@kozou/mcp';

const url = process.env.KOZOU_TEST_DATABASE_URL;
const ID = '0123456789abcdef0123456789abcdef';
const MCP_PATH = '/mcp-0123456789abcdef0123456789abcdef';

describe.skipIf(!url)('stdio bridge against the real local MCP server', () => {
  let handle: HttpServerHandle;
  let bundle: string;
  let userData: string;

  beforeAll(async () => {
    handle = await runMcpServer({ url: url!, schemas: ['public'], port: 0, mcpPath: MCP_PATH });
    bundle = buildBridgeBundle();
    userData = publishLocator({ id: ID, port: handle.port, path: MCP_PATH });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
  });

  async function throughBridge<T>(use: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: 'kozou-desktop-bridge-test', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [bundle, '--id', ID],
        env: stringEnv({ KOZOU_DESKTOP_USER_DATA: userData }),
      }),
    );
    try {
      return await use(client);
    } finally {
      await client.close();
    }
  }

  async function direct<T>(use: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: 'kozou-desktop-direct-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}${MCP_PATH}`)));
    try {
      return await use(client);
    } finally {
      await client.close();
    }
  }

  // Every case below starts with client.connect(), which is itself two of
  // the acceptance criteria: the SDK sends initialize and then the
  // notifications/initialized notification, and it would fail on a stray
  // stdout line — so a connection that succeeds is a session that handshook
  // and a 202 that produced no output.
  it('serves the same tool list as a direct connection', async () => {
    const viaBridge = await throughBridge((c) => c.listTools());
    const viaHttp = await direct((c) => c.listTools());
    expect(viaBridge.tools.map((t) => t.name).sort()).toEqual(viaHttp.tools.map((t) => t.name).sort());
    // Not just the names: nothing is rewritten on the way through.
    expect(viaBridge.tools).toEqual(viaHttp.tools);
  });

  it('returns the same tool result as a direct connection', async () => {
    const viaBridge = await throughBridge((c) => c.callTool({ name: 'list_tables', arguments: {} }));
    const viaHttp = await direct((c) => c.callTool({ name: 'list_tables', arguments: {} }));
    expect(viaBridge.isError ?? false).toBe(false);
    expect(viaBridge.content).toEqual(viaHttp.content);
  });

  it('keeps one session across several requests', async () => {
    const names = await throughBridge(async (client) => {
      const first = await client.listTools();
      // A second and third request on the same process: each needs the
      // session id the server issued during initialize, so a bridge that
      // dropped it would fail here with HTTP 400.
      await client.callTool({ name: 'list_tables', arguments: {} });
      const third = await client.listTools();
      return [first.tools.length, third.tools.length];
    });
    expect(names[0]).toBe(names[1]);
    expect(names[0]).toBeGreaterThan(0);
  });

  it('needs no protocol-version header from the client side of the relay', async () => {
    // The bridge sends none (it never reads an initialize result — that would
    // be the semantic interpretation BD1 rules out). If the real server
    // required the header, every request after initialize would 400, so a
    // working call IS the measurement.
    const listed = await throughBridge((c) => c.callTool({ name: 'list_tables', arguments: {} }));
    expect(listed.isError ?? false).toBe(false);
  });
});
