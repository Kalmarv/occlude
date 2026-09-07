import { describe, expect, it } from 'vitest';
import { append, connect, curve, material, polygon, type Material } from '../src/index.js';
import { faces, planarize, FaceSelection } from '../src/faces.js';

const square = (x = 0, y = 0, s = 10, extra: Record<string, number> = {}) =>
  curve([[x, y], [x + s, y], [x + s, y + s], [x, y + s]], { closed: true, ...extra });
const seg = (a: [number, number], b: [number, number], attrs: Record<string, number> = {}) => material([a, b], { edges: [[0, 1]], ...attrs });
const areas = (m: Material) => m.faces().faces.map((f) => +f.area.toFixed(6)).sort((p, q) => p - q);
// Euler check: bounded faces = E - V + C over the whole (finite) graph, isolated vertices counted in V and C
const euler = (m: Material) => {
  const seen = new Int32Array(m.n).fill(-1);
  let c = 0;
  for (let v = 0; v < m.n; v++) {
    if (seen[v] !== -1) continue;
    const st = [v];
    seen[v] = c;
    while (st.length) for (const w of m.connected(st.pop()!)) if (seen[w] === -1) { seen[w] = c; st.push(w); }
    c++;
  }
  return m.edgeCount - m.n + c;
};

describe('planarize', () => {
  it('proper crossing: one shared vertex, four children, transfer by policy', () => {
    const cross = append(seg([0, 0], [10, 10]).attribute('age', (p) => p.index * 4), seg([0, 10], [10, 0]).attribute('age', (p) => p.index * 4));
    const p = cross.planarize();
    expect(p.n).toBe(5);
    expect(p.edgeCount).toBe(4);
    expect([p.x[4], p.y[4]]).toEqual([5, 5]);
    expect(Array.from(p.edgeList)).toEqual([0, 4, 4, 1, 2, 4, 4, 3]); // parent order, parameter order, direction kept
    expect(p.attrs.age[4]).toBe(2); // 0→4 at t=.5 on both edges: equal candidates
    expect(p.iteration).toBe(0);
    expect(p.history).toEqual([]);
    expect(cross.n).toBe(4); // source untouched
    expect(p.faces().length).toBe(0);
  });

  it('T-junction and endpoint contact reuse the endpoint; several edges at one event share one vertex', () => {
    const t = append(seg([0, 0], [10, 0]), seg([5, 0], [5, 5]));
    const pt = t.planarize();
    expect(pt.n).toBe(4);
    expect(pt.edgeCount).toBe(3);
    expect(pt.degree(2)).toBe(3); // the T's stem end is the shared vertex
    // three lines through one point: one new vertex, six children
    let star = append(seg([0, 0], [10, 10]), seg([0, 10], [10, 0]));
    star = append(star, seg([5, 0], [5, 10]));
    const ps = star.planarize();
    expect(ps.n).toBe(7);
    expect(ps.edgeCount).toBe(6);
    expect(ps.degree(6)).toBe(6);
    // collinear endpoint contact: a shared endpoint, no overlap
    const touch = append(seg([0, 0], [5, 0]), seg([5, 0], [10, 0]));
    const ptouch = touch.planarize();
    expect(ptouch.n).toBe(3);
    expect(ptouch.edgeCount).toBe(2);
    // a distinct vertex at the same coordinates merges into the lowest row
    expect(ptouch.x[1]).toBe(5);
  });

  it('isolated points stay isolated, even on an edge; nearby is not coincident', () => {
    const m = material([[0, 0], [10, 0], [5, 0], [20, 20]], { edges: [[0, 1]] });
    const p = m.planarize();
    expect(p.n).toBe(4);
    expect(p.edgeCount).toBe(1);
    expect(p.degree(2)).toBe(0);
    const gap = append(seg([0, 0], [10, 0]), seg([5, 1e-9], [5, 5]));
    expect(gap.planarize().edgeCount).toBe(2); // the gap stays
  });

  it('rejects overlaps, duplicates, zero-length edges and non-finite input by row', () => {
    expect(() => append(seg([0, 0], [10, 0]), seg([5, 0], [15, 0])).planarize()).toThrow(/edges 0 and 1 overlap/);
    expect(() => append(seg([0, 0], [10, 0]), seg([0, 0], [10, 0])).planarize()).toThrow(/same segment|overlap/);
    expect(() => append(seg([0, 0], [10, 0]), seg([0, 0], [5, 0])).planarize()).toThrow(/overlap/);
    expect(() => seg([1, 1], [1, 1]).planarize()).toThrow(/zero-length edge 0/);
    expect(() => seg([NaN, 0], [1, 1]).planarize()).toThrow(/not finite/);
    const src = append(seg([0, 0], [10, 0]), seg([5, 0], [15, 0]));
    try { src.planarize(); } catch { /* the source is untouched on failure */ }
    expect(src.edgeCount).toBe(2);
  });

  it('conflicting point attributes need a resolver; child edge attributes by interval', () => {
    const a = seg([0, 0], [10, 10], { age: 0 });
    const b = seg([0, 10], [10, 0]).attribute('age', 8);
    const cross = append(a, b).edgeAttribute('rest', 3);
    expect(() => cross.planarize()).toThrow(/conflicting 'age' \(0 vs 8\)/);
    const seen: number[][] = [];
    const p = cross.planarize({
      point: (ev) => { seen.push(ev.candidates.map((c) => c.edge!)); return { age: 1 }; },
      edges: (parent, child) => ({ rest: parent.attrs.rest * child.fraction }),
    });
    expect(seen).toEqual([[0, 1]]);
    expect(p.attrs.age[4]).toBe(1);
    expect(Array.from(p.edgeAttrs.rest)).toEqual([1.5, 1.5, 1.5, 1.5]);
    expect(() => cross.planarize({ point: () => ({ nope: 1 }) })).toThrow(/no attribute 'nope'/);
    expect(() => cross.planarize({ point: () => ({}) })).toThrow(/still has conflicting 'age'/);
    // nearest policy copies; unsplit edges get fraction 1
    const cat = append(seg([0, 0], [10, 10]).attribute('kind', 1, { transfer: 'nearest' }), seg([0, 10], [10, 0]).attribute('kind', 1, { transfer: 'nearest' }));
    const pc = append(cat, seg([20, 20], [30, 30]).attribute('kind', 1, { transfer: 'nearest' })).edgeAttribute('w', 2).planarize({ edges: (_, c) => ({ w: c.fraction * 10 }) });
    expect(pc.attrs.kind[4]).toBe(1);
    expect(Array.from(pc.edgeAttrs.w)).toEqual([5, 5, 5, 5, 10]);
    expect(pc.transfers.kind).toBe('nearest');
  });

  it('is idempotent on its output and deterministic', () => {
    let net = append(seg([0, 0], [10, 10]), seg([0, 10], [10, 0]));
    net = append(net, seg([2, 7], [9, 3]));
    const p1 = net.planarize();
    const p2 = p1.planarize();
    expect(p2.n).toBe(p1.n);
    expect(Array.from(p2.edgeList)).toEqual(Array.from(p1.edgeList));
    expect(Array.from(p2.x)).toEqual(Array.from(p1.x));
    const again = net.planarize();
    expect(Array.from(again.x)).toEqual(Array.from(p1.x));
    expect(Array.from(again.edgeList)).toEqual(Array.from(p1.edgeList));
  });

  it('near-parallel and near-contact cases at several scales decide exactly', () => {
    for (const scale of [1e-3, 1, 1e3, 1e6]) {
      // a segment ending exactly on another's line is a contact; one unit-ulp away is not
      const on = append(seg([0, 0], [10 * scale, 0]), seg([5 * scale, 0], [5 * scale, 5 * scale]));
      expect(on.planarize().edgeCount).toBe(3);
      const off = append(seg([0, 0], [10 * scale, 0]), seg([5 * scale, scale * 1e-12], [5 * scale, 5 * scale]));
      expect(off.planarize().edgeCount).toBe(2);
      // near-parallel proper crossing at a shallow angle still yields one vertex
      const shallow = append(seg([0, 0], [10 * scale, 0]), seg([0, -scale * 1e-7], [10 * scale, scale * 1e-7]));
      const ps = shallow.planarize();
      expect(ps.n).toBe(5);
      expect(ps.x[4]).toBeCloseTo(5 * scale, 6);
    }
  });
});

