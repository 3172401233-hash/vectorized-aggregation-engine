import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AggregationOperator, ReferenceAggregation } from '../src/index.js';
import { assertRowsEqual, batch, column } from './helpers.js';

const COUNT_SUM_PLAN = {
  groupKeys: ['g'],
  aggregates: [
    { func: 'count', name: 'cnt' },
    { func: 'count', column: 'v', name: 'cnt_v' },
    { func: 'sum', column: 'v', name: 'sum_v' },
    { func: 'min', column: 'v', name: 'min_v' },
    { func: 'max', column: 'v', name: 'max_v' },
  ],
};

function runBoth(plan, batches, options = {}) {
  const vectorized = new AggregationOperator(plan, options);
  const reference = new ReferenceAggregation(plan, options);
  for (const input of batches) {
    vectorized.addBatch(input);
    reference.addBatch(input);
  }
  return {
    vectorized: vectorized.finish(),
    reference: reference.finish(),
    operator: vectorized,
  };
}

test('empty input and empty batches produce no grouped rows', () => {
  const result = runBoth(COUNT_SUM_PLAN, [batch({ g: column('string', []), v: column('int32', []) })]);
  assertRowsEqual(result.vectorized, result.reference);
  assert.deepEqual(result.vectorized, []);
  assert.deepEqual(result.reference, []);
});

test('global aggregation still emits a row for empty input', () => {
  const plan = { aggregates: [{ func: 'count', name: 'rows' }] };
  const result = runBoth(plan, []);
  assertRowsEqual(result.vectorized, result.reference);
  assert.equal(result.vectorized[0].aggregates.rows, 0);
});

test('NULL values skip COUNT/SUM/MIN/MAX inputs but keep the group', () => {
  const input = batch({
    g: column('string', ['a', 'a', 'b', 'b']),
    v: column('int32', [1, null, null, null]),
  });
  const result = runBoth(COUNT_SUM_PLAN, [input]);
  assertRowsEqual(result.vectorized, result.reference);
  const rows = Object.fromEntries(result.vectorized.map((row) => [row.keys[0], row.aggregates]));
  assert.deepEqual(rows.a, { cnt: 2, cnt_v: 1, sum_v: 1n, min_v: 1, max_v: 1 });
  assert.deepEqual(rows.b, { cnt: 2, cnt_v: 0, sum_v: 0n, min_v: null, max_v: null });
});

test('all-NULL group keys form one group', () => {
  const input = batch({
    g: column('string', [null, null, null]),
    v: column('int32', [5, 6, null]),
  });
  const plan = {
    groupKeys: ['g'],
    aggregates: [
      { func: 'count', name: 'cnt' },
      { func: 'sum', column: 'v', name: 'sum_v' },
      { func: 'min', column: 'v', name: 'min_v' },
      { func: 'max', column: 'v', name: 'max_v' },
    ],
  };
  const result = runBoth(plan, [input]);
  assertRowsEqual(result.vectorized, result.reference);
  assert.equal(result.vectorized.length, 1);
  assert.equal(result.vectorized[0].keys[0], null);
  assert.deepEqual(result.vectorized[0].aggregates, {
    cnt: 3,
    sum_v: 11n,
    min_v: 5,
    max_v: 6,
  });
});

test('integer SUM widens to BigInt and survives int32 overflow', () => {
  const big = 2_000_000_000;
  const input = batch({
    g: column('string', ['x', 'x']),
    v: column('int32', [big, big]),
  });
  const plan = {
    groupKeys: ['g'],
    aggregates: [{ func: 'sum', column: 'v', name: 'sum_v' }],
  };
  const result = runBoth(plan, [input]);
  assertRowsEqual(result.vectorized, result.reference);
  assert.equal(result.vectorized[0].aggregates.sum_v, 4_000_000_000n);
  assert.ok(typeof result.vectorized[0].aggregates.sum_v === 'bigint');
});

