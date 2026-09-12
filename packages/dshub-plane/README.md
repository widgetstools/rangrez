# `@wellsfargo-starui/dshub-plane`

The SSRM plane over the `hub-rust` wasm engine: view lifecycle, windows,
group watches, predicate watches, edits, ticks.

Lives **here, beside the engine**, because it encodes engine behaviour that
is not in any documentation — the `sort`-not-`dir` key, the `|` pivot field
separator, whole-row upserts, splitBy-needs-groupBy. Those were learned by
probing. Keeping the plane in the same repo means a wasm rebuild fails the
probed-behaviour tests in the same commit, instead of surfacing as a silently
wrong grid in a downstream repo weeks later.

Extracted from stern-bak (`packages/data/host-data/src/runtime/ssrm`), which
had built and tested the whole thing. Moved rather than reimplemented so
there is one plane, one set of probed behaviours, one test suite.

## No dependencies

Deliberately. A plane that pins engine behaviour should not drag an app's
type tree behind it, so the two couplings to starui are structural:

- **Provider config** — the plane reads exactly four fields
  (`columnDefinitions`, `keyColumn`, `publishWindowMs`, `searchColumns`).
  Declared as `SsrmPlaneConfig`; starui's `SsrmProviderConfig` satisfies it
  without either side importing the other.
- **Expression AST** — `ssrmExpression.ts` re-declares the wire contract.
  starui's `ExpressionEngine` is still the only parser and the normative
  semantics are `hub-rust/tests/fixtures/ssrmExpressionContract.wire.json`.
  `SSRM_EXPR_CONTRACT_VERSION` is what detects drift.

## Tests

```sh
npm test -w @wellsfargo-starui/dshub-plane
```

92 tests. Twelve of them run against the REAL engine — `hub-rust/pkg`,
instantiated in-process (`initSync` + `RustHub.new()`), no SharedWorker and
no servers — covering T2 lifecycle through T7 pivot.

## Known: the test files are not typechecked

`tsconfig.json` excludes `*.test.ts`, matching the scope this code was
typechecked under in stern-bak. The move preserved that rather than widening
it, because fixing test code inside a move makes the diff unreviewable as a
move. It does hide real drift — at the time of extraction the fake hub in
`RustHubHost.test.ts` was missing the four lifecycle methods
(`delete_rows`, `truncate`, `replace_snapshot`, `drop_table`) that
`RustHubLike` now requires. It passes at runtime because that test never
calls them. Worth a follow-up that widens the scope and fixes what falls out.
