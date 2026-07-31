// The byte budget for a browse page, applied inside the data worker.
//
// A page is up to DATA_MAX_PAGE_SIZE rows and a `text`, `json`/`jsonb` or
// `bytea` column can hold an arbitrarily large value, so an ordinary schema is
// enough to make one page weigh hundreds of megabytes. The renderer's own cell
// trim happens far too late: by then the whole page has crossed worker -> main
// -> renderer and is retained in component state. The cut therefore belongs
// here, before serialization.
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
// if it were the value would be making a claim the app cannot support.

import { DATA_VALUE_BUDGET, type DataTruncation } from '../shared/types.js';

/** Thrown out of the measuring replacer below to stop JSON.stringify as soon as
 *  the budget is passed, so measuring a huge value costs about a budget's worth
 *  of work rather than serializing all of it. */
const OVER_BUDGET = Symbol('over budget');

/** Approximate serialized size of a json/array/composite value, with an early
 *  exit at `budget`. The replacer sees every key and value before they are
 *  serialized, which is what makes the exit cheap: a multi-megabyte string leaf
 *  is measured by its length and never copied.
 *
 *  Approximate on purpose — it accounts for quotes, separators and key names
 *  but not for escape sequences, so a value full of newlines or non-ASCII
 *  characters serializes somewhat larger than measured here. The budget is a
 *  guard against pages that do not fit in memory, not an accounting boundary. */
function overJsonBudget(value: object, budget: number): boolean {
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
    // Only the budget verdict belongs to us. Anything else (a bigint, a cyclic
    // structure — both fine for structured clone, both fatal to JSON) is not a
    // statement about size, so the value passes through untouched rather than
    // being cut on the strength of an unrelated failure.
    return err === OVER_BUDGET;
  }
  return false;
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
  if (!overJsonBudget(value, budget)) return undefined;
  // A cut object is not an object. Replacing it with null (and reporting the
  // cut) is honest; a half-serialized one would not be.
  row[column] = null;
  return { kind: 'json', size: budget };
}

/** Apply the per-value budget to a list body's rows, mutating them in place —
 *  the body was just built by the handler inside this process and is not shared.
 *  Returns the cuts made, empty when the page was already within budget or the
 *  body is not a shape with rows (that case is the renderer's error to report,
 *  not ours to guess at). */
export function boundListRows(body: unknown, budget: number = DATA_VALUE_BUDGET): DataTruncation[] {
  if (typeof body !== 'object' || body === null) return [];
  const rows = (body as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return [];
  const cuts: DataTruncation[] = [];
  rows.forEach((row, index) => {
    if (typeof row !== 'object' || row === null) return;
    const record = row as Record<string, unknown>;
    for (const column of Object.keys(record)) {
      const cut = boundCell(record, column, budget);
      if (cut !== undefined) cuts.push({ row: index, column, ...cut });
    }
  });
  return cuts;
}
