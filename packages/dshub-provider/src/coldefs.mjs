/**
 * Schema artifact -> AG-Grid ColDef[].
 *
 * The provider is the only place AG-Grid exists (principle 7); the hub knows
 * nothing about grids. Everything here is derived from the artifact, so
 * onboarding a datasource touches zero source files — the leanness test that
 * actually matters.
 *
 * Targets AG-Grid 36 (architecture §2.1).
 */

// The capability list lives with the translator that defines it, so the menu
// and what the server can execute cannot drift apart.
import { SERVER_FILTER_OPTIONS } from './modes/ssrm.mjs';

/** Cardinality -> filter behaviour (architecture §4.3, parity study §1.4). */
export const CARDINALITY_EAGER = 500;
export const CARDINALITY_LAZY = 10_000;
/**
 * The mini-filter threshold is NOT the eager/lazy threshold.
 *
 * Parity study §1.4 keys eager-vs-lazy fetching on 500, and mentions the
 * mini-filter while describing the 500–10k band. Reusing 500 for both would
 * mean a 499-value list with no way to search it, which is worse UX than the
 * clutter the suppression avoids. Suppress only where the list is genuinely
 * short enough to scan by eye.
 */
export const CARDINALITY_MINI_FILTER = 20;

const HEADER_OVERRIDES = new Map([
  ['id', 'ID'], ['isin', 'ISIN'], ['cusip', 'CUSIP'], ['sedol', 'SEDOL'],
  ['lei', 'LEI'], ['dv01', 'DV01'], ['pv', 'PV'], ['pnl', 'P&L'], ['ccy', 'CCY'],
]);

