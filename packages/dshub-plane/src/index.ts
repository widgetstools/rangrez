export { flattenRow, flattenRows, FLATTEN_SEPARATOR, FLATTEN_MAX_DEPTH } from './flattenRow.js';
export { toViewSpec, toViewSpecResult, filterModelToNodes } from './toViewSpec.js';
export type { ToViewSpecOptions, ToViewSpecResult } from './toViewSpec.js';
// NO value exports of RustHubHost / SsrmWasmPlane here: they are worker-only
// (RustHubHost dynamic-imports the vendored WASM, which only the worker build
// aliases), and this barrel is what `@wellsfargo-starui/data/runtime` serves to PAGE
// code. The hub reaches them by relative import; a value re-export here makes
// every page bundle try to resolve `@starui/dshub` and fail.
export type { RustHubLike, RustHubFactory } from './RustHubHost.js';
export type { SsrmPlaneBootCfg } from './SsrmWasmPlane.js';
export { SSRM_PIVOT_FIELD_SEPARATOR } from './ssrmTypes.js';
export type {
  SsrmColRef,
  SsrmColumnValuesRequest,
  SsrmColumnValuesResult,
  SsrmFilterCondition,
  SsrmFilterNode,
  SsrmFilterOp,
  SsrmFilterOr,
  SsrmGetRowsRequest,
  SsrmGetRowsResult,
  SsrmAggFn,
  SsrmAggSpec,
  SsrmAggregatesRequest,
  SsrmAggregatesResult,
  SsrmRowCountRequest,
  SsrmRowCountResult,
  SsrmTickPayload,
  SsrmWatchGroupsRequest,
  SsrmWatchPredicateRequest,
  SsrmViewSpec,
  SsrmComputedColumnSpec,
  SsrmExprNode,
} from './ssrmTypes.js';
