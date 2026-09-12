/** Vitest stand-in for `@starui/dshub` — real WASM is worker-only. */
export default async function init(): Promise<void> {
  throw new Error('[ssrm] vitest stub: inject a RustHubFactory instead of loading WASM');
}

export const RustHub = {
  new(): never {
    throw new Error('[ssrm] vitest stub: inject a RustHubFactory instead of loading WASM');
  },
};
