/**
 * Offline schema inference — sample raw messages, emit a REVIEWABLE artifact.
 *
 * Architecture §4.1. Every rule here exists because the opposite choice fails
 * silently and permanently in production:
 *
 *   - narrowing float->int truncates every subsequent value, forever
 *   - a numeric-looking string that becomes a number loses leading zeros
 *     (CUSIP, SEDOL, ISIN, account numbers) or precision
 *   - an all-null first batch typed as anything but string is a guess
 *
 * Output is a CANDIDATE. It carries `needsReview` for every call that was not
 * clear-cut, and `reviewedBy` is absent until a human sets it. Nothing here is
 * ever auto-applied in production.
 */

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Beyond this we stop tracking exact distinct values and report a lower bound. */
const CARDINALITY_CAP = 20_000;
/** Keep a few real values so a reviewer can sanity-check the inferred type. */
const SAMPLE_CAP = 10;

const ISO_8601 = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const BOOLEAN_TOKENS = new Set(['y', 'n', 'true', 'false', '0', '1', 'yes', 'no']);
/** A string that is all digits, or has a leading zero, or is long enough to lose precision. */
const NUMERIC_LOOKING = /^-?\d+(\.\d+)?$/;

class LeafStats {
  constructor(path) {
    this.path = path;
    this.count = 0;
    this.nullCount = 0;
    this.types = new Set();
    this.min = undefined;
    this.max = undefined;
    this.maxStringLength = 0;
    this.maxDecimals = 0;
    this.distinct = new Set();
    this.distinctOverflowed = false;
    this.samples = [];
    this.sawNonIntegerNumber = false;
    this.sawLeadingZero = false;
    this.isoLikeCount = 0;
  }

  observe(value) {
    this.count += 1;
    if (value === null) { this.nullCount += 1; this.types.add('null'); return; }

    const t = typeof value;
    this.types.add(t);

    if (t === 'number') {
      if (!Number.isInteger(value)) this.sawNonIntegerNumber = true;
      this.min = this.min === undefined ? value : Math.min(this.min, value);
      this.max = this.max === undefined ? value : Math.max(this.max, value);
      const dot = String(value).indexOf('.');
      if (dot >= 0) this.maxDecimals = Math.max(this.maxDecimals, String(value).length - dot - 1);
    } else if (t === 'string') {
      this.maxStringLength = Math.max(this.maxStringLength, value.length);
      if (/^0\d/.test(value)) this.sawLeadingZero = true;
      if (ISO_8601.test(value)) this.isoLikeCount += 1;
    }

    if (!this.distinctOverflowed) {
      this.distinct.add(value);
      if (this.distinct.size > CARDINALITY_CAP) {
        this.distinctOverflowed = true;
        this.distinct.clear();
      }
    }
    if (this.samples.length < SAMPLE_CAP) this.samples.push(value);
  }

  get nonNullCount() { return this.count - this.nullCount; }
  get cardinality() { return this.distinctOverflowed ? CARDINALITY_CAP : this.distinct.size; }
}

export function createSampler({ separator = '_', minNonNullPerLeaf = 20 } = {}) {
  if (separator === '.') throw new Error('separator "." is not permitted (architecture §5.2)');
  const leaves = new Map();
  let messages = 0;

  function walk(node, prefix, path, depth) {
    if (depth > 12) return;
    for (const [key, value] of Object.entries(node)) {
      const column = prefix ? `${prefix}${separator}${key}` : key;
      const rawPath = path ? `${path}.${key}` : key;

      if (Array.isArray(value)) {
        // Arrays are a config decision (index-pin / aggregate / explode), not an
        // inference one. Record that the path is an array and move on.
        const stats = leaves.get(rawPath) ?? new LeafStats(rawPath);
        stats.types.add('array');
        stats.count += 1;
        stats.column = column;
        leaves.set(rawPath, stats);
        continue;
      }
      if (isPlainObject(value)) { walk(value, column, rawPath, depth + 1); continue; }

      let stats = leaves.get(rawPath);
      if (!stats) { stats = new LeafStats(rawPath); stats.column = column; leaves.set(rawPath, stats); }
      stats.observe(value);
    }
  }

  return {
    observe(raw) { messages += 1; walk(raw, '', '', 1); },

    /**
     * Sampling completes when every leaf has been seen non-null M times — not
     * after N messages. A rarely-populated field needs the same evidence as a
     * common one, and message count alone gives none.
     */
    progress() {
      const all = [...leaves.values()];
      const satisfied = all.filter((s) => s.nonNullCount >= minNonNullPerLeaf);
      return {
        messages,
        leaves: all.length,
        satisfied: satisfied.length,
        complete: all.length > 0 && satisfied.length === all.length,
        starved: all.filter((s) => s.nonNullCount < minNonNullPerLeaf).map((s) => s.path),
      };
    },

    infer(meta = {}) { return infer(leaves, messages, { separator, minNonNullPerLeaf, ...meta }); },
  };
}

