// AI-client connection snippets for a profile's local MCP server. Pure (no
// Svelte, no Electron) so it is unit-testable in isolation. Output shapes
// mirror kozou's web-UI connection helper; the server name is the desktop's
// per-profile identity (kozou-local-<profile>) so entries from different
// profiles — and from remote kozou servers (kozou-remote-<profile>) — can
// never be confused in an AI client's config.

export type McpClientSnippets = {
  serverName: string;
  httpUrl: string;
  /** Claude Desktop / Cursor mcpServers JSON (pretty-printed). */
  mcpServersJson: string;
  /** One-line `claude mcp add` command for Claude Code. */
  claudeCodeCommand: string;
};

export function buildMcpClientSnippets(profile: string, port: number, path: string): McpClientSnippets {
  const serverName = `kozou-local-${profile}`;
  const httpUrl = `http://127.0.0.1:${port}${path}`;
  const mcpServersJson = JSON.stringify(
    { mcpServers: { [serverName]: { type: 'http', url: httpUrl } } },
    null,
    2,
  );
  const claudeCodeCommand = `claude mcp add --transport http ${serverName} ${httpUrl}`;
  return { serverName, httpUrl, mcpServersJson, claudeCodeCommand };
}
