// Per-aggregate state machines. Same semantics are shared by the columnar
// operator, the row-at-a-time reference executor and the spill merger.

export const AGG_KIND = {
  COUNT: 'count',
  SUM_INT: 'sum_int',
  SUM_FP: 'sum_float',
  MIN: 'min',
  MAX: 'max',
};

function less(a, b) {
  if (a === null) return false;
  if (b === null) return true;
  return a < b;
}

function greater(a, b) {
  if (a === null) return false;
  if (b === null) return true;
  return a > b;
}

export function createState(kind, retractable) {
  switch (kind) {
    case AGG_KIND.COUNT:
      return { kind, count: 0 };
    case AGG_KIND.SUM_INT:
      return { kind, sum: 0n };
    case AGG_KIND.SUM_FP:
      return { kind, sum: 0 };
    case AGG_KIND.MIN:
    case AGG_KIND.MAX:
      return retractable
        ? { kind, retractable: true, freq: new Map(), value: null }
        : { kind, retractable: false, value: null };
    default:
      throw new Error(`unknown aggregate kind: ${kind}`);
  }
}

function recomputeExtremum(state) {
  const pick = state.kind === AGG_KIND.MIN ? less : greater;
  let best = null;
  for (const candidate of state.freq.keys()) {
    if (pick(candidate, best)) best = candidate;
  }
  state.value = best;
}

export function addInput(state, value) {
  switch (state.kind) {
    case AGG_KIND.COUNT:
      state.count += 1;
      return;
    case AGG_KIND.SUM_INT:
      if (value !== null) state.sum += BigInt(value);
      return;
    case AGG_KIND.SUM_FP:
      if (value !== null) state.sum += value;
      return;
    case AGG_KIND.MIN:
    case AGG_KIND.MAX: {
      if (value === null) return;
      if (state.retractable) {
        state.freq.set(value, (state.freq.get(value) ?? 0) + 1);
        recomputeExtremum(state);
      } else {
        const pick = state.kind === AGG_KIND.MIN ? less : greater;
        if (pick(value, state.value)) state.value = value;
      }
      return;
    }
    default:
      throw new Error(`unknown aggregate kind: ${state.kind}`);
  }
}

export function removeInput(state, value) {
  switch (state.kind) {
    case AGG_KIND.COUNT:
      state.count -= 1;
      return;
    case AGG_KIND.SUM_INT:
      if (value !== null) state.sum -= BigInt(value);
      return;
    case AGG_KIND.SUM_FP:
      if (value !== null) state.sum -= value;
      return;
    case AGG_KIND.MIN:
    case AGG_KIND.MAX: {
      if (value === null) return;
      if (!state.retractable) {
        throw new Error('retraction received but aggregate was not built with retractable=true');
      }
      const remaining = (state.freq.get(value) ?? 0) - 1;
      if (remaining <= 0) state.freq.delete(value);
      else state.freq.set(value, remaining);
      recomputeExtremum(state);
      return;
    }
    default:
      throw new Error(`unknown aggregate kind: ${state.kind}`);
  }
}

/**
 * Fold `incoming` into `target`. Used when two spill partitions (or a spill
 * partition and the live table) carry the same group key.
 */
export function mergeState(target, incoming) {
  if (target.kind !== incoming.kind) {
    throw new Error(`cannot merge ${target.kind} with ${incoming.kind}`);
  }
  switch (target.kind) {
    case AGG_KIND.COUNT:
      target.count += incoming.count;
      return;
    case AGG_KIND.SUM_INT:
      target.sum += incoming.sum;
      return;
    case AGG_KIND.SUM_FP:
      target.sum += incoming.sum;
      return;
    case AGG_KIND.MIN:
    case AGG_KIND.MAX: {
      if (target.retractable && incoming.retractable) {
        for (const [value, n] of incoming.freq) {
          target.freq.set(value, (target.freq.get(value) ?? 0) + n);
        }
        recomputeExtremum(target);
      } else if (target.retractable) {
        if (incoming.value !== null) {
          target.freq.set(incoming.value, (target.freq.get(incoming.value) ?? 0) + 1);
          recomputeExtremum(target);
        }
      } else {
        const pick = target.kind === AGG_KIND.MIN ? less : greater;
        if (pick(incoming.value, target.value)) target.value = incoming.value;
      }
      return;
    }
    default:
      throw new Error(`unknown aggregate kind: ${target.kind}`);
  }
}

export function stateResult(state) {
  switch (state.kind) {
    case AGG_KIND.COUNT:
      return state.count;
    case AGG_KIND.SUM_INT:
      return state.sum;
    case AGG_KIND.SUM_FP:
      return state.sum;
    case AGG_KIND.MIN:
    case AGG_KIND.MAX:
      return state.value;
    default:
      throw new Error(`unknown aggregate kind: ${state.kind}`);
  }
}

// ---- spill wire format (plain objects; binary encoding lives in spill.js) ----

export function stateToWire(state) {
  if (state.kind === AGG_KIND.MIN || state.kind === AGG_KIND.MAX) {
    if (state.retractable) {
      return { kind: state.kind, retractable: true, entries: [...state.freq.entries()] };
    }
    return { kind: state.kind, retractable: false, value: state.value };
  }
  return { ...state };
}

export function stateFromWire(wire) {
  if (wire.kind === AGG_KIND.MIN || wire.kind === AGG_KIND.MAX) {
    if (wire.retractable) {
      return {
        kind: wire.kind,
        retractable: true,
        freq: new Map(wire.entries),
        value: null,
      };
    }
    return { kind: wire.kind, retractable: false, value: wire.value };
  }
  return { ...wire };
}

export function rehydrateExtrema(state) {
  if ((state.kind === AGG_KIND.MIN || state.kind === AGG_KIND.MAX) && state.retractable) {
    recomputeExtremum(state);
  }
}
