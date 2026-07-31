// What a browse page is allowed to weigh, applied inside the data worker.
//
// A page is up to DATA_MAX_PAGE_SIZE rows and a `text`, `json`/`jsonb` or
// `bytea` column can hold an arbitrarily large value, so an ordinary schema is
// enough to make one page weigh hundreds of megabytes. The renderer's own cell
// trim happens far too late: by then the whole page has crossed worker -> main
// -> renderer and is retained in component state. The cut therefore belongs
// here, before serialization.
//
// Two parts of a page can carry a row value, and both are bounded here:
//
//   1. the cells, cut to DATA_VALUE_BUDGET per value;
//   2. the keyset cursors, which encode the boundary row's ORDER BY values —
//      measured, this is not theoretical: a 2,048-character sorted value
//      produced a 2,799-character cursor while its own cell was cut to 1,024.
//      A cursor over DATA_MAX_CONTROL_CHARS is withheld, which is also the
//      length main refuses on the way back in, so the pane is never handed a
//      hop that cannot be made.
//
// Two things this deliberately does NOT claim:
//
//   1. It does not bound what the worker holds. The driver has already read the
//      page into this process; the budget bounds what leaves it.
//   2. It does not bound the `get` path. A single row is bounded by being one
//      row, and an editor that only ever saw a cut value could write the cut
//      back — so a full value stays reachable there. See DataResult.truncated.
//
// Every cut is reported, never silent: a pane that shows a shortened value as
// if it were the value would be making a claim the app cannot support. And a
// value whose size cannot be established is dropped rather than passed through
// — a bound that assumes "unmeasured means small" is not a bound.

import {
  DATA_MAX_CONTROL_CHARS,
  DATA_VALUE_BUDGET,
  type DataTruncation,
} from '../shared/types.js';

/** What the page-level pass found. Both lists are empty for the common case of
 *  a page that was already within every limit. */
export type PageBounds = {
  cuts: DataTruncation[];
  droppedCursors: ('next' | 'prev')[];
};

/** Thrown out of the measuring replacer below to stop JSON.stringify as soon as
 *  the budget is passed, so measuring a huge value costs about a budget's worth
 *  of work rather than serializing all of it. */
const OVER_BUDGET = Symbol('over budget');

type SizeVerdict = 'within' | 'over' | 'unmeasurable';

/** Approximate the size of a json/array/composite value, with an early exit at
 *  `budget`. The replacer sees every key and value before they are serialized,
 *  which is what makes the exit cheap: a multi-megabyte string leaf is measured
 *  by its length and never copied.
 *
 *  Approximate on purpose, and in the units that matter. Both IPC hops carry
 *  values by structured clone rather than as JSON, so this counts code units and
 *  structural overhead — the cost of a clone — and not JSON escape sequences,
 *  which the wire never pays for.
 *
 *  JSON.stringify is only the walker here, so a value it cannot serialize is not
 *  a value we know anything about: that is 'unmeasurable', not 'within'. */
function measureJson(value: object, budget: number): SizeVerdict {
  let total = 0;
  try {
    JSON.stringify(value, (key: string, v: unknown) => {
      total +=
        key.length +
        3 +
        (typeof v === 'string'
          ? v.length + 2
          : typeof v === 'number' || typeof v === 'boolean'
            ? String(v).length
            : v === null
              ? 4
              : 2);
      if (total > budget) throw OVER_BUDGET;
      return v;
    });
  } catch (err) {
    if (err === OVER_BUDGET) return 'over';
    // A bigint or a cyclic structure lands here: both survive structured clone,
    // both are fatal to this walk. Nothing is known about the size, so the
    // value is not carried — see the header note on why fail-open would void
    // the bound rather than merely weaken it.
    return 'unmeasurable';
  }
  return 'within';
}

/** Bring one cell within budget, in place. Returns how it was cut, or undefined
 *  when the value was already small enough (the common case, and the only one
 *  that costs nothing). */
function boundCell(
  row: Record<string, unknown>,
  column: string,
  budget: number,
): Pick<DataTruncation, 'kind' | 'size'> | undefined {
  const value = row[column];
  if (typeof value === 'string') {
    if (value.length <= budget) return undefined;
    row[column] = value.slice(0, budget);
    return { kind: 'text', size: value.length };
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength <= budget) return undefined;
    // Uint8Array.from copies: Buffer#subarray (and Buffer#slice) would return a
    // view that keeps the whole original allocation reachable.
    row[column] = Uint8Array.from(value.subarray(0, budget));
    return { kind: 'bytes', size: value.byteLength };
  }
  // Dates and every primitive are bounded by their own representation.
  if (typeof value !== 'object' || value === null || value instanceof Date) return undefined;
  const verdict = measureJson(value, budget);
  if (verdict === 'within') return undefined;
  // A cut object is not an object. Replacing it with null (and reporting the
  // cut) is honest; a half-serialized one would not be.
  row[column] = null;
  return verdict === 'over' ? { kind: 'json', size: budget } : { kind: 'unmeasurable' };
}

/** Withhold a cursor longer than the wire allows. Named separately from the
 *  cell pass because the failure it prevents is different: not a page that is
 *  too heavy, but a hop the next request could not make. */
function boundCursors(body: Record<string, unknown>): ('next' | 'prev')[] {
  const dropped: ('next' | 'prev')[] = [];
  for (const [direction, key] of [
    ['next', 'nextCursor'],
    ['prev', 'prevCursor'],
  ] as const) {
    const cursor = body[key];
    if (typeof cursor === 'string' && cursor.length > DATA_MAX_CONTROL_CHARS) {
      body[key] = null;
      dropped.push(direction);
    }
  }
  return dropped;
}

/** Apply the page limits to a list body, mutating it in place — the body was
 *  just built by the handler inside this process and is not shared. Reports what
 *  it did; a body that is not a page with rows yields nothing (that case is the
 *  renderer's error to report, not ours to guess at). */
export function boundListPage(body: unknown, budget: number = DATA_VALUE_BUDGET): PageBounds {
  if (typeof body !== 'object' || body === null) return { cuts: [], droppedCursors: [] };
  const page = body as Record<string, unknown>;
  const rows = page.rows;
  if (!Array.isArray(rows)) return { cuts: [], droppedCursors: [] };
  const cuts: DataTruncation[] = [];
  rows.forEach((row, index) => {
    if (typeof row !== 'object' || row === null) return;
    const record = row as Record<string, unknown>;
    for (const column of Object.keys(record)) {
      const cut = boundCell(record, column, budget);
      if (cut !== undefined) cuts.push({ row: index, column, ...cut });
    }
  });
  return { cuts, droppedCursors: boundCursors(page) };
}
