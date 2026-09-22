/**
 * The basket of small words: `distanceToPoints`, `hull`,
 * `faces().containing`, `connect.turns`, `path().arcTo({ large })`, the
 * four vector helpers, and `gaussian` on the seeded stream.
 */
import { describe, expect, it } from 'vitest';
import {
  angleBetween, append, connect, curve, distanceToPoints, hull, lerp, material, path, reflect,
  rotate, stroke, turn, unit, type Material, type Station,
} from '../src/index.js';
import { faces } from '../src/faces.js';
import { toolkit } from './helpers/run.js';

const square = (x = 0, y = 0, s = 10) =>
  curve([[x, y], [x + s, y], [x + s, y + s], [x, y + s]], { closed: true });
const seg = (a: [number, number], b: [number, number]) => material([a, b], { edges: [[0, 1]] });

// ---- distanceToPoints ------------------------------------------------------

describe('distanceToPoints: the nearest site, as a field', () => {
  it('is zero at a site and negative everywhere else', () => {
    const f = distanceToPoints([[10, 10], [30, 10]]);
    expect(f(10, 10)).toBe(0);
    expect(f(30, 10)).toBe(0);
    expect(f(14, 10)).toBeCloseTo(-4, 12);
    expect(f(26, 10)).toBeCloseTo(-4, 12);
    // Equidistant: the wall between the two cells.
    expect(f(20, 10)).toBeCloseTo(-10, 12);
    expect(f(20, 20)).toBeCloseTo(-Math.hypot(10, 10), 12);
  });

  it('agrees with the full scan over a cloud, on and off the grid', () => {
    const sites: [number, number][] = [];
    let s = 12345;
    const next = () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
    for (let i = 0; i < 400; i++) sites.push([next() * 100, next() * 100]);
    const f = distanceToPoints(sites);
    const brute = (x: number, y: number) => -Math.min(...sites.map(([sx, sy]) => Math.hypot(x - sx, y - sy)));
    let worst = 0;
    for (let i = 0; i < 40; i++) {
      // Inside the cloud, and well outside it in every direction.
      const x = next() * 300 - 100;
      const y = next() * 300 - 100;
      worst = Math.max(worst, Math.abs(f(x, y) - brute(x, y)));
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it('reads a material and a point selection, and drops non-finite sites', () => {
    const m = material([[4, 4], [40, 40]]);
    expect(distanceToPoints(m)(4, 4)).toBe(0);
    expect(distanceToPoints(m.points)(40, 40)).toBe(0);
    expect(distanceToPoints([[4, 4], [NaN, 3]])(4, 4)).toBe(0);
  });

  it('is nowhere inside with no sites at all', () => {
    expect(distanceToPoints([])(0, 0)).toBe(-Infinity);
    expect(distanceToPoints([[NaN, NaN]])(0, 0)).toBe(-Infinity);
  });
});

// ---- hull ------------------------------------------------------------------

const areaOf = (pts: readonly [number, number][]): number => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
};

describe('hull: the outline of a cloud', () => {
  it('alpha 0 is the convex hull — one contour, the corners only', () => {
    const cloud: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10], [5, 5], [3, 7], [8, 2]];
    const out = hull(cloud);
    expect(out).toHaveLength(1);
    expect(out[0].closed).toBe(true);
    expect(out[0].pts).toHaveLength(4);
    expect(areaOf(out[0].pts)).toBeCloseTo(100, 9);
  });

  it('a big alpha splits a cloud into a contour per clump', () => {
    const cloud: [number, number][] = [];
    for (const [ox, oy] of [[0, 0], [60, 0]] as const) {
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) cloud.push([ox + i * 3, oy + j * 3]);
    }
    expect(hull(cloud, { alpha: 0 })).toHaveLength(1);
    // 1/alpha under the circumradius that bridges the 60-unit gap, over the
    // one that spans a 3-unit cell (3/√2 ≈ 2.12).
    const split = hull(cloud, { alpha: 1 / 4 });
    expect(split).toHaveLength(2);
    for (const c of split) expect(areaOf(c.pts)).toBeCloseTo(81, 6);
  });

  it('follows a concavity the convex hull bridges', () => {
    const cloud: [number, number][] = [];
    // A C: the ring of a disc with its right quarter missing.
    for (let k = 0; k < 40; k++) {
      const th = (k / 40) * Math.PI * 2;
      if (th > Math.PI * 0.25 && th < Math.PI * 0.75) continue;
      for (const r of [12, 16]) cloud.push([50 + r * Math.cos(th), 50 + r * Math.sin(th)]);
    }
    const convex = hull(cloud, { alpha: 0 });
    const carved = hull(cloud, { alpha: 1 / 6 });
    expect(convex).toHaveLength(1);
    expect(carved.length).toBeGreaterThanOrEqual(1);
    expect(areaOf(carved[0].pts)).toBeLessThan(areaOf(convex[0].pts));
  });

  it('has nothing to outline with fewer than three points, or on one line', () => {
    expect(hull([])).toEqual([]);
    expect(hull([[0, 0], [1, 1]])).toEqual([]);
    expect(hull([[0, 0], [1, 1], [2, 2], [3, 3]])).toEqual([]);
  });

  it('refuses a negative alpha by name', () => {
    expect(() => hull([[0, 0], [1, 0], [0, 1]], { alpha: -1 })).toThrow('hull: alpha');
  });
});

