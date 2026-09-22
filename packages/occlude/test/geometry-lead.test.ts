/**
 * The lead drawing of docs/reference/geometry.mdx: a walker draws one
 * cell of the `{5, 4}` tiling, and the tiling fills the disk.
 *
 * The cell is the regular right-angled pentagon. Its side at radius `R`
 * is `2 · k · asinh(√((√5 − 1) / 4))` with `k = R / 2` — 26.5318765 at
 * radius 50. Five such legs with a right turn between them close in the
 * hyperbolic plane, and the walker comes back turned a quarter turn.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  circle, compileSketch, compileSketchAsync, evalPrim, initOcclude, line, render, sketch, space,
  type ShapeOpts, type ShapeValue, type Space, type Station, type Tiling, type Toolkit, type Vec,
} from '../src/index.js';

beforeAll(async () => {
  await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url)));
});

/** Compile a throwaway sketch and read one value off its toolkit: the
 * frame door (`t.space`, `t.tiling`, `t.station`) a walk binds to. */
function fromSketch<T>(config: Parameters<typeof sketch>[0], read: (t: Toolkit) => T): T {
  let got: T | undefined;
  compileSketch(sketch(config, (t) => { got = read(t); return null; }));
  return got as T;
}

/** The hyperbolic sketch the fence draws in. */
const HYP = { aspect: [1, 1], space: space.hyperbolic({ radius: 50 }) } as Parameters<typeof sketch>[0];

/** The turn that keeps the walk on the cell: `+90`, positive as
 * `rotate`, because the cell's own corners turn counter-clockwise (the
 * cross product of `log(cell[1], cell[0])` and `log(cell[1], cell[2])`
 * is negative) and `+90` lands the second step on `cell[2]`. `−90`
 * also closes, on the mirror pentagon across the first side. */
const SIGN = 1;

let sp: Space;
let til: Tiling;

beforeAll(() => {
  sp = fromSketch(HYP, (t) => t.space);
  til = fromSketch(HYP, (t) => t.tiling(5, 4));
});

describe('the {5, 4} cell', () => {
  it('has five points, every side the derived length', () => {
    expect(til.cell).toHaveLength(5);
    const derived = 2 * (sp.radius / 2) * Math.asinh(Math.sqrt((Math.sqrt(5) - 1) / 4));
    for (let i = 0; i < til.cell.length; i++) {
      const d = sp.distance(til.cell[i], til.cell[(i + 1) % til.cell.length]);
      expect(Math.abs(d - derived)).toBeLessThan(1e-6);
    }
  });

  it('placements[0] is the identity on every cell point', () => {
    for (const v of til.cell) {
      const p = til.placements[0].point(v);
      expect(Math.hypot(p[0] - v[0], p[1] - v[1])).toBeLessThan(1e-9);
    }
  });
});

describe('the walk of the fence', () => {
  it('lands on cell[1..4] in turn, closes, and comes back turned a quarter turn', () => {
    const side = sp.distance(til.cell[0], til.cell[1]);
    const v = sp.log(til.cell[0], til.cell[1]);
    let st = fromSketch(HYP, (t) => t.station(til.cell[0][0], til.cell[0][1], Math.atan2(v[1], v[0])));
    const first = st;
    const landed: Vec[] = [];
    for (let i = 0; i < 5; i++) {
      st = st.step(side);
      landed.push([st.x, st.y]);
      if (i < 4) st = st.turn(SIGN * 90);
    }
    for (let i = 0; i < 4; i++) expect(sp.distance(landed[i], til.cell[i + 1])).toBeLessThan(1e-6);
    expect(sp.distance(landed[4], til.cell[0])).toBeLessThan(1e-9);
    expect(st.heading - first.heading).toBeCloseTo(-SIGN * Math.PI / 2, 9);
  });
});

describe('the Poincaré fence, end to end', () => {
  it('draws visible ink, all of it inside the drawable', async () => {
    // The `ts live` fence on docs/reference/geometry.mdx, compiled here
    // so the page and the engine cannot drift apart.
    const definition = sketch(HYP, (t) => {
      const { cell, placements } = t.tiling(5, 4, { depth: 5 });
      const c = t.space.center;
      const ring = (pts: Vec[], opts?: ShapeOpts) => pts.map((v, i) => {
        const w = pts[(i + 1) % pts.length];
        return line(v[0], v[1], w[0], w[1], opts);
      });
      const around = placements.slice(1).map((f) => ring(cell.map((v) => f.point(v))));
      const side = t.space.distance(cell[0], cell[1]);
      const v = t.space.log(cell[0], cell[1]);
      let st = t.station(cell[0][0], cell[0][1], Math.atan2(v[1], v[0]));
      const start = st;
      const legs: ShapeValue[] = [];
      for (let i = 0; i < 5; i++) {
        const from = st;
        st = st.step(side);
        legs.push(line(from.x, from.y, st.x, st.y, { pen: 'stabilo-88-blue' }));
        if (i < 4) st = st.turn(SIGN * 90);
      }
      const arrow = (s: Station): ShapeValue[] => {
        const tip = s.step(9);
        return [
          line(s.x, s.y, tip.x, tip.y, { pen: 'stabilo-88-blue' }),
          ...[150, -150].map((a) => {
            const b = tip.turn(a).step(3);
            return line(tip.x, tip.y, b.x, b.y, { pen: 'stabilo-88-blue' });
          }),
        ];
      };
      return [circle(c[0], c[1], 300), around, legs, arrow(start), arrow(st)];
    });
    const out = render(await compileSketchAsync(definition), { paper: { w: 148, h: 148 }, marginPct: 5 });
    expect(out.stats.fragments).toBeGreaterThan(0);
    // The drawable rect, as the docs checker and test/walk.test.ts
    // measure it: no fragment may leave it (half a unit of grazing
    // tolerance, at the fragment's middle).
    const x0 = out.frame.offsetX;
    const y0 = out.frame.offsetY;
    const off = out.frags.filter((frag) => {
      const [x, y] = evalPrim(frag.geom, 0.5);
      return x < x0 - 0.5 || x > x0 + out.frame.inner.innerW + 0.5 || y < y0 - 0.5 || y > y0 + out.frame.inner.innerH + 0.5;
    });
    expect(off).toHaveLength(0);
  });
});
