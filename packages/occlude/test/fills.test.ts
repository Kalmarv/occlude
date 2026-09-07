import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BUILTIN_FILL_NAMES, circle, clearFills, compileSketch, encodeScene, fill, fillAsset, initOcclude,
  isBuiltinFill, loadFillModule, registerFill, render, renderEncoded, resolveFill, rulings,
  scanFillNames, sketch, type WasmModule,
} from '../src/index.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(
    new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
  );
  await initOcclude(readFileSync(wasmPath));
});

describe('fill registry', () => {
  it('ships exactly the ink-immutable built-ins, resolved from the package', () => {
    expect([...BUILTIN_FILL_NAMES].sort()).toEqual(['crosshatch', 'hatch', 'solid', 'stipple']);
    for (const n of BUILTIN_FILL_NAMES) expect(resolveFill(n)?.generate).toBeTypeOf('function');
    expect(isBuiltinFill('hatch')).toBe(true);
    expect(isBuiltinFill('mine')).toBe(false);
  });

  it('refuses to shadow a built-in', () => {
    expect(() => registerFill('hatch', { params: {}, generate: () => [] })).toThrow(/built-in/);
  });

  it('scans literal fill names, including the CJS indirect call form', () => {
    const src = `
      circle(1, 1, 1, { fill: fill('grain', { d: 1 }) });
      rect(0, 0, 1, 1, { fill: (0, occlude_1.fill)("stipple") });
      const name = 'nope'; fill(name);
    `;
    expect(scanFillNames(src).sort()).toEqual(['grain', 'stipple']);
  });
});

describe('loadFillModule', () => {
  const ESM = `
import { fillAsset, rulings } from 'occlude';
export default fillAsset({
  params: { spacing: 2 },
  generate(region, p, ctx) { return rulings(region, { spacing: p.spacing, angle: 30 }); },
});`;

  it('evaluates an ESM fill file, registers it, and renders through fill(name)', () => {
    clearFills();
    loadFillModule('lines30', ESM);
    expect(resolveFill('lines30')).toBeDefined();
    const def = sketch({ seed: 1 }, () => circle(50, 50, 20, { fill: fill('lines30') }));
    const out = render(def, { paper: 'Square20' });
    expect(out.frags.filter((f) => f.origin >= 2).length).toBeGreaterThan(10);
    // Params at the call site override the declared defaults.
    const dense = render(
      sketch({ seed: 1 }, () => circle(50, 50, 20, { fill: fill('lines30', { spacing: 0.5 }) })),
      { paper: 'Square20' },
    );
    expect(dense.stats.fillPrims).toBeGreaterThan(out.stats.fillPrims * 2);
  });

  it('accepts the already-CommonJS form a TS emit produces', () => {
    clearFills();
    const cjs = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const occlude_1 = require("occlude");
exports.default = (0, occlude_1.fillAsset)({ params: {}, generate: () => [] });`;
    expect(loadFillModule('emitted', cjs).params).toEqual({});
  });

  it('refuses any import but occlude, before running a line', () => {
    let ran = false;
    (globalThis as Record<string, unknown>).__fillProbe = () => { ran = true; };
    expect(() => loadFillModule('bad', `
import { fillAsset } from 'occlude';
import fs from 'node:fs';
globalThis.__fillProbe();
export default fillAsset({ params: {}, generate: () => [] });`)).toThrow(/only from 'occlude'.*node:fs/);
    expect(() => loadFillModule('bad2', `const x = require('fs'); module.exports.default = { params: {}, generate: () => [] };`))
      .toThrow(/only from 'occlude'/);
    expect(ran).toBe(false);
    expect(resolveFill('bad')).toBeUndefined();
  });

  it('reads imports, not prose: a clone header saying "from \'hatch\'" is fine', () => {
    clearFills();
    const src = `// Cloned from 'hatch' — this copy is yours; 'hatch' itself never changes.
import {
  fillAsset,
  rulings,
} from 'occlude';
export default fillAsset({ params: {}, generate: (r) => rulings(r, { spacing: 1 }) });`;
    expect(loadFillModule('hatch-2', src).params).toEqual({});
    expect(() => loadFillModule('multi', src.replace("} from 'occlude'", "} from 'lodash'")))
      .toThrow(/found 'lodash'/);
    expect(() => loadFillModule('side', `import 'node:fs';\n${src}`)).toThrow(/node:fs/);
    expect(() => loadFillModule('dyn', `${src}\nimport('node:fs');`)).toThrow(/node:fs/);
  });

  it('refuses dynamic import() in any form, and unsupported ESM import forms', () => {
    const body = "export default fillAsset({ params: {}, generate: () => [] });";
    expect(() => loadFillModule('dyn2', `import { fillAsset } from 'occlude';\nconst m = import(\`/api/x\`);\n${body}`))
      .toThrow(/dynamic import/);
    expect(() => loadFillModule('ns', `import * as o from 'occlude';\nexport default o.fillAsset({ params: {}, generate: () => [] });`))
      .toThrow(/import \{ … \} from 'occlude'/);
  });

  it('hands a fill the pure surface only — no host setters, registry, or render entry points', () => {
    clearFills();
    const probe = loadFillModule('probe', `
import { fillAsset } from 'occlude';
const o = require('occlude');
export default fillAsset({ params: { keys: Object.keys(o) }, generate: () => [] });`);
    const keys = probe.params.keys as string[];
    expect(keys).toContain('rulings');
    expect(keys).toContain('mm');
    for (const k of ['setSeedHint', 'setPenLibrary', 'setPaperHint', 'getState', 'registerFill', 'clearFills', 'render', 'loadFillModule']) {
      expect(keys).not.toContain(k);
    }
  });

  it('scans only well-formed names', () => {
    expect(scanFillNames("fill('../sketches/x'); fill('my fill'); fill('ok_1')")).toEqual(['ok_1']);
  });

  it('refuses a file whose default export is not a fill module', () => {
    expect(() => loadFillModule('notafill', `export default 42;`)).toThrow(/fillAsset/);
    expect(() => loadFillModule('hatch', ESM)).toThrow(/built-in/);
  });

  it('unregistered names fail loudly at encode, naming the panel', () => {
    clearFills();
    const def = sketch({ seed: 1 }, () => circle(50, 50, 20, { fill: fill('ghost') }));
    expect(() => render(def, { paper: 'Square20' })).toThrow(/unknown fill 'ghost'.*Fills page/);
  });
});

