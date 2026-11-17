import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AggregationOperator, ReferenceAggregation } from '../src/index.js';
import { assertRowsEqual, batch, column } from './helpers.js';

const PLAN = {
  groupKeys: ['g'],
  aggregates: [
    { func: 'count', name: 'cnt' },
    { func: 'sum', column: 'v', name: 'sum_v' },
    { func: 'min', column: 'v', name: 'min_v' },
    { func: 'max', column: 'v', name: 'max_v' },
  ],
};

function runRetract(batches, plan = PLAN, options = {}) {
  const vectorized = new AggregationOperator(plan, { ...options, retractable: true });
  const reference = new ReferenceAggregation(plan, { ...options, retractable: true });
  for (const input of batches) {
    vectorized.addBatch(input);
    reference.addBatch(input);
  }
  const actual = vectorized.finish();
  const expected = reference.finish();
  assertRowsEqual(actual, expected);
  return actual;
}

test('per-row retraction flags remove previously inserted rows', () => {
  const insert = batch({
    g: column('string', ['a', 'a', 'b', 'b']),
    v: column('int32', [1, 10, 2, 20]),
  });
  const retract = batch(
    {
      g: column('string', ['a', 'b']),
      v: column('int32', [1, 20]),
    },
    { retract: [1, 1] },
  );
  const rows = runRetract([insert, retract]);
  const byKey = Object.fromEntries(rows.map((row) => [row.keys[0], row.aggregates]));
  assert.deepEqual(byKey.a, { cnt: 1, sum_v: 10n, min_v: 10, max_v: 10 });
  assert.deepEqual(byKey.b, { cnt: 1, sum_v: 2n, min_v: 2, max_v: 2 });
});

test('retracting the current MIN/MAX value recomputes from remaining rows', () => {
  const insert = batch({
    g: column('string', ['k', 'k', 'k', 'k']),
    v: column('int32', [1, 2, 9, 10]),
  });
  const retract = batch(
    {
      g: column('string', ['k', 'k']),
      v: column('int32', [1, 10]),
    },
    { retract: [1, 1] },
  );
  const rows = runRetract([insert, retract]);
  assert.deepEqual(rows[0].aggregates, {
    cnt: 2,
    sum_v: 11n,
    min_v: 2,
    max_v: 9,
  });
});

test('fully retracted group disappears from grouped output', () => {
  const insert = batch({
    g: column('string', ['gone', 'keep']),
    v: column('int32', [5, 7]),
  });
  const retract = batch(
    {
      g: column('string', ['gone']),
      v: column('int32', [5]),
    },
    { retract: [1] },
  );
  const rows = runRetract([insert, retract]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].keys[0], 'keep');
});

test('global aggregation retains zero-count groups after full retraction', () => {
  const plan = {
    aggregates: [
      { func: 'count', name: 'cnt' },
      { func: 'sum', column: 'v', name: 'sum_v' },
      { func: 'min', column: 'v', name: 'min_v' },
      { func: 'max', column: 'v', name: 'max_v' },
    ],
  };
  const insert = batch({ v: column('int32', [1, 2, 3]) });
  const retract = batch({ v: column('int32', [1, 2, 3]) }, { retract: true });
  const rows = runRetract([insert, retract], plan);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].aggregates, { cnt: 0, sum_v: 0n, min_v: null, max_v: null });
});

test('retraction and reinsertion of duplicate extremum values stays correct', () => {
  const insert = batch({
    g: column('string', ['k', 'k', 'k']),
    v: column('int32', [5, 5, 8]),
  });
  const retractOne = batch(
    {
      g: column('string', ['k']),
      v: column('int32', [5]),
    },
    { retract: [1] },
  );
  const rows = runRetract([insert, retractOne]);
  assert.deepEqual(rows[0].aggregates, {
    cnt: 2,
    sum_v: 13n,
    min_v: 5,
    max_v: 8,
  });
});

test('non-retractable operator rejects retract rows explicitly', () => {
  const operator = new AggregationOperator(PLAN);
  const bad = batch(
    {
      g: column('string', ['k']),
      v: column('int32', [1]),
    },
    { retract: [1] },
  );
  assert.throws(() => operator.addBatch(bad), /retractable/);
});
