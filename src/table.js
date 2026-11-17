// Open-addressing hash group table. Slot metadata lives in parallel typed
// arrays; group keys and aggregate states are allocated once per distinct
// group instead of once per input row.

import { keyEquals } from './hash.js';

const MIN_CAPACITY = 16;
const LOAD_FACTOR = 0.7;

export class GroupTable {
  constructor() {
    this.capacity = MIN_CAPACITY;
    this.occupied = new Uint8Array(this.capacity);
    this.hashes = new BigUint64Array(this.capacity);
    this.keys = new Array(this.capacity);
    this.states = new Array(this.capacity);
    this.netRows = new Int32Array(this.capacity);
    this.size = 0;
    this.memoryBytes = 0;
  }

  // Find an existing slot for `hash`, or the empty slot to insert into.
  probe(hash, candidateKeys) {
    const mask = this.capacity - 1;
    let slot = Number(hash & BigInt(mask));
    for (;;) {
      if (!this.occupied[slot]) return { slot, inserted: true };
      if (this.hashes[slot] === hash && keyEquals(this.keys[slot], candidateKeys)) {
        return { slot, inserted: false };
      }
      slot = (slot + 1) & mask;
    }
  }

  insert(slot, hash, keys, states, entryBytes) {
    this.occupied[slot] = 1;
    this.hashes[slot] = hash;
    this.keys[slot] = keys;
    this.states[slot] = states;
    this.size += 1;
    this.memoryBytes += entryBytes;
    if (this.size >= (this.capacity * LOAD_FACTOR) | 0) this.grow();
  }

  grow() {
    const oldCapacity = this.capacity;
    const oldOccupied = this.occupied;
    const oldHashes = this.hashes;
    const oldKeys = this.keys;
    const oldStates = this.states;
    const oldNetRows = this.netRows;

    this.capacity = oldCapacity * 2;
    this.occupied = new Uint8Array(this.capacity);
    this.hashes = new BigUint64Array(this.capacity);
    this.keys = new Array(this.capacity);
    this.states = new Array(this.capacity);
    this.netRows = new Int32Array(this.capacity);

    const mask = this.capacity - 1;
    for (let i = 0; i < oldCapacity; i++) {
      if (!oldOccupied[i]) continue;
      let slot = Number(oldHashes[i] & BigInt(mask));
      while (this.occupied[slot]) slot = (slot + 1) & mask;
      this.occupied[slot] = 1;
      this.hashes[slot] = oldHashes[i];
      this.keys[slot] = oldKeys[i];
      this.states[slot] = oldStates[i];
      this.netRows[slot] = oldNetRows[i];
    }
  }

  // Lookup by hash + key without inserting (used by the spill merger).
  find(hash, candidateKeys) {
    const mask = this.capacity - 1;
    let slot = Number(hash & BigInt(mask));
    for (;;) {
      if (!this.occupied[slot]) return -1;
      if (this.hashes[slot] === hash && keyEquals(this.keys[slot], candidateKeys)) {
        return slot;
      }
      slot = (slot + 1) & mask;
    }
  }

  // Reserve an empty slot for a group restored from a spill file.
  reserve(hash, candidateKeys) {
    const mask = this.capacity - 1;
    let slot = Number(hash & BigInt(mask));
    while (this.occupied[slot]) slot = (slot + 1) & mask;
    this.occupied[slot] = 1;
    this.hashes[slot] = hash;
    this.keys[slot] = candidateKeys;
    this.states[slot] = null;
    this.size += 1;
    if (this.size >= (this.capacity * LOAD_FACTOR) | 0) this.grow();
    return slot;
  }

  *entries() {
    for (let slot = 0; slot < this.capacity; slot++) {
      if (this.occupied[slot]) {
        yield { slot, hash: this.hashes[slot], keys: this.keys[slot], states: this.states[slot] };
      }
    }
  }

  clear() {
    this.capacity = MIN_CAPACITY;
    this.occupied = new Uint8Array(this.capacity);
    this.hashes = new BigUint64Array(this.capacity);
    this.keys = new Array(this.capacity);
    this.states = new Array(this.capacity);
    this.netRows = new Int32Array(this.capacity);
    this.size = 0;
    this.memoryBytes = 0;
  }
}
