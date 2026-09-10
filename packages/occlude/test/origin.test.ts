import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  circle, evalPrim, group, initOcclude, rect, render, setPaperHint, sketch,
} from '../src/index.js';
import type { SketchDef, Tree } from '../src/index.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(
    new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
  );
  await initOcclude(readFileSync(wasmPath));
  // The sketched box follows the paper hint; the render fixes the paper.
  // A test compares geometry, so the two must agree (the studio always
  // sets the hint to the chosen paper).
  setPaperHint(200, 200);
});

/** Ink extent of a sketch, in paper mm — what the transform did. */
function ink(def: SketchDef): { frags: number; box: number[] } {
  const out = render(def, { paper: 'Square20' });
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const frag of out.frags) {
    for (const s of [0, 0.5, 1]) {
      const [px, py] = evalPrim(frag.geom, s);
      x0 = Math.min(x0, px);
      y0 = Math.min(y0, py);
      x1 = Math.max(x1, px);
      y1 = Math.max(y1, py);
    }
  }
  return { frags: out.stats.fragments, box: [x0, y0, x1, y1] };
}

function sameInk(a: { frags: number; box: number[] }, b: { frags: number; box: number[] }): void {
  expect(a.frags).toBe(b.frags);
  for (let k = 0; k < 4; k++) expect(a.box[k]).toBeCloseTo(b.box[k], 6);
}

describe('origin: the pivot for rotate and scale', () => {
  it("scales about the drawable's centre — exactly the ritual it replaces", () => {
    const s = 0.6;
    const ritual = ink(sketch({}, (t) => group({ scale: s, translate: [t.cx * (1 - s), t.cy * (1 - s)] }, circle(30, 30, 12))));
    sameInk(ink(sketch({}, () => group({ scale: s, origin: 'center' }, circle(30, 30, 12)))), ritual);
  });

  it('means the same on a shape as on a group around it', () => {
    const wrapped = ink(sketch({}, () => group({ scale: 0.5, rotate: 30, origin: 'center' }, circle(30, 30, 12))));
    sameInk(ink(sketch({}, () => circle(30, 30, 12, { scale: 0.5, rotate: 30, origin: 'center' }))), wrapped);
  });

  it('is the pivot the transform says: scale about o is translate by o(1-s) then scale', () => {
    const o: [number, number] = [20, 30];
    const s = 0.5;
    sameInk(
      ink(sketch({}, () => rect(10, 20, 30, 20, { scale: s, origin: o }))),
      ink(sketch({}, () => rect(10, 20, 30, 20, { translate: [o[0] * (1 - s), o[1] * (1 - s)], scale: s }))),
    );
  });

  it('is the pivot the transform says: a half turn about o is translate by 2o then turn', () => {
    const o: [number, number] = [20, 30];
    sameInk(
      ink(sketch({}, () => rect(10, 20, 30, 20, { rotate: 180, origin: o }))),
      ink(sketch({}, () => rect(10, 20, 30, 20, { translate: [o[0] * 2, o[1] * 2], rotate: 180 }))),
    );
  });

  it('leaves the user origin as the default, and a translate in the same op is outside the pivot', () => {
    sameInk(
      ink(sketch({}, () => rect(10, 20, 30, 20, { rotate: 90, origin: [0, 0] }))),
      ink(sketch({}, () => rect(10, 20, 30, 20, { rotate: 90 }))),
    );
    sameInk(
      ink(sketch({}, () => circle(30, 30, 12, { translate: [10, 0], scale: 0.5, origin: 'center' }))),
      ink(sketch({}, () => group({ translate: [10, 0] }, group({ scale: 0.5, origin: 'center' }, circle(30, 30, 12))))),
    );
  });

  it('agrees with the conversion: what t.material measures is where the ink is', () => {
    const dots = ink(sketch({}, (t) => {
      const sh = circle(30, 30, 12, { scale: 0.5, origin: 'center' });
      return t.material(sh).points.map((p): Tree => rect(p.x - 0.05, p.y - 0.05, 0.1, 0.1));
    }));
    const inked = ink(sketch({}, () => circle(30, 30, 12, { scale: 0.5, origin: 'center' })));
    // The conversion flattens curves at 0.05 mm (the one tolerance), and the
    // dots have width, so agreement is to a fraction of a millimetre.
    expect(Math.abs(dots.box[0] - inked.box[0])).toBeLessThan(0.2);
    expect(Math.abs(dots.box[2] - inked.box[2])).toBeLessThan(0.2);
  });
});
