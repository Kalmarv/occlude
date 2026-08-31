import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  circle, ellipse, exportGcode, exportPng, exportSvg, hatch, initOcclude,
  line, mask, mm, polygon, rect, render, sketch, stipple, w,
} from '../src/index.js';
import { evalPrim } from '../src/index.js';
import type { Fragment, Prim, RenderOptions, SketchDef } from '../src/index.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(
    new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
  );
  await initOcclude(readFileSync(wasmPath));
});

const sq = (def: SketchDef, opts: RenderOptions = {}) =>
  render(def, { paper: 'Square20', ...opts });

function fragLen(f: Fragment): number {
  const p = f.geom;
  if (p.t === 'line') return Math.hypot(p.x1 - p.x0, p.y1 - p.y0);
  if (p.t === 'arc') return p.r * Math.abs(p.sweep);
  return Math.hypot(p.x1 - p.x0, p.y1 - p.y0);
}

function totalLen(frags: Fragment[]): number {
  return frags.filter((f) => !f.dot).reduce((sum, f) => sum + fragLen(f), 0);
}

describe('occlude declarative api', () => {
  it('occludes a line under a filled rect', () => {
    const def = sketch({ seed: 1 }, () => [
      line(0, 50, 100, 50),
      rect(25, 25, 50, 50, { fill: hatch(45) }),
    ]);
    const out = sq(def);
    // Paper 200×200: line spans (0,100)→(200,100); rect covers x∈[50,150].
    const lineFrags = out.frags.filter((f) => f.shape === 0);
    expect(lineFrags).toHaveLength(2);
    expect(totalLen(lineFrags)).toBeCloseTo(100, 4);
    expect(out.stats.fillPrims).toBeGreaterThan(5);
  });

  it('tree order is draw order; nesting and falsy entries flatten away', () => {
    const def = sketch({ seed: 1 }, ({ path }) => [
      line(0, 50, 100, 50),
      false,
      null,
      [[rect(25, 25, 50, 50, { opaque: true })], undefined],
      path().moveTo(0, 0).lineTo(10, 0).build(),
    ]);
    const out = sq(def);
    // Shapes numbered in flattened order: line 0, rect 1, path 2.
    expect(new Set(out.frags.map((f) => f.shape))).toEqual(new Set([0, 1, 2]));
    const lineFrags = out.frags.filter((f) => f.shape === 0);
    expect(totalLen(lineFrags)).toBeCloseTo(100, 4); // rect (later) occludes it
  });

  it('fill on an open path throws at compile', () => {
    const open = sketch({ seed: 1 }, ({ path }) => [
      path().moveTo(0, 0).lineTo(10, 10).build({ fill: hatch() }),
    ]);
    expect(() => sq(open)).toThrow(/open/);
    const closed = sketch({ seed: 1 }, ({ path }) => [
      path().moveTo(0, 0).lineTo(10, 0).lineTo(10, 10).close().build({ fill: hatch() }),
    ]);
    expect(() => sq(closed)).not.toThrow();
  });

  it('unknown pens throw loudly', () => {
    const def = sketch({ seed: 1 }, () => circle(50, 50, 10, { pen: 'nope' }));
    expect(() => sq(def)).toThrow(/unknown pen/);
    const viaConfig = sketch({ seed: 1, pen: 'also-nope' }, () => circle(50, 50, 10));
    expect(() => sq(viaConfig)).toThrow(/unknown pen/);
  });

  it('z overrides tree order', () => {
    const def = sketch({ seed: 1 }, () => [
      circle(40, 50, 20, { fill: hatch(), z: 10 }), // earlier in tree, stacked on top
      circle(60, 50, 20, { fill: hatch() }),
    ]);
    const out = sq(def);
    const outline0 = out.frags.filter((f) => f.shape === 0 && f.geom.t === 'arc');
    const sweep = outline0.reduce(
      (acc, f) => acc + Math.abs((f.geom as Extract<Prim, { t: 'arc' }>).sweep),
      0,
    );
    expect(sweep).toBeCloseTo(2 * Math.PI, 5);
  });

  it('clip() restricts children; the region is not drawn', () => {
    const def = sketch({ seed: 1 }, ({ clip }) =>
      clip(circle(50, 50, 25), line(0, 50, 100, 50)),
    );
    const out = sq(def);
    expect(out.frags).toHaveLength(1);
    expect(totalLen(out.frags)).toBeCloseTo(100, 4); // the circle's diameter
  });

  it('mask() occludes and draws nothing; opaque draws only the stroke', () => {
    const masked = sketch({ seed: 1 }, () => [
      line(0, 50, 100, 50),
      mask(circle(50, 50, 25)),
    ]);
    const out = sq(masked);
    expect(out.frags.every((f) => f.shape === 0)).toBe(true);
    expect(totalLen(out.frags)).toBeCloseTo(100, 4);

    const outlined = sketch({ seed: 1 }, () => [
      line(0, 50, 100, 50),
      circle(50, 50, 25, { opaque: true }),
    ]);
    const out2 = sq(outlined);
    expect(out2.frags.some((f) => f.shape === 1 && f.geom.t === 'arc')).toBe(true);
    expect(out2.stats.fillPrims).toBe(0);
    expect(totalLen(out2.frags.filter((f) => f.shape === 0))).toBeCloseTo(100, 4);

    // No fill, no opaque → transparent: nothing occludes the line.
    const transparent = sketch({ seed: 1 }, () => [
      line(0, 50, 100, 50),
      circle(50, 50, 25),
    ]);
    const out3 = sq(transparent);
    expect(totalLen(out3.frags.filter((f) => f.shape === 0))).toBeCloseTo(200, 4);
  });

  it('group() composes transforms', () => {
    const def = sketch({ seed: 1 }, ({ group }) => [
      group({ translate: [20, 0] }, group({ translate: [0, 30] }, circle(0, 0, 10))),
      circle(20, 30, 10),
    ]);
    const out = sq(def);
    const arcs = out.frags.filter((f) => f.geom.t === 'arc');
    // Both circles land identically → seam dedupe draws the outline once.
    expect(arcs).toHaveLength(2);
    const centers = new Set(
      arcs.map((f) => {
        const a = f.geom as Extract<Prim, { t: 'arc' }>;
        return `${a.cx.toFixed(3)},${a.cy.toFixed(3)}`;
      }),
    );
    expect(centers.size).toBe(1);
  });

  it('rotation pivots around the user origin, not the paper corner', () => {
    const def = sketch({ aspect: [1, 1], seed: 1, origin: 'center' }, ({ group }) =>
      [0, 30, 45, 137].map((deg) => group({ rotate: deg }, rect(-10, -4, 20, 8))),
    );
    const out = sq(def);
    for (let shape = 0; shape < 4; shape++) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const f of out.frags.filter((f) => f.shape === shape)) {
        for (const t of [0, 0.5, 1]) {
          const [x, y] = evalPrim(f.geom, t);
          x0 = Math.min(x0, x); y0 = Math.min(y0, y);
          x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
      }
      expect((x0 + x1) / 2).toBeCloseTo(100, 1);
      expect((y0 + y1) / 2).toBeCloseTo(100, 1);
    }
  });

  it('yUp keeps circles as exact arcs (reflection, not cubics)', () => {
    const def = sketch({ seed: 1, yUp: true }, () => circle(50, 25, 10));
    const out = sq(def);
    const arcs = out.frags.filter((f) => f.geom.t === 'arc');
    expect(arcs.length).toBe(2);
    const a = arcs[0].geom as Extract<Prim, { t: 'arc' }>;
    expect(a.cx).toBeCloseTo(100, 6);
    expect(a.cy).toBeCloseTo(150, 6); // y=25 from the bottom of a 200mm square
  });

  it('stipples stay inside rotated rounded rects (reported seeds)', () => {
    for (const seed of [556023384, 1026822258, 376656802, 219337517, 2058254706, 600858359, 1592708539, 1788219583, 1635323682, 1718006969, 2056267948]) {
      const def = sketch({ aspect: [1, 1], seed, origin: 'center', margin: 6 }, ({ group }) =>
        Array.from({ length: 100 }, (_, i) =>
          group({ rotate: i },
            rect(-10, -4, 20, 8, 10, { fill: stipple(1), fillPen: 'stabilo-88-red' })),
        ),
      );
      const out = sq(def);
      const dots = out.frags.filter((f) => f.dot);
      expect(dots.length).toBeGreaterThan(50);
      const unit = 176 / 100;
      let worst = -Infinity;
      for (const d of dots) {
        const [dx, dy] = evalPrim(d.geom, 0);
        const px = (dx - 100) / unit;
        const py = (dy - 100) / unit;
        const a = (-d.shape * Math.PI) / 180;
        const lx = px * Math.cos(a) - py * Math.sin(a);
        const ly = px * Math.sin(a) + py * Math.cos(a);
        const r = 4;
        const qx = Math.abs(lx) - (10 - r);
        const qy = Math.abs(ly) - (4 - r);
        const sdf =
          Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
        worst = Math.max(worst, sdf);
      }
      expect(worst, `seed ${seed}`).toBeLessThanOrEqual(0.05);
    }
  });

  it('letterboxes a fixed aspect onto A4; config margin insets', () => {
    const def = sketch({ aspect: 'square', seed: 1, margin: 10 }, () =>
      line(0, 0, 100, 0),
    );
    const out = render(def, { paper: 'A4' });
    expect(out.frags).toHaveLength(1);
    const g = out.frags[0].geom as Extract<Prim, { t: 'line' }>;
    // Drawable: 210−42=168 wide, 297−42=255 tall → square 168, centered.
    expect(g.y0).toBeCloseTo(21 + (255 - 168) / 2, 3);
    expect(Math.abs(g.x1 - g.x0)).toBeCloseTo(168, 3);
  });

  it('units resolve against the right axes; grid tiles the drawable', () => {
    const def = sketch({ seed: 1 }, ({ s }) => [
      line(0, 0, w(100), 0),
      line(0, 0, mm(50), 0),
      line(10, 0, 10, s(100)), // s spans the LONG axis (vertical on A4 portrait)
    ]);
    const out = render(def, { paper: 'A4' });
    const geomOf = (i: number) =>
      out.frags.find((f) => f.shape === i)!.geom as Extract<Prim, { t: 'line' }>;
    expect(Math.abs(geomOf(0).x1 - geomOf(0).x0)).toBeCloseTo(210, 3);
    expect(Math.abs(geomOf(1).x1 - geomOf(1).x0)).toBeCloseTo(50, 3);
    expect(Math.abs(geomOf(2).y1 - geomOf(2).y0)).toBeCloseTo(297, 3); // long side

    const gridDef = sketch({ aspect: [2, 1], seed: 1 }, ({ grid, bounds }) => {
      const b = bounds();
      const cells = grid({ cols: 4, rows: 2 });
      const maxX = Math.max(...cells.map((c) => c.x + c.w));
      const maxY = Math.max(...cells.map((c) => c.y + c.h));
      expect(maxX).toBeCloseTo(b.w, 9);
      expect(maxY).toBeCloseTo(b.h, 9);
      return line(0, 0, b.w, 0);
    });
    const gout = render(gridDef, { paper: { paper: { w: 200, h: 100 } } });
    expect(totalLen(gout.frags)).toBeCloseTo(200, 3);
  });

  it('same seed → identical output; named streams are independent', () => {
    const make = () =>
      sketch({ seed: 'fixed-seed' }, ({ stream }) => {
        const a = stream('ridges');
        const r0 = a.rnd();
        return [
          circle(50, 50, 30, { fill: stipple(0.5, mm(2)), fillPen: 'stabilo-88-red' }),
          circle(20, 20, r0 * 5 + 2),
        ];
      });
    const out1 = sq(make());
    const out2 = sq(make());
    expect(out1.frags.length).toBe(out2.frags.length);
    const dots1 = out1.frags.filter((f) => f.dot).map((f) => f.geom);
    const dots2 = out2.frags.filter((f) => f.dot).map((f) => f.geom);
    expect(dots1.length).toBeGreaterThan(10);
    expect(dots1).toEqual(dots2);

    // Named streams don't shift when the main stream draws more.
    let first: number[] = [];
    render(sketch({ seed: 'streams' }, ({ stream }) => {
      const r = stream('ridges');
      first = [r.rnd(), r.rnd()];
      return [];
    }), { paper: 'Square20' });
    let second: number[] = [];
    render(sketch({ seed: 'streams' }, ({ rnd, stream }) => {
      rnd(); rnd(); stream('other').rnd();
      const r = stream('ridges');
      second = [r.rnd(), r.rnd()];
      return [];
    }), { paper: 'Square20' });
    expect(second).toEqual(first);
  });

  it('polygon forms and ellipse opts placement', () => {
    const def = sketch({ seed: 1 }, () => [
      polygon(50, 50, 6, 20, { fill: hatch(0, mm(2)) }),
      polygon([[10, 10], [30, 10], [20, 30]]),
      ellipse(70, 70, 10, 5, { opaque: true }), // opts in the rotation slot
    ]);
    const out = sq(def);
    expect(out.frags.filter((f) => f.shape === 0 && f.geom.t === 'line').length)
      .toBeGreaterThan(6);
    expect(out.frags.filter((f) => f.shape === 1)).toHaveLength(3);
    expect(out.frags.some((f) => f.shape === 2)).toBe(true);
  });

  it('path builder: build() snapshots, the builder stays extendable', () => {
    const def = sketch({ seed: 1 }, ({ path, mask }) => {
      const crest = path().moveTo(0, 40).lineTo(50, 20).lineTo(100, 45);
      const ridgeLine = crest.build();
      const ridgeMask = mask(crest.lineTo(100, 100).lineTo(0, 100).close().build());
      return [ridgeMask, ridgeLine, line(0, 70, 100, 70)];
    });
    const out = sq(def);
    // The mask hides the later-drawn... no: the line at y=70 comes AFTER the
    // mask in tree order, so it draws over it. The crest line (shape 1) must
    // remain the open 3-point polyline, unaffected by the mask's extra cmds.
    const ridgeFrags = out.frags.filter((f) => f.shape === 1);
    expect(ridgeFrags.length).toBeGreaterThan(0);
    const ys = ridgeFrags.flatMap((f) => [evalPrim(f.geom, 0)[1], evalPrim(f.geom, 1)[1]]);
    // Sketch y ≤ 45 → paper y ≤ 90mm: the snapshot never gained the closing
    // edges down to y=100 (200mm).
    expect(Math.max(...ys)).toBeLessThan(95);
  });

  it('custom fills receive contains/path/area and accept polylines and arcs', () => {
    let seenArea = 0;
    const def = sketch({ seed: 1 }, () =>
      circle(50, 50, 25, {
        fill: (region, ctx) => {
          seenArea = region.area;
          expect(region.contains(100, 100)).toBe(true);
          expect(region.contains(region.bbox.x + 0.1, region.bbox.y + 0.1)).toBe(false);
          const pts: [number, number][] = [];
          const dots = [];
          for (let i = 0; i < 150; i++) {
            const x = region.bbox.x + ctx.rnd() * region.bbox.w;
            const y = region.bbox.y + ctx.rnd() * region.bbox.h;
            if (!region.contains(x, y)) continue;
            pts.push([x, y]);
            dots.push({
              type: 'arc' as const, cx: x, cy: y,
              r: 0.3 + ctx.rnd(), start: 0, sweep: Math.PI * 2,
            });
          }
          return [{ type: 'polyline' as const, pts }, ...dots];
        },
      }),
    );
    const out = sq(def);
    expect(Math.abs(seenArea - Math.PI * 2500) / (Math.PI * 2500)).toBeLessThan(0.005);
    expect(out.frags.filter((f) => f.shape === 0 && f.origin >= 2).length).toBeGreaterThan(20);
  });

  it('exports SVG, G-code and PNG from a sketch def', () => {
    const def = sketch({ seed: 1 }, () => [
      circle(35, 50, 20, { fill: hatch(45) }),
      circle(65, 50, 20, { fill: hatch(-45), pen: 'stabilo-88-red' }),
    ]);
    const svg = exportSvg(def, { paper: 'A5', background: '#faf7f0' });
    expect(svg).toContain('<svg');
    expect(svg).toContain('data-pen="stabilo-88-red"');
    const jobs = exportGcode(def, { paper: 'A5' });
    expect(jobs).toHaveLength(2);
    expect(jobs[0].gcode).toContain('G21');
    expect(jobs[0].inkMm).toBeGreaterThan(10);
    const png = exportPng(def, { paper: 'A5', scale: 2 });
    expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG magic
  });

  it('rect center mode: per-shape and via config rectMode', () => {
    // Per-shape: mode 'center' anchors (x, y) at the rect centre.
    const def = sketch({ seed: 1 }, () => [
      rect(50, 50, 20, 10, { mode: 'center' }),
      rect(40, 45, 20, 10), // same rect, corner-anchored
    ]);
    const out = sq(def);
    const box = (shape: number) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const f of out.frags.filter((f) => f.shape === shape)) {
        for (const t of [0, 1]) {
          const [x, y] = evalPrim(f.geom, t);
          x0 = Math.min(x0, x); y0 = Math.min(y0, y);
          x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
      }
      return { x0, y0, x1, y1 };
    };
    // Identical geometry → seam dedupe leaves one copy; both boxes match.
    const b0 = box(0);
    expect((b0.x0 + b0.x1) / 2).toBeCloseTo(100, 6); // centred at (100,100)mm
    expect((b0.y0 + b0.y1) / 2).toBeCloseTo(100, 6);

    // Config default applies to all rects; per-shape 'corner' overrides.
    const def2 = sketch({ seed: 1, rectMode: 'center' }, () => [
      rect(50, 50, 20, 10),
      rect(50, 50, 20, 10, { mode: 'corner' }),
    ]);
    const out2 = sq(def2);
    const box2 = (shape: number) => {
      let x0 = Infinity;
      for (const f of out2.frags.filter((f) => f.shape === shape)) {
        for (const t of [0, 1]) x0 = Math.min(x0, evalPrim(f.geom, t)[0]);
      }
      return x0;
    };
    expect(box2(0)).toBeCloseTo(80, 6); // centred: left edge at 100−20mm
    expect(box2(1)).toBeCloseTo(100, 6); // corner: left edge at x=50 → 100mm
  });

  it('per-shape transforms match group transforms; toolkit exposes width/height', () => {
    // A rotated rect via shape opts must land exactly where the group form does.
    const def = sketch({ aspect: [1, 1], seed: 1, origin: 'center' }, ({ group }) => [
      rect(-10, -4, 20, 8, { rotate: 30, translate: [5, 0] }),
      group({ rotate: 30, translate: [5, 0] }, rect(-10, -4, 20, 8)),
    ]);
    const out = sq(def);
    // Identical geometry → seam dedupe leaves exactly one drawn copy.
    expect(out.frags.every((f) => f.shape === 0)).toBe(true);
    expect(out.frags.length).toBeGreaterThan(0);

    // Toolkit width/height/cx/cy are the same numbers bounds() returns.
    const def2 = sketch({ aspect: [3, 2], seed: 1, margin: 5 }, (t) => {
      expect(t.width).toBeCloseTo(150, 9);
      expect(t.height).toBe(100);
      expect(t.cx).toBeCloseTo(75, 9);
      expect(t.cy).toBe(50);
      const b = t.bounds();
      expect([b.w, b.h]).toEqual([t.width, t.height]);
      return line(0, 0, t.width, 0);
    });
    const out2 = render(def2, { paper: { paper: { w: 300, h: 200 } } });
    // avail 280×180 after 10mm margins; 3:2 letterboxes to 270×180.
    expect(totalLen(out2.frags)).toBeCloseTo(270, 3);
  });

  it('off-paper shapes are culled', () => {
    const def = sketch({ seed: 1 }, ({ group }) => [
      circle(50, 50, 10),
      group({ translate: [500, 0] }, circle(50, 50, 10)),
    ]);
    const out = sq(def);
    expect(out.stats.culledOffPaper).toBe(1);
  });
});