describe('faces', () => {
  it('empty, isolated, tree, one ring, disjoint rings', () => {
    expect(material([]).faces().length).toBe(0);
    expect(material([[0, 0], [1, 1]]).faces().length).toBe(0);
    expect(connect.chain([[0, 0], [5, 0], [5, 5], [9, 9]]).faces().length).toBe(0);
    const one = square();
    expect(areas(one)).toEqual([100]);
    expect(one.faces().faces[0].perimeter).toBe(40);
    expect(one.faces().faces[0].bounds).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    expect(areas(append(square(), square(20, 0)))).toEqual([100, 100]);
    for (const m of [one, append(square(), square(20, 0)), connect.chain([[0, 0], [5, 0], [5, 5]])]) expect(m.faces().length).toBe(euler(m));
  });

  it('a square with one diagonal has two faces; both diagonals need planarize and give four', () => {
    const diag = square().steps(1, (_, next) => next.connect(0, 2));
    expect(areas(diag)).toEqual([50, 50]);
    const both = diag.steps(1, (_, next) => next.connect(1, 3));
    expect(() => both.faces()).toThrow(/cross without a shared vertex — run planarize\(\)/);
    const p = both.planarize();
    expect(p.n).toBe(5);
    expect(areas(p)).toEqual([25, 25, 25, 25]);
    expect(p.faces().length).toBe(euler(p));
    const f = p.faces().faces[0];
    expect(f.contours).toHaveLength(1);
    expect(f.contours[0].closed).toBe(true);
    expect(f.contours[0].pts).toHaveLength(3);
  });

  it('nested rings: annulus + disk, three levels; faces do not overlap and areas add up', () => {
    const two = append(square(0, 0, 30), square(10, 10, 10));
    const cells = two.faces();
    expect(areas(two)).toEqual([100, 800]);
    const annulus = cells.faces.find((f) => f.area === 800)!;
    expect(annulus.contours).toHaveLength(2);
    expect(annulus.perimeter).toBe(120 + 40);
    expect(annulus.bounds).toEqual({ x: 0, y: 0, w: 30, h: 30 });
    let three = append(square(0, 0, 50), square(10, 10, 30));
    three = append(three, square(20, 20, 10));
    expect(areas(three)).toEqual([100, 800, 1600]);
    const total = three.faces().faces.reduce((s, f) => s + f.area, 0);
    expect(total).toBe(2500);
    expect(three.faces().length).toBe(euler(three));
    // the union outline of everything is the outer square alone
    expect(three.faces().boundaries()).toHaveLength(1);
  });

  it('dangling branches and bridges add no area, no face, no retraced contour', () => {
    const withBranch = square().steps(1, (_, next) => next.extend(() => ({ position: [5, 5], attributes: {} }), { where: (p) => p.index === 0 }));
    const cells = withBranch.faces();
    expect(cells.length).toBe(1);
    expect(cells.faces[0].area).toBe(100);
    expect(cells.faces[0].perimeter).toBe(40);
    expect(cells.faces[0].contours).toHaveLength(1);
    expect(cells.faces[0].contours[0].pts).toHaveLength(4);
    // a bridge between two loops
    const bridged = append(square(), square(20, 0)).steps(1, (_, next) => next.connect(1, 4));
    expect(areas(bridged)).toEqual([100, 100]);
    expect(bridged.faces().length).toBe(euler(bridged));
    for (const f of bridged.faces().faces) expect(f.contours[0].pts).toHaveLength(4);
    // a ring hanging inside another by a bridge: annulus with a pinched hole, two contours, no retrace
    const inner = append(square(0, 0, 30), square(10, 10, 10)).steps(1, (_, next) => next.connect(1, 5));
    const ic = inner.faces();
    expect(areas(inner)).toEqual([100, 800]);
    const ann = ic.faces.find((f) => f.area === 800)!;
    expect(ann.contours).toHaveLength(2);
    expect(ann.perimeter).toBe(160);
    expect(ic.boundaries()).toHaveLength(1);
  });

  it('regions meeting at a vertex stay separate faces and separate contours', () => {
    const touching = append(square(), square(10, 10)); // corner (10,10) twice → planarize merges them
    expect(() => touching.faces()).toThrow(/coincide but are distinct/);
    const p = touching.planarize();
    expect(p.n).toBe(7);
    expect(areas(p)).toEqual([100, 100]);
    const both = p.faces().boundaries();
    expect(both).toHaveLength(2);
    for (const c of both) expect(c.pts).toHaveLength(4);
  });

  it('face selections: domain, source, fixed membership, set operations', () => {
    const grid = connect.triangulate(material([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5]]));
    const cells = grid.faces();
    expect(cells.length).toBe(4);
    expect(cells.iteration).toBe(0);
    const big = cells.filter((f) => f.area >= 25);
    expect(big.length).toBe(4);
    expect(big.has(cells.faces[0])).toBe(true);
    expect(big.has(grid.faces().faces[0])).toBe(false); // another collection of the same state
    expect(() => big.has(grid.vertex(0) as never)).toThrow(/vertex view/);
    expect(() => big.has(grid.edge(0) as never)).toThrow(/edge view/);
    expect(() => cells.has({ index: 0, area: 1 } as never)).toThrow(/face view/);
    const none = cells.filter(() => false);
    expect(none.boundaries()).toEqual([]);
    expect(big.subtract(none).indices).toEqual([0, 1, 2, 3]);
    expect(big.intersect(cells.filter((f) => f.index < 2)).indices).toEqual([0, 1]);
    expect(() => big.union(grid.faces().filter(() => true))).toThrow(/different face collections/);
    expect(() => big.union({} as FaceSelection)).toThrow(/face selection/);
    expect(cells.map((f) => f.index)).toEqual([0, 1, 2, 3]);
    expect(Object.isFrozen(cells.faces[0])).toBe(true);
  });

  it('union boundaries: shared walls vanish, holes stay when the inner face is unselected', () => {
    const diag = square().steps(1, (_, next) => next.connect(0, 2));
    const cells = diag.faces();
    expect(cells.boundaries()).toHaveLength(1);
    expect(cells.boundaries()[0].pts).toHaveLength(4);
    const one = cells.filter((f) => f.index === 0);
    expect(one.boundaries()[0].pts).toHaveLength(3);
    const nested = append(square(0, 0, 30), square(10, 10, 10)).faces();
    const outerOnly = nested.filter((f) => f.area > 500);
    expect(outerOnly.boundaries()).toHaveLength(2); // the hole is kept
    expect(nested.boundaries()).toHaveLength(1); // both selected: the inner wall goes
    const innerOnly = nested.filter((f) => f.area < 500);
    expect(innerOnly.boundaries()).toHaveLength(1);
    expect(innerOnly.boundaries()[0].pts).toHaveLength(4);
    // contours feed polygon and stroke directly
    expect(() => polygon(nested.faces[0].contours, { winding: 'evenodd' })).not.toThrow();
    expect(() => polygon(nested.boundaries())).not.toThrow();
  });

  it('every intersection of a planarized network is a shared endpoint (cross-check on a random net)', () => {
    let net = material([]);
    const pts: [number, number][] = [];
    let s = 7;
    const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647) * 40;
    for (let i = 0; i < 24; i++) pts.push([rnd(), rnd()]);
    for (let i = 0; i + 1 < pts.length; i += 2) net = append(net, seg(pts[i], pts[i + 1]));
    const p = net.planarize();
    expect(() => p.faces()).not.toThrow();
    expect(p.faces().length).toBe(euler(p));
    const again = p.planarize();
    expect(again.n).toBe(p.n);
    expect(again.edgeCount).toBe(p.edgeCount);
  });
});