/**
 * Decide a Perspective type from observations.
 * @returns {{type:string, needsReview?:string}}
 */
export function inferType(stats, { minNonNullPerLeaf }) {
  const types = new Set(stats.types);
  types.delete('null');

  if (types.has('array')) return { type: 'string', needsReview: 'array path — configure an array strategy in flatten.arrays' };

  // An all-null column is not evidence of anything. Default to string, the only
  // type that cannot silently corrupt a later value.
  if (types.size === 0 || stats.nonNullCount === 0) {
    return { type: 'string', needsReview: 'never observed non-null — defaulted to string' };
  }

  if (stats.nonNullCount < minNonNullPerLeaf) {
    // First-batch inference is banned in production (§4.1). Emit the best guess
    // but force a human to look at it.
    const guess = guessFrom(types, stats);
    return { ...guess, needsReview: `only ${stats.nonNullCount} non-null observations (want ${minNonNullPerLeaf})` };
  }

  return guessFrom(types, stats);
}

function guessFrom(types, stats) {
  // Mixed number and string: the string wins. Coercing the strings to numbers
  // is a lossy guess; keeping numbers as strings is not.
  if (types.has('string') && types.has('number')) {
    return { type: 'string', needsReview: 'mixed string and number observed — kept as string' };
  }

  if (types.has('boolean')) return { type: 'boolean' };

  if (types.has('number')) {
    // WIDEN, NEVER NARROW. A float column whose sample happened to hold whole
    // numbers becomes an integer and truncates silently forever.
    if (stats.sawNonIntegerNumber) return { type: 'float' };
    return {
      type: 'integer',
      needsReview: 'every observed value was a whole number — confirm this is not a float that happened to sample whole',
    };
  }

  if (types.has('string')) {
    const values = [...stats.distinct].map((v) => String(v).toLowerCase());

    // Boolean only when the observed value set is EXACTLY a boolean set.
    if (values.length > 0 && values.length <= 2 && values.every((v) => BOOLEAN_TOKENS.has(v))) {
      return { type: 'boolean', needsReview: `observed only ${values.join('/')} — confirm this is a flag, not a truncated sample` };
    }

    // ISO-8601 -> datetime needs a high parse rate AND human confirmation.
    const isoRate = stats.isoLikeCount / stats.nonNullCount;
    if (isoRate >= 0.99) {
      return { type: 'datetime', needsReview: `${(isoRate * 100).toFixed(1)}% ISO-8601 — confirm before applying, and check timezone handling` };
    }
    if (isoRate > 0.5) {
      return { type: 'string', needsReview: `${(isoRate * 100).toFixed(1)}% ISO-8601 but below the threshold — kept as string` };
    }

    // Numeric-looking strings STAY STRINGS. Leading zeros and float precision
    // loss are how identifiers turn into support tickets.
    const numericLooking = [...stats.distinct].filter((v) => NUMERIC_LOOKING.test(String(v)));
    if (stats.distinct.size > 0 && numericLooking.length === stats.distinct.size) {
      const why = stats.sawLeadingZero
        ? 'leading zeros observed — must stay a string'
        : 'numeric-looking string kept as string; type it explicitly if it is really a number';
      return { type: 'string', needsReview: why };
    }

    return { type: 'string' };
  }

  return { type: 'string', needsReview: `unhandled observed types: ${[...types].join(', ')}` };
}

/**
 * A column whose distinct count tracks the sample size is an identifier, and
 * the sample tells you NOTHING about its real cardinality.
 *
 * Observed cardinality can never exceed the number of messages sampled. Sample
 * 200 messages of a 500k-row book and `positionId` reports cardinality 200 —
 * which would earn it a set filter and then ship half a million values to the
 * browser in production. Near-uniqueness is the signal that the sample is
 * censored, not that the column is small.
 */