// ---- faces().containing ----------------------------------------------------

const split = (): Material => append(square(0, 0, 10), seg([5, 0], [5, 10])).planarize();

describe('faces().containing: the face under a place', () => {
  it('names the one face a point falls in', () => {
    const cells = faces(split());
    expect(cells.length).toBe(2);
    const left = cells.containing([2, 5]);
    expect(left.length).toBe(1);
    expect(left.at(0).area).toBeCloseTo(50, 9);
    expect(left.at(0).centroid[0]).toBeCloseTo(2.5, 9);
  });

  it('takes many places at once, and a face named twice is still one member', () => {
    const cells = faces(split());
    expect(cells.containing([[2, 5], [8, 5]]).length).toBe(2);
    expect(cells.containing([[2, 5], [3, 6]]).length).toBe(1);
    expect(cells.containing(material([[2, 5], [8, 5]])).length).toBe(2);
    expect(cells.containing({ x: 8, y: 5 }).length).toBe(1);
  });

  it('a place on a wall, or outside every face, picks nothing', () => {
    const cells = faces(split());
    expect(cells.containing([5, 5]).length).toBe(0); // the dividing wall
    expect(cells.containing([0, 5]).length).toBe(0); // the outer wall
    expect(cells.containing([20, 20]).length).toBe(0); // outside
  });

  it('a hole belongs to its own face, not to the ring around it', () => {
    const ring = append(square(0, 0, 30), square(10, 10, 10)).planarize();
    const cells = faces(ring);
    expect(cells.length).toBe(2);
    const inner = cells.containing([15, 15]);
    expect(inner.length).toBe(1);
    expect(inner.at(0).area).toBeCloseTo(100, 9);
    const outer = cells.containing([5, 5]);
    expect(outer.at(0).area).toBeCloseTo(800, 9);
  });

  it('a selection answers with its members only', () => {
    const cells = faces(split());
    const left = cells.containing([2, 5]);
    expect(left.containing([2, 5]).length).toBe(1);
    expect(left.containing([8, 5]).length).toBe(0);
  });

  it('refuses something that is not a place', () => {
    expect(() => faces(split()).containing(42 as never)).toThrow('faces.containing');
  });
});

// ---- connect.turns ---------------------------------------------------------

