// The one place the resident-worker managers touch Electron at runtime: the
// utilityProcess fork, wrapped behind each manager's structural fork type so
// unit tests can inject a fake child (same philosophy as the injected
// Encryptor). argv stays empty by construction — the connection URL and the
// row-access capability travel via the env option only.

import { utilityProcess } from 'electron';
import type { DataWorkerFork } from './dataWorkerManager.js';
import type { McpWorkerFork } from './mcpServerManager.js';

export const electronMcpWorkerFork: McpWorkerFork = (modulePath, options) =>
  utilityProcess.fork(modulePath, [], options);

export const electronDataWorkerFork: DataWorkerFork = (modulePath, options) =>
  utilityProcess.fork(modulePath, [], options);
