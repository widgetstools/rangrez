// GENERATED — do not edit. Source: https://wellsfargo-starui/dshub/schema-artifact.schema.json
// Regenerate with `npm run codegen`. CI asserts this file matches.

/** Widen int->float on conflict, never narrow. Numeric-looking strings stay strings — CUSIP, SEDOL, ISIN and account numbers lose leading zeros or precision otherwise (architecture §4.1). */
export type PerspectiveType =
  "string" | "integer" | "float" | "boolean" | "datetime" | "date";

/** Chosen from observed cardinality: <500 set eager · 500-10k set lazy · >10k search-select. AG-Grid ships the whole set-filter value list to the browser, so beyond ~10k the UX degrades regardless of virtualization (parity study §1.4). */
export type FilterStrategy =
  "set" | "search-select" | "text" | "number" | "date" | "none";

export interface Column {
    id: string;
    path: string;
    column: string;
    type: PerspectiveType;
    nullable?: boolean;
    cardinality?: number;
    filter?: FilterStrategy;
    cascadingValues?: boolean;
    observed?: {
    nonNullCount?: number;
    nullCount?: number;
    min?: unknown;
    max?: unknown;
    maxStringLength?: number;
    maxDecimals?: number;
    samples?: unknown[];
  };
    companion?: {
    column: string;
    type: PerspectiveType;
    coercion: "ticks-to-decimal" | "string-to-number" | "epoch-to-datetime" | "scaled-integer";
  };
    colDef?: {
    headerName?: string;
    width?: number;
    type?: string;
    enableRowGroup?: boolean;
    enableValue?: boolean;
    sortColumn?: string;
    aggFunc?: string;
    precision?: number;
    hide?: boolean;
  };
  }

export interface SchemaArtifact {
    id: string;
    version: number;
    inferredAt?: string;
    inferredFrom?: {
    messageCount?: number;
    destination?: string;
    minNonNullPerLeaf?: number;
  };
    reviewedBy?: string;
    keyColumns: string[];
    columns: Column[];
    volatileSortColumns?: string[];
    setFilterColumns?: string[];
    estimatedRows?: number;
  }
