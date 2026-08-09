// AI-client connection snippets for a profile's local MCP server. Pure (no
// Svelte, no Electron) so it is unit-testable in isolation. Output shapes
// mirror kozou's web-UI connection helper; the server name is the desktop's
// per-profile identity (kozou-local-<profile>) so entries from different
// profiles — and from remote kozou servers (kozou-remote-<profile>) — can
// never be confused in an AI client's config.
//
// Two shapes, one server. A client that connects to a URL gets the loopback
// URL; a client that launches a local command instead (Claude Desktop) gets an
// entry that starts this app's stdio bridge. Both name the same running server,
// which is why they share the server name: one profile is one entry (BD5), and
// the difference between them is the transport, not the destination.

import type { McpBridgeLauncher } from './types.js';

export type McpClientSnippets = {
  serverName: string;
  httpUrl: string;
  /** `mcpServers` JSON for a client that connects to a URL from its config,
   *  e.g. Cursor. Not Claude Desktop: its config file launches local commands,
   *  and its custom connectors are opened from Anthropic's cloud and require a
   *  public https address — hence the bridge entry below. */
  mcpServersJson: string;
  /** One-line `claude mcp add` command for Claude Code. */
  claudeCodeCommand: string;
  /** `mcpServers` JSON for a client that launches a local command: it starts
   *  this app's stdio bridge, which relays to the same loopback server.
   *
   *  Absent when the profile has no bridge id yet (an allocation written by a
   *  build that predates locators gains one on next use) or when the app could
   *  not resolve its own paths. The entry is deliberately not derived here from
   *  anything but what main handed over — the paths are absolute, and a rebuilt
   *  or moved app makes a pasted entry stale, which the bridge reports as an
   *  explicit failure rather than a silent reconnection.
   *
   *  Note what is NOT in it: the capability path. The bridge is pointed at a
   *  locator id, and reads port and path from a file this app owns, so the
   *  secret never lands in another application's config file. */
  claudeDesktopJson?: string;
};

export function buildMcpClientSnippets(
  profile: string,
  port: number,
  path: string,
  bridge?: { launcher: McpBridgeLauncher; id: string },
): McpClientSnippets {
  const serverName = `kozou-local-${profile}`;
  const httpUrl = `http://127.0.0.1:${port}${path}`;
  const mcpServersJson = JSON.stringify(
    { mcpServers: { [serverName]: { type: 'http', url: httpUrl } } },
    null,
    2,
  );
  const claudeCodeCommand = `claude mcp add --transport http ${serverName} ${httpUrl}`;
  const claudeDesktopJson =
    bridge === undefined
      ? undefined
      : JSON.stringify(
          {
            mcpServers: {
              [serverName]: {
                command: bridge.launcher.command,
                args: [bridge.launcher.script, '--id', bridge.id],
                // Runs the app binary as Node rather than as the desktop app:
                // without this the client would launch a second copy of the
                // window, not a bridge.
                env: { ELECTRON_RUN_AS_NODE: '1' },
              },
            },
          },
          null,
          2,
        );
  return {
    serverName,
    httpUrl,
    mcpServersJson,
    claudeCodeCommand,
    ...(claudeDesktopJson !== undefined ? { claudeDesktopJson } : {}),
  };
}