const station = (x: number, y: number, heading: number): Station => ({
  x, y, heading, tangent: [Math.cos(heading), Math.sin(heading)],
  normal: [-Math.sin(heading), Math.cos(heading)],
  s: 0, u: 0, length: 0, chain: 0, closed: false, attrs: {}, edgeAttrs: {},
  place: () => { throw new Error('not used'); },
  step: () => { throw new Error('not used'); },
  turn: () => { throw new Error('not used'); },
  toward: () => { throw new Error('not used'); },
  placement: () => { throw new Error('not used'); },
});

/** Walk the chain from row 0 and measure it. */
const chainOf = (m: Material): { pts: [number, number][]; length: number; maxTurn: number } => {
  const curves = m.curves();
  const pts = curves.flatMap((c) => c.pts as [number, number][]);
  let length = 0;
  let maxTurn = 0;
  for (const c of curves) {
    for (let i = 1; i < c.pts.length; i++) {
      length += Math.hypot(c.pts[i][0] - c.pts[i - 1][0], c.pts[i][1] - c.pts[i - 1][1]);
    }
    for (let i = 2; i < c.pts.length; i++) {
      const a = unit([c.pts[i - 1][0] - c.pts[i - 2][0], c.pts[i - 1][1] - c.pts[i - 2][1]]);
      const b = unit([c.pts[i][0] - c.pts[i - 1][0], c.pts[i][1] - c.pts[i - 1][1]]);
      maxTurn = Math.max(maxTurn, Math.abs(angleBetween(a, b)));
    }
  }
  return { pts, length, maxTurn };
};

describe('connect.turns: the shortest bounded-curvature run', () => {
  it('two places already in line are joined by the straight between them', () => {
    const m = connect.turns([station(0, 0, 0), station(40, 0, 0)], { radius: 5 });
    const { pts, length } = chainOf(m);
    expect(length).toBeCloseTo(40, 6);
    for (const [, y] of pts) expect(Math.abs(y)).toBeLessThan(1e-9);
  });

  it('ends where the next station is, facing the way it faces', () => {
    const a = station(0, 0, 0);
    const b = station(30, 20, Math.PI / 2);
    const m = connect.turns([a, b], { radius: 6 });
    const { pts, length, maxTurn } = chainOf(m);
    expect(pts[0]).toEqual([0, 0]);
    const end = pts[pts.length - 1];
    expect(end[0]).toBeCloseTo(30, 6);
    expect(end[1]).toBeCloseTo(20, 6);
    // The last step runs along the arrival heading.
    const tail = unit([end[0] - pts[pts.length - 2][0], end[1] - pts[pts.length - 2][1]]);
    expect(Math.abs(angleBetween(tail, [Math.cos(Math.PI / 2), Math.sin(Math.PI / 2)]))).toBeLessThan(0.15);
    // Never tighter than the radius: a step of arc s turns at most s / r.
    const step = length / (pts.length - 1);
    expect(maxTurn).toBeLessThan(step / 6 + 1e-6);
    // Dubins is the SHORTEST such path: never shorter than the straight line.
    expect(length).toBeGreaterThan(Math.hypot(30, 20) - 1e-9);
  });

  it('a U-turn in place is one of the three-arc words', () => {
    const m = connect.turns([station(0, 0, 0), station(0, 0, Math.PI)], { radius: 4 });
    const { pts, length } = chainOf(m);
    expect(length).toBeGreaterThan(4);
    const end = pts[pts.length - 1];
    expect(Math.hypot(end[0], end[1])).toBeLessThan(1e-6);
  });

  it('closed joins the last back to the first, one chain and no loose end', () => {
    const ring = [station(0, 0, 0), station(40, 0, Math.PI / 2), station(40, 40, Math.PI), station(0, 40, -Math.PI / 2)];
    const open = connect.turns(ring, { radius: 8 });
    const shut = connect.turns(ring, { radius: 8, closed: true });
    expect(shut.edgeCount).toBeGreaterThan(open.edgeCount);
    expect(shut.n).toBe(shut.edgeCount); // every vertex has two neighbours
    expect(shut.curves()).toHaveLength(1);
    expect(shut.curves()[0].closed).toBe(true);
  });

  it('refuses plain points by name, and says where headings come from', () => {
    expect(() => connect.turns([[0, 0], [10, 10]] as never, { radius: 3 }))
      .toThrow(/m\.along/);
    expect(() => connect.turns(material([[0, 0], [1, 1]]), { radius: 3 }))
      .toThrow(/heading/);
    expect(() => connect.turns([station(0, 0, 0)], { radius: 0 }))
      .toThrow('connect.turns: { radius }');
  });

  it('is deterministic and holds its stations', () => {
    const list = [station(0, 0, 0), station(25, 12, 1), station(50, -6, 2.5)];
    const a = connect.turns(list, { radius: 5 });
    const b = connect.turns(list, { radius: 5 });
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect(a.x[0]).toBe(0);
    expect(a.y[0]).toBe(0);
  });
});

