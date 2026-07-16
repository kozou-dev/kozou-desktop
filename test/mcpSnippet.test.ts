import { describe, expect, it } from 'vitest';
import { buildMcpClientSnippets } from '../src/shared/mcpSnippet.js';

describe('buildMcpClientSnippets', () => {
  const s = buildMcpClientSnippets('db-a', 3335, '/mcp-0123456789abcdef0123456789abcdef');

  it('names the server kozou-local-<profile> and builds the loopback URL', () => {
    expect(s.serverName).toBe('kozou-local-db-a');
    expect(s.httpUrl).toBe('http://127.0.0.1:3335/mcp-0123456789abcdef0123456789abcdef');
  });

  it('emits valid mcpServers JSON with an http entry', () => {
    const parsed = JSON.parse(s.mcpServersJson) as {
      mcpServers: Record<string, { type: string; url: string }>;
    };
    expect(parsed.mcpServers['kozou-local-db-a']).toEqual({ type: 'http', url: s.httpUrl });
  });

  it('emits the claude mcp add command', () => {
    expect(s.claudeCodeCommand).toBe(
      'claude mcp add --transport http kozou-local-db-a http://127.0.0.1:3335/mcp-0123456789abcdef0123456789abcdef',
    );
  });
});
