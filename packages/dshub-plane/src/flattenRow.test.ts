import { describe, expect, it } from 'vitest';
import { flattenRow, flattenRows } from './flattenRow.js';

describe('flattenRow', () => {
  it('flattens nested objects with underscore paths', () => {
    expect(flattenRow({ a: { b: 1 }, c: 'x' })).toEqual({ a_b: 1, c: 'x' });
  });

  it('skips arrays (rangrez ingest ignores them)', () => {
    expect(flattenRow({ tags: [1, 2], id: 3 })).toEqual({ id: 3 });
  });

  it('flattens a batch', () => {
    expect(flattenRows([{ id: 1 }, { id: 2 }])).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('writes a prefixed primitive and ignores a bare array/null row', () => {
    expect(flattenRow(null)).toEqual({});
    expect(flattenRow([1, 2])).toEqual({});
    expect(flattenRow('x', 'leaf')).toEqual({ leaf: 'x' });
  });

  it('stops recursing at max depth', () => {
    const row = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
    expect(flattenRow(row)).toHaveProperty('a_b_c_d_e_f');
  });
});
