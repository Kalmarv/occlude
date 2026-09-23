// Spec 67: the doors the sibling pass (spec 66) could not open, because
// they live in the toolkit, the 2D rows and the frame. One block per entry;
// the failing lines come from the audit sketches' `// FRICTION` comments.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  initOcclude, renderAsync, render, sketch, pen, mm, strokes, circle, rect, material, query, grad, rotate, space,
  type RenderResult, type SketchConfig,
} from '../src/index.js';
import { box, plane, sphere, view, orthographic, perspective, curve } from '../src/three/api/index.js';
import { ProjectedCurves, type ProjectedLines } from '../src/three/api/projected.js';
import { toPaper3 } from '../src/three/camera.js';
import { lerp3 } from '../src/three/math.js';
import { paperToUser } from '../src/record.js';
import { flattenPrim } from '../src/prims.js';
import { toolkit, SQ } from './helpers/run.js';

beforeAll(async () => {
  await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url)));
});

const pens = { ink: pen({ width: mm(0.3), color: '#18202A' }), ghost: pen({ width: mm(0.15), color: '#8A94A6' }) };
const draw = (body: Parameters<typeof sketch>[1]) => renderAsync(sketch({ aspect: [1, 1], pens }, body), { paper: 'Square20' });

describe('O1 · G3-21 · t.within cuts projected lines', () => {
  const scene = () => [box(1.5), sphere(0.7, { segments: 24, rings: 12 }).translate([1.3, 1, 0.9])];
  for (const [name, camera, r] of [
    ['orthographic', orthographic({ eye: [5, 7, 4], target: [0.5, 0.4, 0.4], span: 5 }), 25],
    ['perspective', perspective({ eye: [4, 5, 3], target: [0.5, 0.4, 0.4] }), 16],
  ] as const) {
    it(`keeps the lines inside a lens and cuts the rest at its edge (${name})`, async () => {
      let all: ProjectedLines | undefined;
      let cut: ProjectedCurves | undefined;
      const out = await draw((t) => view(scene(), { camera }, (lines) => {
        // FRICTION G3-21: strokes(t.within(lines.hidden, circle(50, 50, 25)), …)
        all = lines;
        cut = t.within(lines.hidden, circle(50, 50, r));
        return strokes(cut, { pen: 'ghost' });
      }));
      const toUser = paperToUser(out.frame);
      expect(cut).toBeInstanceOf(ProjectedCurves);
      expect(cut!.source).toBe(all!.hidden.source);
      expect(cut!.length).toBeGreaterThan(0);
      // Every piece ends inside the lens or on its edge.
      for (const row of cut!) {
        for (const p of [row.a, row.b]) {
          const [x, y] = toUser(p[0], p[1]);
          expect(Math.hypot(x - 50, y - 50)).toBeLessThanOrEqual(r + 1e-6);
        }
      }
      // A cut piece's range is read back through the camera: its paper
      // ends are where its source ends project.
      const pieces = [...cut!].filter((r) => !all!.hidden.rows.includes(r));
      expect(pieces.length).toBeGreaterThan(0);
      for (const row of pieces) {
        const f = row.feature;
        for (const [end, s] of [[row.a, row.range[0]], [row.b, row.range[1]]] as const) {
          const q = toPaper3(cut!.source.frame, lerp3(f.a, f.b, s));
          expect(Math.hypot(q[0] - end[0], q[1] - end[1])).toBeLessThan(1e-6);
        }
      }
      // A line wholly inside is the same row, id and all.
      const whole = [...cut!].filter((r) => all!.hidden.rows.includes(r));
      expect(whole.length).toBeGreaterThan(0);
      expect(new Set([...cut!].map((r) => r.id)).size).toBe(cut!.length);
      // The cut lines draw.
      const ghost = out.pens.findIndex((p) => p.name === 'ghost');
      expect(out.frags.some((f) => f.pen === ghost)).toBe(true);
    });
  }

  it('refuses keep and transfer by name', async () => {
    const camera = orthographic({ eye: [5, 7, 4], target: [0, 0, 0], span: 5 });
    await expect(draw((t) => view(box(1), { camera }, (lines) =>
      strokes((t.within as (x: unknown, area: unknown, opts: unknown) => ProjectedCurves)(lines.visible, circle(50, 50, 25), { keep: 'touching' }))))).rejects.toThrow(/'keep' is for a selection — projected lines are cut/);
  });
});

