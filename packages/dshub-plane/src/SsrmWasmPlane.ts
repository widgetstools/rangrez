import type { SsrmPlaneConfig } from './ssrmTypes.js';
import { flattenRows } from './flattenRow.js';
import { RustHubHost, type RustHubFactory, type RustHubLike } from './RustHubHost.js';
import type {
  SsrmColumnValuesRequest,
  SsrmColumnValuesResult,
  SsrmGetRowsRequest,
  SsrmGetRowsResult,
  SsrmAggregatesRequest,
  SsrmAggregatesResult,
  SsrmRowCountRequest,
  SsrmRowCountResult,
  SsrmTickPayload,
  SsrmViewSpec,
  SsrmWatchGroupsRequest,
  SsrmWatchPredicateRequest,
} from './ssrmTypes.js';
import { SSRM_PIVOT_FIELD_SEPARATOR } from './ssrmTypes.js';
import { toViewSpecResult, type ToViewSpecOptions } from './toViewSpec.js';

/** Result column a watched predicate computes into — engine-internal name. */
const WATCH_PREDICATE_COLUMN = '__ssrmWatch';

const EMPTY_PARAMS = '{}';

/** Distinct-value ceiling for a set filter list. AG Grid renders them all. */
const DEFAULT_COLUMN_VALUES_LIMIT = 1000;

/**
 * Ceiling on held edit overlays per provider. Each entry is one edited row
 * (a map of edited column → value), so this bounds worker memory against a
 * pathological "paste over the whole book" without ever being reachable by
 * hand-editing. Over the cap the OLDEST edits are released to the feed —
 * FIFO, so a fresh edit never evicts silently in favour of a stale one.
 */
export const MAX_EDIT_OVERLAYS_PER_PROVIDER = 10_000;

/**
 * One edited cell held over the upstream feed.
 *
 * `apply_message_json` upserts WHOLE rows (§3 of the SSRM handoff), so a
 * `legacy`-wire feed that resends a full row on any tick silently reverts an
 * engine-side edit to every column it carries. The overlay is reapplied to
 * incoming rows until the upstream value itself moves:
 *   - upstream echoes the edited value → confirmed, overlay dropped;
 *   - upstream sends the SAME value it sent before the edit → stale resend,
 *     the edit is reapplied;
 *   - upstream sends a genuinely NEW value → upstream wins, overlay dropped.
 * `baseline` is the pre-edit upstream value, captured lazily from the first
 * post-edit tick for the row.
 */
interface EditOverlayEntry {
  value: unknown;
  /** First upstream value seen after the edit; undefined until one arrives. */
  baseline?: unknown;
  hasBaseline: boolean;
}

/**
 * Open views held per session (≈ per grid), partitioned by what opened them.
 *
 * An engine view is LIVE — maintained on every tick for as long as it is open
 * — so opening one per read and never disposing it is not a slow leak but a
 * compounding cost: the worker ends up recomputing every view it has ever
 * opened and the grid's own block reads stop arriving, which reads as a grid
 * stuck loading forever. Every scrolled block asks the same query with a
 * different window, so a small cache serves nearly all reads from one view.
 *
 * The partition exists because the two view populations have different
 * lifetimes and costs: `block` views (getRows — the level being scrolled plus
 * a view per expanded group) are what the user is looking at, while `poll`
 * views (status-bar counts, saved-filter pill badges, set-filter value lists)
 * are re-read on a cadence. In one LRU a grid with many expanded groups let
 * the pollers evict a block view mid-scroll — and the re-open rebuilt a view
 * over the whole dataset on the block path, exactly where the latency shows.
 * Under the caps nothing evicts; over one, the cost is a re-open within that
 * partition only. Scoped per session so a second grid can't evict the first
 * one's views.
 */
export const MAX_BLOCK_VIEWS_PER_SESSION = 24;
/** Root/filtered counts + one per pill + open set-filter lists. */
export const MAX_POLL_VIEWS_PER_SESSION = 12;

/** What opened a view — the eviction partition it counts against. */
type ViewKind = 'block' | 'poll';

const VIEW_CAPS: Record<ViewKind, number> = {
  block: MAX_BLOCK_VIEWS_PER_SESSION,
  poll: MAX_POLL_VIEWS_PER_SESSION,
};

interface OpenView {
  sessionId: string;
  providerId: string;
  viewId: string;
  kind: ViewKind;
}

/**
 * Cache key for a view. The filter array is ANDed, so its order carries no
 * meaning — canonicalising it keeps the same query on one view no matter which
 * order the conditions were assembled in. `sort` is left alone: there, order
 * is precedence.
 */
function viewSignature(sessionId: string, providerId: string, spec: SsrmViewSpec): string {
  const filter = [...(spec.filter ?? [])]
    .map((node) => JSON.stringify(node))
    .sort();
  return JSON.stringify([sessionId, providerId, { ...spec, filter }]);
}

export interface SsrmPlaneBootCfg {
  providerId: string;
  cfg: SsrmPlaneConfig;
}

interface SsrmReadWindow {
  rows?: Record<string, unknown>[];
  rowCount?: number;
  groupData?: Record<string, unknown>;
  grandTotalData?: Record<string, unknown>;
  pivotResultFields?: string[];
}

/** Engine message types that are PUSHES, not replies — the set
 *  `pollAllTicks` knows how to translate. */
