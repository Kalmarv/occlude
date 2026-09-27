import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { circle, distanceTo, material, rect, sketch, space, spaceOf } from '../src/index.js';
import { toolkit } from './helpers/run.js';
import { inSpace } from '../src/material.js';
import { initOcclude, render } from '../src/host.js';
import type { SketchDef } from '../src/index.js';
import type { RenderOptions } from '../src/host.js';
import { xy, rec } from './helpers/xy.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(
    new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
  );
  await initOcclude(readFileSync(wasmPath));
});

const sq = (def: SketchDef, opts: RenderOptions = {}) =>
  render(def, { paper: 'Square20', ...opts });

const square = (x0: number, y0: number, s: number): [number, number][] => [
  [x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s],
];

describe('distanceTo: signed distance field', () => {
  it('is positive inside, negative outside, ~zero on the boundary', () => {
    const d = distanceTo([square(10, 10, 20)]);
    expect(d(20, 20)).toBeCloseTo(10, 12); // centre: 10 from every wall
    expect(d(12, 20)).toBeCloseTo(2, 12); // 2 in from the left wall
    expect(d(5, 20)).toBeCloseTo(-5, 12); // 5 outside the left wall
    expect(d(10, 20)).toBeCloseTo(0, 12);
    expect(d(0, 0)).toBeCloseTo(-Math.hypot(10, 10), 12); // corner diagonal
  });

  it('holes flip the sign back (even-odd, like region)', () => {
    const d = distanceTo([square(0, 0, 30), square(10, 10, 10)]);
    expect(d(5, 15)).toBeCloseTo(5, 12); // in the band
    expect(d(15, 15)).toBeCloseTo(-5, 12); // centre of the hole: outside
    expect(d(15, 11)).toBeCloseTo(-1, 12); // just inside the hole
  });

  it('open loops get their closing chord, no usable loops give -Infinity', () => {
    // Two points: the chord back makes a degenerate sliver — everywhere is
    // "outside" with distance to the segment.
    const d = distanceTo([[[0, 0], [10, 0]]]);
    expect(d(5, 3)).toBeCloseTo(-3, 12);
    expect(distanceTo([])(1, 2)).toBe(-Infinity);
    expect(distanceTo([[[4, 4]]])(1, 2)).toBe(-Infinity);
  });

  it('matches the brute-force scan on a jagged loop', () => {
    const loop: [number, number][] = [];
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * 2 * Math.PI;
      const r = 20 + 7 * Math.sin(5 * a);
      loop.push([50 + r * Math.cos(a), 50 + r * Math.sin(a)]);
    }
    const d = distanceTo([loop]);
    const brute = (x: number, y: number): number => {
      let best = Infinity;
      const n = loop.length;
      for (let i = 0; i < n; i++) {
        const [ax, ay] = loop[i];
        const [bx, by] = loop[(i + 1) % n];
        const dx = bx - ax;
        const dy = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
        best = Math.min(best, Math.hypot(x - (ax + dx * t), y - (ay + dy * t)));
      }
      return best;
    };
    for (let y = 20; y <= 80; y += 7) {
      for (let x = 20; x <= 80; x += 7) {
        expect(Math.abs(d(x, y))).toBeCloseTo(brute(x, y), 9);
      }
    }
  });

  it('isolines(distanceTo(loop), k) insets: nested rings, halo at negative k', () => {
    const capture: { level: number; count: number; span: number }[] = [];
    const def = sketch({ seed: 1 }, (t) => {
      const d = t.distanceTo([square(20, 20, 60)]);
      for (const level of [5, 15, -5]) {
        const cs = t.isolines(d, level, { step: 0.5 });
        let minX = Infinity;
        let maxX = -Infinity;
        for (const [x] of cs.points.map(xy)) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
        }
        capture.push({ level, count: cs.curves.map(rec).length, span: maxX - minX });
      }
      return [rect(0, 0, 1, 1)];
    });
    sq(def);
    const [inset5, inset15, halo] = capture;
    expect(inset5.count).toBe(1);
    expect(inset5.span).toBeCloseTo(50, 0); // 60 − 2·5
    expect(inset15.count).toBe(1);
    expect(inset15.span).toBeCloseTo(30, 0); // 60 − 2·15
    expect(halo.count).toBe(1);
    expect(halo.span).toBeCloseTo(70, 0); // 60 + 2·5, rounded corners
  });
});

describe('distanceTo in a curved space', () => {
  it('the pure word measures in the space a value carries, as the toolkit twin does', () => {
    const t = toolkit({ aspect: [1, 1], space: space.hyperbolic({ radius: 45 }) });
    const c = t.space.center;
    const ring = t.material(circle(c, 10));
    // The toolkit twin measures in the space: at the centre, the radius.
    const inside = t.distanceTo(ring)(c[0], c[1]);
    expect(inside).toBeCloseTo(10, 1);
    // The pure word reads the space off the value: a material of a curved
    // sketch, a face of one and a vertex list of one are the same area.
    for (const v of [ring, ring.faces.at(0), [...ring.points]]) {
      expect(distanceTo(v as never)(c[0], c[1])).toBeCloseTo(inside, 9);
    }
    // Its points are points of the space: minus the distance to the nearest.
    const off: [number, number] = [c[0] + 3, c[1] - 2];
    expect(distanceTo(ring.points)(off[0], off[1])).toBe(t.distanceTo(ring.points)(off[0], off[1]));
    // Plain numbers carry no space: the flat field of the coordinates.
    const flatRadius = distanceTo(ring.contours())(c[0], c[1]);
    expect(flatRadius).toBeGreaterThan(0);
    expect(Math.abs(flatRadius - inside)).toBeGreaterThan(0.01);
    // A flat material is measured as it always was.
    const flat = toolkit({ aspect: [1, 1] });
    const box = flat.material(rect(40, 40, 20, 20));
    expect(distanceTo(box)(50, 50)).toBeCloseTo(10, 12);
  });

  it('the toolkit twin reads the space a value carries before the sketch\'s', () => {
    // A flat sketch holding points of a curved space: the value says where
    // its coordinates are, so the field is the space's, not the sheet's.
    const disk = spaceOf({ curvature: -4 / (45 * 45), center: [50, 50] });
    const flat = toolkit({ aspect: [1, 1] });
    const site = material([[50, 50]]);
    const curvedSite = inSpace(material([[50, 50]]), disk);
    expect(flat.distanceTo(site)(50, 80)).toBeCloseTo(-30, 12);
    expect(flat.distanceTo(curvedSite)(50, 80)).toBeCloseTo(-disk.distance([50, 50], [50, 80]), 12);
  });
});
