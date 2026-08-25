/**
 * Render worker: owns the wasm module so geometry never blocks the editor.
 * Keeps the last render's raw buffers so G-code/SVG exports reuse them
 * instead of re-rendering.
 */

import initCore, * as core from 'occlude-core';
import { renderEncoded, type EncodedScene, type WasmModule } from 'occlude';

interface RenderMsg {
  type: 'render';
  id: number;
  scene: EncodedScene;
}

interface GcodeMsg {
  type: 'gcode';
  id: number;
  profileJson: string;
  budget: number;
}

interface SvgMsg {
  type: 'svg';
  id: number;
  width: number;
  height: number;
  background: string | undefined;
  onlyPen: number;
}

interface PngMsg {
  type: 'png';
  id: number;
  width: number;
  height: number;
  scale: number;
  background: string | undefined;
}

type Msg = RenderMsg | GcodeMsg | SvgMsg | PngMsg;

const ready = initCore();
const mod = core as unknown as WasmModule;

let last: { prims: Float64Array; frags: Float64Array; pensJson: string } | null = null;

self.onmessage = async (e: MessageEvent<Msg>) => {
  await ready;
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'render': {
        const raw = renderEncoded(mod, msg.scene);
        last = { prims: raw.prims, frags: raw.frags, pensJson: msg.scene.pensJson };
        // The preview needs the buffers too, so copy rather than transfer the
        // cached ones.
        self.postMessage(
          {
            type: 'render',
            id: msg.id,
            prims: raw.prims.slice(),
            frags: raw.frags.slice(),
            stats: raw.stats,
            renderMs: raw.renderMs,
          },
          { transfer: [] },
        );
        break;
      }
      case 'gcode': {
        if (!last) throw new Error('nothing rendered yet');
        const json = mod.wasm_export_gcode(
          last.prims,
          last.frags,
          last.pensJson,
          msg.profileJson,
          msg.budget,
        );
        self.postMessage({ type: 'gcode', id: msg.id, json });
        break;
      }
      case 'png': {
        if (!last) throw new Error('nothing rendered yet');
        const png = (core as unknown as WasmModule).wasm_export_png(
          last.prims,
          last.frags,
          last.pensJson,
          msg.width,
          msg.height,
          msg.scale,
          msg.background,
        );
        self.postMessage({ type: 'png', id: msg.id, png }, { transfer: [png.buffer] });
        break;
      }
      case 'svg': {
        if (!last) throw new Error('nothing rendered yet');
        const svg = mod.wasm_export_svg(
          last.prims,
          last.frags,
          last.pensJson,
          msg.width,
          msg.height,
          msg.background,
          msg.onlyPen,
        );
        self.postMessage({ type: 'svg', id: msg.id, svg });
        break;
      }
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