const PUSH_TYPES = new Set(['groupDelta', 'viewDelta', 'rowDelta']);

export interface SsrmControlReply {
  id?: string;
  type?: string;
  payload?: unknown;
  error?: string;
}

function parseJson<T>(raw: string, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Engine group rows stamp `__path` / `__group`; AG Grid keys off the column. */
function stampGroupKey(row: Record<string, unknown>, groupCol: string): Record<string, unknown> {
  const path = row.__path;
  const fromPath = Array.isArray(path) ? path[path.length - 1] : undefined;
  const key = row[groupCol] ?? row.__ssrmGroupKey ?? fromPath ?? '';
  return {
    ...row,
    [groupCol]: row[groupCol] ?? key,
    __ssrmGroupKey: String(key),
  };
}

/**
 * The pivot result fields of a `splitBy` window, derived from the rows.
 *
 * The engine names pivoted aggregates `<key>|…|<valueCol>` on each group row
 * but reports no field list of its own (probed — `readWindow` payloads carry
 * only `rows`/`rowCount`). AG Grid builds its secondary column tree from
 * `pivotResultFields`, so the plane collects every such key across the
 * window, keyed to the requested value columns to keep data columns out.
 * Sorted so the tree is stable across blocks and reloads.
 */
function derivePivotResultFields(
  rows: readonly Record<string, unknown>[],
  valueCols: readonly string[],
): string[] {
  const fields = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      const cut = key.lastIndexOf(SSRM_PIVOT_FIELD_SEPARATOR);
      if (cut <= 0) continue;
      if (valueCols.includes(key.slice(cut + 1))) fields.add(key);
    }
  }
  return [...fields].sort();
}

function resultOf(replies: SsrmControlReply[], id: string): SsrmControlReply {
  const match = replies.find((r) => r.id === id) ?? replies.find((r) => r.type === 'result');
  if (!match) throw new Error('[ssrm] wasm control returned no result');
  // The engine's refusals arrive as `{type: 'error', message}` — surface the
  // engine's own words (e.g. WHICH computed column failed to parse), not a
  // generic missing-payload error downstream.
  if (match.type === 'error') {
    throw new Error(String((match as { message?: unknown }).message ?? 'engine error'));
  }
  if (match.error) throw new Error(String(match.error));
  return match;
}

const NON_TEXT_TYPES = new Set(['number', 'boolean']);

/**
 * Columns the quick filter searches. An explicit `searchColumns` wins; with
 * none configured every non-numeric, non-boolean column is searched — the
 * behaviour of AG Grid's own quick filter, which the search bar promises.
 */
export function resolveSearchColumns(cfg: SsrmPlaneConfig): readonly string[] {
  if (cfg.searchColumns?.length) return cfg.searchColumns;
  return (cfg.columnDefinitions ?? [])
    .filter((c) => typeof c.field === 'string' && !NON_TEXT_TYPES.has(String(c.cellDataType ?? 'text')))
    .map((c) => c.field as string);
}

/** Columns declared as dates — their filter bounds need the storage shape. */
export function dateColumnsOf(cfg: SsrmPlaneConfig): readonly string[] {
  return (cfg.columnDefinitions ?? [])
    .filter((c) => typeof c.field === 'string' && (c.cellDataType === 'date' || c.cellDataType === 'dateString'))
    .map((c) => c.field as string);
}

/** Key column(s) rows are upserted by — the overlay keys rows the same way. */
export function keyColumnsOf(cfg: SsrmPlaneConfig): string[] {
  const keyCol = cfg.keyColumn;
  if (typeof keyCol === 'string') return [keyCol];
  return keyCol && keyCol.length > 0 ? [...keyCol] : ['positionId'];
}

function bootJson(providerId: string, cfg: SsrmPlaneConfig): string {
  const keyColumns = keyColumnsOf(cfg);
  // A `date` type makes the engine parse the epoch at WRITE time (plan §12
  // T6): sorts order instants and numeric range bounds compare against the
  // parsed value, while the stored string stays what rows display. This
  // retired the client-stamped `__epoch` shadow columns.
  const columns = (cfg.columnDefinitions ?? []).map((c) => ({
    name: c.field,
    type:
      c.cellDataType === 'number' ? 'f64'
      : c.cellDataType === 'boolean' ? 'bool'
      : c.cellDataType === 'date' || c.cellDataType === 'dateString' ? 'date'
      : 'string',
  }));
  return JSON.stringify({
    id: providerId,
    schemaRef: `${providerId}@v1`,
    keyColumns,
    columns,
    searchColumns: cfg.searchColumns ?? [],
  });
}

/**
 * Per-provider façade over one shared {@link RustHubLike}.
 * One WASM cache per `providerId`; each subscriber is a rust session.
 */
