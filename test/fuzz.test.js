import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AggregationOperator, ReferenceAggregation } from '../src/index.js';
import { assertRowsEqual, batch, column, makeRng, pick } from './helpers.js';

const KEY_DOMAIN = ['red', 'green', 'blue', null];
const NUMERIC_DOMAIN = [-100, -1, 0, 1, 7, 100, null];

function randomBatches(rng, batchCount) {
  const batches = [];
  for (let b = 0; b < batchCount; b++) {
    const size = 1 + Math.floor(rng() * 30);
    const keys = [];
    const values = [];
    const flags = [];
    for (let i = 0; i < size; i++) {
      keys.push(pick(rng, KEY_DOMAIN));
      values.push(pick(rng, NUMERIC_DOMAIN));
      flags.push(rng() < 0.25 ? 1 : 0);
    }
    const columns = {
      g: column('string', keys),
      v: column('int32', values),
    };
    const options = { retract: flags };
    if (rng() < 0.3) options.sel = [...keys.keys()].filter(() => rng() < 0.8);
    batches.push(batch(columns, options));
  }
  return batches;
}

const PLAN = {
  groupKeys: ['g'],
  aggregates: [
    { func: 'count', name: 'cnt' },
    { func: 'count', column: 'v', name: 'cnt_v' },
    { func: 'sum', column: 'v', name: 'sum_v' },
    { func: 'min', column: 'v', name: 'min_v' },
    { func: 'max', column: 'v', name: 'max_v' },
  ],
};

test('differential fuzz: vectorized output equals row reference across scenarios', () => {
  const rng = makeRng(20261117);
  for (let scenario = 0; scenario < 25; scenario++) {
    const batches = randomBatches(rng, 4 + Math.floor(rng() * 6));
    const useSpill = rng() < 0.6;
    const forceCollisions = rng() < 0.3;
    const options = { retractable: true, forceHashCollisions: forceCollisions };
    let directory;
    if (useSpill) {
      directory = mkdtempSync(join(tmpdir(), `fuzz-spill-${scenario}-`));
      options.memoryBudgetBytes = 512 + Math.floor(rng() * 4096);
      options.spillDirectory = directory;
      options.spillPartitions = 4;
    }
    try {
      const vectorized = new AggregationOperator(PLAN, options);
      const reference = new ReferenceAggregation(PLAN, { retractable: true });
      for (const input of batches) {
        vectorized.addBatch(input);
        reference.addBatch(input);
      }
      assertRowsEqual(vectorized.finish(), reference.finish());
    } finally {
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('differential fuzz: global aggregates with retractions', () => {
  const rng = makeRng(424242);
  const plan = {
    aggregates: [
      { func: 'count', name: 'cnt' },
      { func: 'sum', column: 'v', name: 'sum_v' },
      { func: 'min', column: 'v', name: 'min_v' },
      { func: 'max', column: 'v', name: 'max_v' },
    ],
  };
  const batches = randomBatches(rng, 8);
  const vectorized = new AggregationOperator(plan, { retractable: true });
  const reference = new ReferenceAggregation(plan, { retractable: true });
  for (const input of batches) {
    vectorized.addBatch(input);
    reference.addBatch(input);
  }
  assertRowsEqual(vectorized.finish(), reference.finish());
});
