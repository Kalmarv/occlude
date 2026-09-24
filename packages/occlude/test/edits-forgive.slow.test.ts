/**
 * Edits as values, acceptance 3 and 5: the fold never throws on data, and
 * what it drops does not depend on the order of the list.
 *
 * A seeded random rule asks for every op; a seeded random stage then does
 * to the list what a mutation would: it points references at ids of this
 * state, of an earlier one, of a later one and of an unrelated material,
 * and at new points' records it has dropped; it duplicates, drops and
 * reorders records; it makes moves, parameters and columns not finite; and
 * it pairs a removal with a move and a disconnection with a split. The
 * state that lands must be valid, every reason one of seven, and the same
 * list in another order must drop the same records and land the same
 * state.
 *
 * Three rules keep order in a batch on purpose — the last `set` of a
 * column wins, the first `connect` of a pair keeps its columns, and new
 * points keep the order they were asked in. The random rule writes one
 * value per column per step, so the first two cannot show; new points are
 * compared by what they are rather than by the row or id they got. Which
 * of two equal asks is the `already` one is the one order decides, so
 * `already` drops are counted per op.
 */

import { describe, expect, it } from 'vitest';
import { curve, type Material, type Next, type Edit, type PointRef, type EdgeRef, type PointId, type EdgeId, type Dropped, type ChildInterval, type Edge } from '../src/material.js';
import { plane, box, type Edit3, type Dropped3, type Mesh, type MeshEdit } from '../src/three/api/index.js';

const REASONS = new Set(['gone', 'self', 'already', 'removed', 'disconnected', 'conflict', 'not-finite']);