describe('sequence helpers', () => {
  it('times provides index and normalised t; range covers both forms', async () => {
    const { times, range } = await import('../src/index.js');
    expect(times(4, (i, t) => [i, t])).toEqual([
      [0, 0], [1, 1 / 3], [2, 2 / 3], [3, 1],
    ]);
    expect(times(1, (_i, t) => t)).toEqual([0]); // no divide-by-zero
    expect(range(4)).toEqual([0, 1, 2, 3]);
    expect(range(2, 8, 2)).toEqual([2, 4, 6]);
    expect(range(3, 0, -1)).toEqual([3, 2, 1]);

    // The loop idiom end to end: 12 rects down the sheet.
    const def = sketch({ aspect: [1, 1], seed: 1 }, ({ times, height }) =>
      times(12, (_, t) => rect(10, t * (height - 10), 80, 4)),
    );
    const out = sq(def);
    expect(new Set(out.frags.map((f) => f.shape)).size).toBe(12);
  });
});

describe('decimate', () => {
  it('drops the requested fraction of final strokes, deterministically', async () => {
    const { decimate } = await import('../src/index.js');
    const make = (p: number) =>
      sketch({ seed: 42 }, ({ times }) =>
        decimate(p, times(60, (_, t) => line(5, 5 + t * 90, 95, 5 + t * 90))),
      );
    const full = sq(make(0));
    const half = sq(make(0.5));
    const half2 = sq(make(0.5));
    expect(full.frags.length).toBe(60);
    // ~50% survive (seeded binomial; wide tolerance).
    expect(half.frags.length).toBeGreaterThan(15);
    expect(half.frags.length).toBeLessThan(45);
    // Deterministic: identical survivors both runs.
    expect(half2.frags.map((f) => f.origin)).toEqual(half.frags.map((f) => f.origin));
    // decimate(1) deletes everything.
    expect(sq(make(1)).frags.length).toBe(0);

    // Per-shape opt overrides the combinator default; exports see it too.
    const mixed = sketch({ seed: 42 }, ({ times }) =>
      decimate(1, [
        times(10, (_, t) => line(5, 5 + t * 20, 95, 5 + t * 20)),
        circle(50, 70, 10, { decimate: 0 }), // opts out
      ]),
    );
    const out = sq(mixed);
    expect(out.frags.every((f) => f.shape === 10)).toBe(true);
    const svg = exportSvg(mixed, { paper: 'Square20' });
    expect((svg.match(/A[0-9.]+ /g) ?? []).length).toBeGreaterThan(0); // circle arcs present
  });
});

  it('decimates fill and stroke independently', async () => {
    const { decimate } = await import('../src/index.js');
    // fill: 1 → hatch fully erased, outline intact.
    const fillOnly = sketch({ seed: 7 }, () => [
      rect(20, 20, 60, 60, { fill: hatch(45, mm(2)), decimate: { fill: 1 } }),
    ]);
    const out = sq(fillOnly);
    expect(out.frags.filter((f) => f.origin >= 4)).toHaveLength(0); // no fill ink
    expect(out.frags.filter((f) => f.origin < 4)).toHaveLength(4); // all 4 sides

    // stroke: 1 → outline gone, hatch intact.
    const strokeOnly = sketch({ seed: 7 }, () => [
      rect(20, 20, 60, 60, { fill: hatch(45, mm(2)), decimate: { stroke: 1 } }),
    ]);
    const out2 = sq(strokeOnly);
    expect(out2.frags.filter((f) => f.origin < 4)).toHaveLength(0);
    expect(out2.frags.filter((f) => f.origin >= 4).length).toBeGreaterThan(10);

    // Combinator accepts the object form too.
    const viaCombinator = sketch({ seed: 7 }, () =>
      decimate({ fill: 1 }, rect(20, 20, 60, 60, { fill: hatch(45, mm(2)) })),
    );
    const out3 = sq(viaCombinator);
    expect(out3.frags.filter((f) => f.origin >= 4)).toHaveLength(0);
    expect(out3.frags.filter((f) => f.origin < 4)).toHaveLength(4);
  });