// ---- path().arcTo large ----------------------------------------------------

describe('path().arcTo: the minor arc, or the long way round', () => {
  const bow = (large: boolean): { w: number; h: number } => {
    const t = toolkit();
    const p = path().moveTo(20, 50).arcTo(80, 50, 35, { large }).build();
    const m = t.material(p);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < m.n; i++) {
      x0 = Math.min(x0, m.x[i]); x1 = Math.max(x1, m.x[i]);
      y0 = Math.min(y0, m.y[i]); y1 = Math.max(y1, m.y[i]);
    }
    return { w: x1 - x0, h: y1 - y0 };
  };

  it('the default is the minor arc: its rise is the small sagitta', () => {
    const { w, h } = bow(false);
    // chord 60, radius 35: rise = 35 − √(35² − 30²) ≈ 16.97, width the chord.
    expect(h / w).toBeCloseTo((35 - Math.sqrt(35 * 35 - 30 * 30)) / 60, 2);
  });

  it('large takes the other arc about the same centre', () => {
    const minor = bow(false);
    const large = bow(true);
    expect(large.h).toBeGreaterThan(minor.h);
    // rise = 35 + √(35² − 30²) ≈ 53.03, and the bulge is now wider than the chord
    expect(large.h / minor.h).toBeCloseTo((35 + Math.sqrt(325)) / (35 - Math.sqrt(325)), 1);
    expect(large.w / minor.w).toBeCloseTo(70 / 60, 2);
  });
});

// ---- vector helpers --------------------------------------------------------

