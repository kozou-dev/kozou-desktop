// Integration test for the local MCP server worker core: boots the real
// server (plain Node, same modules the utilityProcess entry runs) against a
// real database and asserts the guarantees the design leans on:
//
//   1. read-only surface — tools/list is exactly the describe tools, the
//      execution tool is absent, and forcing it by name is refused;
//   2. the capability path is load-bearing — the default /mcp path 404s;
//   3. the DNS-rebinding guard rejects a forged Host header.
//
// Requires a reachable PostgreSQL: set KOZOU_TEST_DATABASE_URL (the CI job
// provisions postgres:16 + fixtures/contract.sql — same as contract.test.ts).

import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMcpServer } from '../src/worker/runMcpServer.js';
import type { HttpServerHandle } from '@kozou/mcp';

const url = process.env.KOZOU_TEST_DATABASE_URL;
const MCP_PATH = '/mcp-0123456789abcdef0123456789abcdef';

/** The complete always-on tool set of a read-only (describe-scope) kozou MCP server. */
const DESCRIBE_TOOLS = [
  'describe_functions',
  'describe_table',
  'describe_view',
  'get_concept_context',
  'list_concepts',
  'list_tables',
  'list_views',
  'search_schema',
];

function rawPost(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on('error', reject);
    req.end('{}');
  });
}

describe.skipIf(!url)('local MCP server (read-only, loopback, capability path)', () => {
  let handle: HttpServerHandle;

  beforeAll(async () => {
    // Port 0: the OS assigns a free port — the handle reports the real one.
    handle = await runMcpServer({ url: url!, schemas: ['public'], port: 0, mcpPath: MCP_PATH });
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('serves exactly the describe tools and refuses the execution tool', async () => {
    const client = new Client({ name: 'kozou-desktop-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}${MCP_PATH}`));
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual(DESCRIBE_TOOLS);

      // A describe tool works end to end against the real database.
      const listed = await client.callTool({ name: 'list_tables', arguments: {} });
      expect(listed.isError ?? false).toBe(false);

      // Forcing the execution tool by name is refused (defense in depth: it
      // is not merely unadvertised).
      let refusal = '';
      try {
        const forced = await client.callTool({ name: 'call', arguments: { function: 'public.f', args: {} } });
        expect(forced.isError).toBe(true);
        refusal = JSON.stringify(forced.content);
      } catch (err) {
        refusal = err instanceof Error ? err.message : String(err);
      }
      expect(refusal).toMatch(/not enabled|unknown tool/i);
    } finally {
      await client.close();
    }
  });

  it('404s on the default /mcp path — the capability path is load-bearing', async () => {
    const res = await rawPost(handle.port, '/mcp', {});
    expect(res.status).toBe(404);
  });

  it('rejects a forged Host header (DNS-rebinding guard active)', async () => {
    const res = await rawPost(handle.port, MCP_PATH, { host: 'evil.example.com' });
    expect(res.status).toBe(403);
  });
});
