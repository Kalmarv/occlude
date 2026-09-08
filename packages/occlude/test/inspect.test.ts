import { describe, expect, it } from 'vitest';
import {
  circle, compileSketch, getInspectHint, getInspectionIndex, inspectIfMaterial, inspectionPayload, material, setInspectHint, sketch, stroke,
  userUnitsToPaper,
} from '../src/index.js';
import { makeFrame } from '../src/record.js';
import { getState } from '../src/state.js';

const two = () => material([[10, 10], [30, 10], [30, 30]], { edges: [[0, 1], [1, 2]], active: 1 });

describe('t.inspect: the debug registry', () => {
  it('registers nothing while the host has inspection off, and validates its arguments anyway', () => {
    setInspectHint(false);
    expect(getInspectHint()).toBe(false);
    compileSketch(sketch({ seed: 1 }, (t) => {
      t.inspect('a', two());
      expect(() => t.inspect('', two())).toThrow(/label/);
      expect(() => t.inspect('bad', [[1, 2]] as never)).toThrow(/expected a Material/);
      return circle(50, 50, 10);
    }));
    expect(getInspectionIndex()).toEqual([]);
    expect(inspectionPayload('a')).toBeNull();
  });

  it('keeps registration order, replaces a reused label in place, and resets per compile', () => {
    setInspectHint(true);
    try {
      compileSketch(sketch({ seed: 1 }, (t) => {
        const a = two();
        t.inspect('source', a);
        t.inspect('grown', a.attribute('age', 3));
        t.inspect('source', a.withEdges([[0, 2]]));  // replaced, stays first
        return stroke(a.contour);
      }));
      const index = getInspectionIndex();
      expect(index.map((e) => e.name)).toEqual(['source', 'grown']);
      expect(index[0]).toEqual({ name: 'source', points: 3, edges: 3 });
      expect(index[1]).toEqual({ name: 'grown', points: 3, edges: 2 });
      compileSketch(sketch({ seed: 1 }, () => circle(50, 50, 10)));
      expect(getInspectionIndex()).toEqual([]);
    } finally {
      setInspectHint(false);
    }
  });

  it('the stations of along() register as a material of their own', () => {
    setInspectHint(true);
    try {
      compileSketch(sketch({ seed: 1 }, (t) => {
        const ring = t.sample(circle(50, 50, 20), { count: 8 });
        const stations = ring.along({ count: 4 });
        inspectIfMaterial('stations', stations); // what the studio's instrumentation calls
        t.inspect('named', stations);
        inspectIfMaterial('nothing', [1, 2, 3]);
        expect(() => t.inspect('bad', [] as never)).toThrow(/expected a Material/);
        return stroke(ring.contour);
      }));
      expect(getInspectionIndex().map((e) => e.name)).toEqual(['stations', 'named']);
      const p = inspectionPayload('stations')!;
      expect(p.n).toBe(4);
      expect(p.edges.length / 2).toBe(4); // a closed walk
      expect(Object.keys(p.attrs).sort()).toEqual(['chain', 'heading', 's', 'u']);
    } finally {
      setInspectHint(false);
    }
  });

  it('inspecting inside a step keeps the last state, not every iteration', () => {
    setInspectHint(true);
    try {
      compileSketch(sketch({ seed: 1 }, (t) => {
        const grown = two().steps(5, (cur, next, k) => {
          next.move(() => [1, 0]);
          t.inspect('step', cur);
        });
        return stroke(grown.contour);
      }));
      const p = inspectionPayload('step')!;
      expect(p.iteration).toBe(4); // `cur` of the last step
      expect(p.x[0]).toBe(14);
    } finally {
      setInspectHint(false);
    }
  });

  it('payloads are plain copies: transferring them cannot detach the material', () => {
    setInspectHint(true);
    try {
      let held: ReturnType<typeof two> | null = null;
      compileSketch(sketch({ seed: 1 }, (t) => {
        held = two().attribute('w', (p) => p.x).edgeAttribute('rest', 2);
        t.inspect('m', held);
        return circle(50, 50, 10);
      }));
      const p = inspectionPayload('m')!;
      expect(p.n).toBe(3);
      expect(Array.from(p.edges)).toEqual([0, 1, 1, 2]);
      expect(Object.keys(p.attrs)).toEqual(['active', 'w']);
      expect(Array.from(p.attrs.w)).toEqual([10, 30, 30]);
      expect(Array.from(p.edgeAttrs.rest)).toEqual([2, 2]);
      expect(p.x).not.toBe(held!.x);
      expect(p.attrs.w.buffer).not.toBe(held!.attrs.w.buffer);
      // Simulate the worker transferring the payload away.
      structuredClone(p, { transfer: [p.x.buffer, p.attrs.w.buffer, p.edges.buffer] });
      expect(p.x.byteLength).toBe(0);
      expect(held!.x.byteLength).toBe(24);
      expect(held!.attrs.w[1]).toBe(30);
      expect(getState().inspections.get('m')!.x.byteLength).toBe(24);
    } finally {
      setInspectHint(false);
    }
  });

  it('inspection changes no geometry or randomness', () => {
    const run = (on: boolean) => {
      setInspectHint(on);
      compileSketch(sketch({ seed: 7 }, (t) => {
        const m = material(t.times(20, () => [t.rnd(100), t.rnd(100)]));
        t.inspect('m', m);
        return m.points.map((p) => circle(p.x, p.y, t.rnd(1, 3)));
      }));
      return getState().shapes.length + ':' + getState().rng.next();
    };
    const off = run(false);
    const on = run(true);
    setInspectHint(false);
    expect(on).toBe(off);
  });
});

describe('userUnitsToPaper', () => {
  it('follows the frame: margin offset, centre origin and yUp', () => {
    const st = { marginPct: 10, aspect: 'square', origin: 'topLeft', yUp: false, rectMode: 'corner' } as never;
    const f = makeFrame(st, 200, 100);
    // 10 % margin of the short side = 10 mm; the square drawable is 80 mm, centred: offset x 60, y 10.
    expect(userUnitsToPaper(f)(0, 0)).toEqual([60, 10]);
    expect(userUnitsToPaper(f)(100, 50)).toEqual([140, 50]);
    const c = makeFrame({ ...st, origin: 'center', yUp: true } as never, 200, 100);
    const [x, y] = userUnitsToPaper(c)(0, 0);
    expect([x, y]).toEqual([100, 50]);
    const [, up] = userUnitsToPaper(c)(0, 10);
    expect(up).toBeCloseTo(42); // y up: 10 units = 8 mm above the centre
  });
});
