// Vectorized aggregation operator.
//
// Processing is split into two passes per batch:
//   1. resolve one hash-table slot per selected row (vector of slot indices),
//      creating new groups and flushing spill partitions when over budget;
//   2. update aggregate states through the slot vector with the per-aggregate
//      function pointer hoisted out of the row loop.
// Splitting the passes means a spill flush can never invalidate slot indices
// and no input row is ever applied twice.

import { batchLength, isRetract, resolveNulls, resolveSelection } from './column.js';
import { hashKey, hashRow, rowEqualsKeys } from './hash.js';
import { GroupTable } from './table.js';
import { SpillManager } from './spill.js';
import {
  AGG_KIND,
  addInput,
  createState,
  mergeState,
  rehydrateExtrema,
  removeInput,
  stateResult,
} from './states.js';

const DEFAULT_ENTRY_BYTES = 96;
const COLLISION_HASH = 0xdeadbeefn;

function inferSumKind(data) {
  if (data instanceof Float64Array) return AGG_KIND.SUM_FP;
  return AGG_KIND.SUM_INT; // Int32Array and BigInt64Array widen to BigInt
}

function compareKeyComponent(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === typeof b) return a < b ? -1 : a > b ? 1 : 0;
  return String(typeof a) < String(typeof b) ? -1 : 1;
}

export class AggregationOperator {
  constructor(plan = {}, options = {}) {
    this.plan = plan;
    this.groupKeyNames = plan.groupKeys ?? [];
    this.global = this.groupKeyNames.length === 0;
    this.aggregateSpecs = (plan.aggregates ?? []).map((agg) => ({
      name: agg.name ?? `${agg.func}(${agg.column ?? '*'})`,
      func: agg.func,
      column: agg.column ?? null,
    }));
    this.retractable = options.retractable ?? plan.retractable ?? false;
    this.memoryBudgetBytes = options.memoryBudgetBytes ?? plan.memoryBudgetBytes ?? Infinity;
    this.spillPartitions = options.spillPartitions ?? plan.spillPartitions ?? 4;
    this.spillDirectory = options.spillDirectory ?? plan.spillDirectory;
    this.forceHashCollisions = options.forceHashCollisions ?? plan.forceHashCollisions ?? false;

    this.table = new GroupTable();
    this.spill = null;
    this.globalSlot = -1;
    this.stats = {
      batches: 0,
      rows: 0,
      spillFlushes: 0,
      probes: 0,
      collisions: 0,
    };
    this._ensureGlobalGroup();
  }

  _createAggStates(columns) {
    return this.aggregateSpecs.map((spec) => {
      if (spec.func === 'count') return createState(AGG_KIND.COUNT, this.retractable);
      if (spec.func === 'sum') {
        const kind = columns && columns[spec.column]
          ? inferSumKind(columns[spec.column].data)
          : AGG_KIND.SUM_INT;
        return createState(kind, this.retractable);
      }
      if (spec.func === 'min' || spec.func === 'max') {
        return createState(spec.func === 'min' ? AGG_KIND.MIN : AGG_KIND.MAX, this.retractable);
      }
      throw new Error(`unsupported aggregate function: ${spec.func}`);
    });
  }

  _ensureGlobalGroup() {
    if (!this.global || this.globalSlot >= 0) return;
    const { slot } = this.table.probe(0n, []);
    this.table.insert(slot, 0n, [], null, DEFAULT_ENTRY_BYTES);
    this.globalSlot = slot;
    this.table.netRows[slot] = 0;
  }

  _entryBytes(keys) {
    let bytes = DEFAULT_ENTRY_BYTES + this.aggregateSpecs.length * 48;
    for (const key of keys) {
      if (typeof key === 'string') bytes += key.length * 2 + 16;
      else if (key !== null) bytes += 16;
    }
    return bytes;
  }

  _ensureSpill() {
    if (!this.spill) {
      this.spill = new SpillManager({
        partitions: this.spillPartitions,
        directory: this.spillDirectory,
      });
    }
    return this.spill;
  }

