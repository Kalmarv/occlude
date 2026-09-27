/**
 * Best effort where geometry becomes ink: a non-finite place draws nothing
 * for its piece and never fails the render. A chain breaks at a NaN vertex
 * and keeps the rest; a shape with a non-finite parameter is dropped whole;
 * a clip with one holds nothing.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { circle, clip, curve, fill, material, polygon, rect, sketch, strokes, type SketchDef } from '../src/index.js';
import { initOcclude, render } from '../src/host.js';

beforeAll(async () => {
  await initOcclude(readFileSync(fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));
});

const drawn = (def: SketchDef) => {
  const r = render(def, { paper: 'Square20' });
  return { fragments: r.stats.fragments, finite: r.frags.every((f) => Object.values(f.geom).every((v) => typeof v !== 'number' || Number.isFinite(v))) };
};

describe('a non-finite place draws nothing for its piece', () => {
  it('a chain breaks at a NaN vertex and draws the rest', () => {
    const whole = drawn(sketch({ aspect: [1, 1] }, () => strokes(material([[0, 0], [50, 50], [60, 60]], { edges: [[0, 1], [1, 2]] }))));
    const broken = drawn(sketch({ aspect: [1, 1] }, () => strokes(material([[NaN, 0], [50, 50], [60, 60]], { edges: [[0, 1], [1, 2]] }))));
    expect(broken.finite).toBe(true);
    expect(broken.fragments).toBeGreaterThan(0);
    expect(broken.fragments).toBeLessThan(whole.fragments + 1);
  });

  it('a ring broken at one vertex is one run through its seam', () => {
    const r = drawn(sketch({ aspect: [1, 1] }, () => strokes(curve([[10, 10], [40, 10], [NaN, 30], [10, 40]], { closed: true }))));
    expect(r.finite).toBe(true);
    expect(r.fragments).toBeGreaterThan(0);
  });

  it('a shape with a non-finite parameter is dropped whole, and the rest draws', () => {
    const alone = drawn(sketch({ aspect: [1, 1] }, () => circle(20, 80, 5)));
    const beside = drawn(sketch({ aspect: [1, 1] }, (t) => [
      circle(NaN, 50, 5),
      rect(10, 10, NaN, 5),
      strokes(t.material(circle(NaN, 50, 5))),
      polygon([[60, 60], [90, 60], [NaN, 90], [60, 90]], { fill: fill('hatch', { spacing: 2 }) }),
      clip(circle(NaN, 50, 10), circle(50, 50, 20)),
      circle(20, 80, 5),
    ]));
    expect(beside.finite).toBe(true);
    expect(beside.fragments).toBeGreaterThanOrEqual(alone.fragments);
  });
});
