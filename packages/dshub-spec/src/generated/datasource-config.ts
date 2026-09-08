// GENERATED — do not edit. Source: https://wellsfargo-starui/dshub/datasource-config.schema.json
// Regenerate with `npm run codegen`. CI asserts this file matches.

/** live=applied in place · resubscribe=drop and re-establish upstream · rebuild=destroy and recreate the table · restart=host restart required */
export type ReloadClass =
  "live" | "resubscribe" | "rebuild" | "restart";

/** Lowercase id; dots and dashes allowed after the first character (names like "test.dp" are the working convention). */
export type Id =
  string;

export interface Connection {
    id: Id;
    kind: "stomp" | "ws" | "socketio" | "rest" | "amps" | "solace";
    url: string;
    vhost?: string;
    heartbeat?: {
    outMs?: number;
    inMs?: number;
  };
    auth?: {
    mode?: "token-from-app" | "none";
  };
    credentialRef?: string;
    reconnect?: {
    initialMs?: number;
    maxMs?: number;
    factor?: number;
    maxAttempts?: number | null;
  };
    failover?: string[];
    tls?: {
    verify?: boolean;
    caRef?: string;
  };
    updatesUrl?: string;
    updatesKind?: "stomp" | "ws" | "socketio";
  }

export interface Datasource {
    id: Id;
    connectionRef: Id;
    schemaRef: string;
    snapshot: Snapshot;
    updates?: Updates;
    keyColumns: string[];
    opField?: {
    path: string;
    map: Record<string, "insert" | "update" | "delete">;
  };
    softDelete?: {
    column: string;
    reapAfterMs?: number;
  };
    flatten?: Flatten;
    coercions?: Coercion[];
    batch?: {
    maxMs?: number;
    maxRows?: number;
    dedupeByKey?: boolean;
  };
    conflation?: {
    defaultIntervalMs?: number;
    maxIntervalMs?: number;
  };
    params?: Record<string, {
    type: "string" | "number" | "boolean";
    required?: boolean;
    default?: unknown;
  }>;
    sharing?: {
    strategy?: "none" | "superset";
    supersetParams?: Record<string, unknown>;
  };
    lifecycle?: {
    prewarm?: boolean;
    idleTeardownMs?: number;
    maxRows?: number;
  };
  }

export interface Updates {
    destination: string;
    selector?: string | null;
    bodyShape?: "record" | "record-array";
    subscribeBeforeSnapshot?: boolean;
    updatesDuringSnapshot?: "buffer" | "apply-live" | "none-expected";
  }

/** Discriminated union on mode (architecture §3.4). */
export type Snapshot =
  {
    mode: "trigger-reply";
    triggerDestination: string;
    triggerBody?: unknown;
    replyDestination: string;
    correlationHeader?: string;
    endOfSnapshot: EndOfSnapshot;
    expectedCountHeader?: string;
    timeoutMs?: number;
    quietPeriodMs?: number | null;
  }
  | {
    mode: "rest-then-subscribe";
    url: string;
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    pagination?: {
    style?: "offset" | "cursor" | "none";
    pageSize?: number;
    cursorPath?: string;
  };
    endOfSnapshot: EndOfSnapshot;
    expectedCountHeader?: string;
    timeoutMs?: number;
    quietPeriodMs?: number | null;
  }
  | {
    mode: "subscribe-with-replay";
    replayFrom: string;
    endOfSnapshot: EndOfSnapshot;
    expectedCountHeader?: string;
    timeoutMs?: number;
    quietPeriodMs?: number | null;
  }
  | {
    mode: "subscribe-only";
    endOfSnapshot?: EndOfSnapshot;
    expectedCountHeader?: string;
    timeoutMs?: number;
    quietPeriodMs?: number | null;
  }
  | {
    mode: "file-seed";
    path: string;
    endOfSnapshot?: EndOfSnapshot;
    expectedCountHeader?: string;
    timeoutMs?: number;
    quietPeriodMs?: number | null;
  };

/** A missing sentinel must fail the subscription loudly. Going live with a silently truncated book is the worst failure in this system (architecture §3.4). */
export type EndOfSnapshot =
  {
    kind: "sentinel-header";
    header: string;
    value: string;
  }
  | {
    kind: "sentinel-body";
    path: string;
    value: unknown;
  }
  | {
    kind: "sentinel-substring";
    value: string;
    caseSensitive?: boolean;
  }
  | {
    kind: "count-reached";
  }
  | {
    kind: "stream-end";
  };

export interface Flatten {
    separator?: "_" | "/" | "-" | ":";
    maxDepth?: number;
    arrays?: Record<string, {
    strategy: "index-pin" | "aggregate" | "json-string" | "explode";
    arity?: number;
    aggregate?: "count" | "sum" | "min" | "max";
    aggregatePath?: string;
    childTable?: Id;
  }>;
  }

export interface Coercion {
    path: string;
    kind: "ticks-to-decimal" | "string-to-number" | "epoch-to-datetime" | "scaled-integer";
    companion?: string;
    scale?: number;
  }

export interface ConfigBundle {
    specVersion: "1.0";
    connections: Connection[];
    datasources: Datasource[];
  }
