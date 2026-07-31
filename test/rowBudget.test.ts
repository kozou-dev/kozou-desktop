// What a browse page is allowed to weigh, applied inside the data worker.
//
// What is pinned here is the promise the browse pane makes: nothing oversized
// crosses the IPC hops — through a cell OR through a page cursor, which carries
// the boundary row's ordering values — a value that was cut is REPORTED rather
// than passed off as the value, and a value whose size cannot be established is
// dropped rather than waved through as "probably small".
//
// The companion integration test drives the same budget through a real
// PostgreSQL page (data.integration.test.ts).

import { describe, expect, it } from 'vitest';
import { boundListPage } from '../src/worker/rowBudget.js';
import {
  DATA_CELL_PREVIEW_CHARS,
  DATA_MAX_CONTROL_CHARS,
  DATA_VALUE_BUDGET,
} from '../src/shared/types.js';

const page = (rows: Record<string, unknown>[]): { rows: Record<string, unknown>[] } => ({ rows });

describe('row page budget', () => {
  it('leaves a page that is already small enough untouched', () => {
    const body = page([{ id: 1, name: 'Ada', tags: ['a', 'b'], joined: new Date(0), ok: true }]);
    expect(boundListPage(body).cuts).toEqual([]);
    expect(body.rows[0]).toEqual({
      id: 1,
      name: 'Ada',
      tags: ['a', 'b'],
      joined: new Date(0),
      ok: true,
    });
  });

  it('cuts an oversized text value to the budget and reports its real length', () => {
    const body = page([{ id: 1, bio: 'x'.repeat(DATA_VALUE_BUDGET + 500) }]);
    const cuts = boundListPage(body).cuts;

    expect(cuts).toEqual([
      { row: 0, column: 'bio', kind: 'text', size: DATA_VALUE_BUDGET + 500 },
    ]);
    expect((body.rows[0]!.bio as string).length).toBe(DATA_VALUE_BUDGET);
  });

  it('keeps a text value of exactly the budget whole', () => {
    const body = page([{ bio: 'x'.repeat(DATA_VALUE_BUDGET) }]);
    expect(boundListPage(body).cuts).toEqual([]);
    expect((body.rows[0]!.bio as string).length).toBe(DATA_VALUE_BUDGET);
  });

  it('cuts an oversized byte array into a copy, not a view onto the original', () => {
    const original = Buffer.alloc(DATA_VALUE_BUDGET * 4, 7);
    const body = page([{ blob: original }]);
    const cuts = boundListPage(body).cuts;

    expect(cuts).toEqual([
      { row: 0, column: 'blob', kind: 'bytes', size: DATA_VALUE_BUDGET * 4 },
    ]);
    const kept = body.rows[0]!.blob as Uint8Array;
    expect(kept.byteLength).toBe(DATA_VALUE_BUDGET);
    // A Buffer#subarray/#slice would hand back a view whose .buffer is the whole
    // original allocation — the bytes would still be reachable, and retained.
    expect(kept.buffer.byteLength).toBe(DATA_VALUE_BUDGET);
  });

  it('drops an oversized json value rather than serializing part of it', () => {
    const body = page([{ doc: { note: 'y'.repeat(DATA_VALUE_BUDGET * 2) } }]);
    const cuts = boundListPage(body).cuts;

    expect(cuts).toEqual([{ row: 0, column: 'doc', kind: 'json', size: DATA_VALUE_BUDGET }]);
    // null, and reported: the renderer must be able to tell this from a NULL the
    // database actually returned.
    expect(body.rows[0]!.doc).toBeNull();
  });

  it('drops a json value made of many small members once they add up', () => {
    const doc: Record<string, string> = {};
    for (let i = 0; i < 200; i += 1) doc[`key_${i}`] = 'value';
    const body = page([{ doc }]);

    expect(boundListPage(body).cuts).toEqual([
      { row: 0, column: 'doc', kind: 'json', size: DATA_VALUE_BUDGET },
    ]);
  });

  it('keeps a json value whose serialized form fits', () => {
    const doc = { note: 'z'.repeat(100), nested: { count: 3, flag: false } };
    const body = page([{ doc }]);
    expect(boundListPage(body).cuts).toEqual([]);
    expect(body.rows[0]!.doc).toEqual(doc);
  });

  it('drops a value it cannot measure, and does not claim it was too large', () => {
    // Both survive structured clone and both are fatal to the measuring walk.
    // Fail closed: a bound that reads "could not measure" as "small enough" is
    // not a bound — a bigint sibling would otherwise carry an unbounded value
    // through untouched. The report says nothing about size, because nothing
    // about the size is known.
    const cyclic: Record<string, unknown> = { name: 'ada' };
    cyclic.self = cyclic;
    const body = page([{ cyclic, big: { count: 10n } }]);

    expect(boundListPage(body).cuts).toEqual([
      { row: 0, column: 'cyclic', kind: 'unmeasurable' },
      { row: 0, column: 'big', kind: 'unmeasurable' },
    ]);
    expect(body.rows[0]!.cyclic).toBeNull();
    expect(body.rows[0]!.big).toBeNull();
  });

  it('does not let a bigint sibling smuggle an oversized value past the budget', () => {
    // The shape the fail-open version let through: the walk hits the bigint and
    // throws before it ever reaches the large string.
    const body = page([{ doc: { count: 1n, note: 'y'.repeat(DATA_VALUE_BUDGET * 100) } }]);
    expect(boundListPage(body).cuts).toEqual([
      { row: 0, column: 'doc', kind: 'unmeasurable' },
    ]);
    expect(body.rows[0]!.doc).toBeNull();
  });

  it('addresses every cut by its row index and column', () => {
    const long = 'x'.repeat(DATA_VALUE_BUDGET + 1);
    const body = page([{ a: 'short', b: long }, { a: long, b: 'short' }, { a: 'short', b: 'short' }]);

    expect(boundListPage(body).cuts).toEqual([
      { row: 0, column: 'b', kind: 'text', size: long.length },
      { row: 1, column: 'a', kind: 'text', size: long.length },
    ]);
  });

  it('reports nothing for a body that is not a page of rows', () => {
    expect(boundListPage(null).cuts).toEqual([]);
    expect(boundListPage('rows').cuts).toEqual([]);
    expect(boundListPage({ rows: 'not an array' }).cuts).toEqual([]);
    expect(boundListPage({ rows: [null, 3] }).cuts).toEqual([]);
  });

  it('leaves a single-row body whole: a get result is not a page', () => {
    // Why the `get` path is protected twice — the runner does not offer it to
    // the budget at all, AND a single row is not a shape this function cuts.
    // Neither half alone is observable, which is worth stating rather than
    // implying that removing the runner-side check would be caught here.
    const long = 'x'.repeat(DATA_VALUE_BUDGET + 1);
    const singleRow: Record<string, unknown> = { id: 1, bio: long };
    expect(boundListPage(singleRow).cuts).toEqual([]);
    expect(singleRow.bio).toBe(long);
  });

  it('never lets the pane promise more text than the wire carries', () => {
    // The browse pane renders DATA_CELL_PREVIEW_CHARS per cell; raising it past
    // the budget would make it advertise characters the worker never sends.
    expect(DATA_CELL_PREVIEW_CHARS).toBeLessThanOrEqual(DATA_VALUE_BUDGET);
  });
});