describe('O2 · G5-1, G3-32 · scatter and sample take a face selection and a 3D curve', () => {
  const sheet = () => plane(2, 2).subdivide(4);

  it('scatters on the faces a selection names, their ids kept', () => {
    const t = toolkit({ aspect: [1, 1], seed: 3 });
    const faces = sheet().faces.filter((f) => f.centroid[0] > 0);
    const ids = new Set(faces.map((f) => f.id));
    // FRICTION G5-1: t.scatter(terrain.faces.filter((f) => …), { spacing })
    const sites = t.scatter(faces, { spacing: 0.15 });
    expect(sites.points.length).toBeGreaterThan(10);
    for (const p of sites.points) {
      expect(p.x).toBeGreaterThanOrEqual(-1e-9);
      expect(ids.has(p.sample.face.id)).toBe(true);
    }
    const drawn = t.sample(faces, { count: 25 });
    expect(drawn.points.length).toBe(25);
    for (const p of drawn.points) expect(ids.has(p.sample.face.id)).toBe(true);
  });

  it('samples any 3D curve by arc length, in world units', () => {
    const t = toolkit({ aspect: [1, 1] });
    const path = curve([[0, 0, 0], [1, 0, 0], [1, 1, 0]]);
    // FRICTION G3-32: t.sample(helix, { count })
    const five = t.sample(path, { count: 5 });
    expect(five.points.map((p) => [p.x, p.y, p.z])).toEqual([[0, 0, 0], [0.5, 0, 0], [1, 0, 0], [1, 0.5, 0], [1, 1, 0]]);
    expect(t.sample(path, { spacing: 0.25 }).points.length).toBe(9);
    expect(t.sample(path, { count: 3, key: 'walk' }).key).toBe('walk');
  });
});

describe('O3 · G7-12 · an edge column reads as a property of the row', () => {
  it('answers e.level beside e.attrs.level', () => {
    const m = material([[0, 0], [10, 0], [10, 10]], { edges: [[0, 1], [1, 2]] }).edgeAttribute('level', (e) => e.index + 1);
    // FRICTION G7-12: outer.edges.filter((e) => e.level === sparse[2])
    expect(m.edges.map((e) => e.level)).toEqual([1, 2]);
    expect(m.edges.map((e) => e.attrs.level)).toEqual([1, 2]);
    expect(m.edges.filter((e) => e.level === 2).length).toBe(1);
  });

  it('refuses a column named for a field the edge already has', () => {
    const m = material([[0, 0], [10, 0]], { edges: [[0, 1]] });
    for (const name of ['center', 'root', 'id', 'attrs', 'faces', 'adjacent']) {
      expect(() => m.edgeAttribute(name, 1)).toThrow(`'${name}' is a reserved edge field`);
    }
  });
});

describe('O4 · G7-6 · query.points is the sibling of query.edges', () => {
  it('finds the nearest point within a bound, as a full scan does', () => {
    const t = toolkit({ aspect: [1, 1], seed: 8 });
    const food = material(t.times(300, () => [t.rnd() * 100, t.rnd() * 100]));
    // FRICTION G7-6: const near = query.points(food); … near.nearest(p, { within: 30 })
    const near = query.points(food);
    for (let k = 0; k < 200; k++) {
      const p: [number, number] = [t.rnd() * 120 - 10, t.rnd() * 120 - 10];
      const within = t.rnd() * 12;
      let best = -1;
      let bestD = Infinity;
      for (const q of food.points) {
        const d = Math.hypot(q.x - p[0], q.y - p[1]);
        if (d <= within && d < bestD) { best = q.index; bestD = d; }
      }
      const hit = near.nearest(p, { within });
      expect(hit?.point.index ?? -1).toBe(best);
      if (hit) expect(hit.distance).toBe(bestD);
    }
  });

  it('never answers a vertex of the queried state with itself', () => {
    const m = material([[0, 0], [3, 0], [10, 0]]);
    const near = query.points(m);
    expect(near.nearest(m.points.at(0)!, { within: 5 })?.point.index).toBe(1);
    expect(near.nearest([0, 0], { within: 5 })?.point.index).toBe(0);
    expect(near.nearest(m.points.at(2)!, { within: 5 })).toBeNull();
  });
});

