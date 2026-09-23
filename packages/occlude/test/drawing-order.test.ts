import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { initOcclude, render, renderAsync, sketch, line, polygon, rect, fill, strokes, pen, mm, evalPrim, type RenderResult } from '../src/index.js';
import { box, plane, sphere, view, orthographic } from '../src/three/api/index.js';
import type { ProjectedLines } from '../src/three/api/projected.js';

beforeAll(async () => {
  await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url)));
});

const pens = { black: pen({ width: mm(0.3), color: '#111111' }), blue: pen({ width: mm(0.3), color: '#2457D6' }), heavy: pen({ width: mm(0.8), color: '#D64045' }) };
const penOf = (out: RenderResult, i: number) => out.pens[i].name;
const drawable = (out: RenderResult) => {
  const f = out.frame;
  return { x0: f.offsetX, y0: f.offsetY, x1: f.offsetX + f.inner.innerW, y1: f.offsetY + f.inner.innerH };
};

describe('coincident ink belongs to the first stroke', () => {
  it('keeps one fragment on a path drawn in two pens, in the first pen, whatever the order', () => {
    for (const [first, second] of [['black', 'blue'], ['blue', 'black']]) {
      const out = render(sketch({ aspect: [1, 1], pens }, () => [line(10, 50, 90, 50, { pen: first }), line(10, 50, 90, 50, { pen: second })]), { paper: 'Square20' });
      expect(out.frags).toHaveLength(1);
      expect(penOf(out, out.frags[0].pen)).toBe(first);
    }
  });
  it('lets a border drawn first keep the shared outline in its own pen', () => {
    const out = render(sketch({ aspect: [1, 1], pens }, (t) => [
      strokes(t.material(rect(10, 10, 80, 80)), { pen: 'heavy' }),
      polygon(t.material(rect(10, 10, 80, 80)), { stroke: 'blue' }),
    ]), { paper: 'Square20' });
    expect(out.frags).toHaveLength(4);
    expect(new Set(out.frags.map((f) => penOf(out, f.pen)))).toEqual(new Set(['heavy']));
  });
  it('does not let z change which stroke keeps the path', () => {
    const out = render(sketch({ aspect: [1, 1], pens }, () => [line(10, 50, 90, 50, { pen: 'black', z: 2 }), line(10, 50, 90, 50, { pen: 'blue', z: 1 })]), { paper: 'Square20' });
    expect(out.frags.map((f) => penOf(out, f.pen))).toEqual(['black']);
  });
});

describe('angles are clockwise on the sheet', () => {
  // +x turned by +90 degrees: down the page when y grows down, up it under yUp.
  const tip = (out: RenderResult) => {
    const [a, b] = [evalPrim(out.frags[0].geom, 0), evalPrim(out.frags[0].geom, 1)];
    return Math.abs(a[1] - 100) > Math.abs(b[1] - 100) ? a : b;
  };
  it('turns a rotated shape clockwise on the paper', () => {
    const out = render(sketch({ aspect: [1, 1] }, () => line(50, 50, 90, 50, { rotate: 90, origin: [50, 50] })), { paper: 'Square20' });
    expect(tip(out)[0]).toBeCloseTo(100, 6);
    expect(tip(out)[1]).toBeCloseTo(180, 6);
  });
  it('points a station heading of 90 down the page', () => {
    const out = render(sketch({ aspect: [1, 1] }, (t) => { const s = t.station(50, 50, { heading: 90 }).step(40); return line(50, 50, s.x, s.y); }), { paper: 'Square20' });
    expect(tip(out)[1]).toBeCloseTo(180, 6);
  });
  it('turns the other way on the paper under yUp', () => {
    const out = render(sketch({ aspect: [1, 1], yUp: true }, () => line(50, 50, 90, 50, { rotate: 90, origin: [50, 50] })), { paper: 'Square20' });
    expect(tip(out)[1]).toBeCloseTo(20, 6);
  });
});