  addBatch(batch) {
    const rowCount = batchLength(batch);
    this.stats.batches += 1;
    if (rowCount === 0) return this;

    const selected = resolveSelection(batch);
    const n = selected.length;
    if (n === 0) return this;
    this.stats.rows += n;

    const keyColumns = this.groupKeyNames.map((name) => batch.columns[name]);
    const keyNulls = keyColumns.map((column) => resolveNulls(column, selected));
    const inputColumns = this.aggregateSpecs.map((spec) =>
      spec.column ? batch.columns[spec.column] : null,
    );
    const inputNulls = inputColumns.map((column, idx) =>
      column ? resolveNulls(column, selected) : new Uint8Array(n),
    );
    const retractFlags = batch.retract instanceof Uint8Array ? batch.retract : null;
    const allRetract = batch.retract === true;

    if (this.global && this.table.states[this.globalSlot] === null) {
      this.table.states[this.globalSlot] = this._createAggStates(batch.columns);
    }
    if (!this.retractable && (allRetract || retractFlags !== null)) {
      throw new Error('retraction row received but operator was not built with retractable=true');
    }

    // Pre-grow so pass 1 never rehashes: every slot index stays valid for pass 2.
    while (this.table.size + n >= (this.table.capacity * 0.7) | 0) {
      this.table.grow();
      if (this.global) this.globalSlot = this.table.find(0n, []);
    }

    const slots = new Uint32Array(n);

    // ---- pass 1: locate / create groups, flushing spill when over budget ----
    let flushedThisBatch = false;
    if (this.global) {
      for (let i = 0; i < n; i++) slots[i] = this.globalSlot;
    } else {
      let i = 0;
      while (i < n) {
        const hash = this.forceHashCollisions
          ? COLLISION_HASH
          : hashRow(keyColumns, selected[i], keyNulls, i);
        const mask = this.table.capacity - 1;
        let slot = Number(hash & BigInt(mask));
        let found = false;
        for (;;) {
          if (!this.table.occupied[slot]) break;
          this.stats.probes += 1;
          if (
            this.table.hashes[slot] === hash &&
            rowEqualsKeys(this.table.keys[slot], keyColumns, selected[i], keyNulls, i)
          ) {
            found = true;
            break;
          }
          this.stats.collisions += 1;
          slot = (slot + 1) & mask;
        }
        if (found) {
          slots[i] = slot;
          i += 1;
          continue;
        }
        const candidateKeys = keyColumns.map((column, k) =>
          keyNulls[k][i] ? null : column.data[selected[i]],
        );
        let restored = null;
        if (this.spill && this.spill.hasSpilled()) {
          restored = this.spill.reloadGroup(hash, candidateKeys);
        }
        const entryBytes = this._entryBytes(candidateKeys);
        if (
          !this.global &&
          restored === null &&
          !flushedThisBatch &&
          Number.isFinite(this.memoryBudgetBytes) &&
          this.table.memoryBytes + entryBytes > this.memoryBudgetBytes
        ) {
          const spillManager = this._ensureSpill();
          spillManager.flushTable(this.table);
          this.stats.spillFlushes += 1;
          this.table.clear();
          flushedThisBatch = true;
          while (this.table.size + n >= (this.table.capacity * 0.7) | 0) {
            this.table.grow();
          }
          // Restart pass 1 from row 0: the cleared table holds no states, so
          // no input update can be lost or double-applied.
          i = 0;
          continue;
        }
        const states = restored ? restored.states : this._createAggStates(batch.columns);
        this.table.insert(slot, hash, candidateKeys, states, entryBytes);
        this.table.netRows[slot] = restored ? restored.netRows : 0;
        slots[i] = slot;
        i += 1;
      }
    }

    // ---- pass 2: vectorized state updates, hoisted per aggregate ----
    for (let i = 0; i < n; i++) {
      this.table.netRows[slots[i]] += isRetract(batch, selected[i]) ? -1 : 1;
    }
    for (let j = 0; j < this.aggregateSpecs.length; j++) {
      const spec = this.aggregateSpecs[j];
      const nullRows = inputNulls[j];
      const data = inputColumns[j] ? inputColumns[j].data : null;
      for (let i = 0; i < n; i++) {
        if (spec.column && nullRows[i]) continue;
        const state = this.table.states[slots[i]][j];
        const retract = allRetract || (retractFlags !== null && retractFlags[selected[i]] === 1);
        if (spec.func === 'count') {
          if (retract) state.count -= 1;
          else state.count += 1;
          continue;
        }
        const value = data[selected[i]];
        if (retract) removeInput(state, value);
        else addInput(state, value);
      }
    }
    return this;
  }

  // Rebuild without groups whose net row count returned to zero.
  _pruneEmptyGroups(source) {
    const rebuilt = new GroupTable();
    while (rebuilt.capacity * 0.7 < source.size) rebuilt.grow();
    for (const entry of source.entries()) {
      if ((source.netRows[entry.slot] ?? 0) === 0) continue;
      const slot = rebuilt.reserve(entry.hash, entry.keys);
      rebuilt.states[slot] = entry.states;
      rebuilt.netRows[slot] = source.netRows[entry.slot];
      rebuilt.memoryBytes += this._entryBytes(entry.keys);
    }
    return rebuilt;
  }

  _emitRows(table) {
    const rows = [];
    for (const entry of table.entries()) {
      if (!this.global && (table.netRows[entry.slot] ?? 0) === 0) continue;
      const states = entry.states ?? this._createAggStates(null);
      const aggregates = {};
      states.forEach((state, j) => {
        rehydrateExtrema(state);
        aggregates[this.aggregateSpecs[j].name] = stateResult(state);
      });
      rows.push({ keys: entry.keys.map((key) => key), aggregates });
    }
    rows.sort((a, b) => {
      const length = Math.max(a.keys.length, b.keys.length);
      for (let k = 0; k < length; k++) {
        const cmp = compareKeyComponent(a.keys[k], b.keys[k]);
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
    return rows;
  }

  finish() {
    let outputTable = this.table;
    if (this.spill && this.spill.hasSpilled()) {
      if (this.table.size > 0) {
        this.spill.flushTable(this.table);
        this.stats.spillFlushes += 1;
      }
      const merged = new GroupTable();
      for (let partition = 0; partition < this.spill.partitions; partition++) {
        for (const entry of this.spill.readPartition(partition)) {
          const hash = hashKey(entry.keys);
          let slot = merged.find(hash, entry.keys);
          if (slot < 0) {
            while (merged.size + 1 >= (merged.capacity * 0.7) | 0) merged.grow();
            slot = merged.reserve(hash, entry.keys);
            merged.states[slot] = entry.states;
            merged.netRows[slot] = entry.netRows;
            merged.memoryBytes += this._entryBytes(entry.keys);
          } else {
            for (let j = 0; j < entry.states.length; j++) {
              mergeState(merged.states[slot][j], entry.states[j]);
            }
            merged.netRows[slot] += entry.netRows;
          }
        }
      }
      outputTable = merged;
      this.spill.cleanup();
    }
    if (!this.global) outputTable = this._pruneEmptyGroups(outputTable);
    return this._emitRows(outputTable);
  }

  get spillFiles() {
    return this.spill ? this.spill.listFiles() : [];
  }
}
