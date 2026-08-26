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

  it('off-paper shapes are culled', () => {
    const def = sketch({ seed: 1 }, ({ group }) => [
      circle(50, 50, 10),
      group({ translate: [500, 0] }, circle(50, 50, 10)),
    ]);
    const out = sq(def);
    expect(out.stats.culledOffPaper).toBe(1);
  });
});
