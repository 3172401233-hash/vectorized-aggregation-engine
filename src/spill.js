// Spill partition files.
//
// Frame layout (all integers little-endian):
//   u8  frameVersion
//   i32 netRows
//   u32 keyCount
//   repeated key:        u8 typeTag, payload (see writeValue)
//   u32 stateCount
//   repeated state frame:
//     u8 stateKindTag | (retractable ? 0x80 : 0)
//     payload per kind (see writeState / readState)
//
// Partition routing is derived from the group hash so every row of one group
// always lands in the same file and merge never has to cross partitions.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AGG_KIND, mergeState, rehydrateExtrema, stateFromWire, stateToWire } from './states.js';
import { keyEquals } from './hash.js';

const FRAME_VERSION = 1;

const KIND_TAGS = {
  [AGG_KIND.COUNT]: 1,
  [AGG_KIND.SUM_INT]: 2,
  [AGG_KIND.SUM_FP]: 3,
  [AGG_KIND.MIN]: 4,
  [AGG_KIND.MAX]: 5,
};
const TAG_KINDS = Object.fromEntries(Object.entries(KIND_TAGS).map(([k, v]) => [v, k]));

// Value type tags match src/hash.js TYPE_TAGS.
const TAG_NULL = 0;
const TAG_BOOLEAN = 1;
const TAG_INT32 = 2;
const TAG_INT64 = 3;
const TAG_FLOAT64 = 4;
const TAG_STRING = 5;

class Writer {
  constructor() {
    this.chunks = [];
    this.total = 0;
  }
  u8(value) {
    const b = Buffer.alloc(1);
    b.writeUInt8(value);
    this.push(b);
  }
  u32(value) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value >>> 0);
    this.push(b);
  }
  i32(value) {
    const b = Buffer.alloc(4);
    b.writeInt32LE(value | 0);
    this.push(b);
  }
  f64(value) {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(value);
    this.push(b);
  }
  bigint(value) {
    const signed = BigInt.asIntN(64, BigInt(value));
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(signed);
    this.push(b);
  }
  string(value) {
    const b = Buffer.from(value, 'utf8');
    this.u32(b.length);
    this.push(b);
  }
  push(buffer) {
    this.chunks.push(buffer);
    this.total += buffer.length;
  }
  buffer() {
    return Buffer.concat(this.chunks, this.total);
  }
}