describe('wobble', () => {
  it('displaces final strokes deterministically, bounded by amplitude', async () => {
    const { wobble } = await import('../src/index.js');
    const make = () =>
      sketch({ seed: 5 }, () => wobble(mm(1.5), line(10, 50, 90, 50)));
    const out = sq(make());
    expect(out.frags.length).toBeGreaterThan(20); // straight line → segments
    let maxDev = 0;
    for (const f of out.frags) {
      for (const t of [0, 1]) {
        maxDev = Math.max(maxDev, Math.abs(evalPrim(f.geom, t)[1] - 100));
      }
    }
    expect(maxDev).toBeGreaterThan(0.1);
    expect(maxDev).toBeLessThan(2.5);
    const out2 = sq(make());
    expect(out2.frags.map((f) => f.geom)).toEqual(out.frags.map((f) => f.geom));
    // Occlusion is computed on exact geometry: a wobbled hidden line stays hidden.
    const hidden = sketch({ seed: 5 }, () =>
      wobble(mm(1), [line(0, 50, 100, 50), rect(25, 25, 50, 50, { opaque: true })]),
    );
    const outH = sq(hidden);
    let inkLen = 0;
    for (const f of outH.frags.filter((f) => f.shape === 0)) {
      const g = f.geom as Extract<Prim, { t: 'line' }>;
      inkLen += Math.hypot(g.x1 - g.x0, g.y1 - g.y0);
    }
    expect(inkLen).toBeGreaterThan(90);
    expect(inkLen).toBeLessThan(115);
  });
});

