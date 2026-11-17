// Row-at-a-time reference executor. It deliberately processes one row and one
// virtual call at a time; the vectorized operator must return identical rows.

import { batchLength, isRetract, resolveNulls, resolveSelection } from './column.js';
import { hashKey, keyEquals } from './hash.js';
import { AGG_KIND, addInput, createState, removeInput, stateResult } from './states.js';

function inferSumKind(data) {
  return data instanceof Float64Array ? AGG_KIND.SUM_FP : AGG_KIND.SUM_INT;
}

export class ReferenceAggregation {
  constructor(plan = {}, options = {}) {
    this.groupKeyNames = plan.groupKeys ?? [];
    this.global = this.groupKeyNames.length === 0;
    this.aggregateSpecs = (plan.aggregates ?? []).map((agg) => ({
      name: agg.name ?? `${agg.func}(${agg.column ?? '*'})`,
      func: agg.func,
      column: agg.column ?? null,
    }));
    this.retractable = options.retractable ?? plan.retractable ?? false;
    // Entries: { hash, keys, states } keyed by an opaque group id.
    this.groupList = [];
    this.netRows = [];
    if (this.global) {
      this.groupList.push({ hash: 0n, keys: [], states: this._createStates(null) });
      this.netRows.push(0);
    }
  }

  _createStates(batch) {
    return this.aggregateSpecs.map((spec) => {
      const kind =
        spec.func === 'count'
          ? AGG_KIND.COUNT
          : spec.func === 'min'
            ? AGG_KIND.MIN
            : spec.func === 'max'
              ? AGG_KIND.MAX
              : batch && batch.columns[spec.column]
                ? inferSumKind(batch.columns[spec.column].data)
                : AGG_KIND.SUM_INT;
      return createState(kind, this.retractable);
    });
  }

  _findGroup(hash, keys) {
    for (let i = 0; i < this.groupList.length; i++) {
      const group = this.groupList[i];
      if (group.hash === hash && keyEquals(group.keys, keys)) return i;
    }
    return -1;
  }

  addBatch(batch) {
    const rowCount = batchLength(batch);
    if (rowCount === 0) return this;
    const selected = resolveSelection(batch);
    const keyNulls = this.groupKeyNames.map((name) =>
      resolveNulls(batch.columns[name], selected),
    );
    const inputNulls = this.aggregateSpecs.map((spec) =>
      spec.column ? resolveNulls(batch.columns[spec.column], selected) : null,
    );
    if (!this.retractable) {
      for (let i = 0; i < selected.length; i++) {
        if (isRetract(batch, selected[i])) {
          throw new Error('retraction row received but operator was not built with retractable=true');
        }
      }
    }

    for (let i = 0; i < selected.length; i++) {
      const row = selected[i];
      const retract = isRetract(batch, row);
      let index;
      if (this.global) {
        index = 0;
      } else {
        const keys = this.groupKeyNames.map((name, k) =>
          keyNulls[k][i] ? null : batch.columns[name].data[row],
        );
        const hash = hashKey(keys);
        index = this._findGroup(hash, keys);
        if (index < 0) {
          index = this.groupList.length;
          this.groupList.push({ hash, keys, states: this._createStates(batch) });
          this.netRows.push(0);
        }
      }
      this.netRows[index] += retract ? -1 : 1;
      const states = this.groupList[index].states;

      for (let j = 0; j < this.aggregateSpecs.length; j++) {
        const spec = this.aggregateSpecs[j];
        const state = states[j];
        if (spec.func === 'count') {
          if (spec.column && inputNulls[j][i]) continue;
          if (retract) removeInput(state, null);
          else addInput(state, null);
        } else {
          if (inputNulls[j][i]) continue;
          const value = batch.columns[spec.column].data[row];
          if (retract) removeInput(state, value);
          else addInput(state, value);
        }
      }
    }
    return this;
  }

  finish() {
    const rows = [];
    for (let i = 0; i < this.groupList.length; i++) {
      if (!this.global && this.netRows[i] === 0) continue;
      const group = this.groupList[i];
      const aggregates = {};
      group.states.forEach((state, j) => {
        aggregates[this.aggregateSpecs[j].name] = stateResult(state);
      });
      rows.push({ keys: [...group.keys], aggregates });
    }
    rows.sort(compareRows);
    return rows;
  }
}

function compareKeyComponent(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === typeof b) return a < b ? -1 : a > b ? 1 : 0;
  return String(typeof a) < String(typeof b) ? -1 : 1;
}

function compareRows(a, b) {
  for (let k = 0; k < Math.max(a.keys.length, b.keys.length); k++) {
    const cmp = compareKeyComponent(a.keys[k], b.keys[k]);
    if (cmp !== 0) return cmp;
  }
  return 0;
}