/** `counterparty_name` -> `Counterparty Name`, with FI acronyms kept upper. */
export function humanize(column) {
  return column
    .split(/[_/\-:]/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      if (HEADER_OVERRIDES.has(lower)) return HEADER_OVERRIDES.get(lower);
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

/**
 * Width from the widest observed value, not from the header.
 *
 * autoSizeAllColumns only measures RENDERED rows, so in SSRM it sizes to
 * whatever happens to be loaded (parity study §3). Sizing from the artifact's
 * observed max length is the replacement, and it is stable across modes.
 */
export function widthFor(col) {
  const headerChars = humanize(col.column).length;
  const dataChars =
    col.type === 'integer' || col.type === 'float'
      ? Math.max(String(col.observed?.max ?? '').length, 8)
      : col.observed?.maxStringLength ?? 12;
  const chars = Math.max(headerChars, Math.min(dataChars, 60));
  return Math.round(Math.max(90, Math.min(320, chars * 8 + 32)));
}

/**
 * Restrict the filter menu to what the mode can execute.
 *
 * CSRM evaluates predicates locally and supports AG-Grid's whole default menu.
 * A server-backed mode can only offer what the translator can turn into engine
 * operations — notably NOT "Not contains", which Perspective has no operator
 * for. Offering it anyway means the user picks it and the grid silently goes
 * blank.
 */
function withServerOptions(base, kind, dataService) {
  if (!dataService || dataService.mode === 'csrm') return base;
  const filterOptions = SERVER_FILTER_OPTIONS[kind];
  if (!filterOptions) return base;
  return { ...base, filterParams: { ...base.filterParams, filterOptions } };
}

function filterParamsFor(col, dataService) {
  switch (col.filter) {
    case 'set': {
      const cardinality = col.cardinality ?? 0;
      const eager = cardinality < CARDINALITY_EAGER;
      return {
        filter: 'agSetColumnFilter',
        filterParams: {
          // Async values: in SSRM there is no row data to scan (parity §1.1).
          values: (params) =>
            dataService
              .getDistinctValues(col.id, col.cascadingValues ? dataService.currentFilterModel?.() : undefined)
              .then((vals) => params.success(vals))
              .catch(() => params.success([])),
          // Cascading values are opt-in per column: every filter change
          // invalidates N caches, so this is only worth it where traders
          // expect it (parity study §1.5).
          refreshValuesOnOpen: col.cascadingValues === true,
          suppressMiniFilter: cardinality <= CARDINALITY_MINI_FILTER,
          // Eager columns are cheap enough to prefetch at subscription time;
          // lazy ones only pay on open.
          eager,
        },
      };
    }
    case 'search-select':
      // Past ~10k distinct values AG-Grid ships the whole list to the browser
      // and the UX degrades regardless of virtualization. Prefix-query instead.
      return {
        filter: 'dshubSearchSelectFilter',
        filterParams: { colId: col.id, dataService, debounceMs: 250, limit: 100 },
      };
    case 'number': return withServerOptions({ filter: 'agNumberColumnFilter' }, 'number', dataService);
    case 'date': return withServerOptions({ filter: 'agDateColumnFilter' }, 'date', dataService);
    case 'text': return withServerOptions({ filter: 'agTextColumnFilter' }, 'text', dataService);
    case 'none': return { filter: false };
    default: return withServerOptions({ filter: 'agTextColumnFilter' }, 'text', dataService);
  }
}

function valueFormatterFor(col) {
  if (col.type !== 'float' && col.type !== 'integer') return undefined;
  const decimals = col.colDef?.precision ?? col.observed?.maxDecimals ?? 0;
  return (p) =>
    p.value === null || p.value === undefined
      ? ''
      : Number(p.value).toLocaleString(undefined, {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        });
}

/**
 * Build ColDefs for one artifact.
 *
 * @param {object} artifact  schema artifact (already reviewed)
 * @param {object} dataService  GridDataService — CSRM answers locally, SSRM/VRM
 *   go to the hub. Same interface either way, so this function does not branch
 *   on mode (architecture §8.5).
 */
export function buildColDefs(artifact, dataService, { includeHidden = false } = {}) {
  const companionColumns = new Set(
    artifact.columns.filter((c) => c.companion).map((c) => c.companion.column)
  );

  return artifact.columns
    // A companion is machine-facing: it exists to sort and aggregate the
    // display column. Showing both confuses traders and doubles the width.
    .filter((c) => !companionColumns.has(c.column))
    .filter((c) => includeHidden || c.colDef?.hide !== true)
    .map((col) => {
      const fragment = col.colDef ?? {};
      const isNumeric = col.type === 'float' || col.type === 'integer';

      const def = {
        colId: col.id,
        field: col.column,
        headerName: fragment.headerName ?? humanize(col.column),
        width: fragment.width ?? widthFor(col),
        ...filterParamsFor(col, dataService),
        sortable: true,
        resizable: true,
        enableRowGroup:
          fragment.enableRowGroup ?? (col.type === 'string' && (col.cardinality ?? 0) < CARDINALITY_LAZY),
        enableValue: fragment.enableValue ?? isNumeric,
      };

      if (isNumeric || fragment.type === 'rightAligned') {
        def.type = 'rightAligned';
        def.valueFormatter = valueFormatterFor(col);
      }
      if (fragment.aggFunc) def.aggFunc = fragment.aggFunc;

      // 32nds prices are strings; sorting and aggregation must run through the
      // numeric companion or "100-01" sorts before "99-16" (architecture §4.2).
      //
      // A custom comparator would work in CSRM and be SILENTLY IGNORED in SSRM
      // (parity study §3) — the sort key has to live in the data, not in a
      // callback. That is why the companion column exists at all.
      const sortColumn = fragment.sortColumn ?? col.companion?.column;
      if (sortColumn) {
        def.sortColumn = sortColumn;
        def.comparator = undefined;
      }

      return def;
    });
}

/**
 * Columns the engine must materialise: every visible column plus every
 * companion, since a companion is sorted on without being displayed.
 */
export function engineColumnsFor(artifact) {
  const cols = new Set();
  for (const c of artifact.columns) {
    cols.add(c.column);
    if (c.companion) cols.add(c.companion.column);
  }
  return [...cols];
}

/**
 * Mode selection is automatic and never a user choice (architecture §8.3).
 * Always visible in diagnostics so support can answer "why does this blotter
 * behave differently".
 */
export function selectMode(artifact, { heavilyGrouped = false } = {}) {
  const rows = artifact.estimatedRows ?? 0;
  if (rows > 200_000) return heavilyGrouped ? 'vrm' : 'ssrm';
  if (rows > 50_000) return heavilyGrouped ? 'ssrm' : 'csrm';
  return 'csrm';
}
