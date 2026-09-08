/**
 * Worker environment shim. Imported FIRST — static imports evaluate in order,
 * so this runs before Perspective's module body.
 *
 * Perspective 5.x's browser build resolves its wasm by calling
 * `customElements.get("perspective-viewer")` to reuse a module the viewer
 * element may already hold. `customElements` does not exist in a Worker or
 * SharedWorker, so importing the module throws before any of our code runs.
 *
 * A stub makes that lookup miss and fall through to the wasm the inline build
 * carries.
 */
if (typeof globalThis.customElements === 'undefined') {
  globalThis.customElements = {
    get: () => undefined,
    define: () => {},
    whenDefined: () => new Promise(() => {}),
  };
}