class Reader {
  constructor(buffer) {
    this.buf = buffer;
    this.offset = 0;
  }
  u8() {
    const value = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }
  u32() {
    const value = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }
  i32() {
    const value = this.buf.readInt32LE(this.offset);
    this.offset += 4;
    return value;
  }
  f64() {
    const value = this.buf.readDoubleLE(this.offset);
    this.offset += 8;
    return value;
  }
  i64() {
    const value = this.buf.readBigInt64LE(this.offset);
    this.offset += 8;
    return value;
  }
  string() {
    const length = this.u32();
    const value = this.buf.toString('utf8', this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
}

function writeValue(writer, value) {
  if (value === null) {
    writer.u8(TAG_NULL);
    return;
  }
  const t = typeof value;
  if (t === 'boolean') {
    writer.u8(TAG_BOOLEAN);
    writer.u8(value ? 1 : 0);
  } else if (t === 'bigint') {
    writer.u8(TAG_INT64);
    writer.bigint(value);
  } else if (t === 'string') {
    writer.u8(TAG_STRING);
    writer.string(value);
  } else if (Number.isInteger(value)) {
    writer.u8(TAG_INT32);
    writer.i32(value);
  } else {
    writer.u8(TAG_FLOAT64);
    writer.f64(value);
  }
}

function readValue(reader) {
  const tag = reader.u8();
  switch (tag) {
    case TAG_NULL:
      return null;
    case TAG_BOOLEAN:
      return reader.u8() === 1;
    case TAG_INT32:
      return reader.i32();
    case TAG_INT64:
      return reader.i64();
    case TAG_FLOAT64:
      return reader.f64();
    case TAG_STRING:
      return reader.string();
    default:
      throw new Error(`unknown spill value tag ${tag}`);
  }
}

function writeState(writer, state) {
  const wire = stateToWire(state);
  let tag = KIND_TAGS[wire.kind];
  if (wire.retractable) tag |= 0x80;
  writer.u8(tag);
  switch (wire.kind) {
    case AGG_KIND.COUNT:
      writer.u32(wire.count);
      return;
    case AGG_KIND.SUM_INT:
      writer.bigint(wire.sum);
      return;
    case AGG_KIND.SUM_FP:
      writer.f64(wire.sum);
      return;
    case AGG_KIND.MIN:
    case AGG_KIND.MAX:
      if (wire.retractable) {
        writer.u32(wire.entries.length);
        for (const [value, n] of wire.entries) {
          writeValue(writer, value);
          writer.u32(n);
        }
      } else {
        writeValue(writer, wire.value);
      }
      return;
    default:
      throw new Error(`unknown state kind ${wire.kind}`);
  }
}

function readState(reader) {
  const rawTag = reader.u8();
  const retractable = (rawTag & 0x80) !== 0;
  const kind = TAG_KINDS[rawTag & 0x7f];
  switch (kind) {
    case AGG_KIND.COUNT:
      return stateFromWire({ kind, count: reader.u32() });
    case AGG_KIND.SUM_INT:
      return stateFromWire({ kind, sum: reader.i64() });
    case AGG_KIND.SUM_FP:
      return stateFromWire({ kind, sum: reader.f64() });
    case AGG_KIND.MIN:
    case AGG_KIND.MAX: {
      if (retractable) {
        const entryCount = reader.u32();
        const entries = [];
        for (let i = 0; i < entryCount; i++) {
          entries.push([readValue(reader), reader.u32()]);
        }
        const state = stateFromWire({ kind, retractable: true, entries });
        rehydrateExtrema(state);
        return state;
      }
      return stateFromWire({ kind, retractable: false, value: readValue(reader) });
    }
    default:
      throw new Error(`unknown state kind tag ${rawTag}`);
  }
}

export function encodeEntry({ keys, states, netRows }) {
  const writer = new Writer();
  writer.u8(FRAME_VERSION);
  writer.i32(netRows);
  writer.u32(keys.length);
  for (const key of keys) writeValue(writer, key);
  writer.u32(states.length);
  for (const state of states) writeState(writer, state);
  return writer.buffer();
}

export function decodeEntry(buffer) {
  const reader = new Reader(buffer);
  const version = reader.u8();
  if (version !== FRAME_VERSION) {
    throw new Error(`unsupported spill frame version ${version}`);
  }
  const netRows = reader.i32();
  const keyCount = reader.u32();
  const keys = new Array(keyCount);
  for (let i = 0; i < keyCount; i++) keys[i] = readValue(reader);
  const stateCount = reader.u32();
  const states = new Array(stateCount);
  for (let i = 0; i < stateCount; i++) states[i] = readState(reader);
  return { keys, states, netRows };
}

export class SpillManager {
  constructor({ partitions = 4, directory } = {}) {
    this.partitions = Math.max(1, partitions);
    this.directory =
      directory ??
      join(tmpdir(), `vectorized-agg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(this.directory, { recursive: true });
    this.flushCount = 0;
    this.framesPerPartition = Array.from({ length: this.partitions }, () => []);
  }

  partitionFor(hash) {
    return Number(hash & BigInt(this.partitions - 1));
  }

  // Merge a full live hash table into the partition files. Entries sharing a
  // key with an earlier flush are combined through mergeState, so a group that
  // was spilled, recreated and retracted still ends in one correct state.
  flushTable(table) {
    const mergeByKey = (entries) => {
      const byKey = new Map();
      for (const entry of entries) {
        const id = JSON.stringify(entry.keys, (_, value) =>
          typeof value === 'bigint' ? `__b${value.toString()}` : value,
        );
        const existing = byKey.get(id);
        if (!existing) {
          byKey.set(id, entry);
          continue;
        }
        existing.netRows += entry.netRows;
        for (let j = 0; j < existing.states.length; j++) {
          mergeState(existing.states[j], entry.states[j]);
        }
      }
      return [...byKey.values()];
    };

    const pending = Array.from({ length: this.partitions }, () => []);
    for (const entry of table.entries()) {
      pending[this.partitionFor(entry.hash)].push(
        encodeEntry({ ...entry, netRows: table.netRows[entry.slot] }),
      );
    }
    for (let p = 0; p < this.partitions; p++) {
      if (pending[p].length === 0) continue;
      const file = join(this.directory, `partition-${p}.spill`);
      const entries = [...this.readPartition(p), ...pending[p].map(decodeEntry)];
      const merged = mergeByKey(entries);
      const body = Buffer.concat(merged.flatMap((entry) => {
        const frame = encodeEntry(entry);
        const lengthPrefix = Buffer.alloc(4);
        lengthPrefix.writeUInt32LE(frame.length);
        return [lengthPrefix, frame];
      }));
      this.framesPerPartition[p] = [merged.length];
      const header = Buffer.alloc(4);
      header.writeUInt32LE(merged.length);
      writeFileSync(file, Buffer.concat([header, body]));
    }
    this.flushCount += 1;
  }

  *readPartition(partition) {
    const file = join(this.directory, `partition-${partition}.spill`);
    let buffer;
    try {
      buffer = readFileSync(file);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    let offset = 0;
    const frameCount = buffer.readUInt32LE(offset);
    offset += 4;
    for (let i = 0; i < frameCount; i++) {
      const length = buffer.readUInt32LE(offset);
      offset += 4;
      yield decodeEntry(buffer.subarray(offset, offset + length));
      offset += length;
    }
  }

  hasSpilled() {
    return this.flushCount > 0;
  }

  // Pull one group back out of its partition file so a late retraction can be
  // applied against its full history. Returns null when the key was never
  // spilled. The partition file is rewritten without the removed entry.
  reloadGroup(hash, keys) {
    if (this.flushCount === 0) return null;
    const partition = this.partitionFor(hash);
    const file = join(this.directory, `partition-${partition}.spill`);
    let buffer;
    try {
      buffer = readFileSync(file);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const remaining = [];
    let removed = null;
    let offset = 0;
    const frameCount = buffer.readUInt32LE(offset);
    offset += 4;
    for (let i = 0; i < frameCount; i++) {
      const length = buffer.readUInt32LE(offset);
      offset += 4;
      const entry = decodeEntry(buffer.subarray(offset, offset + length));
      offset += length;
      if (!removed && keyEquals(entry.keys, keys)) removed = entry;
      else remaining.push(entry);
    }
    if (!removed) return null;
    const header = Buffer.alloc(4);
    header.writeUInt32LE(remaining.length);
    const body = Buffer.concat(remaining.flatMap((entry) => {
      const frame = encodeEntry(entry);
      const lengthPrefix = Buffer.alloc(4);
      lengthPrefix.writeUInt32LE(frame.length);
      return [lengthPrefix, frame];
    }));
    writeFileSync(file, Buffer.concat([header, body]));
    this.framesPerPartition[partition] = [remaining.length];
    return removed;
  }

  cleanup() {
    rmSync(this.directory, { recursive: true, force: true });
  }

  listFiles() {
    try {
      return readdirSync(this.directory);
    } catch {
      return [];
    }
  }
}