describe('review of 3df7b04', () => {
  it('1. a T-junction reconciles the stem endpoint against the receiving edge', () => {
    const bar = seg([0, 0], [10, 0]).attribute('age', 0);
    const stem = seg([5, 0], [5, 5]).attribute('age', 9);
    const t = append(bar, stem);
    expect(() => t.planarize()).toThrow(/vertex 2 .*conflicting 'age' \(9 vs 0\)|conflicting 'age'/);
    const seen: unknown[] = [];
    const p = t.planarize({ point: (ev) => { seen.push(ev.candidates); return { age: 4 }; } });
    expect(seen).toHaveLength(1);
    expect((seen[0] as { vertex?: number }[])[0].vertex).toBe(2);
    expect(p.attrs.age[2]).toBe(4);
    // agreeing candidates need no resolver
    const agree = append(seg([0, 0], [10, 0]).attribute('age', 0), seg([5, 0], [5, 5]).attribute('age', 0));
    expect(agree.planarize().attrs.age[2]).toBe(0);
  });

  it('2. only proven shared events consolidate; distinct nearby crossings stay distinct', () => {
    // two crossings 1e-10 apart along the horizontal: NOT one point
    const near = append(append(seg([0, 0], [10, 0]), seg([5, -1], [5, 1])), seg([5 + 1e-10, -1], [5 + 2e-10, 1]));
    const p = near.planarize();
    expect(p.n).toBe(8);
    expect(p.degree(6)).toBe(4);
    expect(p.degree(7)).toBe(4);
    // three lines through one point: proven by the third pairwise event
    let star = append(seg([0, 0], [10, 10]), seg([0, 10], [10, 0]));
    star = append(star, seg([5, 0], [5, 10]));
    expect(star.planarize().degree(6)).toBe(6);
    // a crossing at a vertex that lies on both edges joins that vertex
    let through = append(seg([0, 0], [10, 0]), seg([5, -5], [5, 5]));
    through = append(through, seg([5, 0], [9, 9])); // its endpoint (5,0) lies on both
    const pt = through.planarize();
    expect(pt.n).toBe(6);
    expect(pt.degree(4)).toBe(5);
  });

  it('3. faces are translation invariant at large coordinate offsets', () => {
    for (const off of [0, 1e6, 1e8]) {
      const sq = square(off, off, 1);
      const cells = sq.faces();
      expect(cells.length).toBe(1);
      expect(cells.faces[0].area).toBeCloseTo(1, 6);
      expect(cells.faces[0].perimeter).toBeCloseTo(4, 6);
      const nested = append(square(off, off, 30), square(off + 10, off + 10, 10)).faces();
      expect(nested.faces.map((f) => +f.area.toFixed(3)).sort((p, q) => p - q)).toEqual([100, 800]);
    }
  });

  it('4. holes touching at a corner are separate contours, in faces and in boundaries', () => {
    let m = append(square(0, 0, 40), square(10, 10, 10));
    m = append(m, square(20, 20, 10)); // touches the first inner square at (20,20)
    const p = m.planarize();
    const cells = p.faces();
    expect(cells.length).toBe(3);
    const outer = cells.faces.find((f) => f.area === 1400)!;
    expect(outer.contours).toHaveLength(3);
    for (const c of outer.contours) expect(c.pts).toHaveLength(4);
    const sel = cells.filter((f) => f.area === 1400);
    const b = sel.boundaries();
    expect(b).toHaveLength(3);
    for (const c of b) expect(c.pts).toHaveLength(4);
  });

  it('5. face views are deeply frozen', () => {
    const f = square().faces().faces[0];
    expect(Object.isFrozen(f.contours)).toBe(true);
    expect(Object.isFrozen(f.contours[0])).toBe(true);
    expect(Object.isFrozen(f.contours[0].pts)).toBe(true);
    expect(Object.isFrozen(f.contours[0].pts[0])).toBe(true);
    expect(Object.isFrozen(f.bounds)).toBe(true);
    expect(() => { (f.contours[0].pts[0] as number[])[0] = 99; }).toThrow();
  });
});

