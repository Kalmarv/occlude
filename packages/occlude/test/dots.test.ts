/**
 * `dots`: a tap of the pen at every point.
 *
 * A dot is an engine stipple mark, so it takes the whole of that path —
 * occluded as a point, kept through the planner's zero-length cleanup,
 * and one pen-down on the machine.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  circle, curve, dots, initOcclude, material, plan, render, sketch, strokes,
  type SketchDef,
} from '../src/index.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
  await initOcclude(readFileSync(wasmPath));
});

const sq = (def: SketchDef) => render(def, { paper: 'Square20' });
const row = () => material([[20, 50], [40, 50], [60, 50], [80, 50]]);

describe('dots', () => {
  it('is one dot fragment per point, and nothing else', () => {
    const out = sq(sketch({}, () => dots(row())));
    const marks = out.frags.filter((f) => f.dot);
    expect(marks).toHaveLength(4);
    expect(out.frags).toHaveLength(4); // the carrying box draws no outline
    for (const f of marks) {
      expect(f.geom.t).toBe('line');
      const g = f.geom as { x0: number; y0: number; x1: number; y1: number };
      expect(g.x0).toBe(g.x1); // zero length: a tap, not a stroke
      expect(g.y0).toBe(g.y1);
    }
  });

  it('takes any geometry that has points, and no points means no ink', () => {
    expect(sq(sketch({}, () => dots([[30, 30], [70, 70]]))).frags).toHaveLength(2);
    const m = row();
    expect(sq(sketch({}, () => dots(m.points.filter((p) => p.x > 45)))).frags).toHaveLength(2);
    expect(sq(sketch({}, () => dots([]))).frags).toHaveLength(0);
    expect(sq(sketch({}, () => dots(material([])))).frags).toHaveLength(0);
  });

  it('is occluded as a point: a shape over it hides it whole', () => {
    const under = sketch({}, () => [dots(row()), circle(50, 50, 25, { opaque: true })]);
    const all = sq(sketch({}, () => dots(row()))).frags.filter((f) => f.dot);
    const left = sq(under).frags.filter((f) => f.dot);
    // 40 and 60 are inside the circle; 20 and 80 are outside it. A dot is
    // hidden whole or not at all, so two of the four survive, unmoved.
    expect(all).toHaveLength(4);
    expect(left).toHaveLength(2);
    const at = (f: typeof all[number]) => (f.geom as { x0: number }).x0;
    expect(left.map(at)).toEqual([all.map(at)[0], all.map(at)[3]]);
  });

  it('takes its own pen and survives the plan as one pen-down each', async () => {
    const out = sq(sketch({}, () => [dots(row(), { pen: 'stabilo-88-blue' }), strokes(row())]));
    const marks = out.frags.filter((f) => f.dot);
    expect(marks).toHaveLength(4);
    expect(new Set(marks.map((f) => f.pen)).size).toBe(1);
    const planned = await plan(out);
    const chains = planned.chains.filter((c) => c.dot);
    expect(chains).toHaveLength(4);
    for (const c of chains) expect(c.prims).toHaveLength(1);
  });
});

describe('extrude', () => {
  it('takes one bare vertex, not only a selection', () => {
    const m = curve([[0, 0], [10, 0]], { closed: false });
    const grown = m.steps(1, (cur, next) => {
      next.extrude(cur.points.at(1), (p) => ({ position: [p.x + 10, p.y] }));
    });
    expect(grown.n).toBe(3);
    expect(grown.pts[2]).toEqual([20, 0]);
    // A vertex held from an earlier state is the same vertex.
    const again = grown.steps(1, (cur, next) => {
      next.extrude(m.points.at(0), (p) => ({ position: [p.x, p.y - 10] }));
    });
    expect(again.n).toBe(4);
    expect(again.pts[3]).toEqual([0, -10]);
  });
});
