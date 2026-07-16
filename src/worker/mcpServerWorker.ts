// utilityProcess entry: one resident MCP server per profile (one profile =
// one process; databases are never mixed in one process — crash isolation,
// and the env-only secret channel stays one URL per fork). The connection
// URL arrives via env only (never argv, never in the IPC message). The
// worker posts a single startup report, then stays resident until the
// parent kills it (explicit stop, profile edit/delete, or app quit).

import processGlobal from 'node:process';
import { sanitizeErrorMessage } from '../shared/url.js';
import type { McpWorkerRequest, McpWorkerStarted } from '../shared/types.js';
import { runMcpServer } from './runMcpServer.js';

const ENV_KEY = 'KOZOU_DESKTOP_DB_URL';

type ParentPort = {
  once(event: 'message', listener: (e: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
};

const parentPort = (processGlobal as unknown as { parentPort: ParentPort }).parentPort;

parentPort.once('message', (e) => {
  void handle(e.data as McpWorkerRequest);
});

async function handle(req: McpWorkerRequest): Promise<void> {
  const url = processGlobal.env[ENV_KEY];
  // Drop the secret from our own env immediately; the server holds it in
  // memory for its lifetime (lazy re-introspection needs it).
  delete processGlobal.env[ENV_KEY];

  let result: McpWorkerStarted;
  if (!url) {
    result = { ok: false, error: 'worker started without a connection URL' };
  } else {
    try {
      const handle = await runMcpServer({
        url,
        schemas: req.schemas,
        port: req.port,
        mcpPath: req.mcpPath,
      });
      result = { ok: true, port: handle.port };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      result = {
        ok: false,
        error: sanitizeErrorMessage(message, url),
        ...(code === 'EADDRINUSE' || message.includes('EADDRINUSE') ? { portBusy: true } : {}),
      };
    }
  }

  parentPort.postMessage(result);
  // Do not self-exit (even on failure): the parent owns termination, and an
  // exit timer would race the flush of the report message.
}
