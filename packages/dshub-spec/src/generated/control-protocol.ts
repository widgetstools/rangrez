// GENERATED — do not edit. Source: https://wellsfargo-starui/dshub/control-protocol.schema.json
// Regenerate with `npm run codegen`. CI asserts this file matches.

export interface Envelope {
    id: string;
    type: string;
  }

export interface SubscriptionRef {
    datasourceId: string;
    params?: Record<string, unknown>;
  }

/** Our shape, not Perspective's. The engine adapter translates (architecture §8.1). */
export interface ViewSpec {
    filter?: Record<string, unknown>[];
    groupBy?: string[];
    splitBy?: string[];
    sort?: Array<{
    column: string;
    dir: "asc" | "desc";
  }>;
    aggregates?: Record<string, string>;
    columns?: string[];
    expressions?: Record<string, string>;
    depth?: number;
  }

/** architecture §5.4. 'stale' is what lets a blotter grey out — silence must never be ambiguous between a quiet market and a dead upstream. */
export type State =
  "idle" | "connecting" | "snapshotting" | "live" | "stale" | "recovering" | "failed";

/** Typed so the UI can act rather than render a string. */
export type ErrorCode =
  "unknown-datasource" | "invalid-params" | "config-invalid" | "config-conflict" | "snapshot-timeout" | "snapshot-truncated" | "upstream-unavailable" | "row-limit-exceeded" | "memory-ceiling-exceeded" | "transport-unavailable" | "protocol-version-mismatch" | "unsupported-expression" | "command-failed" | "backpressure-disconnect" | "internal";

export type ClientMessage =
  {
    id: string;
    type: "hello";
    protocolVersion: number;
    appId: string;
    token?: string;
    bundleVersion?: number;
    bundleChecksum?: string;
  }
  | {
    id: string;
    type: "pushConfig";
    bundle: Record<string, unknown>;
  }
  | {
    id: string;
    type: "subscribe";
    ref: SubscriptionRef;
    delivery?: "rows" | "notify";
  }
  | {
    id: string;
    type: "unsubscribe";
    ref: SubscriptionRef;
  }
  | {
    id: string;
    type: "distinctValues";
    ref: SubscriptionRef;
    colId: string;
    contextFilter?: Record<string, unknown>[];
    limit?: number;
    withCounts?: boolean;
  }
  | {
    id: string;
    type: "searchValues";
    ref: SubscriptionRef;
    colId: string;
    prefix: string;
    limit?: number;
  }
  | {
    id: string;
    type: "rowCount";
    ref: SubscriptionRef;
    view?: ViewSpec;
  }
  | {
    id: string;
    type: "aggregates";
    ref: SubscriptionRef;
    specs: {
    column: string;
    fn: string;
    as?: string;
  }[];
    view?: ViewSpec;
  }
  | {
    id: string;
    type: "openView";
    ref: SubscriptionRef;
    view: ViewSpec;
  }
  | {
    id: string;
    type: "readWindow";
    viewId: string;
    startRow?: number;
    endRow?: number;
  }
  | {
    id: string;
    type: "expandRow";
    viewId: string;
    index: number;
    collapse?: boolean;
  }
  | {
    id: string;
    type: "disposeView";
    viewId: string;
  }
  | {
    id: string;
    type: "rank";
    ref: SubscriptionRef;
    key: string;
    view?: ViewSpec;
  }
  | {
    id: string;
    type: "export";
    ref: SubscriptionRef;
    fmt: "csv" | "xlsx";
    view?: ViewSpec;
  }
  | {
    id: string;
    type: "scan";
    ref: SubscriptionRef;
    view?: ViewSpec;
    batchRows?: number;
  }
  | {
    id: string;
    type: "command";
    ref: SubscriptionRef;
    verb: string;
    idempotencyKey: string;
    payload?: Record<string, unknown>;
    timeoutMs?: number;
  }
  | {
    id: string;
    type: "alertSubscribe";
    ref: SubscriptionRef;
    ruleId: string;
    predicate?: string;
  }
  | {
    id: string;
    type: "stats";
    subscribe?: boolean;
  }
  | {
    id: string;
    type: "ack";
    ref?: SubscriptionRef;
    seq: number;
  }
  | {
    id: string;
    type: "watchGroups";
    ref: SubscriptionRef;
    groupBy: string[];
    aggregates?: Record<string, string>;
  }
  | {
    id: string;
    type: "alertUnsubscribe";
    ruleId: string;
  };

export type HubMessage =
  {
    id: string;
    type: "configAck";
    status: "current" | "hub-newer" | "app-newer" | "conflict";
    bundleVersion: number;
    bundleChecksum?: string;
    bundle?: Record<string, unknown>;
  }
  | {
    id: string;
    type: "subscribed";
    tableName: string;
    schemaRef: string;
    mode: "csrm" | "ssrm" | "vrm";
    estimatedRows?: number;
  }
  | {
    id: string;
    type: "state";
    ref: SubscriptionRef;
    state: State;
    since?: string;
    detail?: string;
  }
  | {
    id: string;
    type: "schemaChanged";
    ref: SubscriptionRef;
    schemaRef: string;
  }
  | {
    id: string;
    type: "result";
    payload: unknown;
    partial?: boolean;
  }
  | {
    id: string;
    type: "rowDelta";
    ref: SubscriptionRef;
    columns: Record<string, unknown>;
    rows?: number;
    seq?: number;
  }
  | {
    id: string;
    type: "alert";
    ruleId: string;
    row: Record<string, unknown>;
    firedAt?: string;
  }
  | {
    id: string;
    type: "commandResult";
    idempotencyKey: string;
    outcome: "applied" | "rejected" | "duplicate" | "unknown";
    detail?: string;
  }
  | {
    id: string;
    type: "statsTick";
    processMemoryBytes?: number;
    processCeilingBytes?: number;
    datasources: Array<{
    datasourceId: string;
    state: State;
    msgsInPerSec?: number;
    msgsOutPerSec?: number;
    conflationRatio?: number;
    cacheRows?: number;
    memoryBytes?: number;
    subscribers?: number;
    openViews?: number;
    backpressureRung?: "none" | "conflating" | "snapshot-refresh" | "disconnecting";
    lastError?: string;
    configVersion?: number;
  }>;
  }
  | {
    id: string;
    type: "error";
    code: ErrorCode;
    message: string;
    ref?: SubscriptionRef;
    retryable?: boolean;
  }
  | {
    id: string;
    type: "refresh";
    ref: SubscriptionRef;
    reason?: "backpressure" | "schema-change" | "reconnect";
    detail?: string;
  }
  | {
    id: string;
    type: "groupDelta";
    ref: SubscriptionRef;
    groupBy?: string[];
    changed: Record<string, unknown>[];
  };

export type ControlMessage =
  ClientMessage
  | HubMessage;