describe('page cursors', () => {
  // A cursor encodes the boundary row's ORDER BY values, so it is the second way
  // a row value can leave the worker. Measured against a real database: a
  // 2,048-character sorted value produced a 2,799-character cursor while its own
  // cell was cut to 1,024.
  const short = 'c'.repeat(DATA_MAX_CONTROL_CHARS);
  const long = 'c'.repeat(DATA_MAX_CONTROL_CHARS + 1);

  it('hands over cursors that fit', () => {
    const body = { rows: [{ id: 1 }], nextCursor: short, prevCursor: short };
    expect(boundListPage(body).droppedCursors).toEqual([]);
    expect(body.nextCursor).toBe(short);
    expect(body.prevCursor).toBe(short);
  });

  it('withholds a cursor longer than the wire allows, and names the direction', () => {
    const body = { rows: [{ id: 1 }], nextCursor: long, prevCursor: short };
    expect(boundListPage(body).droppedCursors).toEqual(['next']);
    // Cleared, not merely reported: main refuses a control string this long on
    // the way back in, so keeping it would offer a hop that cannot be made.
    expect(body.nextCursor).toBeNull();
    expect(body.prevCursor).toBe(short);
  });

  it('withholds both directions when both are oversized', () => {
    const body = { rows: [{ id: 1 }], nextCursor: long, prevCursor: long };
    expect(boundListPage(body).droppedCursors).toEqual(['next', 'prev']);
    expect(body.nextCursor).toBeNull();
    expect(body.prevCursor).toBeNull();
  });

  it('leaves absent cursors absent', () => {
    const body: Record<string, unknown> = { rows: [{ id: 1 }], nextCursor: null };
    expect(boundListPage(body).droppedCursors).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(body.prevCursor).toBeUndefined();
  });
});
