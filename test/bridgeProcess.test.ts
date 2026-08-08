// The bridge as a real process, and BR-3 as a real observation.
//
// Everything else about the bridge is tested through injected dependencies.
// This file is the one that runs the actual entry point — bundled the way it
// ships, spawned by another process, talking over its own stdin/stdout — and
// asks the operating system what sockets that process holds.
//
// Why not a static check: the bridge legitimately imports node:http, so no
// scan of its imports can distinguish "makes requests" from "accepts them".
// The only evidence that separates the two is the process's own socket table
// while it is running, which is what listeningSockets() reads.
//
// The positive control at the top is what keeps that evidence honest. A
// detector that silently returns nothing — wrong platform, missing tool,
// changed output format — would make every assertion below pass vacuously,
// so a process that IS listening must be seen first.

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, readlinkSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBridgeBundle, publishLocator } from './bridgeBundle.js';

const ID = '0123456789abcdef0123456789abcdef';
const MCP_PATH = '/mcp-0123456789abcdef0123456789abcdef';
const TIMEOUT = 60_000;

/** TCP sockets the given process holds in LISTEN state. Throws rather than
 *  returning an empty list when it cannot tell — an unanswerable question
 *  must not read as "no listeners". */
function listeningSockets(pid: number): string[] {
  if (process.platform === 'linux') return linuxListeners(pid);
  const out = runOrEmpty('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-F', 'n']);
  return out
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => line.slice(1));
}

function linuxListeners(pid: number): string[] {
  const inodes = new Set<string>();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      const match = /^socket:\[(\d+)]$/.exec(target);
      if (match) inodes.add(match[1]!);
    } catch {
      // fds come and go while we read the directory
    }
  }
  const found: string[] = [];
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try {
      text = readFileSync(table, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      // sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode
      if (fields.length < 10) continue;
      if (fields[3] !== '0A') continue; // TCP_LISTEN
      if (inodes.has(fields[9]!)) found.push(`${fields[1]} (inode ${fields[9]})`);
    }
  }
  return found;
}

/** PIDs the given process has as direct children.
 *
 *  BR-4 is "does not start the app", and the only way to see that is to look
 *  at what the process actually started. Like listeningSockets, this throws
 *  rather than returning nothing when it cannot tell: a detector that answers
 *  "none" to an unanswerable question turns every assertion below into a
 *  tautology, which is why there is a positive control for it. */
function childPids(pid: number): string[] {
  const out = runOrEmpty('pgrep', ['-P', String(pid)]);
  return out.split('\n').filter((line) => line.trim() !== '');
}

function runOrEmpty(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: 'utf8' });
  } catch (err) {
    // lsof exits 1 with no output when nothing matches; anything else (the
    // tool missing, for instance) has to surface.
    const e = err as { status?: number; stdout?: string; code?: string };
    if (e.code === 'ENOENT') {
      throw new Error(`${command} is not available — BR-3/BR-4 cannot be observed on this machine`);
    }
    if (e.status === 1 && (e.stdout ?? '') === '') return '';
    throw err;
  }
}

/** Read stdout as newline-delimited messages. */
function lineReader(child: ChildProcessWithoutNullStreams): { next(): Promise<string> } {
  const queue: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const resolve = waiting.shift();
      if (resolve) resolve(line);
      else queue.push(line);
    }
  });
  return {
    next: () =>
      new Promise<string>((resolve, reject) => {
        const queued = queue.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        const timer = setTimeout(() => reject(new Error('no message from the bridge within 15s')), 15_000);
        waiting.push((line) => {
          clearTimeout(timer);
          resolve(line);
        });
      }),
  };
}

/** The child's exit code, killing it if it overstays.
 *
 *  Closing stdin is a request; this is the guarantee. Measured the hard way:
 *  running this file against a deliberately listening mutant left three
 *  orphan processes holding ports, because nothing here made a bridge that
 *  would not exit go away. */
