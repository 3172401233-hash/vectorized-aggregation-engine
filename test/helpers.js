// Deterministic builders shared by every test file.

import assert from 'node:assert/strict';

export function packedBitmap(nullRows) {
  const bitmap = new Uint8Array(Math.ceil(nullRows.length / 8));
  nullRows.forEach((isNull, row) => {
    if (!isNull) bitmap[row >>> 3] |= 1 << (row & 7);
  });
  return bitmap;
}

// Build a typed column. `values` may contain null; nulls are encoded both as a
// packed bitmap and as a byte array on demand by callers.
export function column(type, values, { packed = true } = {}) {
  const nullRows = values.map((value) => value === null);
  let data;
  if (type === 'int32') {
    data = Int32Array.from(values.map((value) => value ?? 0));
  } else if (type === 'int64') {
    data = BigInt64Array.from(values.map((value) => BigInt(value ?? 0n)));
  } else if (type === 'float64') {
    data = Float64Array.from(values.map((value) => value ?? 0));
  } else {
    data = values.map((value) => value ?? null);
  }
  const result = { type, data };
  if (nullRows.some(Boolean)) {
    if (packed) result.bitmap = packedBitmap(nullRows);
    else result.nulls = Uint8Array.from(nullRows, (isNull) => (isNull ? 1 : 0));
  }
  return result;
}

export function batch(columns, { sel = null, retract = null, rowCount } = {}) {
  const result = { columns };
  if (sel) result.sel = Uint32Array.from(sel);
  if (retract !== null) {
    result.retract =
      typeof retract === 'boolean' ? retract : Uint8Array.from(retract, (flag) => (flag ? 1 : 0));
  }
  if (rowCount !== undefined) result.rowCount = rowCount;
  return result;
}

// Mulberry32: tiny deterministic PRNG for fuzz tests.
export function makeRng(seed) {
  let state = seed >>> 0;
  return function rng() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick(rng, values) {
  return values[Math.floor(rng() * values.length)];
}

// Normalize BigInt values so node:assert deepEqual comparisons stay readable.
export function normalizeRows(rows) {
  return rows.map((row) => ({
    keys: row.keys.map((key) => (typeof key === 'bigint' ? key.toString() : key)),
    aggregates: Object.fromEntries(
      Object.entries(row.aggregates).map(([name, value]) => [
        name,
        typeof value === 'bigint' ? value.toString() : value,
      ]),
    ),
  }));
}

export function assertRowsEqual(actual, expected) {
  assert.deepStrictEqual(normalizeRows(actual), normalizeRows(expected));
}
