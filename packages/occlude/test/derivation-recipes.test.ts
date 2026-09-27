import { describe, expect, it } from 'vitest';
import { circle, curve, material, rect, type Edge, type Vertex } from '../src/index.js';
import { nodeOf } from '../src/derivation.js';
import { inSpace, mapPositions, withFaces } from '../src/material.js';
import { extractRows } from '../src/relation.js';
import { restamp } from '../src/tables.js';
import { spaceOf } from '../src/space.js';
import type { Selection } from '../src/selection.js';
import { toolkit } from './helpers/run.js';

// `source` is typed by the view; a test reads it as what it is.
const edgeOf = (v: object): Edge | undefined => (v as { source?: unknown }).source as Edge | undefined;
const edgesOf = (v: object): Selection<Edge> | undefined => (v as { source?: unknown }).source as Selection<Edge> | undefined;

/** Does `p` lie on the segment of `e` (to rounding)? */
const onEdge = (p: { x: number; y: number }, e: Edge): boolean => {
  const ax = e.a.x; const ay = e.a.y; const bx = e.b.x; const by = e.b.y;
  const cross = (bx - ax) * (p.y - ay) - (by - ay) * (p.x - ax);
  const dot = (p.x - ax) * (bx - ax) + (p.y - ay) * (by - ay);
  const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
  return Math.abs(cross) / Math.sqrt(len2) < 1e-9 && dot >= -1e-9 && dot <= len2 + 1e-9;
};

const square = () => curve([[0, 0], [40, 0], [40, 40], [0, 40]], { closed: true });

describe('split and replace: a made row names the edge it came from', () => {
  it('split: the new point and both children name the parent edge of the value split was given', () => {
    const g = square();
    const cut = g.split(g.edges.at(1)!);
    const made = cut.points.at(-1)!;
    expect(edgeOf(made)).toBe(g.edges.at(1));
    const children = cut.edges.filter((e) => e.a === made || e.b === made);
    expect(children.length).toBe(2);
    children.forEach((e) => expect(edgeOf(e)).toBe(g.edges.at(1)));
    // A row split did not make says nothing new.
    expect(edgeOf(cut.points.at(0)!)).toBeUndefined();
    expect(edgeOf(cut.edges.at(0)!)).toBeUndefined();
    expect(nodeOf(cut)?.op).toBe('split');
    // A set and a move of the result keep it.
    const moved = cut.move([1, 1]).points.set('w', 3);
    expect(edgeOf(moved.points.at(-1)!)).toBe(g.edges.at(1));
  });

  it('a row keeps what it answered before: a sample split still answers u and its source', () => {
    const t = toolkit({ aspect: [1, 1] });
    const ring = t.sample(t.material(circle([50, 50], 20)).curves.at(0)!, { count: 12 });
    const cut = ring.split(ring.edges.at(0)!);
    // An old point: the sample's own answers.
    expect(cut.points.at(3)!.u).toBe(ring.points.at(3)!.u);
    expect(cut.points.at(3)!.source).toBe(ring.points.at(3)!.source);
    // The new point: the split's.
    expect(edgeOf(cut.points.at(-1)!)).toBe(ring.edges.at(0));
    expect(cut.points.at(-1)!.u).toBeUndefined();
  });

  it('replace: every motif point and every new edge names the edge it replaced', () => {
    const g = square();
    const motif = curve([[0, 0], [1, 0], [1.5, 0.8], [2, 0], [3, 0]]);
    const koch = g.replace(g.edges.at(0)!, motif);
    const made = koch.points.filter((p) => p.index >= g.points.length);
    expect(made.length).toBe(3);
    made.forEach((p) => expect(edgeOf(p)).toBe(g.edges.at(0)));
    const pieces = koch.edges.filter((e) => edgeOf(e) !== undefined);
    expect(pieces.length).toBe(4);
    expect(edgeOf(koch.points.at(0)!)).toBeUndefined();
  });
});

describe('planarize: a piece names its edge, a crossing the edges that meet there', () => {
  it('two crossing lines', () => {
    const g = material([[0, 0], [10, 10], [0, 10], [10, 0]], { edges: [[0, 1], [2, 3]] });
    const p = g.planarize();
    expect(p.points.length).toBe(5);
    const crossing = p.points.at(4)!;
    const meet = edgesOf(crossing)!;
    expect(meet.length).toBe(2);
    expect([...meet]).toEqual([g.edges.at(0), g.edges.at(1)]);
    // A vertex that survives is the vertex it was, and says nothing new.
    expect(p.points.at(0)!.source).toBeUndefined();
    p.edges.forEach((e) => {
      expect(onEdge(e.a, edgeOf(e)!) && onEdge(e.b, edgeOf(e)!)).toBe(true);
    });
    expect(p.edges.filter((e) => edgeOf(e) === g.edges.at(0)).length).toBe(2);
    expect(p.edges.filter((e) => edgeOf(e) === g.edges.at(1)).length).toBe(2);
  });
});