describe('rulings', () => {
  it('is the public primitive under hatch — paper-anchored lines overshoot the bbox', () => {
    const region = { bbox: { x: 10, y: 10, w: 20, h: 10 }, path: [], contains: () => true, area: 200 };
    const lines = rulings(region, { spacing: 2 });
    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const l of lines) {
      expect(l.type).toBe('line');
      if (l.type === 'line') {
        expect(l.y1).toBe(l.y2); // angle 0: horizontal
        expect(l.y1 % 2).toBeCloseTo(0); // paper grid: multiples of spacing
        expect(l.x1).toBeLessThan(10); // overshoot
      }
    }
  });
});

describe('fill by value', () => {
  it('fill(asset, params) uses a fillAsset defined in the sketch, no library involved', () => {
    clearFills();
    const bars = fillAsset({
      params: { spacing: 3, angle: 90 },
      generate(region, p) { return rulings(region, { spacing: p.spacing, angle: p.angle }); },
    });
    const out = render(
      sketch({ seed: 1 }, () => circle(50, 50, 20, { fill: fill(bars, { spacing: 1 }) })),
      { paper: 'Square20' },
    );
    expect(out.stats.fillPrims).toBeGreaterThan(30);
    // Nothing was registered by name: the value form is execution-only.
    expect(resolveFill('bars')).toBeUndefined();
  });
});

