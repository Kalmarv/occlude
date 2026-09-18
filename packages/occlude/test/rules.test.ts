import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { add, circle, force, initOcclude, material, mul, render, rule, sketch, sub, unit, type Edge, type Material, type Vertex } from '../src/index.js';

beforeAll(async () => {
  await initOcclude(readFileSync(fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));
});

/** An open chain of n points along the x axis — points AND the edges that
 * join them, because `material(points)` alone is a cloud. */
const line = (n: number, len = 1): Material =>
  material(
    Array.from({ length: n }, (_, i) => [(i * len) / (n - 1), 0] as [number, number]),
    { edges: Array.from({ length: n - 1 }, (_, i) => [i, i + 1] as [number, number]) },
  );

/** A chain of exactly these points. */
const chain = (pts: [number, number][]): Material =>
  material(pts, { edges: pts.slice(1).map((_, i) => [i, i + 1] as [number, number]) });

describe('rewrite rules', () => {
  it('is a step rule, so steps runs it with no new verb', () => {
    const m = line(5);
    const moved = m.steps(1, rule.point().move([1, 0]));
    expect(moved.points.at(0).x).toBeCloseTo(1, 10);
    expect(moved.points.length).toBe(5);
  });

  it('matches every rule against the frozen state, so move rules commute', () => {
    const m = line(3, 2);
    // Both rules read x. In one batch the second sees the ORIGINAL x, so
    // every point moves by its starting x, not by the moved one.
    const batch = m.steps(1, [
      rule.point().move((p) => [p.x, 0]),
      rule.point().move((p) => [p.x, 0]),
    ]);
    expect(batch.points.at(2).x).toBeCloseTo(2 + 2 + 2, 10);
    // As two passes the second rule sees the first's result: 2 → 4 → 8.
    const passes = m.steps(1, rule.point().move((p) => [p.x, 0]), rule.point().move((p) => [p.x, 0]));
    expect(passes.points.at(2).x).toBeCloseTo(8, 10);
  });

  it('edits in rule order, so a later set wins and new rows follow the rules', () => {
    const attributed = () => material([[0, 0], [1, 0]] as [number, number][], { edges: [[0, 1]] as [number, number][] }).attribute('age', 0);
    const a = rule.point().set({ age: 1 });
    const b = rule.point().set({ age: 2 });
    // Matching is order-free; WRITING is last-wins, as everywhere else.
    expect(attributed().steps(1, [a, b]).points.at(0).age).toBe(2);
    expect(attributed().steps(1, [b, a]).points.at(0).age).toBe(1);
    // A move is the commuting case, and the only one.
    const m = line(2);
    expect(m.steps(1, [rule.point().move([1, 0]), rule.point().move([10, 0])]).points.at(0).x)
      .toBeCloseTo(m.steps(1, [rule.point().move([10, 0]), rule.point().move([1, 0])]).points.at(0).x, 10);
  });

  it('splits every edge that matches, and only those', () => {
    const m = line(4, 3);
    const long = m.steps(1, rule.edge((e) => e.length > 0.9));
    expect(long.points.length).toBe(4);
    const split = m.steps(1, rule.edge((e) => e.length > 0.9).split());
    expect(split.points.length).toBe(4 + 3);
    const none = m.steps(1, rule.edge((e) => e.length > 100).split());
    expect(none.points.length).toBe(4);
  });

  it('grows a Koch curve by replacing every edge with one motif', () => {
    // The classic generator: _/\_ across the middle third.
    const h = Math.sqrt(3) / 6;
    const motif = chain([[0, 0], [1 / 3, 0], [0.5, h], [2 / 3, 0], [1, 0]]);
    const seed = line(2);
    const koch = seed.steps(4, rule.edge().replace(motif));
    // Every step turns each edge into four.
    expect(koch.edges.length).toBe(4 ** 4);
    // The ends stay put, and the curve stays inside its own bump.
    const xs = koch.points.map((p: Vertex) => p.x);
    const ys = koch.points.map((p: Vertex) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(1, 6);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(-1e-9);
    expect(Math.max(...ys)).toBeCloseTo(h, 2);
  });

  it('gives every callback the step, so a motif can alternate by turns', () => {
    const h = Math.sqrt(3) / 6;
    const motif = chain([[0, 0], [1 / 3, 0], [0.5, h], [2 / 3, 0], [1, 0]]);
    const steps: number[] = [];
    line(2).steps(3, rule.edge((_e, _cur, k) => { steps.push(k); return true; }).split());
    expect(new Set(steps)).toEqual(new Set([0, 1, 2]));
    // Alternating on k grows the curve outward, then inward, then out.
    const turns = line(2).steps(2, rule.edge().replace(motif, { flip: (_e, _cur, k) => k % 2 === 1 }));
    const ys = [...turns.points].map((p: Vertex) => p.y);
    expect(Math.max(...ys)).toBeGreaterThan(0);
    expect(Math.min(...ys)).toBeLessThan(0);
  });

  it('flips a motif, so the bumps alternate', () => {
    const h = Math.sqrt(3) / 6;
    const motif = chain([[0, 0], [1 / 3, 0], [0.5, h], [2 / 3, 0], [1, 0]]);
    const down = line(2).steps(1, rule.edge().replace(motif, { flip: true }));
    expect(Math.min(...down.points.map((p: Vertex) => p.y))).toBeCloseTo(-h, 6);
  });

  it('grows a tree by extruding from the tips', () => {
    // A tip is a point with exactly one neighbour — `p.adjacent` is the word.
        const tree = chain([[0, 0], [0, 1]]).steps(3, rule.point((p) => p.adjacent.length === 1 && p.y > 0).extrude((p) => {
      const from = p.adjacent.at(0);
      const dir = unit(sub(p, from));
      return [{ position: add(p, mul(dir, 0.6)) }];
    }));
    // One tip each step, so three new points.
    expect(tree.points.length).toBe(2 + 3);
    expect(tree.points.at(4).y).toBeCloseTo(1 + 0.6 * 3, 6);
  });

  it('gives a point the points an edge joins it to, and never itself', () => {
    const m = line(3);
    const middle = m.points.at(1);
    expect(middle.adjacent.length).toBe(2);
    expect(middle.adjacent.map((p: Vertex) => p.index).sort()).toEqual([0, 2]);
    expect(m.points.at(0).adjacent.length).toBe(1);
    expect(material([[0, 0]] as [number, number][]).points.at(0).adjacent.length).toBe(0);
  });

  it('finds points near one, by distance and not by topology', () => {
    const m = material([[0, 0], [1, 0], [5, 0], [0, 1]] as [number, number][]);
    const p = m.points.at(0);
    const near = m.points.near(p, { radius: 1.5 });
    expect(near.map((q: Vertex) => q.index).sort()).toEqual([1, 3]);
    // Never itself, whatever the radius.
    expect(m.points.near(p, { radius: 100 }).map((q: Vertex) => q.index)).not.toContain(0);
    // A selection of part of the state answers with its own members only.
    const half = m.points.filter((q: Vertex) => q.index !== 1);
    expect(half.near(p, { radius: 1.5 }).map((q: Vertex) => q.index)).toEqual([3]);
    expect(() => m.points.near(p, { radius: 0 })).toThrow(/positive distance/);
  });

  it('rewrites the bloom loop as rules and gets the same drawing', () => {
    const run = (asRules: boolean) => {
      let out: Material | undefined;
      // A sketch body runs when the sketch is compiled, not when it is
      // written: render it, or `out` never gets set.
      const def = sketch({ seed: 8 }, (t) => {
        const ring = t.sample(circle(50, 50, 10), { count: 40 });
        const dish = t.material(circle(50, 50, 44));
        const push = (cur: Material) => force.sum(
          force.separation(cur, { radius: 3, excludeConnected: true }),
          force.tension(cur, { rest: 1.2 }),
          force.relax(cur, { amount: 0.6 }),
          force.boundary(dish, { radius: 8 }),
        );
        // Bloom's real room test: an edge splits only when nothing but its
        // own ends AND THEIR NEIGHBOURS lies near its middle. The weaker
        // test (ends only) never fires at this rest length, so it would
        // compare two runs that never split.
        const hasRoom = (e: Edge, cur: Material): boolean => {
          const own = new Set([e.a.index, e.b.index, ...[...e.a.adjacent].map((q: Vertex) => q.index), ...[...e.b.adjacent].map((q: Vertex) => q.index)]);
          return cur.points.near(mul(add(e.a, e.b), 0.5), { radius: 2.5 }).every((q: Vertex) => own.has(q.index));
        };
        out = asRules
          ? ring.steps(30, [
              rule.point().move((p, cur) => mul(push(cur)(p), 0.2)),
              rule.edge(hasRoom).split(),
            ])
          : ring.steps(30, (cur, next) => {
              next.move(cur.points, (p) => mul(push(cur)(p), 0.2));
              next.splitEdges(cur.edges.filter((e) => hasRoom(e, cur)));
            });
        return [];
      });
      render(def, { paper: { w: 100, h: 100 } });
      return out!;
    };
    const asRules = run(true);
    const asLoop = run(false);
    // The run must actually SPLIT, or this compares two runs that only move.
    expect(asLoop.points.length).toBeGreaterThan(40);
    expect(asRules.points.length).toBe(asLoop.points.length);
    for (let i = 0; i < asLoop.points.length; i++) {
      expect(asRules.points.at(i).x).toBeCloseTo(asLoop.points.at(i).x, 10);
      expect(asRules.points.at(i).y).toBeCloseTo(asLoop.points.at(i).y, 10);
    }
  });

  it('carries point columns through a replace, interpolating like a split', () => {
    const m = material(
      [{ x: 0, y: 0, heat: 0 }, { x: 3, y: 0, heat: 6 }],
      { edges: [[0, 1]] as [number, number][] },
    );
    const motif = chain([[0, 0], [1 / 3, 0], [0.5, 0.2], [2 / 3, 0], [1, 0]]);
    const grown = m.steps(1, rule.edge().replace(motif));
    expect(grown.points.length).toBe(5);
    // The inserted points sit at 1/3, 1/2 and 2/3 along, so heat follows.
    const heats = [...grown.points].map((p: Vertex) => p.heat).sort((a, b) => a - b);
    expect(heats[0]).toBeCloseTo(0, 6);
    expect(heats[4]).toBeCloseTo(6, 6);
    expect(heats[1]).toBeCloseTo(2, 6);
    expect(heats[2]).toBeCloseTo(3, 6);
    expect(heats[3]).toBeCloseTo(4, 6);
  });

  it('refuses a pattern that is not a function, and a bad motif', () => {
    expect(() => rule.point(3 as never)).toThrow(/a pattern is a function/);
    expect(() => rule.edge().replace(material([[0, 0]] as [number, number][]))).toThrow(/one open chain/);
    // A motif whose rows are not its chain order used to thread the rows
    // and draw something else entirely. Now the chain is what counts.
    const zig = material([[0, 0], [1, 0], [0.5, 0.3]] as [number, number][], { edges: [[0, 2], [2, 1]] as [number, number][] });
    const woven = line(2).steps(1, rule.edge().replace(zig));
    const ys = [...woven.points].map((p: Vertex) => p.y);
    expect(Math.max(...ys.map(Math.abs))).toBeLessThan(0.5);
    expect(() => rule.edge().replace(chain([[0, 0], [0, 0]]))).toThrow(/different points/);
    expect(() => rule.edge().replace(chain([[0, 0], [1, 0], [0, 0]]))).toThrow(/closed|different points/);
  });
});

describe('one rule, two worlds', () => {
  it('runs the same rule value on a material and on a mesh, with no cast', async () => {
    const { plane } = await import('../src/three/api/index.js');
    // Built once. Handed to both worlds' steps.
    const lift = rule.point().move([0, 0, 0.5]);
    const flat = rule.point().move([1, 0]);

    const mesh = plane(4).subdivide(2);
    const before = [...mesh.points][0].z;
    const lifted = mesh.steps(1, lift);
    expect([...lifted.points][0].z).toBeCloseTo(before + 0.5, 6);

    const m = line(3);
    expect(m.steps(1, flat).points.at(0).x).toBeCloseTo(1, 10);
  });

  it('writes face attributes on a mesh, and says why a material cannot', async () => {
    const { plane } = await import('../src/three/api/index.js');
    const mesh = plane(4).subdivide(1).faceAttribute('heat', 0);
    const warm = mesh.steps(1, rule.face((f) => f.center[0] > 0).set({ heat: 1 }));
    const heats = [...warm.faces].map((f: { attributes: { heat: number } }) => f.attributes.heat);
    expect(heats.some((h) => h === 1)).toBe(true);
    expect(heats.some((h) => h === 0)).toBe(true);

    // A material's faces are computed, not stored: there is nowhere to write.
    const square = material([[0, 0], [10, 0], [10, 10], [0, 10]] as [number, number][], {
      edges: [[0, 1], [1, 2], [2, 3], [3, 0]] as [number, number][],
    });
    expect(() => square.steps(1, rule.face().set({ heat: 1 }) as never)).toThrow(/no face attributes/);
  });

  it('spreads a value across a mesh by face adjacency, one step at a time', async () => {
    const { plane } = await import('../src/three/api/index.js');
    const mesh = plane(4).subdivide(2).faceAttribute('lit', 0);
    const seed = mesh.steps(1, rule.face((f) => f.index === 0).set({ lit: 1 }));
    const lit = (m: { faces: Iterable<{ attributes: { lit: number } }> }) =>
      [...m.faces].filter((f) => f.attributes.lit > 0).length;
    expect(lit(seed)).toBe(1);
    // A cellular rule: a dark face next to a lit one lights up.
    const spread = seed.steps(2, rule.face((f) => f.attributes.lit === 0 && [...f.adjacent].some((g: { attributes: { lit: number } }) => g.attributes.lit === 1)).set({ lit: 1 }));
    expect(lit(spread)).toBeGreaterThan(lit(seed));
  });
});

describe('a rule names the world its callback reads', () => {
  it('types cur for the flat world by default, and for a mesh when asked', async () => {
    const { plane } = await import('../src/three/api/index.js');
    const mesh = plane(4).subdivide(1);
    type MeshState = typeof mesh;
    // Default: cur is a Material, and the flat world's words typecheck.
    const flat = rule.point((p, cur) => cur.points.near(p, { radius: 2 }).length >= 0);
    expect(line(3).steps(1, flat.move([0, 0])).points.length).toBe(3);
    // Named: cur is the mesh, and a mesh word typechecks instead.
    const solid = rule.point<{ z: number }, MeshState>((p, cur) => p.z >= 0 && [...cur.points].length > 0);
    expect([...mesh.steps(1, solid.move([0, 0, 1])).points][0].z).toBeCloseTo(1, 6);
  });
});