export class SsrmWasmPlane {
  private readonly host: RustHubHost;
  private readonly booted = new Set<string>();
  private readonly subscribed = new Set<string>();
  /**
   * Which datasource each session subscribed to. `tick()` drains EVERY
   * session's outbox in one call, so group deltas must be routed back to
   * their own provider — without this map, provider B's deltas reached
   * provider A's grids and triggered refreshes there.
   */
  private readonly sessionProvider = new Map<string, string>();
  /** Quick filter needs `searchColumns` at getRows time, not just at boot. */
  private readonly searchColumns = new Map<string, readonly string[]>();
  /** Date columns per provider — typed `date` at boot; the engine parses epochs at write. */
  private readonly dateColumns = new Map<string, readonly string[]>();
  /** Key columns per provider — how ingest matches incoming rows to overlays. */
  private readonly keyColumns = new Map<string, readonly string[]>();
  /**
   * Held edits per provider: row key → edited column → {@link EditOverlayEntry}.
   * Insertion-ordered (Map), so the cap evicts oldest-edited-row first.
   */
  private readonly editOverlays = new Map<string, Map<string, Map<string, EditOverlayEntry>>>();
  /** Last boot payload per provider — a change invalidates held edits. */
  private readonly bootSignature = new Map<string, string>();

  /** Live engine views by query signature, insertion-ordered least-recent first. */
  private readonly views = new Map<string, OpenView>();
  /**
   * Watched predicates (plan §12 T5): engine viewId → registration. Kept OFF
   * the query-view LRU — an alert watch must never be evicted by scrolling.
   */
  private readonly watchViews = new Map<string, { sessionId: string; providerId: string; ruleId: string }>();
  /** Parsed engine `capabilities()` — memoized once the hub exists. */
  /**
   * Engine pushes that arrived on a CONTROL reply rather than on a tick.
   *
   * `on_control` returns "the reply, followed by that session's queued
   * outbox", and some engine pushes only ever come that way. `watchGroups` is
   * the one that bites: the engine emits a full group snapshot the instant a
   * watch is registered (`groupwatch.rs`: `if let Some(m) = w.poll() {
   * session.push(m) }`) and then, having recorded that as its baseline,
   * reports nothing on the next tick because nothing has changed. Reading
   * only the matching reply therefore lost the whole tree whenever a watch
   * was registered over an already-populated table — and "the tree as it
   * stands now" is precisely what a skeleton-style consumer asks for.
   *
   * Buffered here, drained by `pollAllTicks` through the same translation as
   * a real tick, so a consumer sees one uniform stream and cannot tell which
   * transport a push took.
   */
  private readonly pendingPushes: Array<{ sessionId: string; message: unknown }> = [];

  private capsMemo: Record<string, unknown> | null | undefined;
  private nextCtl = 1;

  constructor(factory?: RustHubFactory) {
    this.host = new RustHubHost(factory);
  }

  async boot(providerId: string, cfg: SsrmPlaneConfig): Promise<void> {
    const hub = await this.host.ensure();
    // Views held over a re-boot point at a datasource that no longer exists.
    this.dropViews((v) => v.providerId === providerId);
    this.dropWatches((w) => w.providerId === providerId);
    const boot = bootJson(providerId, cfg);
    hub.boot_datasource(boot);
    this.booted.add(providerId);
    this.searchColumns.set(providerId, resolveSearchColumns(cfg));
    this.dateColumns.set(providerId, dateColumnsOf(cfg));
    this.keyColumns.set(providerId, keyColumnsOf(cfg));
    // Held edits survive a same-config re-boot (every ssrm attach calls
    // boot), but a schema/config CHANGE invalidates them — they were made
    // against columns that may no longer mean the same thing.
    if (this.bootSignature.get(providerId) !== boot) this.editOverlays.delete(providerId);
    this.bootSignature.set(providerId, boot);
  }

  /** Translator options for one provider: quick-filter columns and date columns. */
  private specOpts(providerId: string): ToViewSpecOptions {
    return {
      searchColumns: this.searchColumns.get(providerId),
      dateColumns: this.dateColumns.get(providerId),
    };
  }

  async reset(providerId: string, cfg: SsrmPlaneConfig): Promise<void> {
    this.booted.delete(providerId);
    await this.boot(providerId, cfg);
  }

  async attachSession(sessionId: string): Promise<void> {
    const hub = await this.host.ensure();
    hub.connect(sessionId);
  }

  async detachSession(sessionId: string): Promise<string[]> {
    const hub = this.host.current;
    if (!hub) return [];
    this.subscribed.delete(sessionId);
    this.sessionProvider.delete(sessionId);
    this.dropViews((v) => v.sessionId === sessionId);
    this.dropWatches((w) => w.sessionId === sessionId);
    return parseJson<string[]>(hub.disconnect(sessionId), []);
  }

  /**
   * Provider stopped — drop the engine's ingest retention pin so the table
   * frees with its last session (T2: retention follows the DATA — ingest
   * pins the table engine-side, so rows land whether or not any session has
   * subscribed yet, and survive every viewer leaving).
   */
  dropTable(providerId: string): void {
    const hub = this.host.current;
    if (!hub) return;
    try {
      hub.drop_table(providerId, EMPTY_PARAMS);
    } catch {
      /* engine already dropped it */
    }
    this.editOverlays.delete(providerId);
  }

  /** Delete rows by key — removals reach the grids via the delta stream. */
  async deleteRows(providerId: string, keys: readonly string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const hub = await this.host.ensure();
    const reply = hub.delete_rows(providerId, EMPTY_PARAMS, JSON.stringify(keys));
    this.pruneEditOverlays(providerId, keys);
    return parseJson<number[]>(reply, [0])[0] ?? 0;
  }