describe('pass-1 handle lifetime', () => {
  const stub = (onFree: () => void, finish: WasmModule['wasm_finish']): WasmModule =>
    ({
      wasm_prepare: (prims: Float64Array) => ({
        // One job: shape 0, one contour of two rows (the circle's arcs).
        jobs_index: new Uint32Array([0, 0, 1]),
        jobs_contours: new Uint32Array([0, 2]),
        jobs_prims: prims.slice(0, 18),
        free: onFree,
      }),
      wasm_finish: finish,
    }) as unknown as WasmModule;

  it('frees the handle when a fill throws (and never reaches finish)', () => {
    compileSketch(sketch({ seed: 1 }, () =>
      circle(50, 50, 20, { fill: () => { throw new Error('boom'); } })));
    const scene = encodeScene({ paper: 'Square20' });
    let freed = 0;
    const mod = stub(() => { freed++; }, () => { throw new Error('finish must not run'); });
    expect(() => renderEncoded(mod, scene)).toThrow('boom');
    expect(freed).toBe(1);
  });

  it('never frees a handle that finish consumed', () => {
    compileSketch(sketch({ seed: 1 }, () => circle(50, 50, 20, { fill: fill('hatch') })));
    const scene = encodeScene({ paper: 'Square20' });
    let freed = 0;
    const mod = stub(
      () => { freed++; },
      () => ({
        prims: new Float64Array(0), frags: new Float64Array(0),
        stats: new Float64Array(6), ghost: new Float64Array(0),
      }),
    );
    renderEncoded(mod, scene);
    expect(freed).toBe(0);
  });
});

describe('stipple: the disk guarantee, whatever order the neighbourhood is judged in', () => {
  const dots = (opts: { w: number; h: number; density: number; penWidth: number; seed?: number }) => {
    const gen = resolveFill('stipple')!.generate;
    let s = opts.seed ?? 7;
    const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647);
    const region = { bbox: { x: 0, y: 0, w: opts.w, h: opts.h } } as never;
    const ctx = {
      penWidth: opts.penWidth,
      rnd,
      coarsen: 1,
      len: (l: unknown) => (typeof l === 'number' ? l : (l as { value: number }).value),
      anchor: { x: 0, y: 0, a: 1, b: 0, rotation: 0 },
    } as never;
    return gen(region, { density: opts.density, minDist: undefined } as never, ctx) as { x: number; y: number }[];
  };

  it('no two dots are closer than the disk radius, and none escapes the box', () => {
    for (const [w, h, density, penWidth, r] of [
      [100, 100, 0.5, 1, 4],   // minDist 2, density 0.5 → r = 4
      [100, 100, 1, 1, 2],     // r = 2: a denser field, more neighbours in range
      [200, 40, 0.25, 0.5, 4], // a wide thin box
      [7, 7, 1, 1, 2],         // a box only a few cells across
    ] as const) {
      const out = dots({ w, h, density, penWidth });
      expect(out.length).toBeGreaterThan(3);
      for (const d of out) {
        expect(d.x).toBeGreaterThanOrEqual(0);
        expect(d.y).toBeGreaterThanOrEqual(0);
        expect(d.x).toBeLessThanOrEqual(w);
        expect(d.y).toBeLessThanOrEqual(h);
      }
      // every pair, brute force: a neighbourhood cell left out of the scan
      // shows up here as a pair closer than r
      let worst = Infinity;
      for (let i = 0; i < out.length; i++) {
        for (let j = i + 1; j < out.length; j++) {
          const d = Math.hypot(out[i].x - out[j].x, out[i].y - out[j].y);
          if (d < worst) worst = d;
        }
      }
      expect(worst).toBeGreaterThanOrEqual(r);
    }
  });

  it('is a pure function of the box, the params and the stream', () => {
    const a = dots({ w: 60, h: 60, density: 0.5, penWidth: 1 });
    const b = dots({ w: 60, h: 60, density: 0.5, penWidth: 1 });
    expect(b).toEqual(a);
    const c = dots({ w: 60, h: 60, density: 0.5, penWidth: 1, seed: 8 });
    expect(c).not.toEqual(a);
    // a degenerate box draws nothing
    expect(dots({ w: 0, h: 10, density: 0.5, penWidth: 1 })).toEqual([]);
  });
});