describe('faces: the planarity check reads positions and pairs exactly', () => {
  it('duplicate edges and coincident vertices are still refused, −0 counts as 0', () => {
    const dup = material([[0, 0], [10, 0], [10, 10]], { edges: [[0, 1], [1, 2], [1, 0]] });
    expect(() => faces(dup)).toThrow(/duplicate edge 2/);
    const twice = material([[0, 0], [10, 0], [10, 0], [10, 10]], { edges: [[0, 1], [2, 3]] });
    expect(() => faces(twice)).toThrow(/vertices 1 and 2 coincide but are distinct/);
    // -0 and 0 are one position, as they were when the key was a string
    const negZero = material([[-0, 5], [10, 5], [0, 5], [10, 9]], { edges: [[0, 1], [2, 3]] });
    expect(() => faces(negZero)).toThrow(/vertices 0 and 2 coincide but are distinct/);
  });

  it('tens of thousands of distinct positions never collide into a false coincidence', () => {
    // one short segment per cell of a wide lattice: nothing crosses, nothing
    // coincides, and the position map is asked 40 000 times
    const pts: [number, number][] = [];
    const eds: [number, number][] = [];
    let s = 99;
    const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647);
    for (let i = 0; i < 20000; i++) {
      const x = (i % 200) * 10 + rnd();
      const y = Math.floor(i / 200) * 10 + rnd();
      pts.push([x, y], [x + 1 + rnd(), y + 1 + rnd()]);
      eds.push([2 * i, 2 * i + 1]);
    }
    const wide = material(pts, { edges: eds });
    expect(wide.n).toBe(40000);
    expect(faces(wide).faces).toHaveLength(0);
  });
});
