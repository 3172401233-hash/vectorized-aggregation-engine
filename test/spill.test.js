import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AggregationOperator,
  ReferenceAggregation,
  decodeEntry,
  encodeEntry,
} from '../src/index.js';
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

function tempDir() {
  const directory = mkdtempSync(join(tmpdir(), 'spill-test-'));
  after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('spill flush and re-merge matches the non-spilling reference', () => {
  const directory = tempDir();
  const batches = [];
  for (let b = 0; b < 6; b++) {
    const keys = [];
    const values = [];
    for (let i = 0; i < 50; i++) {
      keys.push(`group-${(b * 17 + i) % 40}`);
      values.push((b * 31 + i * 3) % 100);
    }
    batches.push(batch({ g: column('string', keys), v: column('int32', values) }));
  }

  const vectorized = new AggregationOperator(PLAN, {
    memoryBudgetBytes: 2048,
    spillPartitions: 4,
    spillDirectory: directory,
  });
  const reference = new ReferenceAggregation(PLAN);
  for (const input of batches) {
    vectorized.addBatch(input);
    reference.addBatch(input);
  }
  const actual = vectorized.finish();
  assertRowsEqual(actual, reference.finish());
  assert.ok(vectorized.stats.spillFlushes >= 1);
});

test('groups repeated across spill flushes are merged, not duplicated', () => {
  const directory = tempDir();
  const operator = new AggregationOperator(
    {
      groupKeys: ['g'],
      aggregates: [
        { func: 'count', name: 'cnt' },
        { func: 'sum', column: 'v', name: 'sum_v' },
      ],
    },
    { memoryBudgetBytes: 1, spillPartitions: 4, spillDirectory: directory },
  );
  for (let b = 0; b < 4; b++) {
    operator.addBatch(
      batch({
        g: column('string', ['same', 'same', 'other']),
        v: column('int32', [b, b + 1, b + 10]),
      }),
    );
  }
  const rows = operator.finish();
  const byKey = Object.fromEntries(rows.map((row) => [row.keys[0], row.aggregates]));
  assert.equal(rows.length, 2);
  assert.equal(byKey.same.cnt, 8);
  assert.equal(byKey.same.sum_v, 16n);
  assert.equal(byKey.other.cnt, 4);
});

test('spill round-trip preserves BigInt sums, nulls and string keys', () => {
  const entry = {
    keys: ['alpha', null, 9007199254740993n],
    states: [
      { kind: 'count', count: 7 },
      { kind: 'sum_int', sum: 18014398509481986n },
      { kind: 'sum_float', sum: 1.5 },
      { kind: 'min', retractable: false, value: null },
      { kind: 'max', retractable: false, value: 'x' },
    ],
    netRows: 7,
  };
  const decoded = decodeEntry(encodeEntry(entry));
  assert.deepEqual(decoded.keys, entry.keys);
  assert.equal(decoded.netRows, 7);
  assert.equal(decoded.states[1].sum, 18014398509481986n);
  assert.equal(decoded.states[3].value, null);
  assert.equal(decoded.states[4].value, 'x');
});

test('retractable MIN/MAX frequency maps survive a spill cycle', () => {
  const directory = tempDir();
  const plan = {
    groupKeys: ['g'],
    aggregates: [
      { func: 'min', column: 'v', name: 'min_v' },
      { func: 'max', column: 'v', name: 'max_v' },
    ],
  };
  const operator = new AggregationOperator(plan, {
    retractable: true,
    memoryBudgetBytes: 256,
    spillDirectory: directory,
  });
  const reference = new ReferenceAggregation(plan, { retractable: true });
  const inputs = [
    batch(
      {
        g: column('string', ['a', 'a', 'a', 'c', 'd', 'e', 'f']),
        v: column('int32', [1, 2, 9, 3, 4, 5, 6]),
      },
    ),
    batch(
      {
        g: column('string', ['a', 'b', 'b', 'c', 'd', 'e', 'f']),
        v: column('int32', [1, 5, 6, 8, 7, 2, 1]),
      },
    ),
    batch(
      { g: column('string', ['a', 'b', 'c']), v: column('int32', [9, 5, 3]) },
      { retract: [1, 1, 1] },
    ),
  ];
  for (const input of inputs) {
    operator.addBatch(input);
    reference.addBatch(input);
  }
  assertRowsEqual(operator.finish(), reference.finish());
  assert.ok(operator.stats.spillFlushes >= 1);
});

test('spill files are removed after finish()', () => {
  const directory = tempDir();
  const operator = new AggregationOperator(PLAN, {
    memoryBudgetBytes: 256,
    spillDirectory: directory,
  });
  operator.addBatch(
    batch({
      g: column('string', ['a', 'b', 'c']),
      v: column('int32', [1, 2, 3]),
    }),
  );
  operator.finish();
  assert.throws(() => readFileSync(join(directory, 'partition-0.spill')));
});

test('no spill occurs when the budget is never exceeded', () => {
  const operator = new AggregationOperator(PLAN, { memoryBudgetBytes: 10_000_000 });
  operator.addBatch(
    batch({
      g: column('string', ['a', 'b']),
      v: column('int32', [1, 2]),
    }),
  );
  assert.equal(operator.stats.spillFlushes, 0);
  assert.deepEqual(operator.spillFiles, []);
  assert.equal(operator.finish().length, 2);
});
