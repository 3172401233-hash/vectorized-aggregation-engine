// Columnar batch primitives: null bitmap decoding and selection-vector iteration.

/**
 * Resolve the null flag of every row referenced by the selection vector.
 *
 * A column may declare nulls in three equivalent ways:
 *   - packed little-endian bitmap: { bitmap: Uint8Array|Uint32Array }
 *   - byte array:                { nulls: Uint8Array(0|1 per row) }
 *   - no null information:       every row is non-null
 *
 * Returns a Uint8Array aligned with `selected` so callers get an O(1)
 * null lookup without branching on representation inside hot loops.
 */
export function resolveNulls(column, selected) {
  const out = new Uint8Array(selected.length);
  if (column == null) return out;
  const { bitmap, nulls } = column;
  if (nulls !== undefined) {
    for (let i = 0; i < selected.length; i++) out[i] = nulls[selected[i]] ? 1 : 0;
    return out;
  }
  if (bitmap === undefined || bitmap === null) return out;
  if (bitmap instanceof Uint32Array) {
    for (let i = 0; i < selected.length; i++) {
      const row = selected[i];
      out[i] = (bitmap[row >>> 5] >>> (row & 31)) & 1 ? 0 : 1;
    }
    return out;
  }
  // Uint8Array packed bitmap, one bit per row, little-endian within each byte.
  for (let i = 0; i < selected.length; i++) {
    const row = selected[i];
    out[i] = (bitmap[row >>> 3] >>> (row & 7)) & 1 ? 0 : 1;
  }
  return out;
}

/**
 * Expand a batch's optional selection vector into an explicit row index list.
 * A missing selection vector means every row participates.
 */
export function resolveSelection(batch) {
  const length = batchLength(batch);
  if (batch.sel === undefined || batch.sel === null) {
    const all = new Uint32Array(length);
    for (let i = 0; i < length; i++) all[i] = i;
    return all;
  }
  return batch.sel;
}

export function batchLength(batch) {
  if (batch.rowCount !== undefined) return batch.rowCount;
  const first = batch.columns && Object.values(batch.columns)[0];
  return first ? first.data.length : 0;
}

export function isRetract(batch, row) {
  const { retract } = batch;
  if (retract === undefined || retract === null) return false;
  if (retract instanceof Uint8Array) return retract[row] === 1;
  return Boolean(retract);
}

/**
 * Read a typed value from a column. Returns null for null rows.
 * Int64 columns hold BigInt values; Int32 and Float64 hold Numbers.
 */
export function readValue(column, row, isNull) {
  if (isNull) return null;
  return column.data[row];
}