describe('modifier stack', () => {
  it('modify() applies an ordered stack; order is authored', async () => {
    const { modify, decimate, wobble, times } = await import('../src/index.js');
    const lines = () => times(20, (_, t) => line(5, 5 + t * 90, 95, 5 + t * 90));
    // wobble → decimate deletes individual segments: many short survivors.
    const wd = sq(sketch({ seed: 9 }, () => modify([wobble(mm(1)), decimate(0.5)], lines())));
    // decimate → wobble deletes whole strokes first: segment count is a
    // multiple of surviving lines. Same ink budget, different structure.
    const dw = sq(sketch({ seed: 9 }, () => modify([decimate(0.5), wobble(mm(1))], lines())));
    expect(wd.frags.length).toBeGreaterThan(50);
    expect(dw.frags.length).toBeGreaterThan(50);
    expect(wd.frags.length).not.toBe(dw.frags.length);
    // decimate(1) at the end of any stack deletes everything.
    const gone = sq(sketch({ seed: 9 }, () => modify([wobble(mm(1)), decimate(1)], lines())));
    expect(gone.frags.length).toBe(0);
  });

  it('stacks concatenate through nesting, inner-first; repetition works', async () => {
    const { modify, wobble } = await import('../src/index.js');
    // Two wobbles at different wavelengths layer (multi-octave tremor).
    const layered = sq(sketch({ seed: 3 }, () =>
      modify([wobble({ amount: mm(1), wavelength: mm(40) })],
        modify([wobble({ amount: mm(0.3), wavelength: mm(5) })],
          line(10, 50, 90, 50)))));
    expect(layered.frags.length).toBeGreaterThan(40);
    // Nested modify with per-shape modifiers also composes.
    const perShape = sq(sketch({ seed: 3 }, () =>
      modify([wobble(mm(0.5))],
        line(10, 20, 90, 20, { modifiers: [wobble(mm(0.5))] }))));
    expect(perShape.frags.length).toBeGreaterThan(20);
  });

  it('rejects a bare modifier value in the tree with a helpful error', async () => {
    const { decimate } = await import('../src/index.js');
    const bad = sketch({ seed: 1 }, () => [decimate(0.5) as never, line(0, 0, 10, 10)]);
    expect(() => sq(bad)).toThrow(/modifier value/);
  });
});

