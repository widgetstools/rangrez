// Shapes the app hands to the hub. These mirror the DataSource Hub control
// protocol loosely — enough to be type-safe on the app side without duplicating
// the whole spec (that lives in @wellsfargo-starui/dshub-spec).

export type ColumnType =
  | 'string'
  | 'integer'
  | 'int'
  | 'float'
  | 'double'
  | 'number'
  | 'boolean';

export interface ColumnDef {
  name: string;
  type: ColumnType;
}

/** A datasource the app asks the hub to cache + publish (bootstrapped on connect). */
export interface DatasourceConfig {
  id: string;
  schemaRef?: string;
  keyColumns: string[];
  columns: ColumnDef[];
  /** Upstream connection (STOMP / socket.io / REST). */
  connection: Record<string, unknown>;
  snapshot?: Record<string, unknown>;
  updates?: Record<string, unknown>;
  /** Optional hub-side knobs (throttle, conflation, …). */
  config?: Record<string, unknown>;
}

export type GridMode = 'csrm' | 'ssrm';

/** Presentation hints the provider turns into colDefs + row model wiring. */
export interface GridHints {
  /** Row-group columns, outermost first. */
  group?: string[];
  /** Aggregations: column → aggFunc (e.g. { marketValue: 'sum' }). */
  agg?: Record<string, string>;
}

export interface HubProviderConfig {
  /** ws:// URL of the hub (Rust sidecar or in-browser). */
  hubUrl: string;
  /** The datasource to bootstrap + subscribe to. */
  datasource: DatasourceConfig;
  /** Subscription params (e.g. { clientId, rate, batchSize }). */
  params?: Record<string, unknown>;
  mode?: GridMode;
  grid?: GridHints;
}
