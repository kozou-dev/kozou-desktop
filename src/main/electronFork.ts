// The one place the MCP server manager touches Electron at runtime: the
// utilityProcess fork, wrapped behind the manager's structural fork type so
// unit tests can inject a fake child (same philosophy as the injected
// Encryptor). argv stays empty by construction — the connection URL travels
// via the env option only.

import { utilityProcess } from 'electron';
import type { McpWorkerFork } from './mcpServerManager.js';

export const electronMcpWorkerFork: McpWorkerFork = (modulePath, options) =>
  utilityProcess.fork(modulePath, [], options);
