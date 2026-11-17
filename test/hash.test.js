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

test('forced hash collisions still separate distinct groups via equality fallback', () => {
  const groups = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
  const values = [];
  const keys = [];
  for (let i = 0; i < 200; i++) {
    keys.push(groups[i % groups.length]);
    values.push((i * 7) % 97 - 40);
  }
  const input = batch({
    g: column('string', keys),
    v: column('int32', values),
  });

  const vectorized = new AggregationOperator(PLAN, { forceHashCollisions: true });
  const reference = new ReferenceAggregation(PLAN, { forceHashCollisions: true });
  vectorized.addBatch(input);
  reference.addBatch(input);

  const actual = vectorized.finish();
  const expected = reference.finish();
  assertRowsEqual(actual, expected);
  assert.equal(actual.length, groups.length);
  assert.ok(vectorized.stats.collisions > 0, 'linear-probing collision path must be exercised');
});

test('many distinct groups rehash past the initial table capacity', () => {
  const keys = [];
  const values = [];
  for (let i = 0; i < 500; i++) {
    keys.push(`group-${i}`);
    values.push(i);
  }
  const input = batch({
    g: column('string', keys),
    v: column('int32', values),
  });
  const vectorized = new AggregationOperator(PLAN);
  const reference = new ReferenceAggregation(PLAN);
  vectorized.addBatch(input);
  reference.addBatch(input);
  assertRowsEqual(vectorized.finish(), reference.finish());
  assert.ok(vectorized.table.capacity >= 1024);
  assert.equal(vectorized.table.size, 500);
});

test('same value across batches accumulates into one group', () => {
  const makeBatch = (offset) =>
    batch({
      g: column('string', ['k', 'k']),
      v: column('int32', [offset, offset + 1]),
    });
  const vectorized = new AggregationOperator(PLAN);
  const reference = new ReferenceAggregation(PLAN);
  for (let b = 0; b < 10; b++) {
    vectorized.addBatch(makeBatch(b));
    reference.addBatch(makeBatch(b));
  }
  const actual = vectorized.finish();
  assertRowsEqual(actual, reference.finish());
  assert.equal(actual.length, 1);
  assert.equal(actual[0].aggregates.cnt, 20);
});

test('natural hash collisions on integer keys resolve correctly', () => {
  const keys = Array.from({ length: 64 }, (_, i) => i);
  const input = batch({
    g: column('int32', keys),
    v: column('int32', keys),
  });
  const vectorized = new AggregationOperator(PLAN);
  const reference = new ReferenceAggregation(PLAN);
  vectorized.addBatch(input);
  reference.addBatch(input);
  assertRowsEqual(vectorized.finish(), reference.finish());
});