describe('fields', () => {
  it('field-driven decimate varies over the page', async () => {
    const { decimate, times } = await import('../src/index.js');
    // Dissolve toward the bottom: p = y/100 (top row y=5 → ~0, bottom → ~0.95).
    const out = sq(sketch({ seed: 11 }, () =>
      decimate((_x, y) => y / 100, times(40, (_, t) => line(5, 2 + t * 96, 95, 2 + t * 96)))));
    const yOf = (f: (typeof out.frags)[number]): number =>
      (f.geom as Extract<Prim, { t: 'line' }>).y0;
    const top = out.frags.filter((f) => yOf(f) < 60).length;    // user y < 30
    const bottom = out.frags.filter((f) => yOf(f) > 160).length; // user y > 80
    expect(top).toBeGreaterThan(8);
    expect(bottom).toBeLessThan(top / 2);
  });

  it('field-driven wobble amplitude varies over the page', async () => {
    const { wobble } = await import('../src/index.js');
    // Calm left half, wild right half.
    const out = sq(sketch({ seed: 4 }, () =>
      wobble({ amount: (x) => (x < 50 ? 0 : 3), wavelength: mm(10) },
        line(5, 50, 95, 50))));
    let devLeft = 0;
    let devRight = 0;
    for (const f of out.frags) {
      for (const t of [0, 1]) {
        const [px, py] = evalPrim(f.geom, t);
        const dev = Math.abs(py - 100);
        if (px < 80) devLeft = Math.max(devLeft, dev);
        if (px > 120) devRight = Math.max(devRight, dev);
      }
    }
    expect(devLeft).toBeLessThan(0.5);
    expect(devRight).toBeGreaterThan(1);
  });

  it('one field function rasterises once and is shared across shapes', async () => {
    const { encodeScene, compileSketch, times } = await import('../src/index.js');
    const f = (_x: number, y: number): number => y / 100;
    const def = sketch({ seed: 1 }, () =>
      times(10, (k) => line(0, k * 10, 100, k * 10, { decimate: f })));
    compileSketch(def);
    const scene = encodeScene({ paper: 'Square20' });
    // One raster header (w,h,x0,y0,dx,dy) + samples — not ten.
    const w = scene.fieldData[0];
    const h = scene.fieldData[1];
    expect(scene.fieldData.length).toBe(6 + w * h);
  });
});

