// Writes the bridge locators: one file per RUNNING local MCP server, holding
// nothing but the four facts in shared/mcpLocator.ts.
//
// Lifetime is the point. A locator exists only while its server is confirmed
// listening, so "the file is there" and "the app is serving that profile" are
// the same statement — the bridge never needs a liveness protocol, and a
// stopped app leaves nothing behind that claims otherwise. Every launch
// starts by clearing the directory, which is what makes that true after a
// crash too (the manager's model is already "every launch starts from all
// stopped").
//
// Writes are atomic (temp + rename in the same directory) so a bridge reading
// concurrently sees either the old file or the new one, never half a JSON
// document. Mode 0600 because the capability path is a secret: the point of
// the locator is that the path stays out of other applications' config files,
// which would be undone by leaving it world-readable here.

import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { locatorFileName, parseLocator, serializeLocator } from '../shared/mcpLocator.js';
import { generateLocatorGeneration } from './mcpAllocation.js';

/** The slice the MCP manager depends on — narrow so its unit tests can record
 *  calls instead of touching a filesystem. */
export type McpLocatorWriter = {
  /** Publish a locator; returns the generation written. */
  write(entry: { id: string; port: number; path: string }): string;
  /** Remove a locator, but only if the file on disk is still the one this
   *  generation wrote. */
  remove(id: string, generation: string): void;
  /** Drop every locator (launch-time sweep). */
  clearAll(): void;
};

export class FileMcpLocatorWriter implements McpLocatorWriter {
  constructor(private readonly dir: string) {}

  write(entry: { id: string; port: number; path: string }): string {
    const generation = generateLocatorGeneration();
    const target = this.pathFor(entry.id);
    const tmp = `${target}.tmp`;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, serializeLocator({ v: 1, ...entry, generation }), { mode: 0o600 });
    // writeFileSync's mode applies to a file it CREATES; an existing temp file
    // (an interrupted earlier write) keeps its own mode, so pin it explicitly
    // before the rename publishes it.
    chmodSync(tmp, 0o600);
    renameSync(tmp, target);
    return generation;
  }

  remove(id: string, generation: string): void {
    const target = this.pathFor(id);
    // Read before unlinking: a stop belonging to an older start must not
    // delete the locator a newer start has already published (the two race
    // whenever a profile is stopped and restarted quickly).
    try {
      const current = parseLocator(readFileSync(target, 'utf8'), id);
      if (current.generation !== generation) return;
    } catch {
      // Missing or unreadable: fall through and remove whatever is there. A
      // malformed locator is worse than none — the bridge would fail on it
      // while the file kept claiming a server exists.
    }
    rmSync(target, { force: true });
  }

  clearAll(): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return; // no directory yet — nothing published
    }
    for (const name of names) {
      // Confined to this directory's own files by construction, and only
      // those the writer could have produced.
      if (name.endsWith('.json') || name.endsWith('.json.tmp')) {
        rmSync(join(this.dir, name), { force: true });
      }
    }
  }

  private pathFor(id: string): string {
    return join(this.dir, locatorFileName(id));
  }
}