describe('resample and along: the edge under each point, and u', () => {
  it('resample of a ring: u runs k/count round it, each point on the edge it names', () => {
    const g = square();
    const r = g.resample({ count: 8 });
    expect(r.points.map((p) => p.u)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((k) => k / 8));
    r.points.forEach((p) => {
      expect(g.edges.has(edgeOf(p)!)).toBe(true);
      expect(onEdge(p, edgeOf(p)!)).toBe(true);
    });
    // A new edge names the edge under its middle.
    r.edges.forEach((e) => expect(g.edges.has(edgeOf(e)!)).toBe(true));
  });

  it('a resample of part of a chain: the run names its edges, a kept vertex keeps what it had', () => {
    const g = curve([[0, 0], [10, 0], [20, 0], [30, 0], [40, 0]]);
    const r = g.resample({ count: 5, where: g.edges.filter((e) => e.index >= 2) });
    // The run starts at x = 20: its first sample is the kept vertex there.
    const start = r.points.find((p) => p.x === 20)!;
    expect(start.u).toBeCloseTo(0.5, 12);
    expect(edgeOf(start)).toBe(g.edges.at(2));
    expect(r.points.find((p) => p.x === 40)!.u).toBeCloseTo(1, 12);
    expect(r.points.at(0)!.u).toBeUndefined();
  });

  it('along: a point names the edge it lies on; a selection answers rows of its own material', () => {
    const g = square();
    const a = g.along({ count: 8 });
    // Samples at the middles lie on one edge each; every one on its own.
    expect(a.points.filter((p) => p.index % 2 === 1).map((p) => edgeOf(p))).toEqual([g.edges.at(0), g.edges.at(1), g.edges.at(2), g.edges.at(3)]);
    a.points.forEach((p) => expect(onEdge(p, edgeOf(p)!)).toBe(true));
    const two = g.edges.filter((e) => e.index >= 2);
    const b = two.along({ count: 3 });
    b.points.forEach((p) => expect(two.has(edgeOf(p)!)).toBe(true));
    const c = two.resample({ count: 3 });
    c.points.forEach((p) => expect(two.has(edgeOf(p)!)).toBe(true));
  });

  it('t.sample of a material is its resample in the run\'s space: source and u', () => {
    const t = toolkit({ aspect: [1, 1] });
    const box = t.material(rect(10, 10, 40, 40));
    const s = t.sample(box, { count: 8 });
    expect(s.points.map((p) => p.u)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((k) => k / 8));
    s.points.forEach((p) => expect(box.edges.has(edgeOf(p)!)).toBe(true));
  });
});

describe('identity-keeping rebuilds carry what the rows answer', () => {
  it('inSpace, withFaces, mapPositions, transform and extractRows', () => {
    const g = square();
    const cut = g.split(g.edges.at(1)!);
    const made = (m: { points: Selection<Vertex> }) => edgeOf(m.points.at(-1)!);
    const disk = spaceOf({ curvature: -1e-4, center: [20, 20] });
    expect(made(inSpace(cut, disk))).toBe(g.edges.at(1));
    expect(made(withFaces(cut, { cycles: [] }))).toBe(g.edges.at(1));
    expect(made(mapPositions(cut, (p) => [p.x + 1, p.y], 'test'))).toBe(g.edges.at(1));
    expect(made(cut.translate([3, 4]))).toBe(g.edges.at(1));
    const t = toolkit({ aspect: [1, 1] });
    expect(made(cut.transform(t.placement([5, 5], 30)))).toBe(g.edges.at(1));
    const ex = extractRows(cut, [...cut.points.map((p) => p.index)], [...cut.edges.map((e) => e.index)]);
    expect(made(ex)).toBe(g.edges.at(1));
  });
});

describe('a run keeps what its start answered, and drops what a pass derived', () => {
  it('restamp with the start keeps the start\'s links only', () => {
    const t = toolkit({ aspect: [1, 1] });
    const beads = t.sample(t.material(circle([50, 50], 20)).curves.at(0)!, { count: 12 });
    const grown = beads.split(beads.edges.at(0)!);
    const next = restamp(grown, 1, [], beads);
    // The start's answers are kept for the rows the start had.
    expect(next.points.at(2)!.u).toBe(beads.points.at(2)!.u);
    // The split's are gone: they named a state the run held for one pass.
    expect(next.points.at(-1)!.source).toBeUndefined();
    // Without a start, a restamp is a write: everything carries.
    expect(edgeOf(restamp(grown, 1).points.at(-1)!)).toBe(beads.edges.at(0));
  });

  it('t.steps of splits: a pass reads its splits\' sources, and the result the start\'s', () => {
    const t = toolkit({ aspect: [1, 1] });
    const beads = t.sample(t.material(circle([50, 50], 20)).curves.at(0)!, { count: 12 });
    const seen: boolean[] = [];
    const run = t.steps(4, beads, (g) => {
      const cut = g.split(g.edges.at(0)!);
      seen.push(edgeOf(cut.points.at(-1)!) === g.edges.at(0));
      return cut;
    });
    expect(seen).toEqual([true, true, true, true]);
    expect(run.points.at(5)!.u).toBe(beads.points.at(5)!.u);
    expect(run.points.at(-1)!.source).toBeUndefined();
  });

  it('a long run of splits does not hold the states it passed through', async () => {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (gc === undefined) return;
    const t = toolkit({ aspect: [1, 1] });
    let early: WeakRef<object> | undefined;
    t.steps(40, square(), (g) => {
      const cut = g.split(g.edges.at(0)!);
      if (early === undefined && g.points.length > 8) early = new WeakRef(g);
      return cut;
    });
    gc();
    await new Promise((r) => setTimeout(r, 10));
    gc();
    expect(early?.deref()).toBeUndefined();
  });
});
