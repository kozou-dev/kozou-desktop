// The per-value budget a browse page is cut to inside the data worker.
//
// What is pinned here is the promise the browse pane makes: nothing oversized
// crosses the IPC hops, a value that was cut is REPORTED rather than passed off
// as the value, and a failure to measure is never mistaken for a size verdict.
//
// The companion integration test drives the same budget through a real
// PostgreSQL page (data.integration.test.ts).

import { describe, expect, it } from 'vitest';
import { boundListRows } from '../src/worker/rowBudget.js';
import { DATA_CELL_PREVIEW_CHARS, DATA_VALUE_BUDGET } from '../src/shared/types.js';

const page = (rows: Record<string, unknown>[]): { rows: Record<string, unknown>[] } => ({ rows });

describe('row page budget', () => {
  it('leaves a page that is already small enough untouched', () => {
    const body = page([{ id: 1, name: 'Ada', tags: ['a', 'b'], joined: new Date(0), ok: true }]);
    expect(boundListRows(body)).toEqual([]);
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
    const cuts = boundListRows(body);

    expect(cuts).toEqual([
      { row: 0, column: 'bio', kind: 'text', size: DATA_VALUE_BUDGET + 500 },
    ]);
    expect((body.rows[0]!.bio as string).length).toBe(DATA_VALUE_BUDGET);
  });

  it('keeps a text value of exactly the budget whole', () => {
    const body = page([{ bio: 'x'.repeat(DATA_VALUE_BUDGET) }]);
    expect(boundListRows(body)).toEqual([]);
    expect((body.rows[0]!.bio as string).length).toBe(DATA_VALUE_BUDGET);
  });

  it('cuts an oversized byte array into a copy, not a view onto the original', () => {
    const original = Buffer.alloc(DATA_VALUE_BUDGET * 4, 7);
    const body = page([{ blob: original }]);
    const cuts = boundListRows(body);

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
    const cuts = boundListRows(body);

    expect(cuts).toEqual([{ row: 0, column: 'doc', kind: 'json', size: DATA_VALUE_BUDGET }]);
    // null, and reported: the renderer must be able to tell this from a NULL the
    // database actually returned.
    expect(body.rows[0]!.doc).toBeNull();
  });

  it('drops a json value made of many small members once they add up', () => {
    const doc: Record<string, string> = {};
    for (let i = 0; i < 200; i += 1) doc[`key_${i}`] = 'value';
    const body = page([{ doc }]);

    expect(boundListRows(body)).toEqual([
      { row: 0, column: 'doc', kind: 'json', size: DATA_VALUE_BUDGET },
    ]);
  });

  it('keeps a json value whose serialized form fits', () => {
    const doc = { note: 'z'.repeat(100), nested: { count: 3, flag: false } };
    const body = page([{ doc }]);
    expect(boundListRows(body)).toEqual([]);
    expect(body.rows[0]!.doc).toEqual(doc);
  });

  it('leaves a value it cannot measure alone instead of reading a throw as "too large"', () => {
    // Both survive structured clone and both are fatal to JSON.stringify. A
    // failure to measure is not a statement about size, so neither is cut.
    const cyclic: Record<string, unknown> = { name: 'ada' };
    cyclic.self = cyclic;
    const big = { count: 10n };
    const body = page([{ cyclic, big }]);

    expect(boundListRows(body)).toEqual([]);
    expect(body.rows[0]!.cyclic).toBe(cyclic);
    expect(body.rows[0]!.big).toBe(big);
  });

  it('addresses every cut by its row index and column', () => {
    const long = 'x'.repeat(DATA_VALUE_BUDGET + 1);
    const body = page([{ a: 'short', b: long }, { a: long, b: 'short' }, { a: 'short', b: 'short' }]);

    expect(boundListRows(body)).toEqual([
      { row: 0, column: 'b', kind: 'text', size: long.length },
      { row: 1, column: 'a', kind: 'text', size: long.length },
    ]);
  });

  it('reports nothing for a body that is not a page of rows', () => {
    expect(boundListRows(null)).toEqual([]);
    expect(boundListRows('rows')).toEqual([]);
    expect(boundListRows({ rows: 'not an array' })).toEqual([]);
    expect(boundListRows({ rows: [null, 3] })).toEqual([]);
  });

  it('leaves a single-row body whole: a get result is not a page', () => {
    // Why the `get` path is protected twice — the runner does not offer it to
    // the budget at all, AND a single row is not a shape this function cuts.
    // Neither half alone is observable, which is worth stating rather than
    // implying that removing the runner-side check would be caught here.
    const long = 'x'.repeat(DATA_VALUE_BUDGET + 1);
    const singleRow: Record<string, unknown> = { id: 1, bio: long };
    expect(boundListRows(singleRow)).toEqual([]);
    expect(singleRow.bio).toBe(long);
  });

  it('never lets the pane promise more text than the wire carries', () => {
    // The browse pane renders DATA_CELL_PREVIEW_CHARS per cell; raising it past
    // the budget would make it advertise characters the worker never sends.
    expect(DATA_CELL_PREVIEW_CHARS).toBeLessThanOrEqual(DATA_VALUE_BUDGET);
  });
});