/** xorshift: one stream per seed. */
const rng = (seed: number) => {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
};
const shuffle = <T,>(xs: T[], r: () => number): T[] => {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/** A child edge's share of its parent: one function, so two splits that name it agree. */
const share = (e: Edge, c: ChildInterval) => ({ w: e.attrs.w * c.fraction });

/** A rule over every op the batch knows. Columns are written one value per step. */
function randomRule(r: () => number) {
  return (cur: Material, next: Next, k: number) => {
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
    const pts = [...cur.points];
    const eds = [...cur.edges];
    const made: PointRef[] = [];
    const point = (): PointRef => (made.length > 0 && r() < 0.3 ? pick(made) : r() < 0.5 ? pick(pts) : pick(pts).id);
    const edge = (): EdgeRef => (r() < 0.5 ? pick(eds) : pick(eds).id);
    const ops = 3 + Math.floor(r() * 7);
    for (let i = 0; i < ops; i++) {
      const op = Math.floor(r() * 13);
      if (pts.length === 0 && op !== 5) continue;
      if (eds.length === 0 && [4, 7, 9, 11, 12].includes(op)) continue;
      switch (op) {
        case 0: next.move(point(), [r() - 0.5, r() - 0.5]); break;
        case 1: next.move(cur.points.filter(() => r() < 0.3), () => [r() - 0.5, r() - 0.5]); break;
        case 2: next.set(point(), { age: k }); break;
        case 3: next.set(cur.points.filter(() => r() < 0.2), { age: k }); break;
        case 4: next.setEdge(edge(), { w: k + 0.5 }); break;
        case 5: made.push(next.addPoint([r() * 100, r() * 100], { age: r() })); break;
        case 6: next.connect(point(), point(), { w: k }); break;
        case 7: next.disconnect(edge()); break;
        case 8: next.remove(point()); break;
        case 9: made.push(next.split(edge(), {
          at: pick([0, 0.25, 0.5, 0.75, 1]),
          ...(r() < 0.3 ? { point: { age: pick([1, 2]) } } : {}),
          ...(r() < 0.3 ? { edges: r() < 0.5 ? share : { w: pick([1, 2]) } } : {}),
        })); break;
        case 10: next.extrude(pick(pts), (p) => ({ position: [p.x + r() - 0.5, p.y + r() - 0.5], attributes: { age: r() }, edgeAttributes: { w: k } })); break;
        case 11: next.splitEdges(cur.edges.filter(() => r() < 0.1), { at: pick([0.25, 0.5]) }); break;
        case 12: next.setEdges(cur.edges.filter(() => r() < 0.2), { w: k + 0.5 }); break;
      }
    }
  };
}

/** Ids a reference can be pointed at, from every kind of state. */
interface Pools { earlierPoints: number[]; earlierEdges: number[]; unrelatedPoints: number[]; unrelatedEdges: number[]; staleRecords: Edit[]; maxId: number }

/** A stage that mutates the list. */
function randomStage(r: () => number, pools: Pools, keep: (list: Edit[]) => void) {
  return (cur: Material, next: Next) => {
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
    const list = [...next.edits];
    const fresh = list.filter((e) => e.op === 'addPoint' || e.op === 'split');
    const pointTarget = (): PointRef => {
      const roll = Math.floor(r() * 6);
      if (roll === 0 && cur.n > 0) return cur.pointIds[Math.floor(r() * cur.n)] as PointId;
      if (roll === 1 && pools.earlierPoints.length > 0) return pick(pools.earlierPoints) as PointId;
      if (roll === 2) return (pools.maxId + 1 + Math.floor(r() * 40)) as PointId; // an id a later state mints
      if (roll === 3) return pick(pools.unrelatedPoints) as PointId;
      if (roll === 4 && fresh.length > 0) return pick(fresh) as PointRef;
      if (pools.staleRecords.length > 0) return pick(pools.staleRecords) as PointRef;
      return cur.n > 0 ? cur.points.at(0) : (pick(pools.unrelatedPoints) as PointId);
    };
    const edgeTarget = (): EdgeRef => {
      const roll = Math.floor(r() * 4);
      if (roll === 0 && cur.edgeCount > 0) return cur.edgeIds[Math.floor(r() * cur.edgeCount)] as EdgeId;
      if (roll === 1 && pools.earlierEdges.length > 0) return pick(pools.earlierEdges) as EdgeId;
      if (roll === 2) return (pools.maxId + 1 + Math.floor(r() * 40)) as EdgeId;
      return pick(pools.unrelatedEdges) as EdgeId;
    };
    const retarget = (e: Edit): Edit => {
      switch (e.op) {
        case 'move': case 'set': case 'remove': return { ...e, point: pointTarget() };
        case 'connect': return r() < 0.5 ? { ...e, a: pointTarget() } : { ...e, b: pointTarget() };
        case 'setEdge': case 'disconnect': case 'split': return { ...e, edge: edgeTarget() };
        default: return e;
      }
    };
    const nanify = (e: Edit): Edit => {
      switch (e.op) {
        case 'move': return { ...e, by: [NaN, 0] };
        case 'split': return { ...e, at: NaN };
        case 'addPoint': return r() < 0.5 ? { ...e, position: [0, NaN] } : { ...e, attrs: { ...e.attrs, age: NaN } };
        case 'set': case 'setEdge': return { ...e, attrs: Object.fromEntries(Object.keys(e.attrs).map((name) => [name, NaN])) };
        case 'connect': return { ...e, attrs: { w: NaN } };
        default: return e;
      }
    };
    let out: Edit[] = [];
    for (const e of list) {
      if (r() < 0.06) continue; // dropped, even an addPoint a join still names
      let x = e;
      if (r() < 0.15) x = retarget(x);
      if (r() < 0.05) x = nanify(x);
      out.push(x);
      if (r() < 0.05) out.push(x); // duplicated
      // A split asked again with other overrides: two definitions of one cut that disagree.
      if (x.op === 'split' && r() < 0.2) out.push({ ...x, point: { age: 3 }, edges: r() < 0.5 ? { w: 3 } : share });
      if (r() < 0.05) {
        // contradictions: a removal beside a move, a disconnection beside a split
        if (x.op === 'move' || x.op === 'set') out.push({ op: 'remove', point: x.point });
        if (x.op === 'split') out.push({ op: 'disconnect', edge: x.edge });
      }
    }
    if (r() < 0.3) out = shuffle(out, r);
    keep(out);
    return out;
  };
}

/** Every edge has two distinct live ends, no pair repeats, ids are unique, every number is finite. */
function expectValid(m: Material) {
  const pairs = new Set<string>();
  for (let e = 0; e < m.edgeCount; e++) {
    const a = m.edgeList[2 * e];
    const b = m.edgeList[2 * e + 1];
    expect(a).not.toBe(b);
    expect(a < m.n && b < m.n).toBe(true);
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    expect(pairs.has(key)).toBe(false);
    pairs.add(key);
  }
  expect(new Set(m.pointIds).size).toBe(m.n);
  expect(new Set(m.edgeIds).size).toBe(m.edgeCount);
  for (const col of [m.x, m.y, ...Object.values(m.attrs), ...Object.values(m.edgeAttrs)]) expect(col.every(Number.isFinite)).toBe(true);
}

/** The drops of a landing as a comparable value: by identity and reason,
 * except `already`, which is counted per op. */
function drops(list: readonly Dropped[], order: readonly Edit[]) {
  const index = new Map<Edit, number>();
  for (const e of order) if (!index.has(e)) index.set(e, index.size);
  const named: string[] = [];
  const already: Record<string, number> = {};
  for (const d of list) {
    expect(REASONS.has(d.reason)).toBe(true);
    if (d.reason === 'already') already[d.edit.op] = (already[d.edit.op] ?? 0) + 1;
    else named.push(`${index.get(d.edit) ?? `outside:${d.edit.op}`}:${d.reason}`);
  }
  return { named: named.sort(), already };
}

/** Two landings of one list from one state are the same state: the state's
 * own points by id, new points by what they are, edges by their ends. */
function expectSameState(before: Material, a: Material, b: Material) {
  const old = new Set(before.pointIds);
  const oldEdges = new Set(before.edgeIds);
  const names = a.attrNames;
  const rows = (m: Material) => {
    const own = new Map<number, number>();
    const fresh: number[] = [];
    for (let i = 0; i < m.n; i++) (old.has(m.pointIds[i]) ? own.set(m.pointIds[i], i) : fresh.push(i));
    return { own, fresh };
  };
  const ra = rows(a);
  const rb = rows(b);
  expect([...ra.own.keys()].sort()).toEqual([...rb.own.keys()].sort());
  const close = (i: number, j: number) => Math.abs(a.x[i] - b.x[j]) <= 1e-9 && Math.abs(a.y[i] - b.y[j]) <= 1e-9 && names.every((n) => a.attrs[n][i] === b.attrs[n][j]);
  for (const [id, i] of ra.own) expect(close(i, rb.own.get(id)!)).toBe(true);
  // New points: matched by position and columns.
  expect(ra.fresh.length).toBe(rb.fresh.length);
  const toB = new Map<number, number>();
  const used = new Set<number>();
  for (const i of ra.fresh) {
    const j = rb.fresh.find((j) => !used.has(j) && close(i, j));
    expect(j).toBeDefined();
    used.add(j!);
    toB.set(i, j!);
  }
  for (const [id, i] of ra.own) toB.set(i, rb.own.get(id)!);
  // Edges, by their ends in B's rows, their columns and their lineage.
  const edgeKey = (m: Material, e: number, row: (i: number) => number) => {
    const p = row(m.edgeList[2 * e]);
    const q = row(m.edgeList[2 * e + 1]);
    const root = m.edgeRoots[e];
    const id = m.edgeIds[e];
    return `${Math.min(p, q)}-${Math.max(p, q)}|${m.edgeAttrNames.map((n) => m.edgeAttrs[n][e]).join(',')}|${oldEdges.has(id) ? `id${id}` : oldEdges.has(root) ? `root${root}` : 'new'}`;
  };
  const ea = Array.from({ length: a.edgeCount }, (_, e) => edgeKey(a, e, (i) => toB.get(i)!)).sort();
  const eb = Array.from({ length: b.edgeCount }, (_, e) => edgeKey(b, e, (i) => i)).sort();
  expect(ea).toEqual(eb);
}

describe('the fold forgives, and in any order', () => {
  it('200 seeds × 50 steps: never throws, lands a valid state, drops by precedence alone', () => {
    const unrelated = curve([[0, 0], [5, 0], [5, 5], [0, 5]], { closed: true, age: 0 }).edgeAttribute('w', 0);
    let checked = 0;
    const seen: Record<string, number> = {};
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const pools: Pools = { earlierPoints: [], earlierEdges: [], unrelatedPoints: [...unrelated.pointIds], unrelatedEdges: [...unrelated.edgeIds], staleRecords: [], maxId: 0 };
      let m = curve(Array.from({ length: 10 }, (_, i) => [50 + 20 * Math.cos(i), 50 + 20 * Math.sin(i)] as [number, number]), { closed: true, age: 0 }).edgeAttribute('w', 0);
      const rule = randomRule(r);
      for (let k = 0; k < 50; k++) {
        pools.maxId = Math.max(pools.maxId, ...m.pointIds, ...m.edgeIds);
        let list: Edit[] = [];
        const a = m.steps(1, [rule, randomStage(r, pools, (l) => { list = l; })]);
        expectValid(a);
        // The same list, in another order, from the same state.
        const b = m.steps(1, () => shuffle(list, r));
        expectValid(b);
        expect(drops(b.dropped, list)).toEqual(drops(a.dropped, list));
        expectSameState(m, a, b);
        for (const d of a.dropped) seen[d.reason] = (seen[d.reason] ?? 0) + 1;
        pools.earlierPoints.push(...m.pointIds);
        pools.earlierEdges.push(...m.edgeIds);
        pools.staleRecords.push(...list.filter((e) => e.op === 'addPoint' || e.op === 'split').slice(0, 3));
        m = a;
        checked++;
      }
    }
    expect(checked).toBe(10000);
    // Every reason turned up: the stage reached every rule of the fold.
    expect(Object.keys(seen).sort()).toEqual([...REASONS].sort());
  });
});

