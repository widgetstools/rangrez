/**
 * Table registry — cache keys, refcounting, lifecycle, admission.
 *
 * Architecture §6. The registry is what makes "one stop shop" true rather than
 * aspirational: two blotters asking for the same data share one upstream
 * subscription and one table.
 */

/**
 * Canonical params hash. Property order must not produce a different cache key,
 * or {book:'CMBS',ccy:'USD'} and {ccy:'USD',book:'CMBS'} become two upstream
 * subscriptions for identical data.
 */
export function canonicalParams(params = {}) {
  const keys = Object.keys(params).sort();
  return JSON.stringify(keys.map((k) => [k, params[k]]));
}

export const cacheKey = (datasourceId, params) => `${datasourceId}#${canonicalParams(params)}`;

/**
 * Does a superset table serve this request?
 *
 * `sharing.supersetParams` names the wildcard: with `{book:'*'}` a table holding
 * every book serves a subscriber wanting one, via a filtered view. Params NOT
 * listed as wildcards must match exactly — otherwise a subscriber silently gets
 * a table built for a different slice.
 */
export function supersetServes(entryParams, wanted) {
  // Compare over the UNION of both key sets. A param the entry wildcards is
  // free; every other param must match exactly, in both directions.
  //
  // Only comparing the requested keys let a transport param the superset never
  // mentioned (clientId, rate) read as a mismatch, so nothing ever shared.
  // Only comparing the entry's keys would let a subscriber silently receive a
  // table built for a different slice.
  const keys = new Set([...Object.keys(entryParams ?? {}), ...Object.keys(wanted ?? {})]);
  for (const k of keys) {
    if (entryParams?.[k] === '*') continue;
    if (entryParams?.[k] !== wanted?.[k]) return false;
  }
  return true;
}

export class MemoryBudgetExceeded extends Error {
  constructor(needed, remaining) {
    super(`table needs ~${needed} bytes; ${remaining} remain under the process ceiling`);
    this.code = 'memory-ceiling-exceeded';
    this.needed = needed;
    this.remaining = remaining;
  }
}

export class RowLimitExceeded extends Error {
  constructor(rows, limit) {
    super(`datasource estimates ${rows} rows; lifecycle.maxRows is ${limit}`);
    this.code = 'row-limit-exceeded';
  }
}

export class Registry {
  /**
   * @param {object} o
   * @param {number} o.processCeilingBytes  Ceiling for the WHOLE host, not one
   *   table. Chrome commits ~3.76 GB and Memory64 buys nothing extra in the
   *   browser (phase-0-findings.md §1a); tables cost ~30-42 bytes/cell (§8), so
   *   this guard is load-bearing rather than theoretical.
   * @param {(rows:number, cols:number)=>number} [o.estimateBytes]
   * @param {(fn:Function, ms:number)=>any} [o.setTimer] injectable for tests
   */
  constructor({
    // Chrome commits ~3.76 GB (phase-0-findings.md §1a) and the engine, grid
    // and page all draw on it. 2.5 GB leaves working room without pretending
    // the ceiling is larger than it is.
    processCeilingBytes = 2_500_000_000,
    // MEASURED, not guessed. Perspective 5.3 in Chrome 152 costs ~30-42 bytes
    // per cell for a mixed FI column set (see phase-0-findings.md §8) — the
    // original `* 6` was ~7x optimistic, which made the process ceiling fire
    // far too late to protect anything. 32 is the conservative middle of the
    // measured range; re-derive per datasource once real artifacts exist.
    estimateBytes = (rows, cols) => rows * cols * 32,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (t) => clearTimeout(t),
  } = {}) {
    this.processCeilingBytes = processCeilingBytes;
    this.estimateBytes = estimateBytes;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.entries = new Map();
  }

  get usedBytes() {
    let total = 0;
    for (const e of this.entries.values()) total += e.estimatedBytes;
    return total;
  }

  get remainingBytes() {
    return Math.max(0, this.processCeilingBytes - this.usedBytes);
  }

  /** Find an existing entry serving this request, exact or via a superset. */
  find(datasourceId, params) {
    const exact = this.entries.get(cacheKey(datasourceId, params));
    if (exact) return exact;
    for (const e of this.entries.values()) {
      if (e.datasourceId !== datasourceId) continue;
      if (e.supersetParams && supersetServes(e.supersetParams, params)) return e;
    }
    return null;
  }

  /**
   * Acquire a table, creating it if no existing entry serves the request.
   *
   * Admission happens BEFORE creation: a subscription that cannot fit is
   * refused with a typed error rather than discovered halfway through its
   * snapshot, when the memory is already spent (architecture §6.2).
   */
  acquire(datasource, params, create) {
    const existing = this.find(datasource.id, params);
    if (existing) {
      existing.refs += 1;
      if (existing.teardownTimer) {
        this.clearTimer(existing.teardownTimer);
        existing.teardownTimer = null;
      }
      return existing;
    }

    const estimatedRows = datasource.estimatedRows ?? 0;
    const maxRows = datasource.lifecycle?.maxRows;
    if (maxRows !== undefined && estimatedRows > maxRows) {
      throw new RowLimitExceeded(estimatedRows, maxRows);
    }

    const bytes = this.estimateBytes(estimatedRows, datasource.columnCount ?? 1);
    if (bytes > this.remainingBytes) {
      throw new MemoryBudgetExceeded(bytes, this.remainingBytes);
    }

    // A superset entry keeps the requester's params and wildcards only the
    // shared dimensions. Replacing params wholesale would drop the transport
    // params the upstream trigger needs.
    const superset =
      datasource.sharing?.strategy === 'superset' ? datasource.sharing.supersetParams : null;
    const effective = superset ? { ...params, ...superset } : params;

    const entry = {
      key: cacheKey(datasource.id, effective),
      datasourceId: datasource.id,
      params: effective,
      supersetParams: superset ? effective : null,
      refs: 1,
      estimatedBytes: bytes,
      prewarm: datasource.lifecycle?.prewarm === true,
      idleTeardownMs: datasource.lifecycle?.idleTeardownMs ?? 300_000,
      teardownTimer: null,
      table: create ? create(superset ?? params) : null,
    };
    this.entries.set(entry.key, entry);
    return entry;
  }

  /**
   * Release a reference. The last departure arms the idle teardown timer rather
   * than tearing down immediately — a trader closing and reopening a blotter
   * should not re-snapshot. Prewarmed tables are never torn down.
   */
  release(datasourceId, params, onTeardown = () => {}) {
    const entry = this.find(datasourceId, params);
    if (!entry) return null;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0 || entry.prewarm) return entry;

    entry.teardownTimer = this.setTimer(() => {
      this.entries.delete(entry.key);
      entry.teardownTimer = null;
      onTeardown(entry);
    }, entry.idleTeardownMs);
    return entry;
  }

  /** Least-recently-idle first — the eviction order if the ceiling is breached. */
  evictionCandidates() {
    return [...this.entries.values()].filter((e) => e.refs === 0 && !e.prewarm);
  }

  stats() {
    return {
      tables: this.entries.size,
      subscribers: [...this.entries.values()].reduce((a, e) => a + e.refs, 0),
      usedBytes: this.usedBytes,
      ceilingBytes: this.processCeilingBytes,
    };
  }
}