describe('phase-3 modifiers', () => {
  it('dash chops final strokes by physical length, curves stay curves', async () => {
    const { dash } = await import('../src/index.js');
    const out = sq(sketch({ seed: 2 }, () => dash(mm(4), mm(4), line(0, 50, 100, 50))));
    // 200mm line → 8mm period → 25 dashes of ~4mm.
    expect(out.frags.length).toBe(25);
    expect(totalLen(out.frags)).toBeGreaterThan(90);
    expect(totalLen(out.frags)).toBeLessThan(105);
    // A dashed circle stays made of exact arcs.
    const c = sq(sketch({ seed: 2 }, () => dash(mm(3), mm(3), circle(50, 50, 30))));
    expect(c.frags.length).toBeGreaterThan(10);
    expect(c.frags.every((f) => f.geom.t === 'arc')).toBe(true);
  });

  it('smooth rounds corners before the solve (perimeter shrinks)', async () => {
    const { smooth } = await import('../src/index.js');
    const sharp = sq(sketch({ seed: 2 }, () => rect(20, 20, 60, 60)));
    const smoothed = sq(sketch({ seed: 2 }, () => smooth(3, rect(20, 20, 60, 60))));
    const lenSharp = totalLen(sharp.frags);
    const lenSmooth = totalLen(smoothed.frags);
    expect(lenSmooth).toBeLessThan(lenSharp - 5); // corner cutting shrinks
    expect(lenSmooth).toBeGreaterThan(lenSharp * 0.8);
  });

  it('roughen fractures edges deterministically, bounded by amplitude', async () => {
    const { roughen } = await import('../src/index.js');
    const make = () => sketch({ seed: 8 }, () => roughen(mm(1.2), mm(2), rect(20, 20, 60, 60)));
    const out = sq(make());
    expect(out.frags.length).toBeGreaterThan(50);
    let maxDev = 0;
    for (const f of out.frags) {
      const g = f.geom as Extract<Prim, { t: 'line' }>;
      for (const [x, y] of [[g.x0, g.y0], [g.x1, g.y1]]) {
        // distance outside the crisp rect (40..160 mm square)
        const dx = Math.max(40 - x, x - 160, 0);
        const dy = Math.max(40 - y, y - 160, 0);
        maxDev = Math.max(maxDev, Math.hypot(dx, dy));
      }
    }
    expect(maxDev).toBeGreaterThan(0.2);
    expect(maxDev).toBeLessThan(1.3);
    expect(sq(make()).frags.length).toBe(out.frags.length);
  });

  it('deform changes occlusion (pre-solve); wobble does not', async () => {
    const { deform, wobble, noiseField } = await import('../src/index.js');
    const behind = (def: SketchDef): number =>
      totalLen(sq(def).frags.filter((f) => f.shape === 0));
    // Crisp circle r=15 hides exactly its diameter of the line.
    const crisp = behind(sketch({ seed: 6 }, () => [
      line(0, 50, 100, 50), circle(50, 50, 15, { opaque: true }),
    ]));
    expect(crisp).toBeCloseTo(200 - 60, 3);
    // Post-wobble: trembling ink, same hidden span.
    const wob = behind(sketch({ seed: 6 }, () => [
      line(0, 50, 100, 50), wobble(mm(2), circle(50, 50, 15, { opaque: true })),
    ]));
    expect(wob).toBeCloseTo(crisp, 3);
    // Pre-deform: the deformed silhouette is what hides.
    const def = behind(sketch({ seed: 6 }, ({ }) => [
      line(0, 50, 100, 50),
      deform(noiseField(3, 20), circle(50, 50, 15, { opaque: true })),
    ]));
    expect(Math.abs(def - crisp)).toBeGreaterThan(0.5);
    // The line itself stays perfectly straight — only the occluder deformed.
    const outD = sq(sketch({ seed: 6 }, () => [
      line(0, 50, 100, 50),
      deform(noiseField(3, 20), circle(50, 50, 15, { opaque: true })),
    ]));
    for (const f of outD.frags.filter((f) => f.shape === 0)) {
      const g = f.geom as Extract<Prim, { t: 'line' }>;
      expect(g.y0).toBeCloseTo(100, 6);
      expect(g.y1).toBeCloseTo(100, 6);
    }
  });
});

describe('seamless dash', () => {
  it('dashes a circle with uniform lengths and no seam', async () => {
    const { dash } = await import('../src/index.js');
    const out = sq(sketch({ seed: 2 }, () => dash(mm(3), mm(3), circle(50, 50, 30))));
    const lens = out.frags.map(fragLen).sort((a, b) => a - b);
    // Period snapped to circumference: every dash the same length, none
    // doubled or halved at the arc seams.
    expect(lens[lens.length - 1] - lens[0]).toBeLessThan(1e-6);
    const C = 2 * Math.PI * 60; // r=30 user units → 60mm on Square20
    expect(out.frags.length).toBe(Math.round(C / 6));
    // Gaps between consecutive dashes are uniform too (pattern meets itself).
    expect(lens[0]).toBeGreaterThan(2.9);
    expect(lens[0]).toBeLessThan(3.1);
  });

  it('dash phase survives occlusion cuts', async () => {
    const { dash } = await import('../src/index.js');
    // A dashed line partly hidden by a disc: surviving dashes must sit at
    // the same absolute positions as in the unoccluded render.
    const bare = sq(sketch({ seed: 2 }, () => dash(mm(4), mm(4), line(0, 50, 100, 50))));
    const occ = sq(sketch({ seed: 2 }, () => [
      dash(mm(4), mm(4), line(0, 50, 100, 50)),
      circle(50, 50, 15, { opaque: true }),
    ]));
    const starts = (frags: typeof bare.frags): number[] =>
      frags.filter((f) => f.shape === 0).map((f) => (f.geom as Extract<Prim, { t: 'line' }>).x0);
    const bareStarts = new Set(starts(bare.frags).map((x) => x.toFixed(6)));
    for (const x of starts(occ.frags)) {
      const g = occ.frags.find((f) => f.shape === 0 && (f.geom as Extract<Prim, { t: 'line' }>).x0 === x)!;
      const gl = g.geom as Extract<Prim, { t: 'line' }>;
      // Every surviving dash either starts at a pattern position or at the
      // occluder's edge (a truncated dash) — never at a re-phased position.
      const atPattern = bareStarts.has(x.toFixed(6));
      const atEdge = Math.abs(Math.hypot(gl.x0 - 100, 100 - 100) - 30) < 4.1;
      expect(atPattern || atEdge).toBe(true);
    }
  });

  it('dash offset shifts the pattern', async () => {
    const { dash } = await import('../src/index.js');
    const a = sq(sketch({ seed: 2 }, () => dash(mm(4), mm(4), line(0, 50, 100, 50))));
    const b = sq(sketch({ seed: 2 }, () => dash(mm(4), mm(4), mm(2), line(0, 50, 100, 50))));
    // The first dash may cover s=0 in both; the SECOND dash's start shows
    // the shift.
    const second = (out: typeof a): number =>
      out.frags.map((f) => (f.geom as Extract<Prim, { t: 'line' }>).x0).sort((p, q) => p - q)[1];
    expect(Math.abs(second(a) - second(b))).toBeCloseTo(2, 4); // shifted by the 2mm offset
  });
});