  async ingest(providerId: string, rows: readonly unknown[], replace: boolean): Promise<void> {
    const hub = await this.host.ensure();
    const flat = flattenRows(rows) as Record<string, unknown>[];
    // Overlays before ingest — the engine parses date epochs at write time,
    // so an overlaid date edit is parsed as the EDITED value, not the
    // upstream one it replaced.
    this.applyEditOverlays(providerId, flat);
    if (replace) {
      // Restart flush: after this the table holds exactly `rows` (possibly
      // none — the chunked-snapshot case, where the truncate lands here and
      // the chunks follow as plain upserts). Stale keys become removals on
      // the delta stream; keys that survive the replace are never emitted
      // as removals (engine rule: a live re-upsert supersedes its delete).
      // This REPLACES the old empty-schema re-boot, which — probed — never
      // dropped anything while a session was subscribed.
      hub.replace_snapshot(providerId, EMPTY_PARAMS, JSON.stringify(flat));
      return;
    }
    if (flat.length === 0) return;
    hub.apply_message_json(providerId, EMPTY_PARAMS, JSON.stringify(flat));
  }

  /**
   * Write grid edits into the engine cache and hold each edited column over
   * the feed. See {@link EditOverlayEntry} for the hold/release rules —
   * without them a `legacy`-wire upstream that resends whole rows reverts an
   * edit on the row's next tick, which `ssrm-validate3` caught live.
   */
  async applyEdits(
    providerId: string,
    rows: readonly Record<string, unknown>[],
    editedColumns?: ReadonlyArray<readonly string[]>,
  ): Promise<number> {
    const hub = await this.host.ensure();
    const flat = flattenRows(rows) as Record<string, unknown>[];
    if (flat.length === 0) return 0;
    this.recordEditOverlays(providerId, flat, editedColumns);
    hub.apply_message_json(providerId, EMPTY_PARAMS, JSON.stringify(flat));
    return flat.length;
  }

  /** Composite row key, or undefined when a key part is missing. */
  private rowKeyOf(row: Record<string, unknown>, keys: readonly string[]): string | undefined {
    if (keys.some((k) => row[k] == null)) return undefined;
    return keys.map((k) => String(row[k])).join('');
  }

  private recordEditOverlays(
    providerId: string,
    rows: readonly Record<string, unknown>[],
    editedColumns: ReadonlyArray<readonly string[]> | undefined,
  ): void {
    if (!editedColumns?.length) return;
    const keys = this.keyColumns.get(providerId) ?? [];
    if (keys.length === 0) return;
    let overlays = this.editOverlays.get(providerId);
    if (!overlays) {
      overlays = new Map();
      this.editOverlays.set(providerId, overlays);
    }
    rows.forEach((row, i) => {
      const cols = editedColumns[i];
      if (!cols?.length) return;
      const key = this.rowKeyOf(row, keys);
      if (key === undefined) return;
      const held = overlays.get(key) ?? new Map<string, EditOverlayEntry>();
      // Re-insert so a re-edited row moves to the young end of the FIFO.
      overlays.delete(key);
      for (const col of cols) {
        if (!(col in row)) continue;
        held.set(col, { value: row[col], hasBaseline: false });
      }
      if (held.size > 0) overlays.set(key, held);
    });
    while (overlays.size > MAX_EDIT_OVERLAYS_PER_PROVIDER) {
      const oldest = overlays.keys().next().value;
      if (oldest === undefined) break;
      overlays.delete(oldest);
    }
  }

  /** Reapply held edits over incoming upstream rows — see {@link EditOverlayEntry}. */
  private applyEditOverlays(providerId: string, rows: Record<string, unknown>[]): void {
    const overlays = this.editOverlays.get(providerId);
    if (!overlays?.size) return;
    const keys = this.keyColumns.get(providerId) ?? [];
    if (keys.length === 0) return;
    for (const row of rows) {
      const key = this.rowKeyOf(row, keys);
      if (key === undefined) continue;
      const held = overlays.get(key);
      if (!held) continue;
      for (const [col, entry] of [...held]) {
        // A sparse tick without this column cannot revert the edit — the
        // whole-row problem only exists for rows that carry the column.
        if (!(col in row)) continue;
        const incoming = row[col];
        if (Object.is(incoming, entry.value)) {
          // Upstream echoed the edit back — confirmed, nothing to hold.
          held.delete(col);
          continue;
        }
        if (!entry.hasBaseline) {
          entry.baseline = incoming;
          entry.hasBaseline = true;
          row[col] = entry.value;
          continue;
        }
        if (!Object.is(incoming, entry.baseline)) {
          // Upstream produced a genuinely new value — it wins.
          held.delete(col);
          continue;
        }
        // Stale whole-row resend of the pre-edit value — hold the edit.
        row[col] = entry.value;
      }
      if (held.size === 0) overlays.delete(key);
    }
  }

  /** Rows deleted upstream take their held edits with them. */
  private pruneEditOverlays(providerId: string, removals: readonly string[] | undefined): void {
    if (!removals?.length) return;
    const overlays = this.editOverlays.get(providerId);
    if (!overlays?.size) return;
    for (const id of removals) overlays.delete(id);
    if (overlays.size === 0) this.editOverlays.delete(providerId);
  }

