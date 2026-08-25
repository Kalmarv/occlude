/**
 * WASM initialisation. Browser (Vite) resolves the wasm URL automatically;
 * Node tests pass the wasm bytes explicitly.
 */

import initCore, * as core from 'occlude-core';
import { setWasm } from './render.js';

let ready: Promise<void> | null = null;

/**
 * Initialise the geometry core. Call once before `render()`.
 * `wasmInput` may be a URL, Request, or BufferSource (Node: file bytes).
 */
export function initOcclude(
  wasmInput?: BufferSource | string | URL | Request,
): Promise<void> {
  ready ??= (async () => {
    await initCore(wasmInput ? { module_or_path: wasmInput } : undefined);
    setWasm(core as never);
  })();
  return ready;
}