function exitCodeOf(child: ChildProcessWithoutNullStreams, ms = 15_000): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, ms);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe('the bridge as a process', () => {
  let bundle: string;
  let userData: string;
  let server: Server;
  let seen: Array<{ method: string; session?: string }>;
  let sessions: Set<string>;

  beforeAll(async () => {
    // Bundled the way it ships (one file, no dependencies) so what runs here
    // is the packaged shape rather than a source tree with a loader.
    bundle = buildBridgeBundle();

    seen = [];
    sessions = new Set();
    let issued = 0;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const session = req.headers['mcp-session-id'] as string | undefined;
        seen.push({ method: req.method ?? '', ...(session !== undefined ? { session } : {}) });
        if (req.method === 'DELETE') {
          if (session !== undefined) sessions.delete(session);
          res.writeHead(204).end();
          return;
        }
        if (session === undefined) {
          const id = `session-${++issued}`;
          sessions.add(id);
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': id });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } }));
          return;
        }
        const parsed = JSON.parse(body) as { id?: number };
        if (parsed.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { ok: true } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    userData = publishLocator({ id: ID, port: (server.address() as { port: number }).port, path: MCP_PATH });
  }, TIMEOUT);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('positive control: a listening process IS seen by the detector', async () => {
    const script = `import {createServer} from 'node:http';const s=createServer(()=>{});s.listen(0,'127.0.0.1',()=>console.log('ready'));`;
    const file = join(mkdtempSync(join(tmpdir(), 'kozou-desktop-listener-')), 'listener.mjs');
    writeFileSync(file, script);
    const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve());
        child.once('error', reject);
        setTimeout(() => reject(new Error('control listener did not start')), 10_000);
      });
      expect(listeningSockets(child.pid!).length).toBeGreaterThan(0);
    } finally {
      child.kill();
    }
  }, TIMEOUT);

  it('relays a whole session and holds no listening socket while doing it', async () => {
    const child = spawn(process.execPath, [bundle, '--id', ID], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, KOZOU_DESKTOP_USER_DATA: userData },
    });
    const stderr: string[] = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => stderr.push(chunk));
    const reader = lineReader(child);

    try {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
      );
      expect(JSON.parse(await reader.next())).toMatchObject({ id: 1 });

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
      // The notification produced no line, so the next one is the response to
      // request 2 — the 202 is asserted by what does NOT arrive.
      expect(JSON.parse(await reader.next())).toMatchObject({ id: 2 });

      // BR-3, observed on the live process rather than inferred from its
      // imports.
      expect(listeningSockets(child.pid!)).toEqual([]);
    } finally {
      child.stdin.end();
    }

    const code = await exitCodeOf(child);
    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    // EOF ends the session at the server, not just locally.
    expect(seen.at(-1)?.method).toBe('DELETE');
    expect(sessions.size).toBe(0);
  }, TIMEOUT);

  // BD4 and BR-4, which are the same moment seen from two sides: what the
  // client is told, and what the bridge does not do about it.
  //
  // The previous version of this asserted only the exit code and the stderr
  // text, while its name also claimed "does not start the app" — a claim
  // nothing in it checked. It also could not have caught the gap this
  // replaced: a bridge that exits without answering satisfies both of those
  // assertions, and that is exactly what the bridge used to do.
  it('answers the client with the reason when no locator is published', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'kozou-desktop-empty-'));
    const child = spawn(process.execPath, [bundle, '--id', ID], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, KOZOU_DESKTOP_USER_DATA: empty },
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    const reader = lineReader(child);

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    const reply = JSON.parse(await reader.next()) as { id: number; error?: { message: string } };
    expect(reply.id).toBe(1);
    expect(reply.error?.message).toMatch(/no local MCP server is published/);

    // BR-4, observed rather than inferred: nothing was started to recover.
    expect(childPids(child.pid!)).toEqual([]);

    child.stdin.end();
    expect(await exitCodeOf(child)).toBe(1);
    expect(stderr).toMatch(/no local MCP server is published/);
    expect(stderr).toMatch(/Start Kozou/);
  }, TIMEOUT);

  it('positive control: a process that DOES start a child is seen by the detector', async () => {
    const script =
      "import {spawn} from 'node:child_process';" +
      "const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)']);" +
      "c.on('spawn',()=>console.log('ready'));";
    const file = join(mkdtempSync(join(tmpdir(), 'kozou-desktop-spawner-')), 'spawner.mjs');
    writeFileSync(file, script);
    const parent = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise<void>((resolve, reject) => {
        parent.stdout.once('data', () => resolve());
        parent.once('error', reject);
        setTimeout(() => reject(new Error('control spawner did not start')), 10_000);
      });
      expect(childPids(parent.pid!).length).toBeGreaterThan(0);
    } finally {
      for (const pid of childPids(parent.pid!)) process.kill(Number(pid), 'SIGKILL');
      parent.kill('SIGKILL');
      await new Promise<void>((resolve) => parent.once('exit', () => resolve()));
    }
  }, TIMEOUT);

  it('starts nothing while relaying a healthy session either', async () => {
    const child = spawn(process.execPath, [bundle, '--id', ID], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, KOZOU_DESKTOP_USER_DATA: userData },
    });
    const reader = lineReader(child);
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
      await reader.next();
      expect(childPids(child.pid!)).toEqual([]);
    } finally {
      child.stdin.end();
    }
    await exitCodeOf(child);
  }, TIMEOUT);

  it('exits when the client closes, even with a request the server never answers', async () => {
    // The measured failure this replaces: closing stdin left the process
    // alive indefinitely, because the relay was inside a POST that would
    // never return and nothing told it the client had gone.
    const held: ServerResponse[] = [];
    const silent = createServer((_req, res) => void held.push(res));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const silentUserData = publishLocator({
      id: ID,
      port: (silent.address() as { port: number }).port,
      path: MCP_PATH,
    });
    const child = spawn(process.execPath, [bundle, '--id', ID], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, KOZOU_DESKTOP_USER_DATA: silentUserData },
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
      await new Promise((r) => setTimeout(r, 300));
      child.stdin.end();
      // Well inside the ten-minute deadline the bridge ships with, so passing
      // here means the disconnect ended it, not the deadline.
      expect(await exitCodeOf(child, 10_000)).not.toBeNull();
      expect(stderr).toMatch(/closed its end of the bridge/);
    } finally {
      for (const res of held) res.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  }, TIMEOUT);

  // A malformed id is a broken config entry rather than an absent app, but it
  // reaches the client the same way and for the same reason: whatever stops
  // the bridge from binding to a server is said in the exchange, not only in a
  // log the user has to go find. Usage errors (a missing --id) still exit
  // straight away — there is no client conversation to answer into yet.
  it('refuses an id that is not a locator id, and tells the client so', async () => {
    const child = spawn(process.execPath, [bundle, '--id', '../store/profiles'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, KOZOU_DESKTOP_USER_DATA: userData },
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    const reader = lineReader(child);

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    const reply = JSON.parse(await reader.next()) as { id: number; error?: { message: string } };
    expect(reply.error?.message).toMatch(/32 lowercase hex/);
    expect(childPids(child.pid!)).toEqual([]);

    child.stdin.end();
    expect(await exitCodeOf(child)).toBe(1);
    expect(stderr).toMatch(/32 lowercase hex/);
  }, TIMEOUT);

  it('reports a broken pipe once and leaves, without the client closing stdin', async () => {
    // stdout belongs to the client and the client can go at any moment. Before
    // the handler existed this ended as an unhandled EPIPE, i.e. a Node stack
    // trace in the client's log — measured.
    //
    // Two things beyond that are pinned here, because the first version of the
    // handler satisfied neither while this test stayed green. **stdin is left
    // open on purpose**: nothing else can end this process, so an exit is the
    // handler's doing. And the pipe is reported *once* — the requests written
    // after it breaks are replies the bridge would try to write into it, and
    // the earlier handler emitted one line per attempt while it kept running
    // and kept querying the database behind them.
    const child = spawn(process.execPath, [bundle, '--id', ID], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, KOZOU_DESKTOP_USER_DATA: userData },
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.stdout.on('error', () => {
      // reading side of the parent; the child's write is what matters here
    });
    child.stdin.on('error', () => {
      // the child may stop reading before these writes land, which is the point
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    await new Promise((r) => setTimeout(r, 300));
    child.stdout.destroy();
    for (let id = 2; id <= 6; id += 1) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} })}\n`);
    }
    expect(await exitCodeOf(child, 10_000)).toBe(1);
    const reported = stderr
      .split('\n')
      .filter((line) => /closed the connection before this reply could be written/.test(line));
    expect(reported).toHaveLength(1);
    expect(stderr).not.toMatch(/Unhandled 'error' event/);
    expect(stderr).not.toMatch(/at Relay\./);
    expect(stderr).not.toMatch(/ERR_STREAM_PREMATURE_CLOSE/);
  }, TIMEOUT);

  it('exits straight away on a usage error, with nothing to answer into', async () => {
    const child = spawn(process.execPath, [bundle, '--wrong'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, KOZOU_DESKTOP_USER_DATA: userData },
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    expect(await exitCodeOf(child)).toBe(1);
    expect(stderr).toMatch(/usage:/);
  }, TIMEOUT);
});