  /**
   * The engine's feature manifest. `{}` until the hub exists or when the
   * build predates `capabilities()` — every gate below then reads "absent",
   * so a feature is refused loudly rather than silently mis-served.
   */
  private engineCaps(): Record<string, unknown> {
    if (this.capsMemo === undefined) {
      const hub = this.host.current;
      if (!hub) return {};
      this.capsMemo = typeof hub.capabilities === 'function'
        ? parseJson<Record<string, unknown> | null>(hub.capabilities(), null)
        : null;
    }
    return this.capsMemo ?? {};
  }

  async getRows(
    sessionId: string,
    providerId: string,
    req: SsrmGetRowsRequest,
  ): Promise<SsrmGetRowsResult> {
    const hub = await this.host.ensure();
    await this.ensureSubscribed(hub, sessionId, providerId);
    const { spec, unsupported } = toViewSpecResult(req, this.specOpts(providerId));
    if (spec.computed?.length && this.engineCaps().computedColumns !== true) {
      // An engine that ignores `computed` would serve the view WITHOUT the
      // column while the grid sorts/filters on it — report, never degrade
      // silently.
      delete spec.computed;
      unsupported.push('computed columns (engine build without computedColumns)');
    }
    if (unsupported.length > 0) {
      // Loud on purpose: a dropped condition renders MORE rows than asked for,
      // which is indistinguishable from working software. The worker console
      // is not where users look, so the list also rides the result.
      // eslint-disable-next-line no-console
      console.warn(`[ssrm] ${providerId}: untranslatable filter conditions —`, unsupported);
    }
    const win = this.readView(hub, sessionId, providerId, spec, req.startRow ?? 0, req.endRow);
    let rowData = win.rows ?? [];
    const groupCol = spec.groupBy?.[0];
    if (groupCol) {
      rowData = rowData.map((r) => stampGroupKey(r, groupCol));
    }
    // The engine reports no pivot field list of its own — derive it from the
    // window so AG Grid can build the secondary column tree.
    const pivotResultFields = spec.splitBy?.length
      ? win.pivotResultFields ?? derivePivotResultFields(rowData, spec.columns ?? [])
      : win.pivotResultFields;
    return {
      rowData,
      rowCount: typeof win.rowCount === 'number' ? win.rowCount : rowData.length,
      groupData: win.groupData,
      grandTotalData: win.grandTotalData,
      pivotResultFields,
      ...(unsupported.length > 0 ? { unsupportedFilters: unsupported } : {}),
    };
  }

  /**
   * Distinct values for one column — AG Grid set filters can't derive them
   * under SSRM (no rows on the main thread), so they must be supplied.
   *
   * Implemented as a one-level grouped view: the engine already returns one
   * row per distinct group key, so this needs no new WASM entry point. The
   * other columns' filters are honoured so a set filter offers only values
   * that are actually reachable, matching AG Grid's own SSRM example.
   */
  async getColumnValues(
    sessionId: string,
    providerId: string,
    req: SsrmColumnValuesRequest,
  ): Promise<SsrmColumnValuesResult> {
    const hub = await this.host.ensure();
    await this.ensureSubscribed(hub, sessionId, providerId);
    const limit = req.limit && req.limit > 0 ? req.limit : DEFAULT_COLUMN_VALUES_LIMIT;

    // Its own filters must not narrow its own value list, or de-selecting a
    // value would make it disappear from the list.
    const scoped: Record<string, unknown> = { ...(req.filterModel ?? {}) };
    delete scoped[req.column];
    const { spec } = toViewSpecResult(
      {
        filterModel: scoped,
        sortModel: [{ colId: req.column, sort: 'asc' }],
        // The quick filter narrows the visible rows like any other filter,
        // so a value list that ignores it offers values the grid would
        // show zero rows for.
        ...(req.quickFilterText ? { quickFilterText: req.quickFilterText } : {}),
      },
      this.specOpts(providerId),
    );
    spec.groupBy = [req.column];
    spec.aggregates = {};
    spec.depth = 1;

    // One extra row distinguishes "exactly at the cap" from "truncated".
    const win = this.readView(hub, sessionId, providerId, spec, 0, limit + 1, 'poll');
    const rows = win.rows ?? [];
    const seen = new Set<string>();
    const values: unknown[] = [];
    for (const row of rows) {
      // Group rows carry the key under the grouped column, but fall back to
      // `__ssrmGroupKey` the same way `getRows` does. A nullish key is not a
      // value the user can pick — AG Grid renders blanks on its own.
      const value = row[req.column] ?? row.__ssrmGroupKey;
      if (value == null) continue;
      const key = String(value);
      if (seen.has(key)) continue;
      seen.add(key);
      values.push(value);
      if (values.length >= limit) break;
    }
    return { column: req.column, values, truncated: rows.length > limit };
  }

  /**
   * Total rows matching a filter model, without loading any of them.
   *
   * Reads a one-row window: the engine reports the view's `rowCount` whatever
   * window was asked for, so the count costs no row materialisation. One row
   * rather than none because an empty range is the kind of edge an engine may
   * read as "unbounded" — which would materialise the whole view every poll.
   */
  async getRowCount(
    sessionId: string,
    providerId: string,
    req: SsrmRowCountRequest,
  ): Promise<SsrmRowCountResult> {
    const hub = await this.host.ensure();
    await this.ensureSubscribed(hub, sessionId, providerId);
    const { spec } = toViewSpecResult(req, this.specOpts(providerId));
    const win = this.readView(hub, sessionId, providerId, spec, 0, 1, 'poll');
    return { rowCount: typeof win.rowCount === 'number' ? win.rowCount : 0 };
  }

