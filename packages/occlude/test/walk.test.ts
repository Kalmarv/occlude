/**
 * `station.step` and `station.turn`: the walk, flat and curved.
 *
 * The flat walk is the turtle: `step` adds `d · (cos h, sin h)` and `turn`
 * adds the angle. The curved walk steps the geodesic and carries its
 * direction to the arrival, which is parallel transport along a geodesic;
 * a closed walk then brings the heading back rotated by the holonomy. The
 * pentagon of five right angles is the test: four right turns carry the
 * heading exactly once round, so the walk's return angle IS the holonomy,
 * and its side is the right-angled pentagon side of the {4, 5} tiling,
 * `2 · k · asinh(sqrt((sqrt(5) - 1) / 4))` with `k = radius / 2`.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  compileSketch, compileSketchAsync, circle, curve, evalPrim, initOcclude, line, render, sketch, space,
  type ShapeValue, type Space, type Station, type Toolkit,
} from '../src/index.js';

beforeAll(async () => {
  await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url)));
});

/** Compile a throwaway sketch and read one value off its toolkit: the
 * frame door (`t.space`, `t.station`) a walk binds to. */
function fromSketch<T>(config: Parameters<typeof sketch>[0], read: (t: Toolkit) => T): T {
  let got: T | undefined;
  compileSketch(sketch(config, (t) => { got = read(t); return null; }));
  return got as T;
}

/** The hyperbolic sketch the curved tests walk in. */
const HYP = { aspect: [1, 1], space: space.hyperbolic({ radius: 50 }) } as Parameters<typeof sketch>[0];

let hyp: Space;
/** The right-angled pentagon side at this radius: `2 · k · asinh(√((√5 − 1)/4))`, k = 25. ≈ 26.5318765. */
let side: number;
/** The walk's start: `t.station(50, 60)` in the hyperbolic sketch, on the
 * sketch's own space. */
const walker = (): Station => fromSketch(HYP, (t) => t.station(50, 60));

beforeAll(() => {
  hyp = fromSketch(HYP, (t) => t.space);
  side = 2 * (hyp.radius / 2) * Math.asinh(Math.sqrt((Math.sqrt(5) - 1) / 4));
});

describe('the flat walk', () => {
  it('step is p + d·(cos h, sin h) and turn adds the angle', () => {
    const s = curve([[1, 2], [4, 6]], { age: 7 }).along()[0];
    const q = s.step(2);
    expect(q.x).toBeCloseTo(1 + 2 * Math.cos(s.heading), 12);
    expect(q.y).toBeCloseTo(2 + 2 * Math.sin(s.heading), 12);
    expect(q.heading).toBe(s.heading);
    const r = s.turn(45);
    expect(r.heading).toBeCloseTo(s.heading + Math.PI / 4, 12);
    expect(r.x).toBe(1);
    expect(r.y).toBe(2);
  });

  it('four steps and three right turns close a square to 1e-12', () => {
    const start = curve([[0, 0], [1, 0]]).along()[0];
    let st = start;
    const corners: [number, number][] = [];
    for (let i = 0; i < 4; i++) {
      st = st.step(3);
      if (i < 3) st = st.turn(90);
      corners.push([st.x, st.y]);
    }
    expect(corners[0][0]).toBeCloseTo(3, 12);
    expect(corners[0][1]).toBeCloseTo(0, 12);
    expect(corners[1][0]).toBeCloseTo(3, 12);
    expect(corners[1][1]).toBeCloseTo(3, 12);
    expect(corners[2][0]).toBeCloseTo(0, 12);
    expect(corners[2][1]).toBeCloseTo(3, 12);
    expect(Math.hypot(st.x - start.x, st.y - start.y)).toBeLessThan(1e-12);
  });

  it('carries the chain fields through step and turn', () => {
    const s = curve([[0, 0], [3, 4]], { age: 7 }).along()[0];
    expect(s.length).toBe(5);
    const q = s.step(2).turn(30);
    expect(q.s).toBe(s.s);
    expect(q.u).toBe(s.u);
    expect(q.length).toBe(s.length);
    expect(q.chain).toBe(s.chain);
    expect(q.closed).toBe(s.closed);
    expect(q.attrs).toBe(s.attrs);
    expect(q.edgeAttrs).toBe(s.edgeAttrs);
  });
});

