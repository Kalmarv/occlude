/**
 * Spec 61, level sets and chains (audit P2, N1, the `along` sweep).
 *
 * P2: a level of `t.isolines` is an AREA — the region where the field is at
 * or above the level — closed along the drawable (or the field's `within`
 * bound) through every corner it passes, its closing edges marked `cut`.
 * N1: the chain verbs walk the `curves()` of a network, junctions fixed and
 * kept by id. The sweep: `along` reads heading, tangent and normal from the
 * space's `log`, so a station faces where `station.step` walks.
 *
 * Each case names the audit entry it closes; the sketches the entries came
 * from are under working/audit/sketches/ (their FRICTION lines are the calls
 * made here).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { toolkit } from './helpers/run.js';
import { initOcclude, render, sketch, polygon, rect, ngon, sdf, fill, mm, space, type Material, type SketchDef } from '../src/index.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
  await initOcclude(readFileSync(wasmPath));
});

/** Signed area of one ring. */
const area = (pts: readonly (readonly [number, number])[]): number => {
  let s = 0;
  for (let k = 0; k < pts.length; k++) {
    const [ax, ay] = pts[k];
    const [bx, by] = pts[(k + 1) % pts.length];
    s += ax * by - bx * ay;
  }
  return Math.abs(s) / 2;
};

const has = (m: Material, x: number, y: number): boolean =>
  [...m.points].some((p) => Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9);

/** The hatch ink a sketch draws, in mm. */
const inkOf = (def: SketchDef): number =>
  render(def, { paper: 'Square20' }).frags.filter((f) => !f.dot && f.geom.t === 'line').reduce((s, f) => {
    const g = f.geom as { x0: number; y0: number; x1: number; y1: number };
    return s + Math.hypot(g.x1 - g.x0, g.y1 - g.y0);
  }, 0);