  /**
   * Dataset-level aggregations for the SSRM status bar. The grid only holds
   * loaded blocks, so a client-side sum would be a block statistic.
   */
  async getAggregates(
    sessionId: string,
    providerId: string,
    req: SsrmAggregatesRequest,
  ): Promise<SsrmAggregatesResult> {
    if (req.specs.length === 0) return { values: {} };
    const hub = await this.host.ensure();
    await this.ensureSubscribed(hub, sessionId, providerId);
    const { spec } = toViewSpecResult(req, this.specOpts(providerId));
    const id = this.ctlId();
    const opened = resultOf(
      this.control(hub, sessionId, {
        id,
        type: 'aggregates',
        ref: { datasourceId: providerId, params: {} },
        specs: req.specs.map((s) => ({
          column: s.column,
          fn: s.fn,
          as: s.as ?? `${s.column}_${s.fn}`,
        })),
        spec: { filter: spec.filter },
      }),
      id,
    );
    const raw = (opened.payload ?? {}) as Record<string, unknown>;
    const values: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw)) {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isNaN(n)) values[key] = n;
    }
    return { values };
  }

  /**
   * Open (and materialise) the root view — no filter, no sort — for one
   * session, off the request path.
   *
   * The first block after `ready` paid a 1–2.5 s engine view build over the
   * 20k-row fixture because the view was only opened when AG Grid asked for
   * rows. Building it the moment the snapshot lands means the datasource's
   * first `getRows` (whose spec has the same {@link viewSignature}) is a
   * cache hit on an already-built view. The 1-row read forces the build —
   * `openView` alone may defer materialisation — and mirrors `getRowCount`'s
   * "never ask for an empty window" caution.
   */
  async warmRootView(sessionId: string, providerId: string): Promise<void> {
    const hub = await this.host.ensure();
    await this.ensureSubscribed(hub, sessionId, providerId);
    const { spec } = toViewSpecResult({}, this.specOpts(providerId));
    this.readView(hub, sessionId, providerId, spec, 0, 1);
  }

  async watchGroups(
    sessionId: string,
    providerId: string,
    req: SsrmWatchGroupsRequest,
  ): Promise<void> {
    const hub = await this.host.ensure();
    await this.ensureSubscribed(hub, sessionId, providerId);
    if (req.computedColumns?.length
        && this.engineCaps().groupWatchComputedColumns !== true) {
      // Every build before this capability existed parsed `groupBy` and
      // `aggregates` off the raw cache and ignored `view.computed` entirely,
      // so the columns would be absent from every caption with nothing said.
      // That silence is the bug this whole path was fixed for — throwing is
      // the point.
      throw new Error(
        '[ssrm] this engine build has no computed columns on group watches '
        + '(capability groupWatchComputedColumns)',
      );
    }
    const id = this.ctlId();
    resultOf(
      this.control(hub, sessionId, {
        id,
        type: 'watchGroups',
        ref: { datasourceId: providerId, params: {} },
        groupBy: req.groupBy,
        aggregates: req.aggregates ?? {},
        ...(req.computedColumns?.length
          ? { view: { computed: req.computedColumns } }
          : {}),
      }),
      id,
    );
  }

  /**
   * Watch a boolean predicate over the WHOLE dataset (plan §12 T5). The
   * predicate becomes a computed column on a watch-flagged engine view
   * filtered to `predicate = true`; each revision the engine diffs the
   * membership and `tick()` carries the entered/left keys (entered rows
   * materialized, capped at 200). Replaces any prior watch with the same
   * `ruleId` for this session.
   */
  async watchPredicate(
    sessionId: string,
    providerId: string,
    req: SsrmWatchPredicateRequest,
  ): Promise<void> {
    const hub = await this.host.ensure();
    await this.ensureSubscribed(hub, sessionId, providerId);
    const caps = this.engineCaps();
    if (caps.viewDeltas !== true || caps.computedColumns !== true) {
      throw new Error('[ssrm] this engine build has no predicate watches (viewDeltas/computedColumns)');
    }
    this.unwatchPredicate(sessionId, req.ruleId);
    const spec: SsrmViewSpec = {
      filter: [{ column: WATCH_PREDICATE_COLUMN, op: 'equals', value: true }],
      sort: [],
      computed: [{ as: WATCH_PREDICATE_COLUMN, expr: req.expr }],
      watch: true,
    };
    const openId = this.ctlId();
    const opened = resultOf(
      this.control(hub, sessionId, {
        id: openId,
        type: 'openView',
        ref: { datasourceId: providerId, params: {} },
        view: spec,
      }),
      openId,
    );
    const viewId = ((opened.payload ?? {}) as { viewId?: string }).viewId;
    if (!viewId) throw new Error('[ssrm] watchPredicate: openView returned no viewId');
    this.watchViews.set(viewId, { sessionId, providerId, ruleId: req.ruleId });
  }

  /** Drop one session's watched predicate. Safe when none exists. */
  unwatchPredicate(sessionId: string, ruleId: string): void {
    const hub = this.host.current;
    for (const [viewId, reg] of [...this.watchViews]) {
      if (reg.sessionId !== sessionId || reg.ruleId !== ruleId) continue;
      this.watchViews.delete(viewId);
      if (hub) this.disposeView(hub, { ...reg, viewId, kind: 'poll' });
    }
  }

  /** Drop every watch matching `match` (provider reboot, session teardown). */
  private dropWatches(match: (reg: { sessionId: string; providerId: string }) => boolean): void {
    const hub = this.host.current;
    for (const [viewId, reg] of [...this.watchViews]) {
      if (!match(reg)) continue;
      this.watchViews.delete(viewId);
      if (hub) this.disposeView(hub, { sessionId: reg.sessionId, providerId: reg.providerId, viewId, kind: 'poll' });
    }
  }

  /**
   * Drain the engine ONCE and bucket every tick by provider.
   *
   * `tick()` returns every session's queued group deltas in a single call, so
   * it must be polled once per flush and routed by the session's datasource
   * (see {@link sessionProvider}); the shared row delta is per datasource and
   * is polled for each booted provider. Providers with nothing to say are
   * absent from the map.
   */
  /**
   * Whether to poll a provider's ROW-delta stream at all.
   *
   * On by default, because a client that needs streaming rows and does not get
   * them looks broken in a way nobody attributes to a missing call. Turn it off
   * for a provider whose only consumer reads group deltas — a server-side grid
   * — and the engine stops materializing per-row JSON nothing will read.
   *
   * The stream is created lazily on first poll, so a provider switched off
   * before its first tick never allocates one at all.
   */
  setRowDeltaEnabled(providerId: string, enabled: boolean): void {
    if (enabled) this.rowDeltasOff.delete(providerId);
    else this.rowDeltasOff.add(providerId);
  }

  pollAllTicks(): Map<string, SsrmTickPayload[]> {
    const out = new Map<string, SsrmTickPayload[]>();
    const hub = this.host.current;
    if (!hub) return out;
    const push = (providerId: string, tick: SsrmTickPayload): void => {
      const bucket = out.get(providerId);
      if (bucket) bucket.push(tick);
      else out.set(providerId, [tick]);
    };
    const perSession = parseJson<Array<{ sessionId: string; messages?: unknown[] }>>(hub.tick(), []);
    // Control-reply pushes first, so a watch's initial snapshot precedes any
    // change that landed after it.
    if (this.pendingPushes.length > 0) {
      const buffered = this.pendingPushes.splice(0, this.pendingPushes.length);
      const bySession = new Map<string, unknown[]>();
      for (const { sessionId, message } of buffered) {
        const bucket = bySession.get(sessionId);
        if (bucket) bucket.push(message);
        else bySession.set(sessionId, [message]);
      }
      for (const [sessionId, messages] of bySession) perSession.unshift({ sessionId, messages });
    }
    for (const rec of perSession) {
      const providerId = this.sessionProvider.get(rec.sessionId);
      // A session only produces deltas after `subscribe`, which records it
      // here; anything else is a session already torn down.
      if (!providerId) continue;
      for (const raw of rec.messages ?? []) {
        const m = raw as {
          type?: string;
          groups?: Record<string, unknown>[];
          removed?: string[];
          viewId?: string;
          entered?: string[];
          left?: string[];
          rows?: Record<string, unknown>[];
        };
        if (m.type === 'groupDelta') {
          push(providerId, { kind: 'groupDelta', groups: m.groups, removed: m.removed });
        } else if (m.type === 'viewDelta' && m.viewId) {
          const reg = this.watchViews.get(m.viewId);
          // A delta for a watch this plane no longer tracks (rule removed
          // mid-tick) is dropped — its subscriber asked to stop hearing it.
          if (reg) {
            push(reg.providerId, {
              kind: 'viewDelta',
              ruleId: reg.ruleId,
              entered: m.entered,
              left: m.left,
              rows: m.rows,
              watchSubId: reg.sessionId,
            });
          }
        }
      }
    }
    for (const providerId of this.booted) {
      // The ROW-delta stream is the CSRM path: one JSON object per changed
      // row. A server-side grid never reads it — it folds group deltas and
      // re-reads the windows it is showing — so for an SSRM-only provider
      // this built ~60KB a tick and the consumer dropped every byte. Measured
      // at 64% of the whole tick (0.95ms of 1.49ms at 500k rows, 400 moved).
      //
      // Opt-OUT rather than opt-in on purpose: a consumer that forgets to ask
      // for row deltas would silently stop updating, which is the failure this
      // codebase has too much of already. Forgetting to opt out costs time.
      if (this.rowDeltasOff.has(providerId)) continue;
      const dstr = hub.poll_shared_delta(providerId, EMPTY_PARAMS);
      if (!dstr) continue;
      const m = parseJson<{
        type?: string;
        upserts?: Record<string, unknown>[];
        removals?: string[];
        reset?: boolean;
      }>(dstr, {});
      if (m.type === 'rowDelta' || m.upserts || m.removals) {
        this.pruneEditOverlays(providerId, m.removals);
        push(providerId, {
          kind: 'rowDelta',
          upserts: m.upserts,
          removals: m.removals,
          reset: m.reset,
        });
      }
    }
    return out;
  }

  /**
   * One provider's ticks. Convenience over {@link pollAllTicks} for a
   * single-provider worker — it drains the engine, so other providers' ticks
   * from this poll are discarded. The hub uses `pollAllTicks` directly.
   */
  pollTicks(providerId: string): SsrmTickPayload[] {
    return this.pollAllTicks().get(providerId) ?? [];
  }

  memStats(): unknown {
    const hub = this.host.current;
    if (!hub) return null;
    return parseJson(hub.mem_stats(), null);
  }

  /** `openView` + `readWindow` for one spec — shared by rows, counts and value lists. */
  private readView(
    hub: RustHubLike,
    sessionId: string,
    providerId: string,
    spec: SsrmViewSpec,
    startRow: number,
    endRow: number | undefined,
    kind: ViewKind = 'block',
  ): SsrmReadWindow {
    const viewId = this.acquireView(hub, sessionId, providerId, spec, kind);

    const readId = this.ctlId();
    const window = resultOf(
      this.control(hub, sessionId, {
        id: readId,
        type: 'readWindow',
        viewId,
        startRow,
        endRow,
      }),
      readId,
    );
    return (window.payload ?? {}) as SsrmReadWindow;
  }

  /**
   * The view for this query, opening one only if it isn't already held.
   *
   * Reads run to completion synchronously inside the wasm call, so unlike an
   * async host there's no window in which an eviction can dispose a view
   * another read is part-way through — recency ordering alone is enough.
   */
  private acquireView(
    hub: RustHubLike,
    sessionId: string,
    providerId: string,
    spec: SsrmViewSpec,
    kind: ViewKind,
  ): string {
    const key = viewSignature(sessionId, providerId, spec);
    const cached = this.views.get(key);
    if (cached) {
      // Re-insert so the map stays ordered least-recently-used first. A
      // block read promotes a poll-opened view (the root count view IS the
      // root block view) — block is the partition whose eviction hurts.
      this.views.delete(key);
      if (kind === 'block') cached.kind = 'block';
      this.views.set(key, cached);
      return cached.viewId;
    }

    const openId = this.ctlId();
    const opened = resultOf(
      this.control(hub, sessionId, {
        id: openId,
        type: 'openView',
        ref: { datasourceId: providerId, params: {} },
        view: spec,
      }),
      openId,
    );
    const viewId = ((opened.payload ?? {}) as { viewId?: string }).viewId;
    if (!viewId) throw new Error('[ssrm] openView returned no viewId');

    this.views.set(key, { sessionId, providerId, viewId, kind });
    this.evictSession(hub, sessionId, kind);
    return viewId;
  }

  /** Release this session's least recently used `kind` views down to that partition's cap. */
  private evictSession(hub: RustHubLike, sessionId: string, kind: ViewKind): void {
    const mine = [...this.views].filter(
      ([, v]) => v.sessionId === sessionId && v.kind === kind,
    );
    // Clamped: a negative end would make `slice` count back from the end and
    // evict while under the cap.
    const excess = Math.max(0, mine.length - VIEW_CAPS[kind]);
    for (const [key, view] of mine.slice(0, excess)) {
      this.views.delete(key);
      this.disposeView(hub, view);
    }
  }

  /** Drop every held view matching `match`, telling the engine to release it. */
  private dropViews(match: (v: OpenView) => boolean): void {
    const hub = this.host.current;
    for (const [key, view] of [...this.views]) {
      if (!match(view)) continue;
      this.views.delete(key);
      if (hub) this.disposeView(hub, view);
    }
  }

  private disposeView(hub: RustHubLike, view: OpenView): void {
    // Best-effort: a view the engine has already dropped (provider reboot,
    // worker replaced) is not worth failing a teardown over.
    try {
      this.control(hub, view.sessionId, {
        id: this.ctlId(),
        type: 'disposeView',
        viewId: view.viewId,
      });
    } catch {
      /* engine already released it */
    }
  }

  private async ensureSubscribed(hub: RustHubLike, sessionId: string, providerId: string): Promise<void> {
    if (this.subscribed.has(sessionId)) return;
    const id = this.ctlId();
    this.control(hub, sessionId, {
      id,
      type: 'subscribe',
      ref: { datasourceId: providerId, params: {} },
      delivery: 'rows',
    });
    this.subscribed.add(sessionId);
    this.sessionProvider.set(sessionId, providerId);
  }

  /** Providers whose row-delta stream has no reader — see `setRowDeltaEnabled`. */
  private readonly rowDeltasOff = new Set<string>();

  private control(hub: RustHubLike, sessionId: string, msg: Record<string, unknown>): SsrmControlReply[] {
    const replies = parseJson<SsrmControlReply[]>(hub.on_control(sessionId, JSON.stringify(msg)), []);
    // Keep the outbox pushes that rode along for `pollAllTicks` — see
    // `pendingPushes`. Selected by message TYPE, not by the absence of an
    // `id`: a groupDelta carries one too (`groupwatch.rs` stamps
    // `"g-<datasourceId>"`), so an id-based test silently keeps nothing.
    for (const r of replies) {
      if (r.type !== undefined && PUSH_TYPES.has(r.type)) {
        this.pendingPushes.push({ sessionId, message: r });
      }
    }
    return replies;
  }

  private ctlId(): string {
    return `ssrm-${this.nextCtl++}`;
  }
}

export function publishWindowMsOf(cfg: SsrmPlaneBootCfg['cfg']): number {
  const n = cfg.publishWindowMs;
  return typeof n === 'number' && n > 0 ? n : 100;
}
