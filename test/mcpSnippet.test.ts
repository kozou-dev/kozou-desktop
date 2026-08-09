import { describe, expect, it } from 'vitest';
import { buildMcpClientSnippets } from '../src/shared/mcpSnippet.js';

const PATH = '/mcp-0123456789abcdef0123456789abcdef';
const LAUNCHER = {
  command: '/Applications/Kozou.app/Contents/MacOS/Kozou',
  script: '/Applications/Kozou.app/Contents/Resources/app.asar/out/main/stdioBridge.js',
};
const ID = 'aaaaaaaabbbbbbbbccccccccdddddddd';

describe('buildMcpClientSnippets', () => {
  const s = buildMcpClientSnippets('db-a', 3335, PATH);

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

  it('offers no bridge entry without a launcher and an id', () => {
    expect(s.claudeDesktopJson).toBeUndefined();
    expect('claudeDesktopJson' in s).toBe(false);
  });
});

describe('buildMcpClientSnippets bridge entry', () => {
  const s = buildMcpClientSnippets('db-a', 3335, PATH, { launcher: LAUNCHER, id: ID });
  const entry = (JSON.parse(s.claudeDesktopJson ?? '{}') as {
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  }).mcpServers['kozou-local-db-a'];

  it('launches the app binary as Node with the bridge script and the locator id', () => {
    expect(entry).toEqual({
      command: LAUNCHER.command,
      args: [LAUNCHER.script, '--id', ID],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
  });

  it('passes the id in the argv shape the bridge parses', () => {
    // parseBridgeArgs takes exactly ["--id", <id>] after the script, so the
    // flag and the value are two arguments and the script comes first.
    expect(entry?.args.slice(1)).toEqual(['--id', ID]);
  });

  /** The claim the UI and README make about this entry: unlike the URL shapes,
   *  it does not put the capability path into another application's config
   *  file. Asserted over the whole document rather than over the fields, so a
   *  new field carrying it is caught too. */
  it('keeps the capability path and the port out of the entry', () => {
    expect(s.claudeDesktopJson).not.toContain(PATH);
    expect(s.claudeDesktopJson).not.toContain('mcp-0123456789abcdef0123456789abcdef');
    expect(s.claudeDesktopJson).not.toContain('3335');
    expect(s.claudeDesktopJson).not.toContain('127.0.0.1');
  });

  /** BD5: one profile is one entry. Two profiles differ in the name the client
   *  files the server under AND in the locator the bridge resolves, so a
   *  client holding both never resolves one to the other's database. */
  it('gives each profile its own name and its own locator id', () => {
    const other = buildMcpClientSnippets('db-b', 3336, '/mcp-ffffffffffffffffffffffffffffffff', {
      launcher: LAUNCHER,
      id: '11111111222222223333333344444444',
    });
    expect(other.serverName).not.toBe(s.serverName);
    const names = Object.keys(
      (JSON.parse(other.claudeDesktopJson ?? '{}') as { mcpServers: Record<string, unknown> }).mcpServers,
    );
    expect(names).toEqual(['kozou-local-db-b']);
    expect(other.claudeDesktopJson).toContain('11111111222222223333333344444444');
    expect(other.claudeDesktopJson).not.toContain(ID);
  });
});