describe('ease', () => {
  it('all curves hit both endpoints; non-overshoot curves stay monotone in [0,1]', async () => {
    const { ease } = await import('../src/index.js');
    const monotone = [
      'linear', 'quadIn', 'quadOut', 'quadInOut', 'cubicIn', 'cubicOut', 'cubicInOut',
      'quartIn', 'quartOut', 'quartInOut', 'quintIn', 'quintOut', 'quintInOut', 'sinIn', 'sinOut', 'sinInOut',
      'expoIn', 'expoOut', 'expoInOut', 'circIn', 'circOut', 'circInOut',
      'smooth', 'smoother',
    ] as const;
    for (const [name, fn] of Object.entries(ease)) {
      expect(fn(0), `${name}(0)`).toBeCloseTo(0, 9);
      expect(fn(1), `${name}(1)`).toBeCloseTo(1, 9);
    }
    for (const name of monotone) {
      const fn = ease[name];
      let prev = -1e-9;
      for (let i = 0; i <= 100; i++) {
        const v = fn(i / 100);
        expect(v, `${name} monotone at ${i / 100}`).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = v;
      }
    }
    expect(ease.powIn(0.5, 3)).toBeCloseTo(ease.cubicIn(0.5), 12);
  });
});

describe('hatch align', () => {
  it("align: 'shape' gives identical marks regardless of position", () => {
    // Two identical small circles at different paper positions. Paper-
    // anchored hatch samples one global ruling, so their chord patterns
    // differ; shape-anchored centres the ruling on each circle, so the
    // fills are congruent (same chord lengths at the same relative spots).
    const chords = (align: 'paper' | 'shape') => {
      const def = sketch({ aspect: [1, 1] }, () => [
        circle(30, 30, mm(2.9), { fill: hatch({ angle: 0, spacing: mm(4), align }) }),
        circle(70, 51.3, mm(2.9), { fill: hatch({ angle: 0, spacing: mm(4), align }) }),
      ]);
      const r = sq(def);
      // Collect per-circle sorted chord lengths (line frags only).
      const per: number[][] = [[], []];
      for (const f of r.frags) {
        if (f.geom.t !== 'line' || f.dot) continue;
        const len = Math.hypot(f.geom.x1 - f.geom.x0, f.geom.y1 - f.geom.y0);
        per[f.shape === 0 ? 0 : 1].push(len);
      }
      return per.map((l) => l.sort((x, y) => x - y));
    };
    const paper = chords('paper');
    const shape = chords('shape');
    // Shape-anchored: congruent fills (same count, same lengths).
    expect(shape[0].length).toBe(shape[1].length);
    shape[0].forEach((len, k) => expect(len).toBeCloseTo(shape[1][k], 6));
    // And the centre chord exists: longest chord ≈ the diameter.
    expect(shape[0][shape[0].length - 1]).toBeCloseTo(5.8, 1);
    // Paper-anchored differs for these positions (the phase demo).
    const same =
      paper[0].length === paper[1].length &&
      paper[0].every((len, k) => Math.abs(len - paper[1][k]) < 1e-6);
    expect(same).toBe(false);
  });
});

describe('ui() tweakable values', () => {
  it('is an identity at runtime', async () => {
    const { ui } = await import('../src/index.js');
    expect(ui(12)).toBe(12);
    expect(ui(0.5, { min: 0, max: 2 })).toBe(0.5);
    expect(ui(true)).toBe(true);
  });

  it('scans literal calls with spans, opts, and inferred labels', async () => {
    const { scanUiControls } = await import('../src/index.js');
    const src = [
      "const rows = ui(12);",
      "const amp = ui(0.5, { min: 0, max: 2, step: 0.05 });",
      "const flip = ui(true);",
      "circle(50, 50, ui(-8, { label: 'radius' }));",
    ].join('\n');
    const cs = scanUiControls(src);
    expect(cs.map((c) => [c.label, c.value])).toEqual([
      ['rows', 12],
      ['amp', 0.5],
      ['flip', true],
      ['radius', -8],
    ]);
    expect(cs[1].opts).toEqual({ min: 0, max: 2, step: 0.05 });
    // The span is exactly the literal — replacing it retunes the sketch.
    for (const c of cs) expect(src.slice(c.valueStart, c.valueEnd)).toBe(String(c.value));
  });

  it('ignores non-literals, strings, comments, and other identifiers', async () => {
    const { scanUiControls } = await import('../src/index.js');
    const src = [
      "const a = ui(rnd(10));           // computed — not a control",
      "// ui(99) in a comment",
      "const s = 'call ui(7) maybe';",
      "const t = `also ui(3) ${gui(4)}`;",
      "myui(5); obj.ui(6);",
      "const real = ui(2);",
    ].join('\n');
    const cs = scanUiControls(src);
    expect(cs.map((c) => [c.label, c.value])).toEqual([['real', 2]]);
  });
});

describe('live-coding guards', () => {
  it('rejects infinite and absurd repetition counts with clear errors', async () => {
    const { times, range, grid } = await import('../src/index.js');
    // The freeze that motivated this: STEP typed as "0.0" on the way to
    // "0.05" makes (MAX - MIN) / STEP + 1 === Infinity.
    expect(() => times(Infinity, () => null)).toThrow(/zero step/);
    expect(() => times(NaN, () => null)).toThrow(/count is NaN/);
    expect(() => times(1e9, () => null)).toThrow(/cap/);
    expect(() => range(0, 10, 0)).toThrow(/zero step/);
    expect(times(3, (k) => k)).toEqual([0, 1, 2]);
    expect(range(0, 3)).toEqual([0, 1, 2]);
    // grid needs sketch state for bounds(): validate via a render.
    const def = sketch({ aspect: [1, 1] }, (t) =>
      t.grid({ cols: 1e6, rows: 1e6 }).map((c) => rect(c.x, c.y, c.w, c.h)),
    );
    expect(() => sq(def)).toThrow(/grid.*cap/);
  });

  it('rejects zero or negative fill spacings', () => {
    expect(() => hatch(45, 0)).toThrow(/positive length/);
    expect(() => hatch(45, mm(0))).toThrow(/positive length/);
    expect(() => hatch({ angle: 45, spacing: mm(-1) })).toThrow(/positive length/);
    expect(() => stipple(0.5, mm(0))).toThrow(/positive length/);
    expect(hatch(45, mm(0.05))).toBeTruthy(); // small-but-real stays legal
  });
});