describe('views', () => {
  const camera = orthographic({ eye: [7, 9, 7], target: [0, 0, 0], span: 6 });
  it('clips view ink to the drawable', async () => {
    // The plane is wider than the frame, so its edges leave it.
    const out = await renderAsync(sketch({ aspect: [1, 1], margin: 6, pens }, () => view(plane(12, 12).subdivide(3), { camera, pen: 'black', creaseAngle: 0 })), { paper: 'Square20' });
    const d = drawable(out);
    expect(out.frags.length).toBeGreaterThan(0);
    let atEdge = 0;
    for (const f of out.frags) for (const s of [0, 0.5, 1]) {
      const [x, y] = evalPrim(f.geom, s);
      expect(x).toBeGreaterThanOrEqual(d.x0 - 1e-6); expect(x).toBeLessThanOrEqual(d.x1 + 1e-6);
      expect(y).toBeGreaterThanOrEqual(d.y0 - 1e-6); expect(y).toBeLessThanOrEqual(d.y1 + 1e-6);
      if (Math.min(x - d.x0, d.x1 - x, y - d.y0, d.y1 - y) < 1e-3) atEdge++;
    }
    expect(atEdge).toBeGreaterThan(0);
  });
  it('gives the callback only the folds creaseAngle keeps, visible and hidden', async () => {
    let seen: ProjectedLines | undefined;
    const ball = sphere(1, { segments: 24, rings: 12 });
    const callback = await renderAsync(sketch({ aspect: [1, 1], pens }, () => view(ball, { camera, pen: 'black' }, (lines) => { seen = lines; return strokes(lines.visible, { stroke: 'black' }); })), { paper: 'Square20' });
    const fold = (r: ProjectedLines['visible']['rows'][number]) => r.kinds.has('crease') && r.kinds.size === 1;
    expect(seen!.visible.rows.filter(fold).every((r) => r.feature.creaseAngle >= 30)).toBe(true);
    expect(seen!.hidden.rows.filter(fold).every((r) => r.feature.creaseAngle >= 30)).toBe(true);
    // The callback's lines are the default ink's lines.
    const plain = await renderAsync(sketch({ aspect: [1, 1], pens }, () => view(ball, { camera, pen: 'black' })), { paper: 'Square20' });
    expect(callback.raw.prims).toEqual(plain.raw.prims);
  });
  // Vertical grain over the whole sheet, then a box in the middle of it.
  const grainThroughMiddle = (out: RenderResult) => {
    const d = drawable(out), cx = (d.x0 + d.x1) / 2, cy = (d.y0 + d.y1) / 2;
    return out.frags.filter((f) => penOf(out, f.pen) === 'blue').some((f) => {
      const [a, b] = [evalPrim(f.geom, 0), evalPrim(f.geom, 1)];
      return Math.abs(a[0] - cx) < 3 && Math.min(a[1], b[1]) < cy && Math.max(a[1], b[1]) > cy;
    });
  };
  const grain = (t: { width: number; height: number }) => polygon(rect(0, 0, t.width, t.height), { fill: fill('hatch', { angle: 90, spacing: mm(1) }), stroke: false, pen: 'blue' });
  const cube = view(box(2), { camera, pen: 'black' });
  it('hides nothing drawn before a view', async () => {
    const out = await renderAsync(sketch({ aspect: [1, 1], pens }, (t) => [grain(t), cube]), { paper: 'Square20' });
    expect(grainThroughMiddle(out)).toBe(true);
  });
  it('hides what was drawn before an opaque view, and keeps the view\'s own ink', async () => {
    const out = await renderAsync(sketch({ aspect: [1, 1], pens }, (t) => [grain(t), view(box(2), { camera, pen: 'black', opaque: true })]), { paper: 'Square20' });
    const bare = await renderAsync(sketch({ aspect: [1, 1], pens }, () => cube), { paper: 'Square20' });
    expect(grainThroughMiddle(out)).toBe(false);
    const black = (r: RenderResult) => r.frags.filter((f) => penOf(r, f.pen) === 'black').length;
    expect(black(out)).toBe(black(bare));
  });
});
