// Deterministic hashing and strict key equality for group keys.

export const TYPE_TAGS = {
  null: 0,
  boolean: 1,
  int32: 2,
  int64: 3,
  float64: 4,
  string: 5,
};

export function typeTagOf(value) {
  if (value === null) return TYPE_TAGS.null;
  const t = typeof value;
  if (t === 'bigint') return TYPE_TAGS.int64;
  if (t === 'string') return TYPE_TAGS.string;
  if (t === 'boolean') return TYPE_TAGS.boolean;
  if (Number.isInteger(value)) return TYPE_TAGS.int32;
  return TYPE_TAGS.float64;
}

// 64-bit-ish mixing via BigInt (deterministic across runs, avoids String keys).
const MIX = 0x9e3779b97f4a7c15n;

export function mix64(hash) {
  let h = BigInt.asUintN(64, hash);
  h = BigInt.asUintN(64, (h ^ (h >> 30n)) * MIX);
  h = BigInt.asUintN(64, (h ^ (h >> 27n)) * MIX);
  return BigInt.asUintN(64, h ^ (h >> 31n));
}

function hashValue(value) {
  const tag = typeTagOf(value);
  if (tag === TYPE_TAGS.null) return mix64(0n);
  if (tag === TYPE_TAGS.int64) return mix64(BigInt.asUintN(64, BigInt(value)));
  if (tag === TYPE_TAGS.boolean) return mix64(value ? 1n : 2n);
  if (tag === TYPE_TAGS.int32) return mix64(BigInt(value >>> 0));
  if (tag === TYPE_TAGS.float64) return mix64(BigInt(value === 0 ? 0 : Math.round(value * 1e6)));
  // FNV-1a for strings.
  let h = 0xcbf29ce484222325n;
  const str = value;
  for (let i = 0; i < str.length; i++) {
    h = BigInt.asUintN(64, h ^ BigInt(str.charCodeAt(i)));
    h = BigInt.asUintN(64, h * 0x100000001b3n);
  }
  return mix64(h);
}

/**
 * Hash a composite group key. A different type carrying an equal-looking
 * value (1 vs 1n vs "1") produces a different hash and never groups together.
 */
export function hashKey(keys) {
  let h = 0x12345678n;
  for (let i = 0; i < keys.length; i++) {
    h = BigInt.asUintN(64, h ^ (hashValue(keys[i]) + BigInt(i + 1) * MIX));
    h = mix64(h);
  }
  return mix64(h);
}

// Same hash as hashKey but computed directly from columnar rows, no key array
// allocation until a brand-new group is inserted.
// `row` is the physical row; `nullIndex` is the selection-vector position the
// precomputed null arrays are aligned with.
export function hashRow(columns, row, nullRows, nullIndex) {
  let h = 0x12345678n;
  for (let k = 0; k < columns.length; k++) {
    const value = nullRows[k][nullIndex] ? null : columns[k].data[row];
    h = BigInt.asUintN(64, h ^ (hashValue(value) + BigInt(k + 1) * MIX));
    h = mix64(h);
  }
  return mix64(h);
}

function valueEquals(a, b) {
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'number') return Number.isNaN(a) ? Number.isNaN(b) : a === b;
  return a === b;
}

/**
 * Strict equality used on hash collisions ("grouping fallback"): compares both
 * type tag and value for every key component.
 */
export function keyEquals(storedKeys, candidateKeys) {
  if (storedKeys.length !== candidateKeys.length) return false;
  for (let i = 0; i < storedKeys.length; i++) {
    if (!valueEquals(storedKeys[i], candidateKeys[i])) return false;
  }
  return true;
}

/**
 * Compare stored composite keys against a row still resident in columnar
 * storage. Avoids allocating a candidate key array on every probe; the array
 * is materialised only when the group is new.
 */
export function rowEqualsKeys(storedKeys, keyColumns, row, nullRows, nullIndex) {
  if (storedKeys.length !== keyColumns.length) return false;
  for (let k = 0; k < keyColumns.length; k++) {
    const candidate = nullRows[k][nullIndex] ? null : keyColumns[k].data[row];
    if (!valueEquals(storedKeys[k], candidate)) return false;
  }
  return true;
}