describe('a mesh step forgives the same way', () => {
  // The sheet's column types widen through a step; the test reads them as numbers.
  type Sheet = Mesh<any, any, any, any>;
  const start = (): Sheet => plane(2, 2).subdivide(1)
    .attributes({ age: () => 0, v: () => [0, 0] as [number, number] })
    .edgeAttributes({ w: () => 0 })
    .faceAttributes({ h: () => 0 })
    .cornerAttributes({ c: () => 0 });

  it('50 seeds × 20 steps over its five ops: never throws, drops only gone and not-finite, in any order', () => {
    const other = box(3).attributes({ age: () => 0, v: () => [0, 0] as [number, number] });
    const seen: Record<string, number> = {};
    for (let seed = 1; seed <= 50; seed++) {
      const r = rng(seed);
      let m: Sheet = start();
      for (let k = 0; k < 20; k++) {
        let list: Edit3[] = [];
        const rule = (cur: Sheet, next: MeshEdit<any, any, any, any>) => {
          const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
          for (let i = 0; i < 6; i++) {
            switch (Math.floor(r() * 9)) {
              case 0: next.move(cur.points.filter(() => r() < 0.3), () => [r() - 0.5, r() - 0.5, r() - 0.5]); break;
              case 1: next.set(cur.points.filter(() => r() < 0.3), { age: k, v: [k, k] }); break;
              case 2: next.set(pick([...cur.points]), { age: k }); break;
              case 3: next.setEdges(cur.edges.filter(() => r() < 0.3), { w: k }); break;
              case 4: next.setEdge(pick([...cur.edges]), { w: k }); break;
              case 5: next.setFaces(cur.faces.filter(() => r() < 0.5), { h: k }); break;
              case 6: next.setFace(pick([...cur.faces]), { h: k }); break;
              case 7: next.setCorners(cur.corners.filter(() => r() < 0.3), { c: k }); break;
              case 8: next.setCorner(pick([...cur.corners]), { c: k }); break;
            }
          }
          let out: Edit3[] = [];
          for (const e of next.edits) {
            if (r() < 0.06) continue;
            let x: Edit3 = e;
            const roll = r();
            if (roll < 0.1) {
              // point the record at an id this revision lacks, a row of another mesh, or a string id here
              const field = e.op === 'move' || e.op === 'set' ? 'point' : e.op === 'setEdge' ? 'edge' : e.op === 'setFace' ? 'face' : 'corner';
              const target = r() < 0.3 ? `gone/${Math.floor(r() * 9)}` : field === 'point' && r() < 0.5 ? pick([...other.points]).id : (x as Record<string, unknown>)[field] as string | { id: string };
              x = { ...x, [field]: typeof target === 'string' ? target : target.id } as Edit3;
            } else if (roll < 0.15) {
              x = x.op === 'move' ? { ...x, by: [NaN, 0, 0] } : { ...x, attrs: Object.fromEntries(Object.entries(x.attrs).map(([n, v]) => [n, Array.isArray(v) ? [NaN, 0] : typeof v === 'number' ? NaN : v])) } as Edit3;
            }
            out.push(x);
            if (r() < 0.05) out.push(x);
          }
          if (r() < 0.3) out = shuffle(out, r);
          list = out;
          return out;
        };
        const a: Sheet = m.steps(1, rule as never);
        const b: Sheet = m.steps(1, () => shuffle(list, r));
        for (const g of [a, b]) {
          for (const p of g.points) {
            expect([p.x, p.y, p.z].every(Number.isFinite)).toBe(true);
            expect(Number.isFinite(p.age) && p.v.every(Number.isFinite)).toBe(true);
          }
          for (const d of g.dropped as readonly Dropped3[]) expect(['gone', 'not-finite']).toContain(d.reason);
        }
        const index = new Map(list.map((e, i) => [e, i]));
        const key = (ds: readonly Dropped3[]) => ds.map((d) => `${index.get(d.edit)}:${d.reason}`).sort();
        expect(key(b.dropped)).toEqual(key(a.dropped));
        for (const p of a.points) {
          const q = b.points.at(p.index)!;
          expect(Math.abs(p.x - q.x) + Math.abs(p.y - q.y) + Math.abs(p.z - q.z)).toBeLessThanOrEqual(1e-9);
          expect([q.age, ...q.v]).toEqual([p.age, ...p.v]);
        }
        expect(b.edges.map((e) => e.w)).toEqual(a.edges.map((e) => e.w));
        expect(b.faces.map((f) => f.h)).toEqual(a.faces.map((f) => f.h));
        expect(b.corners.map((c) => c.c)).toEqual(a.corners.map((c) => c.c));
        for (const d of a.dropped) seen[d.reason] = (seen[d.reason] ?? 0) + 1;
        m = a;
      }
    }
    expect(Object.keys(seen).sort()).toEqual(['gone', 'not-finite']);
  });

  it('a selection of an earlier revision is read by id, and skips the rows it has lost', () => {
    const whole = start();
    const part = whole.faces.filter((f) => f.centroid[0] < 0).extract();
    expect(part.points.length).toBeLessThan(whole.points.length);
    const moved = part.steps(1, (_cur, next) => next.move(whole.points as never, [0, 0, 1]));
    expect(moved.points.every((p) => p.z === 1)).toBe(true);
    // One row of the earlier revision that this one lost drops as gone.
    const lost = whole.points.find((p) => !part.points.some((q) => q.id === p.id))!;
    const one = part.steps(1, (_cur, next) => next.set(lost as never, { age: 5 }));
    expect(one.dropped.map((d) => [d.edit.op, d.reason])).toEqual([['set', 'gone']]);
    expect(one.points.every((p) => p.age === 0)).toBe(true);
  });
});
