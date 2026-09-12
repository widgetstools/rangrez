import { describe, expect, it } from 'vitest';
import {
  FLATTEN_MAX_DEPTH,
  FLATTEN_SEPARATOR,
  flattenRow,
  flattenRows,
  SSRM_PIVOT_FIELD_SEPARATOR,
  toViewSpec,
} from './index.js';

describe('ssrm runtime barrel', () => {
  it('re-exports the page-safe helpers and constants', () => {
    expect(flattenRow).toEqual(expect.any(Function));
    expect(flattenRows).toEqual(expect.any(Function));
    expect(toViewSpec).toEqual(expect.any(Function));
    expect(SSRM_PIVOT_FIELD_SEPARATOR).toBe('|');
    expect(FLATTEN_SEPARATOR).toBe('_');
    expect(FLATTEN_MAX_DEPTH).toBe(6);
  });

  it('exports NO WASM plane values — the barrel is what page bundles import', async () => {
    // RustHubHost / SsrmWasmPlane are worker-only (they resolve the vendored
    // WASM); a value re-export here would make every page build try to
    // resolve `@starui/dshub` and fail. The hub imports them relatively.
    const barrel = await import('./index.js');
    expect('RustHubHost' in barrel).toBe(false);
    expect('SsrmWasmPlane' in barrel).toBe(false);
    expect('loadVendoredRustHub' in barrel).toBe(false);
  });
});
