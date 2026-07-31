// Validation tests for the row-data IPC inputs. A compromised renderer is the
// threat model here: every field it can send must be rejected on shape before
// it reaches a worker, and the row payload must not be able to carry a key
// that lands on Object.prototype instead of the row.

import { describe, expect, it } from 'vitest';
import {
  validateListParams,
  validateProfileName,
  validateResourceName,
  validateRowId,
  validateValues,
} from '../src/main/dataInput.js';
import { DATA_MAX_PAGE_SIZE } from '../src/shared/types.js';

describe('row-data input validation', () => {
  it('requires string names and ids', () => {
    expect(validateProfileName('a')).toBe('a');
    expect(() => validateProfileName(42)).toThrow(/profile name/);
    expect(validateResourceName('public.customers')).toBe('public.customers');
    expect(() => validateResourceName('')).toThrow(/resource name/);
    expect(() => validateResourceName(null)).toThrow(/resource name/);
    expect(validateRowId('7')).toBe('7');
    expect(() => validateRowId(7)).toThrow(/row id/);
    expect(() => validateRowId('')).toThrow(/row id/);
  });

  it('accepts a row payload of column values and drops undefined fields', () => {
    expect(validateValues({ name: 'Ada', email: null, note: undefined })).toEqual({
      name: 'Ada',
      email: null,
    });
  });

  it('rejects a payload that is not a plain object, or is empty', () => {
    expect(() => validateValues([{ name: 'Ada' }])).toThrow(/JSON object/);
    expect(() => validateValues('name=Ada')).toThrow(/JSON object/);
    expect(() => validateValues(null)).toThrow(/JSON object/);
    expect(() => validateValues({})).toThrow(/must not be empty/);
    expect(() => validateValues({ only: undefined })).toThrow(/must not be empty/);
  });

  it('rejects prototype-reaching keys', () => {
    // JSON.parse keeps "__proto__" as an own property, which is exactly how a
    // compromised renderer would send it.
    expect(() => validateValues(JSON.parse('{"__proto__": {"admin": true}}'))).toThrow(/__proto__/);
    expect(() => validateValues({ constructor: 'x' })).toThrow(/constructor/);
    expect(() => validateValues({ prototype: 'x' })).toThrow(/prototype/);
  });

  it('caps the payload size', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 513; i++) wide[`c${i}`] = i;
    expect(() => validateValues(wide)).toThrow(/512 fields/);

    expect(() => validateValues({ blob: 'x'.repeat(1_048_577) })).toThrow(/bytes of JSON/);
  });

  it('normalizes list params and rejects out-of-range paging', () => {
    expect(validateListParams(undefined)).toBeUndefined();
    expect(validateListParams({})).toBeUndefined();
    expect(validateListParams({ pageSize: 50, sort: 'id.desc' })).toEqual({
      pageSize: 50,
      sort: 'id.desc',
    });
    expect(validateListParams({ pageSize: DATA_MAX_PAGE_SIZE })).toEqual({
      pageSize: DATA_MAX_PAGE_SIZE,
    });
    expect(() => validateListParams({ pageSize: DATA_MAX_PAGE_SIZE + 1 })).toThrow(/pageSize/);
    expect(() => validateListParams({ pageSize: 0 })).toThrow(/pageSize/);
    expect(() => validateListParams({ pageSize: 1.5 })).toThrow(/pageSize/);
    expect(() => validateListParams({ sort: 3 })).toThrow(/sort/);
    expect(() => validateListParams([])).toThrow(/list params/);
  });

  it('accepts filter pairs and rejects any other shape', () => {
    expect(validateListParams({ filters: [['status', 'eq.placed']] })).toEqual({
      filters: [['status', 'eq.placed']],
    });
    expect(() => validateListParams({ filters: 'status=eq.placed' })).toThrow(/filters/);
    expect(() => validateListParams({ filters: [['status']] })).toThrow(/\[column, expression\]/);
    expect(() => validateListParams({ filters: [[1, 'eq.2']] })).toThrow(/\[column, expression\]/);
    expect(() => validateListParams({ filters: [['', 'eq.2']] })).toThrow(/\[column, expression\]/);
  });
});