export const UNIQUENESS_RATIO = 0.9;

export function looksUnbounded(stats) {
  if (stats.distinctOverflowed) return true;
  if (stats.nonNullCount < 20) return false; // too little evidence either way
  return stats.cardinality / stats.nonNullCount >= UNIQUENESS_RATIO;
}

/** Cardinality drives the filter strategy (architecture §4.3, parity study §1.4). */
export function filterStrategyFor(type, stats) {
  if (type === 'boolean') return 'set';
  if (type === 'datetime' || type === 'date') return 'date';
  if (type === 'integer' || type === 'float') return 'number';

  if (stats.distinctOverflowed || stats.cardinality > 10_000) return 'search-select';
  // Near-unique in the sample: assume unbounded until a bigger sample says
  // otherwise. Wrong in the safe direction — a search-select on a genuinely
  // small column is mildly annoying; a set filter on 500k values is unusable.
  if (looksUnbounded(stats)) return 'search-select';
  return 'set';
}

function inferOne(stats, opts) {
  const { type, needsReview } = inferType(stats, opts);
  const filter = filterStrategyFor(type, stats);

  const column = {
    id: stats.column ?? stats.path,
    path: stats.path,
    column: stats.column ?? stats.path,
    type,
    nullable: stats.nullCount > 0,
    cardinality: stats.cardinality,
    filter,
    observed: {
      nonNullCount: stats.nonNullCount,
      nullCount: stats.nullCount,
      ...(stats.min !== undefined ? { min: stats.min } : {}),
      ...(stats.max !== undefined ? { max: stats.max } : {}),
      maxStringLength: stats.maxStringLength,
      maxDecimals: stats.maxDecimals,
      samples: stats.samples.slice(0, SAMPLE_CAP),
    },
  };
  return { column, needsReview };
}

export function infer(leaves, messages, opts) {
  const columns = [];
  const review = [];

  for (const stats of leaves.values()) {
    const { column, needsReview } = inferOne(stats, opts);
    columns.push(column);
    if (needsReview) review.push({ path: stats.path, reason: needsReview });
    if (stats.distinctOverflowed) {
      review.push({
        path: stats.path,
        reason: `cardinality exceeded ${CARDINALITY_CAP}; a set filter would ship the whole list to the browser — using search-select`,
      });
    } else if (column.filter === 'search-select' && looksUnbounded(stats)) {
      review.push({
        path: stats.path,
        reason:
          `${stats.cardinality} distinct in ${stats.nonNullCount} observations — near-unique, so the sample ` +
          `cannot bound the real cardinality. Treated as unbounded (search-select). Re-sample larger to confirm.`,
      });
    }
  }

  columns.sort((a, b) => a.column.localeCompare(b.column));

  return {
    artifact: {
      id: opts.datasourceId ?? 'unnamed',
      version: opts.version ?? 1,
      keyColumns: opts.keyColumns ?? [],
      inferredFrom: {
        messageCount: messages,
        ...(opts.destination ? { destination: opts.destination } : {}),
        minNonNullPerLeaf: opts.minNonNullPerLeaf,
      },
      // reviewedBy is deliberately absent. An artifact without it has not been
      // reviewed, and the admin flow must refuse to publish it.
      columns,
      setFilterColumns: columns.filter((c) => c.filter === 'set').map((c) => c.id),
    },
    review,
  };
}

/**
 * Detect paths arriving that the artifact does not know about.
 *
 * Perspective cannot add a column to a live table — evolution is a rebuild
 * (architecture §4.4). So an unknown path is LOGGED AND SURFACED, never
 * auto-added. Silently adding would mean a schema that drifts from its version.
 */
export function findUnknownPaths(raw, artifact, { separator = '_' } = {}) {
  const known = new Set(artifact.columns.map((c) => c.path));
  const unknown = [];
  (function walk(node, path, depth) {
    if (depth > 12) return;
    for (const [key, value] of Object.entries(node)) {
      const p = path ? `${path}.${key}` : key;
      if (isPlainObject(value)) { walk(value, p, depth + 1); continue; }
      if (!known.has(p)) unknown.push(p);
    }
  })(raw, '', 1);
  return unknown;
}