describe('G3-39 · a field the library makes answers one point', () => {
  it('takes [x, y] and { x, y } as well as (x, y)', () => {
    const t = toolkit({ aspect: [1, 1], seed: 4 });
    const disc = t.distanceTo(circle(50, 50, 30));
    // FRICTION G3-39: disc(s.uv)
    expect(disc([60, 50])).toBe(disc(60, 50));
    expect(disc({ x: 60, y: 50 })).toBe(disc(60, 50));
    const bounded = t.within((x: number, y: number) => x + y, rect(0, 0, 50, 50));
    expect(bounded([10, 20])).toBe(30);
    expect(bounded([60, 20])).toBeNaN();
    expect(grad(disc)([70, 50])).toEqual(grad(disc)(70, 50));
    expect(rotate(disc, 30)([70, 40])).toBe(rotate(disc, 30)(70, 40));
    const wind = t.noiseField(2);
    expect(wind([12, 34])).toEqual(wind(12, 34));
    const time = t.travelTime({ fromPoints: [[50, 50]] });
    expect(time([60, 50])).toBe(time(60, 50));
  });
});

describe('G6-11 · a mixed pair and record array keeps the shared columns', () => {
  it('keeps what every point carries and refuses nothing', () => {
    const t = toolkit({ aspect: [1, 1], seed: 17 });
    const p = t.scatter({ spacing: 10 }).points.at(0)!;
    // FRICTION G6-11: curve([beacon, p], { closed: false }) — p is a scatter vertex
    const pair = material([[18, 20], p]);
    expect(pair.attrNames).toEqual([]);
    expect(pair.pts).toEqual([[18, 20], [p.x, p.y]]);
    const some = material([{ x: 0, y: 0, a: 1, b: 2 }, { x: 1, y: 1, a: 3 }]);
    expect(some.attrNames).toEqual(['a']);
  });
});

describe('spec 64 · a curved space is centred in the frame the sketch names', () => {
  const HYP = { space: space.hyperbolic({ radius: 50 }) };
  const frames: SketchConfig[] = [{}, { origin: 'center' }, { origin: 'center', yUp: true }, { yUp: true }];

  it('measures from the middle of the drawable in the sketch coordinates', () => {
    for (const f of frames) {
      const t = toolkit({ aspect: [1, 1], ...HYP, ...f });
      const b = t.bounds();
      expect([...t.space.center]).toEqual([b.cx, b.cy]);
      expect(t.space.distance([b.cx, b.cy], [b.cx + 10, b.cy])).toBeCloseTo(10, 9);
    }
  });

  it('draws the same ink for the same drawing written in each frame', () => {
    // A disc 20 units right of the middle and 20 down the page, a step
    // taken from it, and a field's isoline: one picture in four frames.
    const ink = (f: SketchConfig): RenderResult => render(sketch({ aspect: [1, 1], ...HYP, ...f }, (t) => {
      const b = t.bounds();
      const down = f.yUp ? -1 : 1;
      const at = t.station([b.cx + 20, b.cy + 20 * down]);
      return [
        circle(b.cx + 20, b.cy + 20 * down, 10),
        at.place(circle(0, 0, 3)),
        strokes(t.isolines(t.distanceTo(circle(b.cx - 20, b.cy, 8)), 0)),
      ];
    }), SQ);
    // The same picture: the same prims where the frame only moves the
    // origin, and the same extent and ink length where it also turns y
    // over (a mirrored frame walks each outline the other way round, and its
    // isoline grid starts from the other edge).
    const flat = (r: RenderResult) => r.prims.flatMap((p) => Object.values(p).filter((v): v is number => typeof v === 'number'));
    const extent = (r: RenderResult) => {
      const pts = r.prims.flatMap((p) => flattenPrim(p, 0.01));
      const xs = pts.map((q) => q[0]);
      const ys = pts.map((q) => q[1]);
      let length = 0;
      for (const p of r.prims) {
        const q = flattenPrim(p, 0.01);
        for (let i = 1; i < q.length; i++) length += Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]);
      }
      return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys), length];
    };
    const base = ink({});
    expect(flat(ink({ origin: 'center' }))).toEqual(flat(base));
    for (const f of frames.slice(2)) {
      const [a, b] = [extent(base), extent(ink(f))];
      for (let i = 0; i < 4; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(0.05);
      expect(Math.abs(a[4] - b[4]) / a[4]).toBeLessThan(1e-3);
    }
  });
});