describe('svg() shape source', () => {
  const fixture = readFileSync(
    fileURLToPath(new URL('./fixtures/splotter-strokes.svg', import.meta.url)),
    'utf8',
  );

  it('renders an imported SVG like any other shapes, sized in sketch units', () => {
    const def = sketch({ aspect: [1, 1] }, (t) => t.svg(fixture, { x: 5, y: 5, width: 90 }));
    const r = sq(def);
    // 77 strokes survive as drawable fragments (nothing occludes them).
    expect(r.frags.length).toBeGreaterThanOrEqual(77);
    expect(r.stats.shapesIn).toBe(77);
  });

  it('composes with modifiers and layer filtering', async () => {
    const { modify, wobble } = await import('../src/index.js');
    const def = sketch({ aspect: [1, 1] }, (t) =>
      modify([wobble(mm(0.4))], t.svg(fixture, { width: 80, layers: ['silhouettes'] })),
    );
    const r = sq(def);
    expect(r.frags.length).toBeGreaterThan(0);
    expect(() =>
      sketch({ aspect: [1, 1] }, (t) => t.svg(fixture, { layers: ['nope'] })) && sq(
        sketch({ aspect: [1, 1] }, (t) => t.svg(fixture, { layers: ['nope'] })),
      ),
    ).toThrow(/layer filter/);
  });

  it('rejects transforms and curves loudly', () => {
    const bad = '<svg viewBox="0 0 10 10"><g transform="scale(2)"><line x1="0" y1="0" x2="1" y2="1"/></g></svg>';
    const def = sketch({ aspect: [1, 1] }, (t) => t.svg(bad));
    expect(() => sq(def)).toThrow(/transform/);
  });
});

describe('svg() with the generic transform opts', () => {
  it('rotates via the same rotate every shape has (pivot at translate)', () => {
    const src = '<svg viewBox="0 0 100 50"><polyline points="0,0 100,0"/></svg>';
    // Artwork at its own origin; translate+rotate = corner pivot at (30,10).
    // 90° CW turns the horizontal top edge vertical, running down the page.
    const def = sketch({ aspect: [1, 1] }, (t) =>
      t.svg(src, { width: 50, translate: [30, 10], rotate: 90 }),
    );
    const r = sq(def);
    const line = r.frags[0].geom;
    expect(line.t).toBe('line');
    if (line.t === 'line') {
      expect(Math.abs(line.x1 - line.x0)).toBeLessThan(1e-6);
      expect(line.y1).toBeGreaterThan(line.y0);
    }
  });
});

describe('image assets', () => {
  it('samples points, area averages, bands, and edges from registered pixels', async () => {
    const { registerImageAsset, image, clearAssets, scanAssetNames, asset, registerTextAsset } =
      await import('../src/index.js');
    clearAssets();
    // 4×2: left half black, right half white.
    const w = 4, h = 2;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = x < 2 ? 0 : 255;
        data.set([v, v, v, 255], (y * w + x) * 4);
      }
    registerImageAsset('test.png', { width: w, height: h, data });
    const img = image('test.png', { x: 10, y: 10, width: 40 }); // 40×20 units
    expect(img.height).toBe(20);
    // Pixel centers: left half ~0, right half ~1.
    expect(img.lum(15, 15)).toBeCloseTo(0, 5);
    expect(img.lum(45, 15)).toBeCloseTo(1, 5);
    // Area average over the WHOLE placed rect = 0.5 exactly (SAT).
    expect(img.lum(30, 20, 25)).toBeCloseTo(0.5, 5);
    // Outside → 0.
    expect(img.lum(0, 0)).toBe(0);
    expect(img.lum(60, 15)).toBe(0);
    // Bands: 4 levels → 0 on black, 3 on white.
    expect(img.bands(15, 15, 4)).toBe(0);
    expect(img.bands(45, 15, 4)).toBe(3);
    // Edge peaks at the boundary, quiet in flat regions; dir points +x.
    expect(img.edge(30, 15)).toBeGreaterThan(img.edge(15, 15) + 0.1);
    expect(Math.cos(img.dir(30, 15))).toBeGreaterThan(0.7);
    // rgb/alpha shape.
    expect(img.rgb(45, 15)).toEqual([1, 1, 1]);
    expect(img.a(45, 15)).toBe(1);
    // Text assets + literal scanning.
    registerTextAsset('x.svg', '<svg/>');
    expect(asset('x.svg')).toBe('<svg/>');
    expect(() => asset('test.png')).toThrow(/is an image/);
    expect(scanAssetNames(`image('a.png'); asset("b.svg"); image('a.png')`))
      .toEqual(['a.png', 'b.svg']);
    clearAssets();
    expect(() => image('test.png')).toThrow(/unknown asset/);
  });
});

describe('bridge opt', () => {
  it('joins opted strokes across gaps; excluded shapes stay separate', async () => {
    // Three parallel 1mm-gapped lines opted in + one border rect NOT opted.
    const def = sketch({ seed: 1 }, ({ group }) => [
      group({ bridge: mm(1.5) },
        line(10, 10, 90, 10),
        line(90, 10.6, 10, 10.6),   // ends near line 1's end → joins
        line(10, 11.2, 90, 11.2),   // chains on
      ),
      rect(2, 2, 96, 96),           // border: no opt, never joined
    ]);
    const out = sq(def);
    const bridges = out.frags.filter((f) => f.bridge);
    expect(bridges).toHaveLength(2); // serpentine: 3 lines, 2 connectors
    // Connectors are tiny (~the gap), pen-matched, and span blank paper.
    for (const b of bridges) expect(fragLen(b)).toBeLessThan(3.2);
    // The border contributes no bridge frags and stays 4 clean edges.
    const borderFrags = out.frags.filter((f) => f.shape === 3 && !f.bridge);
    expect(borderFrags.length).toBeGreaterThan(0);
    // Toolpath check: the three opted lines + connectors merge into ONE
    // chain (shared exact endpoints), so lifts drop 3 → 1.
    const core = (await import('occlude-core')) as unknown as {
      wasm_export_toolpath(
        p: Float64Array, f: Float64Array, pens: string, b: number, t: number,
      ): Float64Array;
    };
    const plan = core.wasm_export_toolpath(
      out.raw.prims, out.raw.frags, JSON.stringify(out.pens), 10_000, 0.05,
    );
    let chains = 0;
    for (let i = 0; i < plan.length; ) {
      chains += 1;
      i += 3 + plan[i + 2] * 2;
    }
    expect(chains).toBe(2); // one serpentine + one border loop
  });
});
