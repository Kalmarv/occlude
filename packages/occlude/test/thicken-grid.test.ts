import { expect, it } from 'vitest';
import { material, type Vertex } from '../src/index.js';

const radiusOf = (p: Vertex) => p.radius;

// A tiling cell whose centroid sits on the sheet's centre asks for a radius of
// about 1e-15 next to cells asking for whole millimetres. The polygon grid used
// to follow the smallest radius down to nothing and refuse the whole thicken
// ("coordinate range exceeds polygon grid budget"). The grid is now bounded by
// what the coordinate range can carry, and a mark below it is simply left out.
it('a near-zero radius among ordinary ones does not fail the thicken', () => {
  const m = material(
    [[50, 50], [60, 50], [10, 10], [20, 10]],
    { edges: [[0, 1], [2, 3]], radius: [1.5e-15, 1.5e-15, 1.2, 1.2] },
  );
  const body = m.thicken({ radius: radiusOf });
  expect(body.n).toBeGreaterThan(3);
  const xs = [...body.points].map((p) => p.x);
  // The ordinary capsule is there; the vanishing one contributes nothing.
  expect(Math.min(...xs)).toBeCloseTo(10 - 1.2, 1);
  expect(Math.max(...xs)).toBeLessThan(30);
});

it('a large coordinate range with an ordinary radius thickens instead of refusing', () => {
  const m = material([[0, 0], [1e6, 0]], { edges: [[0, 1]], radius: 1 });
  expect(m.thicken({ radius: radiusOf, tolerance: 1 }).n).toBeGreaterThan(3);
});

it('a tolerance finer than the coordinates carry is refused by name', () => {
  expect(() => material([[0, 0]]).thicken({ radius: 1, tolerance: 1e-20 })).toThrow(/finer than/);
});
