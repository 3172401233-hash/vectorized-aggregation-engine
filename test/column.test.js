import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchLength, resolveNulls, resolveSelection } from '../src/column.js';
import { batch, column, packedBitmap } from './helpers.js';

test('selection vector defaults to every row', () => {
  const input = batch({ a: column('int32', [1, 2, 3]) });
  assert.deepEqual([...resolveSelection(input)], [0, 1, 2]);
});

test('explicit selection vector filters rows without copying columns', () => {
  const input = batch({ a: column('int32', [10, 20, 30, 40]) }, { sel: [3, 1] });
  const selected = resolveSelection(input);
  assert.ok(selected instanceof Uint32Array);
  assert.deepEqual([...selected], [3, 1]);
  assert.deepEqual([...selected].map((row) => input.columns.a.data[row]), [40, 20]);
});

test('packed bitmap and byte null array decode identically', () => {
  const values = [1, null, 3, null, 5, null, 7, 8, null];
  const packed = column('int32', values, { packed: true });
  const byteForm = column('int32', values, { packed: false });
  const selected = Uint32Array.from(values, (_, i) => i);
  assert.deepEqual([...resolveNulls(packed, selected)], [0, 1, 0, 1, 0, 1, 0, 0, 1]);
  assert.deepEqual(resolveNulls(packed, selected), resolveNulls(byteForm, selected));
});

test('null bitmap aligns with selection vector positions', () => {
  const packed = {
    data: Int32Array.from([7, 8, 9]),
    bitmap: packedBitmap([false, true, false]),
  };
  const selected = Uint32Array.from([2, 0, 1]);
  assert.deepEqual([...resolveNulls(packed, selected)], [0, 0, 1]);
});

test('column without null info treats all rows as present', () => {
  const plain = { data: Int32Array.from([1, 2]) };
  const selected = Uint32Array.of(0, 1);
  assert.deepEqual([...resolveNulls(plain, selected)], [0, 0]);
});

test('empty and zero-length batches are handled', () => {
  const empty = batch({ a: column('int32', []) });
  assert.equal(batchLength(empty), 0);
  assert.equal(resolveSelection(empty).length, 0);

  const selectedEmpty = batch({ a: column('int32', [1, 2, 3]) }, { sel: [] });
  assert.equal(resolveSelection(selectedEmpty).length, 0);
});