test('Int64 SUM is exact across 64-bit boundaries', () => {
  const input = batch({
    g: column('string', ['x', 'x', 'x']),
    v: column('int64', [9007199254740993n, 9007199254740993n, -1n]),
  });
  const plan = {
    groupKeys: ['g'],
    aggregates: [{ func: 'sum', column: 'v', name: 'sum_v' }],
  };
  const result = runBoth(plan, [input]);
  assertRowsEqual(result.vectorized, result.reference);
  assert.equal(result.vectorized[0].aggregates.sum_v, 18014398509481985n);
});

test('Float64 SUM stays Number and matches the reference', () => {
  const input = batch({
    g: column('string', ['x', 'x']),
    v: column('float64', [0.1, 0.2]),
  });
  const plan = {
    groupKeys: ['g'],
    aggregates: [{ func: 'sum', column: 'v', name: 'sum_v' }],
  };
  const result = runBoth(plan, [input]);
  assertRowsEqual(result.vectorized, result.reference);
  assert.equal(result.vectorized[0].aggregates.sum_v, 0.30000000000000004);
});

test('MIN/MAX ignore NULLs and track typed values across batches', () => {
  const first = batch({
    g: column('string', ['a', 'a', 'b']),
    v: column('int32', [3, null, 10]),
  });
  const second = batch({
    g: column('string', ['a', 'b', 'b']),
    v: column('int32', [-5, 4, null]),
  });
  const plan = {
    groupKeys: ['g'],
    aggregates: [
      { func: 'min', column: 'v', name: 'min_v' },
      { func: 'max', column: 'v', name: 'max_v' },
    ],
  };
  const result = runBoth(plan, [first, second]);
  assertRowsEqual(result.vectorized, result.reference);
  const rows = Object.fromEntries(result.vectorized.map((row) => [row.keys[0], row.aggregates]));
  assert.deepEqual(rows.a, { min_v: -5, max_v: 3 });
  assert.deepEqual(rows.b, { min_v: 4, max_v: 10 });
});

test('strict key typing keeps 1, 1n and "1" in separate groups', () => {
  const input = batch({
    g: { type: 'mixed', data: [1, 1n, '1', 1] },
    v: column('int32', [1, 2, 3, 4]),
  });
  const plan = {
    groupKeys: ['g'],
    aggregates: [{ func: 'sum', column: 'v', name: 'sum_v' }],
  };
  const result = runBoth(plan, [input]);
  assertRowsEqual(result.vectorized, result.reference);
  assert.equal(result.vectorized.length, 3);
});

test('selection vector restricts the aggregated rows', () => {
  const input = batch(
    {
      g: column('string', ['a', 'b', 'a', 'b']),
      v: column('int32', [1, 2, 3, 4]),
    },
    { sel: [0, 2, 3] },
  );
  const plan = {
    groupKeys: ['g'],
    aggregates: [
      { func: 'count', name: 'cnt' },
      { func: 'sum', column: 'v', name: 'sum_v' },
    ],
  };
  const result = runBoth(plan, [input]);
  assertRowsEqual(result.vectorized, result.reference);
  const rows = Object.fromEntries(result.vectorized.map((row) => [row.keys[0], row.aggregates]));
  assert.deepEqual(rows.a, { cnt: 2, sum_v: 4n });
  assert.deepEqual(rows.b, { cnt: 1, sum_v: 4n });
});

test('composite group keys and nulls order deterministically', () => {
  const input = batch({
    g1: column('string', ['x', 'x', 'x', 'y']),
    g2: column('int32', [1, null, 1, 1]),
    v: column('int32', [1, 2, 3, 4]),
  });
  const plan = {
    groupKeys: ['g1', 'g2'],
    aggregates: [{ func: 'count', name: 'cnt' }],
  };
  const result = runBoth(plan, [input]);
  assertRowsEqual(result.vectorized, result.reference);
  assert.deepEqual(result.vectorized.map((row) => row.keys), [
    ['x', null],
    ['x', 1],
    ['y', 1],
  ]);
});
