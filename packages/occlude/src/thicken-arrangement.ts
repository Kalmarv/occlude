/** Analytical two-disc-hull union. All incidence, domain, ordering and
 * membership decisions consume the same algebraic supports. Floating point
 * enclosures are conservative search filters, never junction identity. */
import { Algebraic, Real, nextDown, nextUp } from './algebraic.js';
import { orient2d } from 'robust-predicates';
import { dyFrom, dyAdd, dySub, dyMul, dySign } from './dyadic.js';

export interface Envelope {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  ra: number;
  rb: number;
  va: number;
  vb: number;
  edge: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
export type Candidate = { vertex?: number; edge?: number; t?: number };
export interface BoundaryVertex {
  x: number;
  y: number;
  cands: Candidate[];
}
type Vec = [Real, Real];
interface Point {
  id: number;
  v: Vec;
}
interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
interface Base extends Box {
  id: number;
  events: Map<number, Point>;
  sources: number[];
}
interface Circle extends Base {
  kind: 'circle';
  c: Vec;
  r: Real;
  radius: number;
  vertices: number[];
}
interface Line extends Base {
  kind: 'line';
  n: Vec;
  h: Real;
  start: Point;
  end: Point;
  edges: number[];
  axis: 0 | 1;
  direction: number;
}
type Primitive = Circle | Line;
interface Hull extends Box {
  src: Envelope;
  a: Vec;
  b: Vec;
  ra: Real;
  rb: Real;
  d: Vec;
  dr: Real;
  A: Real;
}
interface Piece {
  prim: Primitive;
  start: Point;
  end: Point;
  owners: Primitive[];
}

export function analyticalUnion(
  inputs: readonly Envelope[],
  tolerance: number,
  provenance: boolean,
  diagnostic?: (stage: string, counts: Record<string, number>) => void,
): BoundaryVertex[][] {
  const k = new Algebraic(),
    n = (x: number) => k.number(x),
    two = n(2);
  const plus = (a: Vec, b: Vec): Vec => [k.add(a[0], b[0]), k.add(a[1], b[1])];
  const minus = (a: Vec, b: Vec): Vec => [k.sub(a[0], b[0]), k.sub(a[1], b[1])];
  const scale = (a: Vec, b: Real): Vec => [k.mul(a[0], b), k.mul(a[1], b)];
  const dot = (a: Vec, b: Vec) => k.add(k.mul(a[0], b[0]), k.mul(a[1], b[1]));
  const cross = (a: Vec, b: Vec) => k.sub(k.mul(a[0], b[1]), k.mul(a[1], b[0]));
  const turn = (a: Vec): Vec => [k.neg(a[1]), a[0]];
  const opposite = (a: Vec): Vec => [k.neg(a[0]), k.neg(a[1])];
  const equal = (a: Vec, b: Vec) =>
    k.cmp(a[0], b[0]) === 0 && k.cmp(a[1], b[1]) === 0;
  const points: Point[] = [],
    cells = new Map<string, Point[]>();
  function event(v: Vec): Point {
    const x0 = Math.floor(v[0].lo),
      x1 = Math.floor(v[0].hi),
      y0 = Math.floor(v[1].lo),
      y1 = Math.floor(v[1].hi);
    const small =
      Number.isSafeInteger(x0) &&
      Number.isSafeInteger(x1) &&
      Number.isSafeInteger(y0) &&
      Number.isSafeInteger(y1) &&
      (x1 - x0 + 1) * (y1 - y0 + 1) <= 16;
    const candidates: Point[] = [];
    if (small)
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
          candidates.push(...(cells.get(`${x},${y}`) ?? []));
    else candidates.push(...points);
    for (const p of candidates) if (equal(p.v, v)) return p;
    const p = { id: points.length, v };
    points.push(p);
    // Index all enclosure cells; an uncertain event must remain discoverable.
    if (small)
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++) {
          const key = `${x},${y}`;
          const list = cells.get(key) ?? [];
          list.push(p);
          cells.set(key, list);
        }
    else wide.push(p);
    return p;
  }
  const wide: Point[] = [];
  const at = (v: Vec): Point => {
    for (const p of wide) if (equal(p.v, v)) return p;
    return event(v);
  };
  const bounds = (a: Vec, b: Vec): Box => ({
    minX: Math.min(a[0].lo, b[0].lo),
    minY: Math.min(a[1].lo, b[1].lo),
    maxX: Math.max(a[0].hi, b[0].hi),
    maxY: Math.max(a[1].hi, b[1].hi),
  });
  const overlaps = (a: Box, b: Box) =>
    a.minX <= b.maxX &&
    b.minX <= a.maxX &&
    a.minY <= b.maxY &&
    b.minY <= a.maxY;
  const prims: Primitive[] = [],
    circles = new Map<string, Circle>(),
    lines = new Map<string, Line>();
  const hulls: Hull[] = inputs.map((src) => {
    const a: Vec = [n(src.ax), n(src.ay)],
      b: Vec = [n(src.bx), n(src.by)],
      d = minus(b, a),
      ra = n(src.ra),
      rb = n(src.rb),
      dr = k.sub(rb, ra);
    return {
      src,
      a,
      b,
      ra,
      rb,
      d,
      dr,
      A: k.sub(dot(d, d), k.square(dr)),
      minX: nextDown(src.minX),
      minY: nextDown(src.minY),
      maxX: nextUp(src.maxX),
      maxY: nextUp(src.maxY),
    };
  });
  function circle(
    c: Vec,
    r: Real,
    radius: number,
    row: number,
    source: number,
  ) {
    if (radius === 0) return;
    const key = `${c[0].approx},${c[1].approx},${radius}`;
    const old = circles.get(key);
    if (old) {
      if (!old.vertices.includes(row)) old.vertices.push(row);
      if (!old.sources.includes(source)) old.sources.push(source);
      return;
    }
    const p: Circle = {
      kind: 'circle',
      id: prims.length,
      c,
      r,
      radius,
      vertices: [row],
      sources: [source],
      events: new Map(),
      ...bounds(minus(c, [r, r]), plus(c, [r, r])),
    };
    // Cardinal events bound every arc interval by a quarter-circle. Samples
    // are then certified normalized sums of distinct endpoint directions.
    for (const v of [
      [r, k.zero],
      [k.zero, r],
      [k.neg(r), k.zero],
      [k.zero, k.neg(r)],
    ] as Vec[]) {
      const e = at(plus(c, v));
      p.events.set(e.id, e);
    }
    prims.push(p);
    circles.set(key, p);
  }
  for (let i = 0; i < hulls.length; i++) {
    const h = hulls[i],
      s = h.src;
    circle(h.a, h.ra, s.ra, s.va, i);
    circle(h.b, h.rb, s.rb, s.vb, i);
    if (k.sign(h.A) <= 0) continue;
    const root = k.sqrt(h.A),
      l2 = dot(h.d, h.d);
    for (const side of [-1, 1]) {
      const normal = scale(
        plus(scale(h.d, k.neg(h.dr)), scale(turn(h.d), k.mul(n(side), root))),
        k.div(k.one, l2),
      );
      let a = at(plus(h.a, scale(normal, h.ra))),
        b = at(plus(h.b, scale(normal, h.rb)));
      if (k.sign(dot(minus(b.v, a.v), turn(normal))) < 0) [a, b] = [b, a];
      const key = `${a.id}:${b.id}`,
        old = lines.get(key);
      if (old) {
        old.edges.push(i);
        old.sources.push(i);
        continue;
      }
      const axis: 0 | 1 =
        Math.abs(normal[0].approx) >= Math.abs(normal[1].approx) ? 1 : 0;
      const direction = k.sign(turn(normal)[axis]);
      const p: Line = {
        kind: 'line',
        axis,
        direction,
        id: prims.length,
        n: normal,
        h: k.add(dot(normal, h.a), h.ra),
        start: a,
        end: b,
        edges: [i],
        sources: [i],
        events: new Map([
          [a.id, a],
          [b.id, b],
        ]),
        ...bounds(a.v, b.v),
      };
      prims.push(p);
      lines.set(key, p);
    }
  }
  diagnostic?.('supports', { primitives: prims.length, events: points.length });
  // Exact angular order about +x, independent of atan2 and rounded angles.
  function angle(a: Vec, b: Vec): number {
    const half = (v: Vec) => {
      const y = k.sign(v[1]);
      return y < 0 || (y === 0 && k.sign(v[0]) < 0) ? 1 : 0;
    };
    const h = half(a) - half(b);
    return h || -k.sign(cross(a, b));
  }
  function lineOrder(p: Line, a: Point, b: Point): number {
    return k.cmp(a.v[p.axis], b.v[p.axis]) * p.direction;
  }
  function inDomain(p: Primitive, v: Vec): boolean {
    return (
      p.kind === 'circle' ||
      (k.cmp(v[p.axis], p.start.v[p.axis]) * p.direction >= 0 &&
        k.cmp(p.end.v[p.axis], v[p.axis]) * p.direction >= 0)
    );
  }
  // Support incidence follows from the exact construction formula. Only
  // finite domains need testing here; recomputing an already certified zero
  // polynomial wastes most of the cost of the algebraic fallback.
  function insert(a: Primitive, b: Primitive, v: Vec) {
    if (!inDomain(a, v) || !inDomain(b, v)) return;
    const e = at(v);
    a.events.set(e.id, e);
    b.events.set(e.id, e);
  }
  function intersect(a: Primitive, b: Primitive) {
    if (a.kind === 'line' && b.kind === 'line') {
      const det = cross(a.n, b.n);
      if (k.sign(det) === 0) {
        if (k.sign(k.sub(dot(a.n, b.start.v), a.h)) === 0)
          for (const p of [a.start, a.end, b.start, b.end]) insert(a, b, p.v);
        return;
      }
      insert(a, b, [
        k.div(k.sub(k.mul(a.h, b.n[1]), k.mul(b.h, a.n[1])), det),
        k.div(k.sub(k.mul(a.n[0], b.h), k.mul(b.n[0], a.h)), det),
      ]);
      return;
    }
    if (a.kind === 'circle' && b.kind === 'line') {
      intersect(b, a);
      return;
    }
    if (a.kind === 'line' && b.kind === 'circle') {
      const distance = k.sub(a.h, dot(a.n, b.c)),
        height2 = k.sub(k.square(b.r), k.square(distance));
      const s = k.sign(height2);
      if (s < 0) return;
      const foot = plus(b.c, scale(a.n, distance));
      if (s === 0) {
        insert(a, b, foot);
        return;
      }
      const offset = scale(turn(a.n), k.sqrt(height2));
      insert(a, b, plus(foot, offset));
      insert(a, b, minus(foot, offset));
      return;
    }
    if (a.kind === 'circle' && b.kind === 'circle') {
      const d = minus(b.c, a.c),
        d2 = dot(d, d);
      if (k.sign(d2) === 0) return;
      const sum = k.add(a.r, b.r),
        diff = k.sub(a.r, b.r),
        u = k.sub(k.square(sum), d2),
        v = k.sub(d2, k.square(diff));
      if (k.sign(u) < 0 || k.sign(v) < 0) return;
      const along = k.div(
        k.add(d2, k.sub(k.square(a.r), k.square(b.r))),
        k.mul(two, d2),
      );
      const foot = plus(a.c, scale(d, along)),
        height = k.mul(u, v);
      if (k.sign(height) === 0) {
        insert(a, b, foot);
        return;
      }
      const offset = scale(turn(d), k.div(k.sqrt(height), k.mul(two, d2)));
      insert(a, b, plus(foot, offset));
      insert(a, b, minus(foot, offset));
    }
  }
  const ordered = prims.slice().sort((a, b) => a.minX - b.minX || a.id - b.id);
  for (let i = 0; i < ordered.length; i++)
    for (
      let j = i + 1;
      j < ordered.length && ordered[j].minX <= ordered[i].maxX;
      j++
    )
      if (overlaps(ordered[i], ordered[j])) intersect(ordered[i], ordered[j]);
  diagnostic?.('intersections', {
    primitives: prims.length,
    events: points.length,
  });
  const pieces = new Map<string, Piece>();
  for (const p of prims) {
    const ev = [...p.events.values()].sort((a, b) =>
      p.kind === 'line'
        ? lineOrder(p, a, b)
        : angle(minus(a.v, p.c), minus(b.v, p.c)),
    );
    const count = p.kind === 'line' ? ev.length - 1 : ev.length;
    for (let i = 0; i < count; i++) {
      const a = ev[i],
        b = ev[(i + 1) % ev.length];
      if (a.id === b.id)
        throw new Error('thicken: repeated exact event in support partition');
      const key = `${p.kind === 'line' ? 'l' : `c${p.id}`}:${a.id}:${b.id}`;
      const old = pieces.get(key);
      if (old) old.owners.push(p);
      else pieces.set(key, { prim: p, start: a, end: b, owners: [p] });
    }
  }
  diagnostic?.('partition', { events: points.length, intervals: pieces.size });
  function rationalBetween(lo: Real, hi: Real): Real {
    let t = n((lo.approx + hi.approx) / 2);
    if (k.cmp(t, lo) > 0 && k.cmp(t, hi) < 0) return t;
    let a = n(-1),
      b = k.one;
    for (let step = 0; step < 2200; step++) {
      t = k.div(k.add(a, b), two);
      if (k.cmp(t, lo) <= 0) a = t;
      else if (k.cmp(t, hi) >= 0) b = t;
      else return t;
    }
    throw new Error('thicken: rational witness budget exceeded');
  }
  // Independent interval witnesses: no crossing-state extrapolation. Every
  // witness lies strictly between successive exact events on its support.
  function sample(pc: Piece): Vec {
    if (pc.prim.kind === 'line')
      return scale(plus(pc.start.v, pc.end.v), k.div(k.one, two));
    const p = pc.prim;
    let a = minus(pc.start.v, p.c),
      b = minus(pc.end.v, p.c);
    const flip = k.sign(k.add(a[0], b[0])) < 0;
    if (flip) {
      a = opposite(a);
      b = opposite(b);
    }
    const t0 = k.div(a[1], k.add(p.r, a[0])),
      t1 = k.div(b[1], k.add(p.r, b[0]));
    // Pick a rational stereographic parameter strictly inside the algebraic
    // interval. The resulting circle witness is rational too, keeping the
    // independent quadratic membership test free of constructed radicals.
    const t = rationalBetween(t0, t1);
    const t2 = k.square(t),
      den = k.add(k.one, t2);
    let v: Vec = [k.div(k.sub(k.one, t2), den), k.div(k.mul(two, t), den)];
    if (flip) v = opposite(v);
    return plus(p.c, scale(v, p.r));
  }
  type I = [number, number];
  const ia = (a: I, b: I): I => [nextDown(a[0] + b[0]), nextUp(a[1] + b[1])];
  const is = (a: I, b: I): I => [nextDown(a[0] - b[1]), nextUp(a[1] - b[0])];
  const im = (a: I, b: I): I => {
    const p = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]];
    return [nextDown(Math.min(...p)), nextUp(Math.max(...p))];
  };
  const ii = (v: Real): I => [v.lo, v.hi];
  const isig = (v: I) => (v[0] > 0 ? 1 : v[1] < 0 ? -1 : undefined);
  function filteredMembership(h: Hull, p: Vec): number | undefined {
    const qx = is(ii(p[0]), ii(h.a[0])),
      qy = is(ii(p[1]), ii(h.a[1]));
    const C = is(ia(im(qx, qx), im(qy, qy)), im(ii(h.ra), ii(h.ra)));
    const D = ia(
      ia(im(qx, ii(h.d[0])), im(qy, ii(h.d[1]))),
      im(ii(h.ra), ii(h.dr)),
    );
    const A = ii(h.A),
      end = ia(is(A, im([2, 2], D)), C);
    const c = isig(C),
      e = isig(end);
    if (c === -1 || e === -1) return -1;
    if (A[0] > 0 && D[0] > 0 && D[1] < A[0])
      return isig(is(im(A, C), im(D, D)));
    if (A[1] <= 0 || D[1] <= 0 || D[0] >= A[1])
      return c === 1 && e === 1 ? 1 : undefined;
    return undefined;
  }
  function membership(h: Hull, p: Vec): number {
    const filtered = filteredMembership(h, p);
    if (filtered !== undefined) return filtered;
    const q = minus(p, h.a),
      C = k.sub(dot(q, q), k.square(h.ra)),
      D = k.add(dot(q, h.d), k.mul(h.ra, h.dr));
    const a = k.sign(C);
    if (a < 0) return -1;
    const end = k.sign(k.add(k.sub(h.A, k.mul(two, D)), C));
    if (end < 0) return -1;
    if (k.sign(h.A) > 0 && k.sign(D) > 0 && k.cmp(D, h.A) < 0)
      return k.sign(k.sub(k.mul(h.A, C), k.square(D)));
    return Math.min(a, end);
  }
  const uniqueHulls: number[] = [],
    hullKeys = new Set<string>();
  for (let i = 0; i < hulls.length; i++) {
    const h = hulls[i].src,
      a = `${h.ax},${h.ay},${h.ra}`,
      b = `${h.bx},${h.by},${h.rb}`;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!hullKeys.has(key)) {
      hullKeys.add(key);
      uniqueHulls.push(i);
    }
  }
  const kept: Piece[] = [];
  for (const [key, pc] of pieces) {
    if (pc.prim.kind === 'line' && pieces.has(`l:${pc.end.id}:${pc.start.id}`))
      continue;
    const v = sample(pc),
      box = bounds(v, v);
    let covered = false;
    for (const hi of uniqueHulls) {
      const h = hulls[hi];
      if (
        pc.prim.kind === 'line' &&
        pc.owners.some((p) => p.sources.includes(hi))
      )
        continue;
      if (!overlaps(h, box)) continue;
      if (membership(h, v) < 0) {
        covered = true;
        break;
      }
    }
    if (!covered) kept.push(pc);
  }
  diagnostic?.('classified', { intervals: pieces.size, boundary: kept.length });
  function tangent(pc: Piece, end: boolean): Vec {
    const p = pc.prim;
    return p.kind === 'line'
      ? turn(p.n)
      : turn(minus((end ? pc.end : pc.start).v, p.c));
  }
  // DCEL boundary continuation: choose the clockwise outgoing germ from
  // the incoming twin. Curvature resolves equal tangents at point contacts.
  const outgoing = new Map<number, number[]>();
  for (let i = 0; i < kept.length; i++) {
    const id = kept[i].start.id;
    const list = outgoing.get(id) ?? [];
    list.push(i);
    outgoing.set(id, list);
  }
  const next = new Int32Array(kept.length).fill(-1),
    incoming = new Int32Array(kept.length);
  function clockwise(ref: Vec, a: Vec, b: Vec): number {
    // Coordinates in the frame (ref, clockwise-perpendicular(ref)).
    return angle(
      [dot(ref, a), k.neg(cross(ref, a))],
      [dot(ref, b), k.neg(cross(ref, b))],
    );
  }
  for (let i = 0; i < kept.length; i++) {
    const pc = kept[i],
      list = outgoing.get(pc.end.id);
    if (!list?.length)
      throw new Error(
        `thicken: exact arrangement has an open event ${pc.end.id}`,
      );
    const ref = opposite(tangent(pc, true));
    const candidates = list.slice().sort((ia, ib) => {
      const a = tangent(kept[ia], false),
        b = tangent(kept[ib], false);
      // A zero-angle reversal enters the opposite filled sector at an
      // external tangency. Prefer an actual turn before this last choice.
      const az = k.sign(cross(ref, a)) === 0 && k.sign(dot(ref, a)) > 0;
      const bz = k.sign(cross(ref, b)) === 0 && k.sign(dot(ref, b)) > 0;
      if (az !== bz) return az ? 1 : -1;
      const c = clockwise(ref, a, b);
      if (c) return c;
      const pa = kept[ia].prim,
        pb = kept[ib].prim;
      if (pa.kind !== pb.kind) return pa.kind === 'circle' ? -1 : 1;
      if (pa.kind === 'circle' && pb.kind === 'circle')
        return k.cmp(pa.r, pb.r);
      return ia - ib;
    });
    next[i] = candidates[0];
    incoming[next[i]]++;
  }
  for (let i = 0; i < incoming.length; i++)
    if (incoming[i] !== 1)
      throw new Error(
        `thicken: exact boundary successor is not a permutation at interval ${i}`,
      );
  const eventCands = new Map<number, Candidate[]>();
  const keyOf = (c: Candidate) =>
    c.vertex !== undefined ? `v${c.vertex}` : `e${c.edge}:${c.t}`;
  function candidates(p: Primitive, v: Vec): Candidate[] {
    if (p.kind === 'circle') return p.vertices.map((vertex) => ({ vertex }));
    return p.edges.map((i) => {
      const h = hulls[i];
      const t = k.div(k.add(dot(minus(v, h.a), h.d), k.mul(h.ra, h.dr)), h.A);
      return k.sign(t) <= 0
        ? { vertex: h.src.va }
        : k.cmp(t, k.one) >= 0
          ? { vertex: h.src.vb }
          : { edge: h.src.edge, t: k.numberOf(t) };
    });
  }
  if (provenance)
    for (const p of prims)
      for (const e of p.events.values()) {
        const cs = eventCands.get(e.id) ?? [];
        for (const c of candidates(p, e.v))
          if (!cs.some((x) => keyOf(x) === keyOf(c))) cs.push(c);
        eventCands.set(e.id, cs);
      }
  interface OutputPoint {
    point: Point;
    cands: Candidate[];
    piece: number;
  }
  let outputSerial = points.length;
  const exactLoops: OutputPoint[][] = [],
    used = new Uint8Array(kept.length);
  for (let i = 0; i < kept.length; i++) {
    if (used[i]) continue;
    const vertices: OutputPoint[] = [];
    let j = i;
    do {
      if (used[j])
        throw new Error(
          'thicken: exact successor traversal entered a different cycle',
        );
      used[j] = 1;
      const pc = kept[j];
      vertices.push({
        point: pc.start,
        cands: eventCands.get(pc.start.id) ?? [],
        piece: j,
      });
      if (pc.prim.kind === 'circle') {
        const p = pc.prim;
        let a = minus(pc.start.v, p.c),
          b = minus(pc.end.v, p.c);
        const flip = k.sign(k.add(a[0], b[0])) < 0;
        if (flip) {
          a = opposite(a);
          b = opposite(b);
        }
        const t0 = k.div(a[1], k.add(p.r, a[0])),
          t1 = k.div(b[1], k.add(p.r, b[0]));
        // θ=2 atan(t), so |dθ/dt|≤2. Rational parameter subdivision
        // bounds sagitta without making floating angles topological data.
        // Reserve half the tolerance for coordinate conversion below.
        const maxAngle = Math.min(
          Math.PI / 2,
          4 * Math.asin(Math.sqrt(Math.min(1, tolerance / (4 * p.radius)))),
        );
        const count = Math.max(1, Math.ceil((3 * (t1.hi - t0.lo)) / maxAngle));
        if (!Number.isFinite(count) || count > 1_000_000)
          throw new Error('thicken: arc tessellation budget exceeded');
        for (let step = 1; step < count; step++) {
          const delta = k.sub(t1, t0);
          const low = k.add(
            t0,
            k.mul(delta, k.div(n(4 * step - 1), n(4 * count))),
          );
          const high = k.add(
            t0,
            k.mul(delta, k.div(n(4 * step + 1), n(4 * count))),
          );
          const t = rationalBetween(low, high),
            t2 = k.square(t),
            den = k.add(k.one, t2);
          let v: Vec = [
            k.div(k.sub(k.one, t2), den),
            k.div(k.mul(two, t), den),
          ];
          if (flip) v = opposite(v);
          const point = { id: outputSerial++, v: plus(p.c, scale(v, p.r)) };
          vertices.push({
            point,
            cands: provenance ? p.vertices.map((vertex) => ({ vertex })) : [],
            piece: j,
          });
        }
      }
      j = next[j];
    } while (j !== i);
    exactLoops.push(vertices);
  }
  // Independent rounding can collapse a real, narrow hole to a doubled
  // line. Preserve exact coordinate order at export, moving only colliding
  // columns/rows to adjacent representable values. Distinct events are never
  // welded. The displacement is checked against the reserved export budget.
  const boundaryPoints = [
    ...new Map(
      exactLoops.flatMap((l) => l.map((v) => [v.point.id, v.point] as const)),
    ).values(),
  ];
  const exportCache = new Map<number, [number, number]>(
    boundaryPoints.map((p) => [p.id, [0, 0]]),
  );
  for (const axis of [0, 1] as const) {
    const sorted = boundaryPoints
      .slice()
      .sort((a, b) => k.cmp(a.v[axis], b.v[axis]));
    let previous = -Infinity,
      previousExact: Real | undefined;
    for (const p of sorted) {
      const value = p.v[axis];
      let coordinate =
        previousExact && k.cmp(value, previousExact) === 0
          ? previous
          : k.numberOf(value);
      if (
        previousExact &&
        k.cmp(value, previousExact) > 0 &&
        coordinate <= previous
      )
        coordinate = nextUp(previous);
      if (
        !Number.isFinite(coordinate) ||
        k.cmp(
          k.square(k.sub(n(coordinate), value)),
          k.square(k.div(n(tolerance), n(8))),
        ) > 0
      )
        throw new Error(
          'thicken: coordinate export cannot preserve event order within tolerance',
        );
      exportCache.get(p.id)![axis] = coordinate;
      previous = coordinate;
      previousExact = value;
    }
  }
  const loops = exactLoops.map((l) =>
    l.map((v) => {
      const [x, y] = exportCache.get(v.point.id)!;
      return { x, y, cands: v.cands };
    }),
  );
  // Validate the exported straight-edge embedding independently of the
  // analytical traversal. A correct arrangement alone does not certify its
  // rounded/tessellated Material representation.
  type Segment = Box & {
    a: BoundaryVertex;
    b: BoundaryVertex;
    start: number;
    end: number;
  };
  const segments: Segment[] = [];
  for (let li = 0; li < loops.length; li++) {
    const loop = loops[li],
      exact = exactLoops[li];
    let area = dyFrom(0),
      left = 0;
    const origin = loop[0],
      ox = dyFrom(origin.x),
      oy = dyFrom(origin.y);
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i],
        j = (i + 1) % loop.length,
        b = loop[j];
      area = dyAdd(
        area,
        dySub(
          dyMul(dySub(dyFrom(a.x), ox), dySub(dyFrom(b.y), oy)),
          dyMul(dySub(dyFrom(b.x), ox), dySub(dyFrom(a.y), oy)),
        ),
      );
      const order = k.cmp(exact[i].point.v[0], exact[left].point.v[0]);
      if (
        order < 0 ||
        (order === 0 && k.cmp(exact[i].point.v[1], exact[left].point.v[1]) < 0)
      )
        left = i;
      segments.push({
        a,
        b,
        start: exact[i].point.id,
        end: exact[j].point.id,
        minX: Math.min(a.x, b.x),
        maxX: Math.max(a.x, b.x),
        minY: Math.min(a.y, b.y),
        maxY: Math.max(a.y, b.y),
      });
    }
    // Compare the embedding before/after coordinate conversion using the
    // exact convex turn at its lexicographic extremum. Tangent direction
    // alone is insufficient at a sharp hole corner.
    const center = exact[left].point.v,
      prior = exact[(left + exact.length - 1) % exact.length].point.v;
    let orientation = 0;
    for (let step = 1; step < exact.length && !orientation; step++)
      orientation = k.sign(
        cross(
          minus(center, prior),
          minus(exact[(left + step) % exact.length].point.v, center),
        ),
      );
    if (!orientation || dySign(area) !== orientation)
      throw new Error('thicken: boundary export changed loop orientation');
  }
  const orientation = (
    a: BoundaryVertex,
    b: BoundaryVertex,
    c: BoundaryVertex,
  ): number => {
    const value = orient2d(a.x, a.y, b.x, b.y, c.x, c.y);
    if (Number.isFinite(value) && value !== 0) return Math.sign(value);
    const ax = dySub(dyFrom(a.x), dyFrom(c.x)),
      ay = dySub(dyFrom(a.y), dyFrom(c.y));
    const bx = dySub(dyFrom(b.x), dyFrom(c.x)),
      by = dySub(dyFrom(b.y), dyFrom(c.y));
    // robust-predicates uses the opposite sign of the usual determinant.
    return -dySign(dySub(dyMul(ax, by), dyMul(ay, bx)));
  };
  segments.sort((a, b) => a.minX - b.minX);
  for (let i = 0; i < segments.length; i++)
    for (
      let j = i + 1;
      j < segments.length && segments[j].minX <= segments[i].maxX;
      j++
    ) {
      const a = segments[i],
        b = segments[j];
      if (!overlaps(a, b)) continue;
      const shared =
        a.start === b.start ||
        a.start === b.end ||
        a.end === b.start ||
        a.end === b.end;
      const ab0 = orientation(a.a, a.b, b.a),
        ab1 = orientation(a.a, a.b, b.b);
      const ba0 = orientation(b.a, b.b, a.a),
        ba1 = orientation(b.a, b.b, a.b);
      if (
        ab0 === 0 &&
        ab1 === 0 &&
        (Math.max(a.minX, b.minX) < Math.min(a.maxX, b.maxX) ||
          Math.max(a.minY, b.minY) < Math.min(a.maxY, b.maxY))
      )
        throw new Error(
          'thicken: boundary export introduced overlapping intervals',
        );
      const opposite = (a: number, b: number) =>
        (a < 0 && b > 0) || (a > 0 && b < 0);
      if (opposite(ab0, ab1) && opposite(ba0, ba1))
        throw new Error('thicken: boundary export introduced a crossing');
      const between = (p: BoundaryVertex, s: Segment) =>
        p.x >= s.minX && p.x <= s.maxX && p.y >= s.minY && p.y <= s.maxY;
      if (
        !shared &&
        ((ab0 === 0 && between(b.a, a)) ||
          (ab1 === 0 && between(b.b, a)) ||
          (ba0 === 0 && between(a.a, b)) ||
          (ba1 === 0 && between(a.b, b)))
      )
        throw new Error('thicken: boundary export introduced a contact');
    }
  return loops;
}
