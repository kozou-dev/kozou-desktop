// Validation for the row-data IPC surface. Every field the renderer sends
// crosses this before a data worker (let alone a database) sees it — the same
// posture as validateProfileInput: a compromised renderer must not be able to
// hand the worker a shape it does not expect.
//
// This is input *shape* validation only. Which resources and columns exist is
// decided by the worker's resource lookup, which is built from the database
// itself; that is the allowlist, and it is not restated here.

import { DATA_MAX_PAGE_SIZE, type DataListParams } from '../shared/types.js';

/** Cap on the fields in one row payload. Generous next to any hand-edited
 *  row, small enough that a runaway renderer cannot build a giant statement. */
const MAX_VALUE_FIELDS = 512;

/** Cap on the JSON size of one row payload (1 MiB). A row edit is typed by a
 *  human; this only rules out a payload nobody meant to send. */
const MAX_VALUES_BYTES = 1_048_576;

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
  let serialized: string;
  try {
    serialized = JSON.stringify(values);
  } catch {
    throw new Error('row values must be JSON-serializable');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_VALUES_BYTES) {
    throw new Error(`row values must not exceed ${MAX_VALUES_BYTES} bytes of JSON`);
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
    params[key] = value;
  }
  if (p.filters !== undefined) {
    if (!Array.isArray(p.filters)) throw new Error('filters must be an array of [column, expression] pairs');
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
      filters.push([pair[0], pair[1]]);
    }
    if (filters.length > 0) params.filters = filters;
  }
  return Object.keys(params).length > 0 ? params : undefined;
}
