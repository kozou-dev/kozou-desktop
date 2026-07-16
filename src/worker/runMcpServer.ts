// Long-lived MCP server core: one profile = one process = one loopback HTTP
// server serving the kozou describe tools for one database. Kept free of
// Electron so the integration test can drive it in plain Node.
//
// Read-only is structural, not configurational: startHttpServer is called
// WITHOUT the opt-in execution capability and WITHOUT the OAuth options, so
// the `call` tool is neither advertised in tools/list nor dispatchable, and
// the server runs in the no-auth loopback mode. The built-in DNS-rebinding
// guard (Host/Origin validation) is active by default; the per-profile
// random capability path raises the local bar from port-scanning to
// file-reading. Both option names are additionally tripwired by
// scripts/check-treeshake.mjs, which fails CI if this file ever constructs
// them.

import { SchemaCache, startHttpServer, type HttpServerHandle } from '@kozou/mcp';

export type McpServerConfig = {
  /** Full connection URL (with password). Held in memory for the server's
   *  lifetime — the schema cache re-introspects lazily on TTL expiry. */
  url: string;
  schemas: string[];
  /** 0 lets the OS assign (integration tests); the app always passes the
   *  profile's sticky allocated port. */
  port: number;
  /** Random capability path ("/mcp-<hex>"). */
  mcpPath: string;
};

export function runMcpServer(config: McpServerConfig): Promise<HttpServerHandle> {
  const cache = new SchemaCache({ connection: config.url, schemas: config.schemas });
  return startHttpServer(cache, {
    host: '127.0.0.1',
    port: config.port,
    mcpPath: config.mcpPath,
    logPrefix: '[kozou-desktop-mcp]',
  });
}