describe('the hyperbolic walk', () => {
  it('step(d) arrives at distance d from the start', () => {
    const s = walker();
    const q = s.step(side);
    expect(hyp.distance([s.x, s.y], [q.x, q.y])).toBeCloseTo(side, 9);
  });

  it('the arrival heading is the geodesic direction on arrival', () => {
    const s = walker();
    const mid = s.step(side);
    const end = mid.step(side);
    // Two steps carry on along one geodesic: twice the distance, and the
    // middle of that geodesic is where the heading carried the walker.
    expect(hyp.distance([s.x, s.y], [end.x, end.y])).toBeCloseTo(2 * side, 9);
    const half = hyp.geodesic([s.x, s.y], [end.x, end.y], 0.5);
    expect(hyp.distance(half, [mid.x, mid.y])).toBeLessThan(1e-9);
  });

  it('along carries its space, and step and turn copy it', () => {
    const s = curve([[50, 60], [60, 60]], { closed: false }).along({ space: hyp })[0];
    expect(s.space).toBe(hyp);
    expect(s.step(side).space).toBe(hyp);
    expect(s.turn(90).space).toBe(hyp);
  });

  it('four right turns and four equal steps do not close', () => {
    const start = walker();
    let st = start;
    for (let i = 0; i < 4; i++) {
      st = st.step(side);
      st = st.turn(90);
    }
    expect(hyp.distance([start.x, start.y], [st.x, st.y])).toBeGreaterThan(1);
  });

  it('five right-angle legs close a pentagon, and the holonomy turns the walker', () => {
    const start = walker();
    let st = start;
    for (let i = 0; i < 5; i++) {
      st = st.step(side);
      if (i < 4) st = st.turn(90);
    }
    expect(hyp.distance([start.x, start.y], [st.x, st.y])).toBeLessThan(1e-9);
    expect(Math.hypot(st.x - start.x, st.y - start.y)).toBeLessThan(1e-9);
    // The expected angle is a quarter turn: the holonomy is the pentagon's
    // angle defect, (5 − 2)·π − 5·(π/2) = π/2. The four right turns carry
    // the heading exactly once round (2π), so the heading the walker comes
    // back with differs from the start by the holonomy alone. Its sign is
    // counter-clockwise legs, clockwise return: −π/2.
    expect(st.heading - start.heading).toBeCloseTo(-Math.PI / 2, 9);
  });

  it('the {4, 5} side is the derived one: cosh(d / k) is the golden ratio', () => {
    expect(Math.cosh(side / (hyp.radius / 2))).toBeCloseTo((1 + Math.sqrt(5)) / 2, 9);
  });

  it('t.station is bound to the sketch space, and place works on a walked station', () => {
    const bent = fromSketch(HYP, (t) => t.station(50, 60).step(side));
    const flat = fromSketch({ aspect: [1, 1] }, (t) => t.station(50, 60).step(side));
    expect(flat.x).toBe(50 + side);
    expect(flat.y).toBe(60);
    // A step in a hyperbolic sketch is not the flat step.
    expect(Math.abs(bent.x - flat.x)).toBeGreaterThan(1);
    const q = hyp.exp([50, 60], [side, 0]);
    expect(bent.x).toBeCloseTo(q[0], 9);
    expect(bent.y).toBeCloseTo(q[1], 9);
    const g = bent.place(line(0, 0, 1, 1));
    expect((g.opts.translate as [number, number])[0]).toBeCloseTo(bent.x, 12);
    expect((g.opts.translate as [number, number])[1]).toBeCloseTo(bent.y, 12);
  });
});

describe('the pentagon fence, end to end', () => {
  it('draws visible ink, all of it inside the drawable', async () => {
    // The `ts live` fence on docs/reference/material.mdx, compiled here so
    // the page and the engine cannot drift apart.
    const definition = sketch({ aspect: [1, 1], space: space.hyperbolic({ radius: 50 }) }, (t) => {
      const k = t.space.radius / 2;
      const d = 2 * k * Math.asinh(Math.sqrt((Math.sqrt(5) - 1) / 4));
      let st = t.station(50, 60);
      const start = st;
      const legs: ShapeValue[] = [];
      for (let i = 0; i < 5; i++) {
        const from = st;
        st = st.step(d);
        legs.push(line(from.x, from.y, st.x, st.y));
        if (i < 4) st = st.turn(90);
      }
      const tick = (s: Station): ShapeValue => {
        const e = s.step(8);
        return line(s.x, s.y, e.x, e.y, { pen: 'stabilo-88-blue' });
      };
      return [circle(50, 50, 400), legs, tick(start), tick(st)];
    });
    const out = render(await compileSketchAsync(definition), { paper: { w: 148, h: 148 }, marginPct: 5 });
    expect(out.stats.fragments).toBeGreaterThan(0);
    // The drawable rect, as the docs checker and test/hyperbolic3.test.ts
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