describe('P2 · a level set is an area', () => {
  it('G5-14: a contour that leaves by two edges walks the corner, not a chord', () => {
    const t = toolkit({ aspect: [1, 1] });
    const b = t.bounds();
    const r = b.w * 0.3;
    const corner = t.isolines(sdf.circle(0, 0, r), 0);
    const [ring] = corner.contours();
    expect(corner.contours()).toHaveLength(1);
    expect(has(corner, 0, 0)).toBe(true);
    // A quarter disc, not the lens between the arc and its chord.
    expect(area(ring.pts)).toBeCloseTo((Math.PI * r * r) / 4, 0);
    expect(corner.faces().length).toBe(1);
  });

  it('G2-4: a lone contour cut by the frame is an area that polygon fills', () => {
    const t = toolkit({ aspect: [1, 1] });
    const b = t.bounds();
    const side = t.isolines(sdf.circle(b.w, b.h * 0.5, b.w * 0.2), 0);
    expect(side.contours()).toHaveLength(1);
    expect(area(side.contours()[0].pts)).toBeCloseTo((Math.PI * (b.w * 0.2) ** 2) / 2, 0);
    const ink = inkOf(sketch({ aspect: [1, 1] }, (tk) => {
      const bb = tk.bounds();
      return polygon(tk.isolines(sdf.circle(bb.w, bb.h * 0.5, bb.w * 0.2), 0), { stroke: false, fill: fill('hatch', { angle: 35, spacing: mm(1) }) });
    }));
    expect(ink).toBeGreaterThan(100);
  });

  it('G5-9: a cut contour beside a closed one is kept', () => {
    const t = toolkit({ aspect: [1, 1] });
    const b = t.bounds();
    const body = sdf.union(sdf.circle(b.w / 2, b.h, b.w * 0.2), sdf.circle(b.w / 2, b.h * 0.3, b.w * 0.1));
    const m = t.isolines(body, 0);
    const areas = m.contours().map((c) => area(c.pts)).sort((p, q) => p - q);
    expect(areas).toHaveLength(2);
    expect(areas[0]).toBeCloseTo(Math.PI * (b.w * 0.1) ** 2, 0);
    expect(areas[1]).toBeCloseTo((Math.PI * (b.w * 0.2) ** 2) / 2, 0);
  });

  it('G6-20: a body the drawable cuts is an area for polygon, within and scatter', () => {
    const t = toolkit({ aspect: [1, 1], seed: 7 });
    const outline = t.isolines(sdf.circle(0, 50, 20), 0);
    expect(outline.contours()).toHaveLength(1);
    const inside = t.within(t.scatter({ spacing: 4 }), outline);
    expect(inside.points.length).toBeGreaterThan(0);
    expect([...inside.points].every((p) => p.x <= 20 && Math.hypot(p.x, p.y - 50) <= 20.01)).toBe(true);
  });

  it('G6-23: an edge-to-edge band fills to the drawable, crest to bottom', () => {
    const t = toolkit({ aspect: [3, 2] });
    const W = t.width;
    const H = t.height;
    // A tilted crest: the band is everything below it.
    const band = t.isolines((x, y) => y / H - 0.2 * (x / W) - 0.4, 0);
    const [ring] = band.contours();
    expect(band.contours()).toHaveLength(1);
    expect(has(band, 0, H) && has(band, W, H)).toBe(true);
    expect(has(band, 0, 0) || has(band, W, 0)).toBe(false);
    // Trapezoid under the line y = H (0.4 + 0.2 x / W).
    expect(area(ring.pts)).toBeCloseTo(W * H * (1 - 0.5), 0);
  });

  it('the closing edges carry cut: strokes of the rest is the level line alone', () => {
    const t = toolkit({ aspect: [1, 1] });
    const b = t.bounds();
    const m = t.isolines(sdf.circle(0, 0, b.w * 0.3), 0);
    const onBorder = (x: number, y: number) => Math.abs(x) < 1e-9 || Math.abs(y) < 1e-9;
    const closing = m.edges.filter((e) => e.attrs.cut === 1);
    const level = m.edges.filter((e) => !e.attrs.cut);
    expect(closing.length).toBe(2); // along the top edge, then down the left one
    expect([...closing].every((e) => onBorder(e.a.x, e.a.y) && onBorder(e.b.x, e.b.y))).toBe(true);
    expect([...level].every((e) => Math.abs(Math.hypot(e.center[0], e.center[1]) - b.w * 0.3) < 0.1)).toBe(true);
    expect(m.edges.length).toBe(closing.length + level.length);
  });

  it('closes along a within bound, through the bound\'s own corners', () => {
    const t = toolkit({ aspect: [1, 1] });
    const diamond = ngon(70, 70, 4, 16);
    const cut = t.isolines(t.within(sdf.circle(78, 70, 14), diamond), 0);
    expect(cut.contours()).toHaveLength(1);
    // The right corner of the diamond is inside the circle: the ring passes it.
    expect(has(cut, 86, 70)).toBe(true);
    // Both walls that meet there close the region: neither is level line.
    const corner = [...cut.points].find((p) => Math.abs(p.x - 86) < 1e-9 && Math.abs(p.y - 70) < 1e-9)!;
    expect([...corner.edges].map((e) => e.attrs.cut)).toEqual([1, 1]);
  });

  it('G6-32: a bound field is sampled over its bound\'s box, not the drawable', () => {
    const t = toolkit({ aspect: [1, 1] });
    const sheet = (x: number, y: number) => sdf.box(0.5, 0.5, 0.9, 0.9)(x, y);
    // 0.005 over the drawable would be 400M cells; over the unit box it is 40k.
    const edges = t.isolines(t.within(sheet, rect(0, 0, 1, 1)), 0, { step: 0.005 });
    expect(edges.contours()).toHaveLength(1);
    expect(area(edges.contours()[0].pts)).toBeCloseTo(0.81, 2);
  });

  it('refuses close, a stray option and a stray level key by name', () => {
    const t = toolkit({ aspect: [1, 1] });
    const f = sdf.circle(50, 50, 20);
    expect(() => t.isolines(f, 0, { close: true } as never)).toThrow(/isolines: \{ close \} is gone.*!e\.attrs\.cut/);
    expect(() => t.isolines(f, 0, { spacing: 2 } as never)).toThrow(/isolines: 'spacing' is not an option — the options are \{ step \}/);
    // Spec 55 found this one silently ignored.
    expect(() => t.isolines(f, { spacing: 5, step: 1 } as never)).toThrow(/isolines: 'step' is not a level key.*\{ step \}/);
    expect(() => t.isolines(f, { count: 3, spacing: 5 } as never)).toThrow(/not both/);
  });
});

