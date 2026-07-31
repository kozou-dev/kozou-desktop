// Validation for the row-data IPC surface. Every field the renderer sends
// crosses this before a data worker (let alone a database) sees it — the same
// posture as validateProfileInput: a compromised renderer must not be able to
// hand the worker a shape it does not expect.
//
// This is input *shape* validation only. Which resources and columns exist is
// decided by the worker's resource lookup, which is built from the database
// itself; that is the allowlist, and it is not restated here.

import {
  DATA_MAX_CONTROL_CHARS,
  DATA_MAX_PAGE_SIZE,
  type DataListParams,
} from '../shared/types.js';

/** Cap on the fields in one row payload. Generous next to any hand-edited
 *  row, small enough that a runaway renderer cannot build a giant statement. */
const MAX_VALUE_FIELDS = 512;

/** Cap on the approximate size of one row payload (1 MiB). A row edit is typed
 *  by a human; this only rules out a payload nobody meant to send. Measured by
 *  a bounded walk rather than by serializing first — `JSON.stringify` would have
 *  to allocate the whole thing before it could be judged too large, which is the
 *  cost the cap exists to avoid. */
const MAX_VALUES_BYTES = 1_048_576;

/** Nesting depth allowed inside a value (a json/jsonb column). Deep enough for
 *  any realistic document, shallow enough that the walk cannot be turned into a
 *  stack-exhaustion lever. */
const MAX_VALUE_DEPTH = 16;

/** Cap on filters per list request. The grammar allows several per column; this
 *  bounds the whole set so one IPC message cannot make main (and then the
 *  worker) parse an unbounded predicate list. */
const MAX_FILTERS = 64;

/** Cap on a single control string (sort spec, search text, keyset cursor).
 *  Shared with the worker, which refuses to hand OUT a cursor longer than this:
 *  restating it in one process only would let the two drift into a state where
 *  the app offers a hop it then rejects. */
const MAX_CONTROL_CHARS = DATA_MAX_CONTROL_CHARS;

/** Approximate the serialized size of a value, stopping as soon as the budget
 *  is blown so an oversized payload is rejected without ever being measured in
 *  full. Returns the bytes counted, or null when the budget or the depth limit
 *  is exceeded. */
function approximateSize(value: unknown, depth: number, budget: number): number | null {
  if (depth > MAX_VALUE_DEPTH) return null;
  if (value === null || typeof value === 'boolean') return 4;
  if (typeof value === 'number') return 8;
  if (typeof value === 'string') return value.length > budget ? null : value.length + 2;
  if (Array.isArray(value)) {
    let total = 2;
    for (const item of value) {
      const size = approximateSize(item, depth + 1, budget - total);
      if (size === null) return null;
      total += size + 1;
      if (total > budget) return null;
    }
    return total;
  }
  if (typeof value === 'object') {
    let total = 2;
    for (const [key, item] of Object.entries(value)) {
      const size = approximateSize(item, depth + 1, budget - total - key.length);
      if (size === null) return null;
      total += key.length + 3 + size;
      if (total > budget) return null;
    }
    return total;
  }
  // undefined / function / symbol: not JSON, and dropped or rejected above.
  return 0;
}

/** Keys that would reach Object.prototype rather than the row. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function validateProfileName(x: unknown): string {
  if (typeof x !== 'string') throw new Error('profile name must be a string');
  return x;
}

/** A resource is addressed by bare or `schema.name` form — the worker resolves
 *  it against the introspected schema, so only its shape matters here. */
export function validateResourceName(x: unknown): string {
  if (typeof x !== 'string' || x.length === 0) {
    throw new Error('resource name must be a non-empty string');
  }
  return x;
}

/** A row id: the primary-key value, or the components of a composite key
 *  joined the way @kozou/api's item routes expect. Kept as an opaque string —
 *  it is bound as a parameter downstream, never interpolated. */
export function validateRowId(x: unknown): string {
  if (typeof x !== 'string' || x.length === 0) {
    throw new Error('row id must be a non-empty string');
  }
  return x;
}

/** A row payload: a plain object of column values. Undefined-valued keys are
 *  dropped ("not provided"), so a form that clears a field must send null. */
export function validateValues(x: unknown): Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) {
    throw new Error('row values must be a JSON object');
  }
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(x)) {
    if (UNSAFE_KEYS.has(key)) throw new Error(`row values must not contain the key "${key}"`);
    if (value === undefined) continue;
    values[key] = value;
  }
  const fields = Object.keys(values).length;
  if (fields === 0) throw new Error('row values must not be empty');
  if (fields > MAX_VALUE_FIELDS) {
    throw new Error(`row values must not exceed ${MAX_VALUE_FIELDS} fields`);
  }
  if (approximateSize(values, 0, MAX_VALUES_BYTES) === null) {
    throw new Error(
      `row values must not exceed ${MAX_VALUES_BYTES} bytes or ${MAX_VALUE_DEPTH} levels of nesting`,
    );
  }
  return values;
}

/** List controls. Absent (or an empty object) means "the resource's defaults",
 *  which is what a first page asks for. */
export function validateListParams(x: unknown): DataListParams | undefined {
  if (x === undefined || x === null) return undefined;
  if (typeof x !== 'object' || Array.isArray(x)) {
    throw new Error('list params must be an object');
  }
  const p = x as Record<string, unknown>;
  const params: DataListParams = {};
  if (p.pageSize !== undefined) {
    if (
      !Number.isInteger(p.pageSize) ||
      (p.pageSize as number) < 1 ||
      (p.pageSize as number) > DATA_MAX_PAGE_SIZE
    ) {
      throw new Error(`pageSize must be an integer between 1 and ${DATA_MAX_PAGE_SIZE}`);
    }
    params.pageSize = p.pageSize as number;
  }
  for (const key of ['sort', 'after', 'before', 'search'] as const) {
    const value = p[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new Error(`${key} must be a string`);
    if (value.length > MAX_CONTROL_CHARS) {
      throw new Error(`${key} must not exceed ${MAX_CONTROL_CHARS} characters`);
    }
    params[key] = value;
  }
  if (p.filters !== undefined) {
    if (!Array.isArray(p.filters)) throw new Error('filters must be an array of [column, expression] pairs');
    if (p.filters.length > MAX_FILTERS) {
      throw new Error(`filters must not exceed ${MAX_FILTERS} entries`);
    }
    const filters: [string, string][] = [];
    for (const pair of p.filters) {
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        typeof pair[0] !== 'string' ||
        pair[0].length === 0 ||
        typeof pair[1] !== 'string'
      ) {
        throw new Error('each filter must be a [column, expression] pair of strings');
      }
      if (pair[0].length > MAX_CONTROL_CHARS || pair[1].length > MAX_CONTROL_CHARS) {
        throw new Error(`a filter column and expression must not exceed ${MAX_CONTROL_CHARS} characters`);
      }
      filters.push([pair[0], pair[1]]);
    }
    if (filters.length > 0) params.filters = filters;
  }
  return Object.keys(params).length > 0 ? params : undefined;
}
