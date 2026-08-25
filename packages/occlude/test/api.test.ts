import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  bounds, chance, circle, clip, evalPrim, exportGcode, exportSvg, grid, hatch,
  initOcclude, line, margin, mm, path, pen, pick, polygon, push, rect, render,
  rnd, s, sketch, stipple, stream, w,
} from '../src/index.js';
import type { Fragment, Prim } from '../src/index.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(
    new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
  );
  await initOcclude(readFileSync(wasmPath));
});

function fragLen(f: Fragment): number {
  const p = f.geom;
  if (p.t === 'line') return Math.hypot(p.x1 - p.x0, p.y1 - p.y0);
  if (p.t === 'arc') return p.r * Math.abs(p.sweep);
  // Chord approximation is fine for the assertions here.
  return Math.hypot(p.x1 - p.x0, p.y1 - p.y0);
}

function totalLen(frags: Fragment[]): number {
  return frags.filter((f) => !f.dot).reduce((s, f) => s + fragLen(f), 0);
}

describe('occlude end to end', () => {
  it('occludes a line under a filled rect', () => {
    sketch({ seed: 1 });
    line(0, 50, 100, 50);
    rect(25, 25, 50, 50).fill(hatch(45));
    const out = render({ paper: 'Square20' });
    // Paper 200×200: line spans (0,100)→(200,100); rect covers x∈[50,150].
    const lineFrags = out.frags.filter((f) => f.shape === 0);
    expect(lineFrags).toHaveLength(2);
    expect(totalLen(lineFrags)).toBeCloseTo(100, 4);
    // Hatch was generated for the rect.
    expect(out.stats.fillPrims).toBeGreaterThan(5);
  });

  it('fill on an open shape throws', () => {
    sketch({ seed: 1 });
    expect(() => line(0, 0, 10, 10).fill(hatch())).toThrow(/open/);
    expect(() => path().moveTo(0, 0).lineTo(10, 10).fill(hatch())).toThrow(/open/);
    // Closed path fills fine.
    expect(() =>
      path().moveTo(0, 0).lineTo(10, 0).lineTo(10, 10).close().fill(hatch()),
    ).not.toThrow();
  });

  it('unknown pen throws loudly', () => {
    sketch({ seed: 1 });
    expect(() => pen('does-not-exist')).toThrow(/unknown pen/);
    expect(() => pen({ name: 'custom', width: 0.5, color: '#123456' })).not.toThrow();
    pen('pigma-005-black');
  });

  it('z() overrides draw order', () => {
    sketch({ seed: 1 });
    circle(40, 50, 20).fill(hatch()).z(10); // drawn first, stacked on top
    circle(60, 50, 20).fill(hatch());
    const out = render({ paper: 'Square20' });
    // Shape 0 keeps its whole outline (two arcs, full sweep).
    const outline0 = out.frags.filter((f) => f.shape === 0 && f.geom.t === 'arc');
    const sweep = outline0.reduce(
      (s, f) => s + Math.abs((f.geom as Extract<Prim, { t: 'arc' }>).sweep), 0);
    expect(sweep).toBeCloseTo(2 * Math.PI, 5);
  });

  it('clip() restricts and does not occlude or draw', () => {
    sketch({ seed: 1 });
    clip(circle(50, 50, 25), () => {
      line(0, 50, 100, 50);
    });
    const out = render({ paper: 'Square20' });
    expect(out.frags).toHaveLength(1);
    // Clipped to the circle's horizontal diameter: 2×25% of 200mm = 100mm.
    expect(totalLen(out.frags)).toBeCloseTo(100, 4);
  });

  it('push() composes transforms', () => {
    sketch({ seed: 1 });
    push({ translate: [20, 0] }, () => {
      push({ translate: [0, 30] }, () => {
        circle(0, 0, 10);
      });
    });
    circle(20, 30, 10);
    const out = render({ paper: 'Square20' });
    const arcs = out.frags.filter((f) => f.geom.t === 'arc');
    // Both circles land identically, so the coincident-seam dedupe draws the
    // outline exactly once: two half-circle arcs.
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
    sketch({ aspect: [1, 1], seed: 1, origin: 'center' });
    for (const deg of [0, 30, 45, 137]) {
      push({ rotate: deg }, () => rect(-10, -4, 20, 8));
    }
    const out = render({ paper: 'Square20' });
    // Every rotated rect's bbox centre must stay at the paper centre (100,100).
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
    sketch({ seed: 1, yUp: true });
    circle(50, 25, 10);
    const out = render({ paper: 'Square20' });
    const arcs = out.frags.filter((f) => f.geom.t === 'arc');
    expect(arcs.length).toBe(2);
    const a = arcs[0].geom as Extract<Prim, { t: 'arc' }>;
    expect(a.cx).toBeCloseTo(100, 6);
    expect(a.cy).toBeCloseTo(150, 6); // y=25 from the bottom of a 200mm square
  });

  it('stipples stay inside rotated rounded rects (reported seeds)', () => {
    // Every seed here escaped the stadium before the seam-weld fix.
    for (const seed of [556023384, 1026822258, 376656802, 219337517, 2058254706, 600858359, 1592708539, 1788219583, 1635323682, 1718006969, 2056267948]) {
      sketch({ aspect: [1, 1], seed, origin: 'center' });
      margin(6);
      for (let i = 0; i < 100; i++) {
        push({ rotate: i }, () => {
          rect(-10, -4, 20, 8, 10).fill(stipple(1), 'stabilo-88-red');
        });
      }
      const out = render({ paper: 'Square20' });
      const dots = out.frags.filter((f) => f.dot);
      expect(dots.length).toBeGreaterThan(50);
      // Independent check: inverse-rotate each dot into its shape's local
      // user units and evaluate the rounded-box SDF (half 10×4, r 4 stadium).
      const unit = 176 / 100; // Square20, 6% margin: drawable 176mm
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
          Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
          Math.min(Math.max(qx, qy), 0) -
          r;
        worst = Math.max(worst, sdf);
      }
      expect(worst, `seed ${seed}`).toBeLessThanOrEqual(0.05);
    }
  });

  it('letterboxes a square aspect onto A4 and margins inset', () => {
    sketch({ aspect: 'square', seed: 1 });
    margin(10); // 10% of short side (210) = 21mm margins
    line(0, 0, 100, 0); // top edge of the drawable square
    const out = render({ paper: 'A4' });
    expect(out.frags).toHaveLength(1);
    const g = out.frags[0].geom as Extract<Prim, { t: 'line' }>;
    // Drawable: 210−42=168 wide, 297−42=255 tall → square 168, centered.
    expect(g.y0).toBeCloseTo(21 + (255 - 168) / 2, 3);
    expect(Math.abs(g.x1 - g.x0)).toBeCloseTo(168, 3);
  });

  it('tagged units resolve against the right axes', () => {
    sketch({ seed: 1 });
    line(0, 0, w(100), 0); // full drawable width on A4
    line(0, 0, mm(50), 0);
    const out = render({ paper: 'A4' });
    const g0 = out.frags.find((f) => f.shape === 0)!.geom as Extract<Prim, { t: 'line' }>;
    const g1 = out.frags.find((f) => f.shape === 1)!.geom as Extract<Prim, { t: 'line' }>;
    expect(Math.abs(g0.x1 - g0.x0)).toBeCloseTo(210, 3);
    expect(Math.abs(g1.x1 - g1.x0)).toBeCloseTo(50, 3);
  });

  it('s() is long-side percent and grid() tiles the whole drawable', () => {
    sketch({ aspect: [2, 1], seed: 1 });
    line(0, 0, s(100), 0); // full long axis
    line(0, 0, s(50), 0); // half of it — the short axis's full extent
    const cells = grid({ cols: 4, rows: 2 });
    const b = bounds();
    // Cells cover the whole drawable in bare units, not just 0–100.
    const maxX = Math.max(...cells.map((c) => c.x + c.w));
    const maxY = Math.max(...cells.map((c) => c.y + c.h));
    expect(maxX).toBeCloseTo(b.w, 9); // 200 on a 2:1 aspect
    expect(maxY).toBeCloseTo(b.h, 9); // 100
    const out = render({ paper: { paper: { w: 200, h: 100 } } });
    const g0 = out.frags.find((f) => f.shape === 0)!.geom as Extract<Prim, { t: 'line' }>;
    const g1 = out.frags.find((f) => f.shape === 1)!.geom as Extract<Prim, { t: 'line' }>;
    expect(Math.abs(g0.x1 - g0.x0)).toBeCloseTo(200, 3); // s(100) = long side
    expect(Math.abs(g1.x1 - g1.x0)).toBeCloseTo(100, 3); // s(50) = short side
  });

  it('seeded randomness and stipple are deterministic', () => {
    const run = () => {
      sketch({ seed: 'fixed-seed' });
      const r = [rnd(), rnd(10), pick([1, 2, 3]), chance(0.5)];
      circle(50, 50, 30).fill(stipple(0.5, mm(2)));
      const out = render({ paper: 'Square20' });
      return { r, dots: out.frags.filter((f) => f.dot).map((f) => f.geom) };
    };
    const a = run();
    const b = run();
    expect(a.r).toEqual(b.r);
    expect(a.dots.length).toBeGreaterThan(10);
    expect(a.dots).toEqual(b.dots);
  });

  it('polygon forms work', () => {
    sketch({ seed: 1 });
    polygon(50, 50, 6, 20).fill(hatch(0, mm(2)));
    polygon([[10, 10], [30, 10], [20, 30]]);
    const out = render({ paper: 'Square20' });
    expect(out.frags.filter((f) => f.shape === 0 && f.geom.t === 'line').length)
      .toBeGreaterThan(6); // 6 edges + hatch lines
    expect(out.frags.filter((f) => f.shape === 1)).toHaveLength(3);
  });

  it('fill(), mask() and fill(false) semantics', () => {
    sketch({ seed: 1 });
    line(0, 50, 100, 50);
    circle(50, 50, 25).mask(); // no stroke, no ink, still opaque
    const out = render({ paper: 'Square20' });
    expect(out.frags.every((f) => f.shape === 0)).toBe(true);
    expect(totalLen(out.frags)).toBeCloseTo(100, 4); // 200mm line minus 100mm diameter

    // Bare fill(): opaque with only the stroke drawn — a mask with a border.
    sketch({ seed: 1 });
    line(0, 50, 100, 50);
    circle(50, 50, 25).fill();
    const out2 = render({ paper: 'Square20' });
    expect(out2.frags.some((f) => f.shape === 1 && f.geom.t === 'arc')).toBe(true);
    expect(out2.stats.fillPrims).toBe(0); // no texture ink
    const lineLen = totalLen(out2.frags.filter((f) => f.shape === 0));
    expect(lineLen).toBeCloseTo(100, 4);

    // fill(false) CLEARS the fill: transparent again, stops occluding —
    // symmetric with stroke(false).
    sketch({ seed: 1 });
    line(0, 50, 100, 50);
    circle(50, 50, 25).fill(hatch()).fill(false);
    const out3 = render({ paper: 'Square20' });
    expect(out3.stats.fillPrims).toBe(0); // hatch gone
    const lineLen3 = totalLen(out3.frags.filter((f) => f.shape === 0));
    expect(lineLen3).toBeCloseTo(200, 4); // nothing occludes the line
  });

  it('bounds() reports the drawable extent in bare units', () => {
    sketch({ aspect: [3, 2], seed: 1 });
    const b = bounds();
    expect(b.h).toBe(100);
    expect(b.w).toBeCloseTo(150, 9);
    expect(b.cx).toBeCloseTo(75, 9);

    // aspect 'paper' uses the paper hint (A4 portrait standalone).
    sketch({ seed: 1 });
    const bp = bounds();
    expect(bp.w).toBe(100);
    expect(bp.h).toBeCloseTo((100 * 297) / 210, 6);

    // The full-bleed rect derived from bounds() really spans the drawable.
    sketch({ aspect: [2, 1], seed: 1 });
    const bb = bounds();
    line(0, 0, bb.w, 0);
    const out = render({ paper: { paper: { w: 200, h: 100 } } });
    expect(totalLen(out.frags)).toBeCloseTo(200, 3);
  });

  it('named streams are independent of the main stream and each other', () => {
    sketch({ seed: 'stream-test' });
    const a1 = stream('ridges');
    const vals1 = [a1.rnd(), a1.rnd(), stream('trees').rnd()];
    const main1 = rnd();

    // Same seed, but interleave extra draws from the main stream and a new
    // stream — named streams must not shift.
    sketch({ seed: 'stream-test' });
    rnd();
    rnd();
    stream('other').rnd();
    const a2 = stream('ridges');
    const vals2 = [a2.rnd(), a2.rnd(), stream('trees').rnd()];
    expect(vals2).toEqual(vals1);
    // And the main stream is unaffected by named-stream usage.
    sketch({ seed: 'stream-test' });
    stream('ridges').rnd();
    expect(rnd()).toBe(main1);
  });

  it('custom fills receive contains/path/area and accept polylines', () => {
    sketch({ seed: 1 });
    let seenArea = 0;
    let insideHits = 0;
    circle(50, 50, 25).fill((region, ctx) => {
      seenArea = region.area;
      expect(region.path.length).toBe(1); // one contour
      // Probe contains(): centre in, corner out.
      expect(region.contains(100, 100)).toBe(true);
      expect(region.contains(region.bbox.x + 0.1, region.bbox.y + 0.1)).toBe(false);
      const pts: [number, number][] = [];
      for (let i = 0; i < 200; i++) {
        const x = region.bbox.x + ctx.rnd() * region.bbox.w;
        const y = region.bbox.y + ctx.rnd() * region.bbox.h;
        if (region.contains(x, y)) {
          insideHits++;
          pts.push([x, y]);
        }
      }
      return [{ type: 'polyline', pts }];
    });
    const out = render({ paper: 'Square20' });
    // Circle r=50mm: area ≈ π·2500 within the flattening error (<0.5%).
    expect(Math.abs(seenArea - Math.PI * 2500) / (Math.PI * 2500)).toBeLessThan(0.005);
    expect(insideHits).toBeGreaterThan(100);
    expect(out.frags.filter((f) => f.shape === 0 && f.origin >= 2).length)
      .toBeGreaterThan(10);
  });

  it('fills accept object options', () => {
    sketch({ seed: 1 });
    circle(30, 50, 15).fill(hatch({ angle: 45, offset: 1.5 }));
    circle(70, 50, 15).fill(stipple({ density: 0.7, minDist: mm(1.5) }));
    const out = render({ paper: 'Square20' });
    expect(out.stats.fillPrims).toBeGreaterThan(10);
    expect(out.frags.some((f) => f.dot)).toBe(true);
  });

  it('clone() duplicates geometry and records a new shape', () => {
    sketch({ seed: 1 });
    const ridge = path().moveTo(10, 60).lineTo(40, 30).lineTo(70, 55).lineTo(90, 40);
    ridge.clone().lineTo(90, 90).lineTo(10, 90).close().mask();
    const out = render({ paper: 'Square20' });
    // The stroked ridge survives fully (the mask is BEHIND nothing — it is
    // later in draw order, so it occludes the ridge where they overlap).
    const ridgeFrags = out.frags.filter((f) => f.shape === 0);
    expect(ridgeFrags.length).toBeGreaterThan(0);
    // The mask contributes no ink.
    expect(out.frags.every((f) => f.shape === 0)).toBe(true);
  });

  it('custom fills can return arcs (variable-radius dots)', () => {
    sketch({ seed: 1 });
    circle(50, 50, 30).fill((region, ctx) => {
      // Variable-radius dot field: full circles as single 2π arcs, paper mm.
      const prims = [];
      for (let i = 0; i < 40; i++) {
        const r = 0.4 + ctx.rnd() * 1.2;
        prims.push({
          type: 'arc' as const,
          cx: region.bbox.x + ctx.rnd() * region.bbox.w,
          cy: region.bbox.y + ctx.rnd() * region.bbox.h,
          r,
          start: 0,
          sweep: Math.PI * 2,
        });
      }
      return prims;
    });
    const out = render({ paper: 'Square20' });
    const arcFrags = out.frags.filter(
      (f) => f.geom.t === 'arc' && f.origin >= 2, // beyond the outline's two arcs
    );
    expect(arcFrags.length).toBeGreaterThan(10);
    // Every dot fragment stays inside the fill region (clipped, not clamped).
    for (const f of arcFrags) {
      for (const t of [0, 0.5, 1]) {
        const [x, y] = (() => {
          const a = f.geom as Extract<Prim, { t: 'arc' }>;
          const ang = a.start + t * a.sweep;
          return [a.cx + a.r * Math.cos(ang), a.cy + a.r * Math.sin(ang)];
        })();
        const d = Math.hypot(x - 100, y - 100); // region: circle r=60mm at centre
        expect(d).toBeLessThanOrEqual(60 + 1e-6);
      }
    }
  });

  it('exports SVG and per-pen G-code', () => {
    sketch({ seed: 1 });
    pen('pigma-005-black');
    circle(35, 50, 20).fill(hatch(45));
    circle(65, 50, 20).fill(hatch(-45), 'stabilo-88-red');
    const svg = exportSvg({ paper: 'A5', background: '#faf7f0' });
    expect(svg).toContain('<svg');
    expect(svg).toContain('data-pen="pigma-005-black"');
    expect(svg).toContain('data-pen="stabilo-88-red"');
    const jobs = exportGcode({ paper: 'A5' });
    expect(jobs).toHaveLength(2);
    expect(jobs[0].gcode).toContain('G21');
    expect(jobs[0].inkMm).toBeGreaterThan(10);
    expect(jobs.map((j) => j.penName)).toContain('stabilo-88-red');
  });

  it('off-paper shapes are culled', () => {
    sketch({ seed: 1 });
    circle(50, 50, 10);
    push({ translate: [500, 0] }, () => circle(50, 50, 10));
    const out = render({ paper: 'Square20' });
    expect(out.stats.culledOffPaper).toBe(1);
  });
});