describe('N1 · chain verbs walk the curves() of a network', () => {
  const junctionsOf = (m: Material) => [...m.points].filter((p) => p.edges.length > 2);
  const byId = (m: Material) => new Map(junctionsOf(m).map((p) => [p.id, [p.x, p.y, p.edges.length]]));

  it('G2-14 / G4-14: resample on t.hexes keeps every junction, where it was and who it was', () => {
    const t = toolkit({ aspect: [1, 1] });
    const hex = t.hexes({ spacing: mm(10) });
    const out = hex.resample({ spacing: t.len(mm(1)) });
    expect(byId(out)).toEqual(byId(hex));
    expect(out.faces().length).toBe(hex.faces().length);
    // Between the junctions the walls are redistributed.
    expect(out.points.length).toBeGreaterThan(hex.points.length * 3);
    // The honeycomb cut to a wall (examples-vessels): the rim is a network too.
    const comb = t.within(t.hexes({ spacing: mm(6) }), rect(0, 0, 40, 80));
    expect(byId(comb.resample({ spacing: 1 }))).toEqual(byId(comb));
  });

  it('resample, trim, spline and oscillate keep a tiling\'s and a voronoi\'s junctions', () => {
    const tk = toolkit({ aspect: [1, 1], space: space.hyperbolic({ radius: 50 }) });
    const tiles: Material = tk.tiling(5, 4, { depth: 2 });
    const flat = toolkit({ aspect: [1, 1], seed: 3 });
    const cells = flat.voronoi(flat.scatter({ spacing: 15 }));
    for (const net of [tiles, cells]) {
      const before = byId(net);
      expect(before.size).toBeGreaterThan(3);
      expect(byId(net.resample({ spacing: 1 }))).toEqual(before);
      expect(byId(net.spline())).toEqual(before);
      expect(byId(net.trim({ start: 0.5, end: 0.5 }))).toEqual(before);
      expect(byId(net.oscillate({ wavelength: 2, amplitude: 0.3 }))).toEqual(before);
    }
  });

  it('G4-1: each verb speaks in its own name; one that cannot keep a junction says so itself', () => {
    const t = toolkit({ aspect: [1, 1] });
    const hex = t.hexes({ spacing: 20 });
    expect(() => hex.oscillate({ wavelength: 4, amplitude: 1 })).not.toThrow();
    expect(() => hex.along({ spacing: 2 })).not.toThrow();
    expect(() => hex.coil({ radius: 1, pitch: 2 })).toThrow(/^coil: vertex \d+ is a junction/);
  });

  it('along on a network: every chain from junction to junction, each end facing along its chain', () => {
    const t = toolkit({ aspect: [1, 1] });
    const hex = t.hexes({ spacing: 20 });
    const chains = hex.curves();
    const stations = hex.along({ spacing: 5 });
    expect(new Set(stations.map((s) => s.chain)).size).toBe(chains.length);
    for (const s of stations.filter((q) => q.s === 0 && !q.closed)) {
      const c = chains[s.chain];
      const [a, b] = [c.pts[0], c.pts[1]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      expect(s.tangent[0]).toBeCloseTo((b[0] - a[0]) / len, 9);
      expect(s.tangent[1]).toBeCloseTo((b[1] - a[1]) / len, 9);
    }
  });
});

describe('sweep · along reads its frame from the space', () => {
  it('on a sphere, heading, tangent and normal are the direction space.log gives toward the next vertex', () => {
    const t = toolkit({ aspect: [1, 1], space: space.spherical({ radius: 30 }) });
    const sp = t.space;
    const arc = t.material(rect(-20, -10, 40, 25));
    const stations = arc.along({ spacing: 3 });
    expect(stations.length).toBeGreaterThan(10);
    let checked = 0;
    for (const st of stations) {
      const c = arc.curves()[st.chain];
      // The vertex ahead of this station along the ring.
      const s = st.s;
      let acc = 0;
      let ahead = c.pts[0];
      for (let k = 0; k < c.pts.length; k++) {
        const a = c.pts[k];
        const b = c.pts[(k + 1) % c.pts.length];
        const d = sp.distance(a, b);
        if (acc + d > s + 1e-6) {
          ahead = b;
          break;
        }
        acc += d;
      }
      // Stations on a vertex take the bisector there; the rest face ahead.
      if (c.pts.some((p) => Math.hypot(p[0] - st.x, p[1] - st.y) < 1e-6)) continue;
      const v = sp.log([st.x, st.y], ahead);
      const len = Math.hypot(v[0], v[1]);
      expect(st.heading).toBeCloseTo(Math.atan2(v[1], v[0]), 9);
      expect(st.tangent[0]).toBeCloseTo(v[0] / len, 9);
      expect(st.normal[0]).toBeCloseTo(-v[1] / len, 9);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
    // A step along the heading stays on the edge's geodesic.
    const st = stations.find((q) => !arc.curves()[q.chain].pts.some((p) => Math.hypot(p[0] - q.x, p[1] - q.y) < 1e-6))!;
    const next = st.step(0.5);
    const back = sp.log([next.x, next.y], [st.x, st.y]);
    expect(Math.hypot(back[0], back[1])).toBeCloseTo(0.5, 6);
  });

  it('flat: the same arithmetic as before (a segment\'s own direction)', () => {
    const t = toolkit({ aspect: [1, 1] });
    const [st] = t.material(rect(0, 0, 10, 5)).along({ count: 7 }).filter((q) => q.s > 0 && q.s < 10);
    expect(st.tangent).toEqual([1, 0]);
    expect(st.heading).toBe(0);
  });
});