describe('vec: turn, lerp, reflect, angleBetween', () => {
  it('turn goes about the origin, in radians, from +x toward +y', () => {
    const [x, y] = turn([1, 0], Math.PI / 2);
    expect(x).toBeCloseTo(0, 12);
    expect(y).toBeCloseTo(1, 12);
    expect(turn({ x: 3, y: 4 }, 0)).toEqual([3, 4]);
    // Turning back comes back, and length is kept.
    const v = turn([3, 4], 1.234);
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(5, 12);
    const back = turn(v, -1.234);
    expect(back[0]).toBeCloseTo(3, 12);
    expect(back[1]).toBeCloseTo(4, 12);
  });

  it('`rotate` is the field verb and is untouched: a field, by degrees', () => {
    const f = rotate((x: number, y: number) => x + 2 * y, 90);
    expect(typeof f).toBe('function');
    // Sampled through the inverse turn: (0, 1) reads the field at (1, 0).
    expect(f(0, 1)).toBeCloseTo(1, 9);
  });

  it('lerp walks from a to b, and past it', () => {
    expect(lerp([0, 0], [10, 20], 0)).toEqual([0, 0]);
    expect(lerp([0, 0], [10, 20], 1)).toEqual([10, 20]);
    expect(lerp([0, 0], [10, 20], 0.25)).toEqual([2.5, 5]);
    expect(lerp({ x: 0, y: 0 }, [10, 0], 1.5)).toEqual([15, 0]);
  });

  it('reflect bounces off a normal, whatever its length', () => {
    expect(reflect([1, 1], [0, 1])).toEqual([1, -1]);
    expect(reflect([1, 1], [0, 7])).toEqual([1, -1]); // normalised here
    const r = reflect([3, 4], [1, 0]);
    expect(r).toEqual([-3, 4]);
    // A zero normal is no surface at all.
    expect(reflect([3, 4], [0, 0])).toEqual([3, 4]);
    // Length is kept, and reflecting twice is the identity.
    const once = reflect([2, -5], [1, 2]);
    expect(Math.hypot(once[0], once[1])).toBeCloseTo(Math.hypot(2, -5), 12);
    const twice = reflect(once, [1, 2]);
    expect(twice[0]).toBeCloseTo(2, 12);
    expect(twice[1]).toBeCloseTo(-5, 12);
  });

  it('angleBetween is signed, and reads lengths not at all', () => {
    expect(angleBetween([1, 0], [0, 1])).toBeCloseTo(Math.PI / 2, 12);
    expect(angleBetween([0, 1], [1, 0])).toBeCloseTo(-Math.PI / 2, 12);
    expect(angleBetween([1, 0], [5, 0])).toBe(0);
    expect(angleBetween([1, 0], [-1, 0])).toBeCloseTo(Math.PI, 12);
    expect(angleBetween([0, 0], [1, 0])).toBe(0);
    expect(angleBetween([2, 2], [-3, 3])).toBeCloseTo(Math.PI / 2, 12);
  });
});

// ---- gaussian --------------------------------------------------------------

describe('gaussian: a normal draw on the seeded stream', () => {
  it('lands on the mean and the spread asked for, over ten thousand draws', () => {
    const t = toolkit({ seed: 42 });
    const draws = Array.from({ length: 10000 }, () => t.gaussian(4, 2));
    const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
    const sd = Math.sqrt(draws.reduce((a, b) => a + (b - mean) ** 2, 0) / draws.length);
    expect(mean).toBeCloseTo(4, 1);
    expect(sd).toBeCloseTo(2, 1);
    // A normal has no bound: some draws are further than two sd out.
    expect(draws.some((v) => Math.abs(v - 4) > 4)).toBe(true);
    // …but most are inside one.
    const within = draws.filter((v) => Math.abs(v - 4) <= 2).length / draws.length;
    expect(within).toBeGreaterThan(0.6);
    expect(within).toBeLessThan(0.75);
  });

  it('is the standard normal by default', () => {
    const t = toolkit({ seed: 7 });
    const draws = Array.from({ length: 4000 }, () => t.gaussian());
    const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
    expect(mean).toBeCloseTo(0, 1);
  });

  it('same seed, same draws — and a named stream is its own', () => {
    const a = toolkit({ seed: 'ink' });
    const b = toolkit({ seed: 'ink' });
    const first = Array.from({ length: 8 }, () => a.gaussian(0, 1));
    const again = Array.from({ length: 8 }, () => b.gaussian(0, 1));
    expect(again).toEqual(first);
    // A named stream is its own: same name, same values; another name, other values.
    const one = toolkit({ seed: 'ink' }).stream('one').gaussian(0, 1);
    const two = toolkit({ seed: 'ink' }).stream('two').gaussian(0, 1);
    expect(toolkit({ seed: 'ink' }).stream('one').gaussian(0, 1)).toBe(one);
    expect(two).not.toBe(one);
  });

  it('draws it in a sketch', () => {
    const t = toolkit({ seed: 3 });
    const marks = Array.from({ length: 20 }, (_, i) => stroke([[i * 4, 50 + t.gaussian(0, 6)], [i * 4, 50 + t.gaussian(0, 6)]]));
    expect(marks).toHaveLength(20);
  });
});
