import { expect, it } from 'vitest';
import { analyticalUnion, type Envelope } from '../src/thicken-arrangement.js';
import fixtures from '../bench/exact-reference/fixtures.json';

for (const fixture of fixtures)
  it(`agrees with the independent CGAL conic arrangement: ${fixture.name}`, () => {
    const inputs: Envelope[] = fixture.inputs.map(
      ([ax, ay, bx, by, ra, rb], i) => ({
        ax,
        ay,
        bx,
        by,
        ra,
        rb,
        va: 2 * i,
        vb: 2 * i + 1,
        edge: i,
        minX: Math.min(ax - ra, bx - rb),
        minY: Math.min(ay - ra, by - rb),
        maxX: Math.max(ax + ra, bx + rb),
        maxY: Math.max(ay + ra, by + rb),
      }),
    );
    const counts: Record<string, number> = {};
    analyticalUnion(inputs, 0.01, false, (_stage, c) =>
      Object.assign(counts, c),
    );
    expect(counts.events).toBe(fixture.expected.vertices);
    expect(counts.intervals).toBe(fixture.expected.edges);
    expect(counts.boundary).toBe(fixture.expected.boundary);
  });

import {
  append,
  material,
  thicken,
  distanceTo,
  type Material,
} from '../src/index.js';
import { exactEnvelopeOracle } from './helpers/envelope-oracle.js';

it('keeps the exposed cap immediately before exact containment', () => {
  const radius = 1.9999999999999998;
  const source = material(
    [
      [0, 0],
      [1, 0],
    ],
    { edges: [[0, 1]], radius: [1, radius] },
  );
  const result = thicken(source, { radius: (p) => p.radius, tolerance: 0.001 });
  expect(result.curves()).toHaveLength(1);
  expect(Math.min(...result.x)).toBe(-1);
  const oracle = exactEnvelopeOracle([[0, 0, 1, 0, 1, radius]]);
  expect(oracle(-1, 0)).toBe(0);
  expect(oracle(-0.9999999999999999, 0)).toBe(-1);
  expect(oracle(-1.0000000000000002, 0)).toBe(1);
  expect(distanceTo(result)(0, 0)).toBeGreaterThan(0);
});

it('preserves exact dyadic subdivision, duplication, edge reversal and reflection', () => {
  const base = material(
    [
      [0, 0],
      [8, 2],
      [3, 7],
    ],
    {
      edges: [
        [0, 1],
        [1, 2],
        [2, 0],
      ],
      radius: [1, 2, 1.5],
    },
  );
  const split = material(
    [
      [0, 0],
      [4, 1],
      [8, 2],
      [3, 7],
    ],
    {
      edges: [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
      ],
      radius: [1, 1.5, 2, 1.5],
    },
  );
  const reverse = material(
    [
      [0, 0],
      [8, 2],
      [3, 7],
    ],
    {
      edges: [
        [1, 0],
        [2, 1],
        [0, 2],
      ],
      radius: [1, 2, 1.5],
    },
  );
  const reflected = material(
    [
      [0, 0],
      [-8, 2],
      [-3, 7],
    ],
    {
      edges: [
        [0, 1],
        [1, 2],
        [2, 0],
      ],
      radius: [1, 2, 1.5],
    },
  );
  const build = (source: Material) =>
    thicken(source, { radius: (p) => p.radius, tolerance: 0.005 });
  const original = build(base),
    variants = [build(split), build(append(base, base)), build(reverse)];
  const d = distanceTo(original),
    other = variants.map(distanceTo),
    mirror = distanceTo(build(reflected));
  for (const result of variants)
    expect(result.curves().length).toBe(original.curves().length);
  for (let i = 0; i < 300; i++) {
    const x = -3 + (((i * 47) % 307) / 307) * 14,
      y = -3 + (((i * 73) % 311) / 311) * 14;
    if (Math.abs(d(x, y)) < 0.02) continue;
    for (const query of other) expect(query(x, y) > 0).toBe(d(x, y) > 0);
    expect(mirror(-x, y) > 0).toBe(d(x, y) > 0);
  }
});

it('sweeps representable values across contact without welding a gap', () => {
  for (const separation of [1.9999999999999998, 2, 2.0000000000000004]) {
    const result = thicken(
      material([
        [0, 0],
        [separation, 0],
      ]),
      { radius: 1 },
    );
    expect(result.curves()).toHaveLength(separation < 2 ? 1 : 2);
  }
});
