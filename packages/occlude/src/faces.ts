/**
 * Planarization, faces and boundaries over a material's sampled edges.
 *
 * `planarize(m)` makes every crossing and endpoint-on-edge contact a shared
 * vertex — explicitly, because the author asked. `faces(m)` reads the
 * bounded regions of an already planar material as derived data of that
 * one state: a face view has an area, a perimeter, bounds and closed
 * contours the drawing operations accept. Face selections pick faces by
 * measurement with the same fixed-membership rules as point and edge
 * selections, and `boundaries()` outlines the union of selected faces
 * with the walls between them removed.
 *
 * Numerical policy (material coordinates, straight segments, no paper
 * units or nib tolerances): orientation is decided EXACTLY with
 * `orient2d` from robust-predicates (Shewchuk's adaptive predicate, public
 * domain), so "crosses", "touches" and "collinear" are never a matter of
 * epsilon. Intersection positions are computed in floating point; the
 * ONE tolerance is event consolidation, and it only ever joins events
 * that are PROVEN to be one point: two crossings A×B and A×C within
 * EVENT_TOL (1e-9) in parameter on A are one event when B×C exists at the
 * matching parameters too (three lines through a point), and a crossing
 * A×B joins a vertex V lying exactly on A when V lies exactly on B as
 * well. Anything else that merely comes close stays distinct; if two
 * distinct events land on identical coordinates the input is rejected as
 * numerically ambiguous. Coincident endpoints merge only when their
 * coordinates are exactly equal; nearby is not coincident and gaps stay
 * gaps.
 *
 * Complexity: intersection uses a sweep over x-sorted edge boxes, so it is
 * O(E log E + P) for P box-overlapping pairs — O(E²) when everything
 * overlaps everything. Face discovery is O(E log E) for the angular sort
 * plus O(H · F · L) for assigning H outer boundaries of nested components
 * to F faces of walk length L. Measured numbers are in the docs.
 */

import { orient2d } from 'robust-predicates';
import { mintIds, Material, inheritEdge, ownedBy, viewKind, viewProto, type ChildInterval, type Edge, type FaceColumn, type PointsLike } from './material.js';
import type { XY } from './vec.js';
import { groupRows, EdgeSelection, PointSelection } from './relation.js';
import { contourMoment, measureFaces, type FaceMeasurements, type MeasureOpts } from './measure.js';
import type { IsoContour } from './isolines.js';

const EVENT_TOL = 1e-9;

// ---- planarize ----------------------------------------------------------------------

/** One proposed set of point attributes at an intersection event. */
export interface EventCandidate {
  /** Source vertex row when the candidate IS an existing endpoint. */
  vertex?: number;
  /** Source edge row and parameter (stored a → b) when interpolated along an edge. */
  edge?: number;
  t?: number;
  attrs: Record<string, number>;
}

export interface PlanarEvent {
  position: [number, number];
  /** Deterministic: by source vertex row, then by source edge row. */
  candidates: EventCandidate[];
}

export interface PlanarizeOpts {
  /** Resolve competing point attributes at an event: the returned record
   * overrides. Required only where candidates disagree. */
  point?: (event: PlanarEvent) => Record<string, number>;
  /** Edge attributes for each child interval, merged over the parent's;
   * called once per final child, an unsplit edge with fraction 1. */
  edges?: (parent: Edge, child: ChildInterval) => Record<string, number>;
}

interface Seg { a: number; b: number; ax: number; ay: number; bx: number; by: number; row: number }

/** Pairs of edges whose boxes overlap, by an x-sweep. Each pair once, i < j.
 * The boxes are laid out in columns first: the sweep reads them thousands of
 * times each, and the order is a total one (least box-left, then row), so the
 * pairs and their order do not depend on the sort. */
function boxPairs(segs: Seg[], visit: (i: number, j: number) => void): void {
  const n = segs.length;
  const lox = new Float64Array(n);
  const hix = new Float64Array(n);
  const loy = new Float64Array(n);
  const hiy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = segs[i];
    lox[i] = Math.min(s.ax, s.bx);
    hix[i] = Math.max(s.ax, s.bx);
    loy[i] = Math.min(s.ay, s.by);
    hiy[i] = Math.max(s.ay, s.by);
  }
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((p, q) => lox[p] - lox[q] || p - q);
  for (let oi = 0; oi < n; oi++) {
    const i = order[oi];
    const maxx = hix[i];
    const miny = loy[i];
    const maxy = hiy[i];
    for (let oj = oi + 1; oj < n; oj++) {
      const j = order[oj];
      if (lox[j] > maxx) break;
      if (loy[j] > maxy || hiy[j] < miny) continue;
      visit(i < j ? i : j, i < j ? j : i);
    }
  }
}

// Exact coincidence of two positions without a string key per endpoint: hash
// the bit patterns, then compare the coordinates themselves. Callers run
// `validate` first, so coordinates are finite; 0 and −0 hash together because
// `===` calls them one position, as the string key did.
const hashBuf = new Float64Array(2);
const hashBits = new Int32Array(hashBuf.buffer);
export function positionHash(x: number, y: number): number {
  hashBuf[0] = x === 0 ? 0 : x;
  hashBuf[1] = y === 0 ? 0 : y;
  let h = Math.imul(hashBits[0], 0x9e3779b1) ^ Math.imul(hashBits[1], 0x85ebca6b)
    ^ Math.imul(hashBits[2], 0xc2b2ae35) ^ Math.imul(hashBits[3], 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  return (h ^ (h >>> 13)) | 0;
}

type Event =
  | { kind: 'cross'; i: number; ti: number; j: number; tj: number; x: number; y: number }
  | { kind: 'contact'; vertex: number; edge: number; t: number };

/**
 * Do two EXACTLY collinear segments share a positive length?
 *
 * Exact, and the caller must have proven collinearity first (`orient2d` of
 * both of the second segment's ends against the first is zero). Collinear
 * points are ordered by x, or by y when the line is vertical — that
 * ordering is the line's own, so the four comparisons below are the answer,
 * with nothing rounded. The normalised parameter this replaces divides by
 * the segment length, which rounds a one-ulp overlap into a touch: merge
 * then leaves the overlap in place and planarize splits two spans that
 * share a sliver of ink. Coordinates rather than records, as `orient2d`
 * takes them, so the two kernels' own segment shapes stay out of it.
 */
export function overlapSpan(
  sax: number, say: number, sbx: number, sby: number,
  uax: number, uay: number, ubx: number, uby: number,
): boolean {
  const byY = sax === sbx; // vertical line: x cannot order it
  const slo = byY ? Math.min(say, sby) : Math.min(sax, sbx);
  const shi = byY ? Math.max(say, sby) : Math.max(sax, sbx);
  const ulo = byY ? Math.min(uay, uby) : Math.min(uax, ubx);
  const uhi = byY ? Math.max(uay, uby) : Math.max(uax, ubx);
  return Math.min(shi, uhi) > Math.max(slo, ulo);
}

/** Exact classification of one pair of segments that share no vertex. */
function classify(s: Seg, u: Seg, out: Event[]): void {
  const o1 = orient2d(s.ax, s.ay, s.bx, s.by, u.ax, u.ay);
  const o2 = orient2d(s.ax, s.ay, s.bx, s.by, u.bx, u.by);
  const o3 = orient2d(u.ax, u.ay, u.bx, u.by, s.ax, s.ay);
  const o4 = orient2d(u.ax, u.ay, u.bx, u.by, s.bx, s.by);
  if (o1 === 0 && o2 === 0) {
    // Collinear: any positive-length overlap is rejected; point contact
    // means coincident endpoints (merged earlier). The two spans are
    // compared along the coordinate the line actually runs on — x, or y
    // when the line is vertical, which `o1 === o2 === 0` makes exact — so
    // the comparison is the f64 one and nothing rounds. A normalised
    // parameter cannot do this: it turns a one-ulp overlap into a touch,
    // and planarize then splits two spans that share a sliver of ink.
    if (overlapSpan(s.ax, s.ay, s.bx, s.by, u.ax, u.ay, u.bx, u.by)) throw new Error(`planarize: edges ${s.row} and ${u.row} overlap along a positive length — collinear overlaps are not supported; repair the input — m.merge() resolves overlaps and duplicates`);
    return;
  }
  const paramOn = (seg: Seg, x: number, y: number) => {
    const dx = seg.bx - seg.ax;
    const dy = seg.by - seg.ay;
    return ((x - seg.ax) * dx + (y - seg.ay) * dy) / (dx * dx + dy * dy);
  };
  if (o1 === 0) {
    const t = paramOn(s, u.ax, u.ay);
    if (t > 0 && t < 1) out.push({ kind: 'contact', vertex: u.a, edge: s.row, t });
    return;
  }
  if (o2 === 0) {
    const t = paramOn(s, u.bx, u.by);
    if (t > 0 && t < 1) out.push({ kind: 'contact', vertex: u.b, edge: s.row, t });
    return;
  }
  if (o3 === 0) {
    const t = paramOn(u, s.ax, s.ay);
    if (t > 0 && t < 1) out.push({ kind: 'contact', vertex: s.a, edge: u.row, t });
    return;
  }
  if (o4 === 0) {
    const t = paramOn(u, s.bx, s.by);
    if (t > 0 && t < 1) out.push({ kind: 'contact', vertex: s.b, edge: u.row, t });
    return;
  }
  if ((o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0)) {
    const t = o3 / (o3 - o4);
    // The position comes from whichever segment holds that coordinate
    // CONSTANT: a crossing with a segment whose x never changes is at that
    // x, exactly, and no parameter rounds it away. Two segments cannot both
    // be constant in the same coordinate — they would be parallel and never
    // cross — so the choice is unambiguous, and where neither is constant it
    // is the interpolation along `s` it always was. This matters at a
    // lattice: two nearly-coincident horizontals (a hand-built grid after
    // unit resolution) cross one vertical at points whose interpolated
    // coordinates round to the SAME f64, which the consolidator then has to
    // refuse as ambiguous. Read off the constant coordinate and the two
    // points stay as distinct as the input is.
    const x = s.ax === s.bx ? s.ax : u.ax === u.bx ? u.ax : s.ax + (s.bx - s.ax) * t;
    const y = s.ay === s.by ? s.ay : u.ay === u.by ? u.ay : s.ay + (s.by - s.ay) * t;
    // One source of truth: the parameter on each edge is measured FROM the
    // position, so the order of the stops along an edge is the order of the
    // points along it. A parameter computed on its own can disagree with the
    // point it names by an ulp, and then a chain of cuts doubles back on
    // itself and the split edges overlap.
    out.push({ kind: 'cross', i: s.row, ti: paramOn(s, x, y), j: u.row, tj: paramOn(u, x, y), x, y });
  }
}

/** Shared-vertex pairs: only a same-direction collinear overlap is possible, and it is an error. */
function checkSharedOverlap(s: Seg, u: Seg, shared: number): void {
  const sx = s.a === shared ? s.bx : s.ax;
  const sy = s.a === shared ? s.by : s.ay;
  const ux = u.a === shared ? u.bx : u.ax;
  const uy = u.a === shared ? u.by : u.ay;
  const vx = s.a === shared ? s.ax : s.bx;
  const vy = s.a === shared ? s.ay : s.by;
  if (orient2d(vx, vy, sx, sy, ux, uy) === 0 && (sx - vx) * (ux - vx) + (sy - vy) * (uy - vy) > 0) {
    throw new Error(`planarize: edges ${s.row} and ${u.row} overlap along a positive length from vertex ${shared} — collinear overlaps are not supported; repair the input — m.merge() resolves overlaps and duplicates`);
  }
}

function validate(m: Material, what: string): void {
  for (let i = 0; i < m.n; i++) {
    if (!Number.isFinite(m.x[i]) || !Number.isFinite(m.y[i])) throw new Error(`${what}: vertex ${i} is not finite`);
  }
  const zero: number[] = [];
  for (let e = 0; e < m.edgeCount; e++) {
    const a = m.edgeList[2 * e];
    const b = m.edgeList[2 * e + 1];
    if (a === b || (m.x[a] === m.x[b] && m.y[a] === m.y[b])) zero.push(e);
  }
  if (zero.length) throw new Error(`${what}: zero-length edge${zero.length > 1 ? 's' : ''} ${zero.join(', ')} — remove or move ${zero.length > 1 ? 'them' : 'it'} first (attributes are never dropped silently)`);
}

function interpolateAttrs(m: Material, a: number, b: number, t: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of m.attrNames) {
    const va = m.attrs[name][a];
    const vb = m.attrs[name][b];
    out[name] = m.transfers[name] === 'nearest' ? (t <= 0.5 ? va : vb) : va + (vb - va) * t;
  }
  return out;
}

/** Agree per column, or ask the resolver; every unresolved conflict is an error. */
function reconcile(m: Material, event: PlanarEvent, resolver: PlanarizeOpts['point'], what: string): Record<string, number> {
  const names = m.attrNames;
  const out: Record<string, number> = {};
  const conflicts: string[] = [];
  for (const name of names) {
    const v0 = event.candidates[0].attrs[name];
    if (event.candidates.every((c) => c.attrs[name] === v0)) out[name] = v0;
    else conflicts.push(name);
  }
  if (conflicts.length === 0 && !resolver) return out;
  if (!resolver) {
    throw new Error(`planarize: ${what} at (${event.position[0]}, ${event.position[1]}) has conflicting '${conflicts[0]}' (${event.candidates.map((c) => c.attrs[conflicts[0]]).join(' vs ')}) — give planarize({ point: (event) => ({ ${conflicts[0]}: … }) })`);
  }
  const chosen = resolver(event) ?? {};
  for (const name in chosen) {
    if (!names.includes(name)) throw new Error(`planarize: no attribute '${name}' — declare it first`);
    if (!Number.isFinite(chosen[name])) throw new Error(`planarize: '${name}' from the point resolver is not a finite number`);
    out[name] = chosen[name];
  }
  for (const name of conflicts) {
    if (!(name in chosen)) throw new Error(`planarize: ${what} at (${event.position[0]}, ${event.position[1]}) still has conflicting '${name}' after the resolver — return it`);
  }
  return out;
}

/**
 * Independent material in which every proper crossing and every
 * endpoint-on-edge contact is one shared vertex, with the edges split at
 * their ordered parameters. Coincident endpoints (exactly equal
 * coordinates) merge into the lowest row. Isolated points stay isolated —
 * even one lying on an edge, since it takes part in no network. Collinear
 * overlaps, duplicate edges, zero-length edges and non-finite coordinates
 * are errors that name the rows. The source and its history are untouched;
 * the result starts at iteration 0 with the same columns and transfer
 * policies.
 *
 * Order: surviving source vertices in source order, then event vertices by
 * (lowest edge row, parameter); child edges in parent-edge, parameter
 * order; candidates by vertex row then edge row.
 */
export function planarize(m: Material, opts: PlanarizeOpts = {}): Material {
  validate(m, 'planarize');
  const n = m.n;
  const E = m.edgeCount;
  const names = m.attrNames;
  const enames = m.edgeAttrNames;

  // ---- merge exactly coincident endpoints of the network ----
  const rep = new Int32Array(n);
  for (let i = 0; i < n; i++) rep[i] = i;
  const participates = new Uint8Array(n);
  for (let e = 0; e < E; e++) {
    participates[m.edgeList[2 * e]] = 1;
    participates[m.edgeList[2 * e + 1]] = 1;
  }
  // Exact coincidence, hashed rather than spelled out: `positionHash` keys
  // the bit patterns (0 and −0 together, as `===` has them), and the
  // coordinates themselves decide inside the bucket. A bucket holds one
  // position in practice; a hash collision only costs the compare.
  const mergedRows = new Map<number, number[]>(); // representative → every row merged into it
  const byPos = new Map<number, number | number[]>();
  for (let i = 0; i < n; i++) {
    if (!participates[i]) continue;
    const x = m.x[i];
    const y = m.y[i];
    const h = positionHash(x, y);
    const slot = byPos.get(h);
    if (slot === undefined) { byPos.set(h, i); continue; }
    let r = -1;
    if (typeof slot === 'number') {
      if (m.x[slot] === x && m.y[slot] === y) r = slot;
      else byPos.set(h, [slot, i]);
    } else {
      for (const other of slot) if (m.x[other] === x && m.y[other] === y) { r = other; break; }
      if (r < 0) slot.push(i);
    }
    if (r < 0) continue;
    rep[i] = r;
    const rows = mergedRows.get(r);
    if (rows) rows.push(i); else mergedRows.set(r, [r, i]);
  }

  // ---- segments on representatives; duplicate pairs are overlaps ----
  const segs: Seg[] = [];
  // The unordered pair packs into one exact integer while n² < 2^53 — the
  // same key `checkPlanar` uses, and no string per edge.
  const seenPair = new Map<number, number>();
  for (let e = 0; e < E; e++) {
    const a = rep[m.edgeList[2 * e]];
    const b = rep[m.edgeList[2 * e + 1]];
    if (a === b) throw new Error(`planarize: edge ${e} joins two coincident endpoints — a zero-length edge after merging`);
    const key = a < b ? a * n + b : b * n + a;
    const dup = seenPair.get(key);
    if (dup !== undefined) throw new Error(`planarize: edges ${dup} and ${e} are the same segment — duplicate edges are overlaps and are not supported — m.merge() resolves overlaps and duplicates`);
    seenPair.set(key, e);
    segs.push({ a, b, ax: m.x[a], ay: m.y[a], bx: m.x[b], by: m.y[b], row: e });
  }

  // ---- events ----
  const events: Event[] = [];
  boxPairs(segs, (i, j) => {
    const s = segs[i];
    const u = segs[j];
    const shared = s.a === u.a || s.a === u.b ? s.a : s.b === u.a || s.b === u.b ? s.b : -1;
    if (shared >= 0) checkSharedOverlap(s, u, shared);
    else classify(s, u, events);
  });
  // Both lookups are a pair of rows packed into one exact integer, the same
  // arithmetic key the duplicate check above uses: E and n are row counts,
  // so the product stays far inside 2^53.
  const crossKey = (i: number, j: number) => (i < j ? i * E + j : j * E + i);
  const crossOf = new Map<number, number>(); // edge pair → event
  const contactOf = new Map<number, number>(); // vertex · E + edge → event
  const contactsAt = new Map<number, number[]>(); // vertex → its contact events
  for (let k = 0; k < events.length; k++) {
    const ev = events[k];
    if (ev.kind === 'cross') crossOf.set(crossKey(ev.i, ev.j), k);
    else {
      contactOf.set(ev.vertex * E + ev.edge, k);
      const list = contactsAt.get(ev.vertex);
      if (list) list.push(k); else contactsAt.set(ev.vertex, [k]);
    }
  }
  const paramOf = (k: number, edge: number): number => {
    const ev = events[k];
    if (ev.kind === 'contact') return ev.t;
    return ev.i === edge ? ev.ti : ev.tj;
  };
  const near = (a: number, b: number) => Math.abs(a - b) <= EVENT_TOL;

  // ---- consolidate: union-find over events, joining only PROVEN shared points ----
  const parent = events.map((_, k) => k);
  const find = (g: number): number => (parent[g] === g ? g : (parent[g] = find(parent[g])));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (const list of contactsAt.values()) for (let k = 1; k < list.length; k++) union(list[0], list[k]); // one vertex, one event
  interface Cut { t: number; event: number }
  const cutsByEdge: Cut[][] = Array.from({ length: E }, () => []);
  for (let k = 0; k < events.length; k++) {
    const ev = events[k];
    if (ev.kind === 'contact') cutsByEdge[ev.edge].push({ t: ev.t, event: k });
    else {
      cutsByEdge[ev.i].push({ t: ev.ti, event: k });
      cutsByEdge[ev.j].push({ t: ev.tj, event: k });
    }
  }
  const otherEdge = (k: number, edge: number): number => {
    const ev = events[k] as Extract<Event, { kind: 'cross' }>;
    return ev.i === edge ? ev.j : ev.i;
  };
  /** Do events p and q on `edge` (both within tolerance there) provably meet at one point? */
  const proven = (p: number, q: number, edge: number): boolean => {
    const ep = events[p];
    const eq = events[q];
    if (ep.kind === 'contact' && eq.kind === 'contact') return false; // two distinct vertices
    if (ep.kind === 'cross' && eq.kind === 'cross') {
      const b = otherEdge(p, edge);
      const c = otherEdge(q, edge);
      if (b === c) return false;
      const bc = crossOf.get(crossKey(b, c));
      if (bc === undefined) return false;
      return near(paramOf(bc, b), paramOf(p, b)) && near(paramOf(bc, c), paramOf(q, c));
    }
    const contact = (ep.kind === 'contact' ? ep : eq) as Extract<Event, { kind: 'contact' }>;
    const cross = ep.kind === 'contact' ? q : p;
    const b = otherEdge(cross, edge);
    const onB = contactOf.get(contact.vertex * E + b);
    return onB !== undefined && near(paramOf(onB, b), paramOf(cross, b));
  };
  for (let e = 0; e < E; e++) {
    const cuts = cutsByEdge[e];
    if (cuts.length < 2) continue;
    cuts.sort((p, q) => p.t - q.t);
    for (let k = 0; k < cuts.length; k++) {
      for (let l = k + 1; l < cuts.length && cuts[l].t - cuts[k].t <= EVENT_TOL; l++) {
        if (proven(cuts[k].event, cuts[l].event, e)) union(cuts[k].event, cuts[l].event);
      }
    }
  }
  // groups: representative vertex (a contact's), position, ordering key, mentions
  const groupVertex = new Map<number, number>();
  const groupPos = new Map<number, [number, number]>();
  const groupKey = new Map<number, [number, number]>();
  const groupEdges = new Map<number, { edge: number; t: number }[]>();
  for (let k = 0; k < events.length; k++) {
    const g = find(k);
    const ev = events[k];
    const mentions = groupEdges.get(g) ?? [];
    if (ev.kind === 'contact') {
      groupVertex.set(g, ev.vertex);
      groupPos.set(g, [m.x[ev.vertex], m.y[ev.vertex]]);
      mentions.push({ edge: ev.edge, t: ev.t });
    } else {
      if (!groupPos.has(g)) groupPos.set(g, [ev.x, ev.y]);
      mentions.push({ edge: ev.i, t: ev.ti }, { edge: ev.j, t: ev.tj });
    }
    groupEdges.set(g, mentions);
    const key = groupKey.get(g);
    const mine: [number, number] = ev.kind === 'contact' ? [ev.edge, ev.t] : [ev.i, ev.ti];
    if (!key || mine[0] < key[0] || (mine[0] === key[0] && mine[1] < key[1])) groupKey.set(g, mine);
  }

  // ---- point attributes at existing vertices: merged rows and contacts reconcile alike ----
  const resolvedAttrs = new Map<number, Record<string, number>>();
  const contactVertices = new Set<number>();
  for (const v of groupVertex.values()) contactVertices.add(rep[v]);
  const touched = new Set<number>([...mergedRows.keys(), ...contactVertices]);
  if (names.length) {
    for (const v of Array.from(touched).sort((p, q) => p - q)) {
      const rows = mergedRows.get(v) ?? [v];
      const candidates: EventCandidate[] = rows.map((i) => ({ vertex: i, attrs: interpolateAttrs(m, i, i, 0) }));
      const contacts = rows.flatMap((i) => contactsAt.get(i) ?? []).map((k) => events[k] as Extract<Event, { kind: 'contact' }>).sort((p, q) => p.edge - q.edge);
      for (const c of contacts) candidates.push({ edge: c.edge, t: c.t, attrs: interpolateAttrs(m, segs[c.edge].a, segs[c.edge].b, c.t) });
      if (candidates.length < 2) continue;
      const event: PlanarEvent = { position: [m.x[v], m.y[v]], candidates };
      resolvedAttrs.set(v, reconcile(m, event, opts.point, `vertex ${v}`));
    }
  }

  // ---- rows: surviving source vertices, then new event vertices ----
  const rowMap = new Int32Array(n).fill(-1);
  const ox: number[] = [];
  const oy: number[] = [];
  const oattrs: Record<string, number[]> = {};
  for (const name of names) oattrs[name] = [];
  // A vertex that survives planarizing is the vertex it was. Coincident
  // endpoints merge into the lowest row, and that row's identity is the one
  // that carries; the others are gone. A crossing is a new vertex.
  const oids: number[] = [];
  for (let i = 0; i < n; i++) {
    if (rep[i] !== i) continue;
    rowMap[i] = ox.length;
    ox.push(m.x[i]);
    oy.push(m.y[i]);
    oids.push(m.pointIds[i]);
    const resolved = resolvedAttrs.get(i);
    for (const name of names) oattrs[name].push(resolved ? resolved[name] : m.attrs[name][i]);
  }
  const roots = Array.from(new Set(parent.map((_, g) => find(g)))).filter((g) => !groupVertex.has(g));
  roots.sort((a, b) => groupKey.get(a)![0] - groupKey.get(b)![0] || groupKey.get(a)![1] - groupKey.get(b)![1]);
  const groupRow = new Map<number, number>();
  // One block of ids for the crossings, in the order the loop would have
  // asked for them one at a time — the same numbers, without an array per
  // vertex. A material with no columns asks no candidate anything: the
  // candidates exist for the resolver, and there is nothing to resolve.
  const crossingIds = mintIds(roots.length);
  for (let r = 0; r < roots.length; r++) {
    const g = roots[r];
    let attrs: Record<string, number> = {};
    if (names.length) {
      const mentions = groupEdges.get(g)!.slice().sort((p, q) => p.edge - q.edge || p.t - q.t);
      const seen = new Set<number>();
      const candidates: EventCandidate[] = [];
      for (const { edge, t } of mentions) {
        if (seen.has(edge)) continue;
        seen.add(edge);
        candidates.push({ edge, t, attrs: interpolateAttrs(m, segs[edge].a, segs[edge].b, t) });
      }
      attrs = reconcile(m, { position: groupPos.get(g)!, candidates }, opts.point, 'the crossing');
    }
    const pos = groupPos.get(g)!;
    groupRow.set(g, ox.length);
    ox.push(pos[0]);
    oy.push(pos[1]);
    oids.push(crossingIds[r]);
    for (const name of names) oattrs[name].push(attrs[name]);
  }
  const rowOfGroup = (g: number): number => {
    const r = find(g);
    const v = groupVertex.get(r);
    return v !== undefined ? rowMap[rep[v]] : groupRow.get(r)!;
  };

  // ---- child edges in parent, parameter order ----
  const edges: number[] = [];
  const eids: number[] = [];
  const minted: number[] = []; // rows of `eids` waiting for a fresh id
  const eroots: number[] = [];
  const eattrs: Record<string, number[]> = {};
  for (const name of enames) eattrs[name] = [];
  for (let e = 0; e < E; e++) {
    const s = segs[e];
    const stops: { t: number; row: number }[] = [{ t: 0, row: rowMap[s.a] }];
    let lastGroup = -1;
    // A tie in the parameter is broken by where the stops actually are.
    // Two crossings one ulp apart round to the SAME parameter, and a stable
    // sort then keeps the order they were discovered in — which cuts the
    // edge into pieces that double back and share a sliver of ink. The
    // edge is straight, so the coordinate it travels furthest in orders its
    // stops exactly, with no arithmetic to round.
    const alongY = Math.abs(s.by - s.ay) > Math.abs(s.bx - s.ax);
    const sign = (alongY ? s.by > s.ay : s.bx > s.ax) ? 1 : -1;
    // Read only on a tie, which is why it is computed there and not for
    // every cut.
    const along = (c: Cut) => { const row = rowOfGroup(find(c.event)); return sign * (alongY ? oy[row] : ox[row]); };
    const cuts = cutsByEdge[e];
    cuts.sort((p, q) => p.t - q.t || along(p) - along(q));
    for (const c of cuts) {
      const g = find(c.event);
      if (g === lastGroup) continue;
      lastGroup = g;
      stops.push({ t: c.t, row: rowOfGroup(g) });
    }
    stops.push({ t: 1, row: rowMap[s.b] });
    for (let k = 1; k < stops.length; k++) {
      const p = stops[k - 1].row;
      const q = stops[k].row;
      if (p !== q && ox[p] === ox[q] && oy[p] === oy[q]) {
        throw new Error(`planarize: two distinct events on edge ${e} (parameters ${stops[k - 1].t} and ${stops[k].t}) land on the same coordinates but are not provably one point — numerically ambiguous input; move the lines apart or make them meet exactly`);
      }
    }
    // Nothing to carry and nobody asking: the whole per-child record —
    // interval, resolver call, inherited columns — is for the columns, and
    // a material without any skips it.
    const carries = enames.length > 0 || opts.edges !== undefined;
    const parentView = carries ? m.edge(e) : undefined!;
    const parentAttrs: Record<string, number> = {};
    for (const name of enames) parentAttrs[name] = m.edgeAttrs[name][e];
    for (let k = 0; k + 1 < stops.length; k++) {
      edges.push(stops[k].row, stops[k + 1].row);
      // A piece of a wall is a new edge, and still that wall: a fresh id,
      // the parent's root. An edge no crossing touched comes through this
      // loop as its own single child, so it keeps its id too. The fresh
      // ones are minted in one block below, in this order.
      if (stops.length === 2) eids.push(m.edgeIds[e]);
      else { minted.push(eids.length); eids.push(0); }
      eroots.push(m.edgeRoots[e]);
      if (!carries) continue;
      const child: ChildInterval = { from: stops[k].t, to: stops[k + 1].t, fraction: stops[k + 1].t - stops[k].t };
      const extra = opts.edges ? opts.edges(parentView, child) : {};
      for (const name in extra) {
        if (!enames.includes(name)) throw new Error(`planarize: no edge attribute '${name}' — declare it with edgeAttribute()`);
        if (!Number.isFinite(extra[name])) throw new Error(`planarize: '${name}' for a child edge is not a finite number`);
      }
      const inherited = inheritEdge(m, parentAttrs, child.fraction);
      for (const name of enames) eattrs[name].push(name in extra ? extra[name] : inherited[name]);
    }
  }
  const childIds = mintIds(minted.length);
  for (let i = 0; i < minted.length; i++) eids[minted[i]] = childIds[i];
  const attrs: Record<string, Float64Array> = {};
  for (const name of names) attrs[name] = Float64Array.from(oattrs[name]);
  const edgeAttrs: Record<string, Float64Array> = {};
  for (const name of enames) edgeAttrs[name] = Float64Array.from(eattrs[name]);
  return new Material(Float64Array.from(ox), Float64Array.from(oy), attrs, Uint32Array.from(edges), {
    iteration: 0,
    edgeAttrs,
    transfers: { ...m.transfers },
    edgeTransfers: { ...m.edgeTransfers },
    ids: { points: Float64Array.from(oids), edges: Float64Array.from(eids), edgeRoots: Float64Array.from(eroots) },
    faceAttrs: m.faceAttrs,
  });
}

// ---- faces ----------------------------------------------------------------------------

/**
 * A bounded region of one planar state, read-only.
 *
 * Face columns read flat off it — `face.height` — the way a vertex's own
 * columns do, which is why the face's ten own fields are reserved names.
 */
export type Face = {
  /** Row in the face collection it came from — not an identity. */
  index: number;
  /** Filled area in squared material units: outer minus holes. */
  area: number;
  /** Outer and hole boundaries; retraced bridges and branches excluded. */
  perimeter: number;
  bounds: { x: number; y: number; w: number; h: number };
  /** Geometric centroid of the filled area, holes respected; `[NaN, NaN]`
   * for a degenerate face. Field-weighted centres come from `measure()`. */
  centroid: readonly [number, number];
  /** This face's edges in the source material, once: its walls and any
   * dangling edge inside it. */
  readonly edges: EdgeSelection;
  /** Endpoints of `edges`, once, in row order. */
  readonly points: PointSelection;
  /** Edges between this face and anything else (another face or the
   * outside): the walls; edges inside the face are not boundary. */
  readonly boundaryEdges: EdgeSelection;
  /** The faces across this face's walls, as a selection of the same
   * collection: neighbours share an edge, not merely a vertex. */
  readonly adjacent: FaceSelection;
  /** Closed contours: the outer boundary with positive signed area
   * (counter-clockwise in a y-up reading), holes negative. Bridges and
   * branches inside the face are not part of them.
   *
   * A method, not a property, because every area value answers `contours()`
   * — a face, a face collection, a material and a plain contour record are
   * all read the same way by `polygon`, `distanceTo` and `t.within`. */
  contours(): IsoContour[];
  /**
   * The face columns, read flat: `f.height`, the way a vertex reads `p.age`.
   *
   * `number | undefined`, and the `undefined` is the honest half: a face
   * column is SPARSE. A write names the faces it writes, a face the write
   * passed by has no value, and a new face that shares no wall with any old
   * one has nothing to inherit. Declared as `number` this read `NaN` into a
   * hatch angle without a word said, which is the worst kind of plotter bug
   * — it typechecks, it does not throw, and it shows after the pen has
   * moved. Give the column a `fallback` if every face must answer.
   */
} & Record<string, number | undefined>;

interface Walk {
  halfEdges: number[]; // in walk order
  cycles: number[][]; // its simple cycles (splitWalk); retraced parts gone
  area: number; // signed shoelace summed over the cycles
  comp: number;
}

/** Throw unless `m` is a valid planar embedding as far as its edges go. */
function checkPlanar(m: Material): void {
  validate(m, 'faces');
  const segs: Seg[] = [];
  // the unordered pair packs into one exact integer while n² < 2^53 — that is
  // every material whose coordinates fit in memory
  const seenPair = new Set<number>();
  for (let e = 0; e < m.edgeCount; e++) {
    const a = m.edgeList[2 * e];
    const b = m.edgeList[2 * e + 1];
    const key = a < b ? a * m.n + b : b * m.n + a;
    if (seenPair.has(key)) throw new Error(`faces: duplicate edge ${e} — duplicate edges are overlaps and are not supported`);
    seenPair.add(key);
    segs.push({ a, b, ax: m.x[a], ay: m.y[a], bx: m.x[b], by: m.y[b], row: e });
  }
  // A distinct vertex at an already-claimed position throws at once, so a
  // bucket only ever holds vertices whose hashes collided but whose
  // coordinates differ; it stays one deep in practice.
  const byPos = new Map<number, number | number[]>();
  const claim = (v: number): void => {
    const x = m.x[v];
    const y = m.y[v];
    const h = positionHash(x, y);
    const slot = byPos.get(h);
    if (slot === undefined) { byPos.set(h, v); return; }
    if (typeof slot === 'number') {
      if (slot === v) return;
      if (m.x[slot] === x && m.y[slot] === y) throw new Error(`faces: vertices ${slot} and ${v} coincide but are distinct — run planarize() first`);
      byPos.set(h, [slot, v]);
      return;
    }
    for (const other of slot) {
      if (other === v) return;
      if (m.x[other] === x && m.y[other] === y) throw new Error(`faces: vertices ${other} and ${v} coincide but are distinct — run planarize() first`);
    }
    slot.push(v);
  };
  for (const s of segs) { claim(s.a); claim(s.b); }
  const events: Event[] = [];
  boxPairs(segs, (i, j) => {
    const s = segs[i];
    const u = segs[j];
    const shared = s.a === u.a || s.a === u.b ? s.a : s.b === u.a || s.b === u.b ? s.b : -1;
    if (shared >= 0) checkSharedOverlap(s, u, shared);
    else classify(s, u, events);
    if (events.length) {
      const ev = events[0];
      // A crossing whose two edges own distinct vertices a rounding apart is
      // not a missing planarize: it is input whose edges very nearly meet at
      // one point, which consolidation cannot prove concurrent and rounding
      // cannot tell apart. Saying "run planarize() first" there sends the
      // reader back to a step they have already taken, so name the real cause.
      if (ev.kind === 'cross') {
        let gap = Infinity;
        let pair: [number, number] = [-1, -1];
        for (const a of [segs[ev.i].a, segs[ev.i].b]) {
          for (const b of [segs[ev.j].a, segs[ev.j].b]) {
            if (a === b) continue;
            const d = Math.hypot(m.x[a] - m.x[b], m.y[a] - m.y[b]);
            if (d < gap) {
              gap = d;
              pair = [a, b];
            }
          }
        }
        // As far as these coordinates can tell, the two edges meet at one
        // point — the crossing is read as that meeting. Refusing here would
        // blank a drawing over a gap of a rounding, and planarize can
        // neither prove the point nor separate it, so there is nothing the
        // reader could do about it either.
        if (gap <= EVENT_TOL) {
          events.length = 0;
          return;
        }
      }
      const where = ev.kind === 'cross' ? `edges ${ev.i} and ${ev.j} cross` : `vertex ${ev.vertex} lies on edge ${ev.edge}`;
      throw new Error(`faces: ${where} without a shared vertex — run planarize() first`);
    }
  });
}

/** Simple cycles of a walk: wherever the walk returns to a vertex it has
 * already left (a retraced edge, a bridge, a pinch, two holes touching at
 * a corner), the part between the two visits becomes its own cycle and
 * the rest continues without it. Cycles shorter than three edges are
 * retraced branches and vanish. */
function splitWalk(walk: number[], tailOf: (h: number) => number): number[][] {
  const out: number[][] = [];
  const rec = (seq: number[]) => {
    const at = new Map<number, number>();
    for (let k = 0; k < seq.length; k++) {
      const v = tailOf(seq[k]);
      const first = at.get(v);
      if (first !== undefined) {
        rec(seq.slice(first, k));
        rec([...seq.slice(0, first), ...seq.slice(k)]);
        return;
      }
      at.set(v, k);
    }
    if (seq.length >= 3) out.push(seq);
  };
  rec(walk);
  return out;
}

function pointInWalk(m: Material, walk: number[], tail: (h: number) => number, px: number, py: number): boolean {
  let inside = false;
  for (let k = 0; k < walk.length; k++) {
    const a = tail(walk[k]);
    const b = tail(walk[(k + 1) % walk.length]);
    const ax = m.x[a];
    const ay = m.y[a];
    const bx = m.x[b];
    const by = m.y[b];
    if (ay > py !== by > py) {
      const x = ax + ((py - ay) * (bx - ax)) / (by - ay);
      if (px < x) inside = !inside;
    }
  }
  return inside;
}

/** The positions `containing` asks about: one point, or a cloud of them.
 * A pair or a record is ONE place; a material, a point selection or an
 * array of either spelling is many. */
function queryPoints(where: XY | PointsLike, who: string): [number, number][] {
  if (Array.isArray(where) && typeof where[0] === 'number') return [[where[0], where[1] as number]];
  const one = where as { x?: unknown; y?: unknown };
  if (typeof one?.x === 'number' && typeof one?.y === 'number') return [[one.x, one.y]];
  const many = where as { x?: ArrayLike<number>; y?: ArrayLike<number>; n?: number };
  if (typeof many?.n === 'number' && many.x !== undefined && many.y !== undefined) {
    const out: [number, number][] = [];
    for (let i = 0; i < many.n; i++) out.push([many.x[i], many.y[i]]);
    return out;
  }
  if (where !== null && where !== undefined && typeof (where as Iterable<XY>)[Symbol.iterator] === 'function') {
    const out: [number, number][] = [];
    for (const p of where as Iterable<XY>) {
      const pair = p as { x?: unknown; y?: unknown };
      if (Array.isArray(p)) out.push([p[0] as number, p[1] as number]);
      else if (typeof pair?.x === 'number' && typeof pair?.y === 'number') out.push([pair.x, pair.y]);
      else throw new Error(`${who}: a point is [x, y] or { x, y }`);
    }
    return out;
  }
  throw new Error(`${who}: expected a point ([x, y] or { x, y }) or points — a material, a point selection, or an array of them`);
}

/**
 * A uniform grid over axis-aligned boxes, four numbers per item
 * (`minx, miny, maxx, maxy`): `near` lists, once each, the items whose box
 * may meet the query box. A prefilter, not an answer — the caller tests.
 */
export function boxGrid(boxes: Float64Array): { near(minx: number, miny: number, maxx: number, maxy: number): number[] } {
  const count = boxes.length / 4;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (let i = 0; i < count; i++) {
    x0 = Math.min(x0, boxes[4 * i]); y0 = Math.min(y0, boxes[4 * i + 1]);
    x1 = Math.max(x1, boxes[4 * i + 2]); y1 = Math.max(y1, boxes[4 * i + 3]);
  }
  if (!(x0 <= x1 && y0 <= y1)) return { near: () => [] };
  const across = Math.max(1, Math.ceil(Math.sqrt(count)));
  const cell = Math.max(x1 - x0, y1 - y0, 1e-9) / across;
  const cols = Math.floor((x1 - x0) / cell) + 1;
  const rows = Math.floor((y1 - y0) / cell) + 1;
  const col = (x: number) => Math.min(cols - 1, Math.max(0, Math.floor((x - x0) / cell)));
  const row = (y: number) => Math.min(rows - 1, Math.max(0, Math.floor((y - y0) / cell)));
  const buckets: number[][] = Array.from({ length: cols * rows }, () => []);
  for (let i = 0; i < count; i++) {
    for (let r = row(boxes[4 * i + 1]); r <= row(boxes[4 * i + 3]); r++) {
      for (let c = col(boxes[4 * i]); c <= col(boxes[4 * i + 2]); c++) buckets[r * cols + c].push(i);
    }
  }
  const stamp = new Int32Array(count);
  let query = 0;
  return {
    near(minx, miny, maxx, maxy) {
      const out: number[] = [];
      if (maxx < x0 || minx > x1 || maxy < y0 || miny > y1) return out;
      query++;
      for (let r = row(miny); r <= row(maxy); r++) {
        for (let c = col(minx); c <= col(maxx); c++) {
          for (const i of buckets[r * cols + c]) {
            if (stamp[i] === query) continue;
            stamp[i] = query;
            out.push(i);
          }
        }
      }
      return out;
    },
  };
}

/** `faces.containing` for many single points: the face index holding
 * (x, y), or −1, by the same rule, with the faces bucketed by their bounds. */
export function faceLocator(cells: Faces): (x: number, y: number) => number {
  const boxes = new Float64Array(4 * cells.faces.length);
  cells.faces.forEach((f, i) => boxes.set([f.bounds.x, f.bounds.y, f.bounds.x + f.bounds.w, f.bounds.y + f.bounds.h], 4 * i));
  const grid = boxGrid(boxes);
  return (x, y) => faceHolding(grid.near(x, y, x, y).sort((a, b) => a - b).map((i) => cells.faces[i]), x, y);
}

/**
 * The bounded face that holds (x, y), or −1.
 *
 * Even-odd over the face's OWN contours, so a face with a hole does not
 * hold what sits in the hole; the hole's own face does. A point on a wall
 * belongs to neither side — the wall is where the faces stop — and a point
 * outside every face belongs to none.
 */
function faceHolding(list: readonly Face[], x: number, y: number): number {
  for (const f of list) {
    const b = f.bounds;
    if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) continue;
    const eps = EVENT_TOL * Math.max(b.w, b.h, 1);
    let inside = false;
    let onWall = false;
    for (const c of f.contours()) {
      const pts = c.pts;
      for (let i = 0; i < pts.length && !onWall; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i + 1) % pts.length];
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
        if (Math.hypot(x - (ax + dx * t), y - (ay + dy * t)) <= eps) onWall = true;
        else if (ay > y !== by > y && x < ax + ((y - ay) / (by - ay)) * dx) inside = !inside;
      }
      if (onWall) break;
    }
    if (onWall) return -1;
    if (inside) return f.index;
  }
  return -1;
}

/**
 * The faces READ OFF the drawn picture: the walks of the half-edge
 * successor, the positive ones as faces, the negative ones as the outer
 * boundaries of whatever contains them. The right answer wherever the
 * sketch's coordinates are a faithful flat picture.
 */
function fromWalk(
  m: Material,
  start: Int32Array,
  outgoing: Int32Array,
  next: Int32Array,
  tailOf: (h: number) => number,
  headOf: (h: number) => number,
): { walks: Walk[]; faceWalk: number[]; holesOf: number[][]; faceOf: Int32Array } {
  const n = m.n;
  const H = 2 * m.edgeCount;
  // components over vertices
  const comp = new Int32Array(n).fill(-1);
  let comps = 0;
  for (let v = 0; v < n; v++) {
    if (comp[v] !== -1 || start[v + 1] === start[v]) continue;
    const stack = [v];
    comp[v] = comps;
    while (stack.length) {
      const u = stack.pop()!;
      for (let k = start[u]; k < start[u + 1]; k++) {
        const w = headOf(outgoing[k]);
        if (comp[w] === -1) {
          comp[w] = comps;
          stack.push(w);
        }
      }
    }
    comps++;
  }
  // walks
  const walkOf = new Int32Array(H).fill(-1);
  const walks: Walk[] = [];
  for (let h0 = 0; h0 < H; h0++) {
    if (walkOf[h0] !== -1) continue;
    const seq: number[] = [];
    let h = h0;
    do {
      walkOf[h] = walks.length;
      seq.push(h);
      h = next[h];
    } while (h !== h0);
    // The signed area is summed over the walk's simple cycles, so a walk
    // that only retraces (a tree, a spur) is exactly zero: summing the
    // raw walk leaves a rounding residue that would make a face of it.
    const cycles = splitWalk(seq, tailOf);
    let area = 0;
    for (const cycle of cycles) {
      const x0 = m.x[tailOf(cycle[0])]; // shoelace about a local origin: absolute coordinates cancel to zero far from (0, 0)
      const y0 = m.y[tailOf(cycle[0])];
      for (const c of cycle) {
        const a = tailOf(c);
        const b = headOf(c);
        area += (m.x[a] - x0) * (m.y[b] - y0) - (m.x[b] - x0) * (m.y[a] - y0);
      }
    }
    walks.push({ halfEdges: seq, cycles, area: area / 2, comp: comp[tailOf(h0)] });
  }
  // bounded faces: positive walks, in walk order (deterministic: lowest half-edge first)
  const faceWalk: number[] = [];
  const faceIndexOfWalk = new Int32Array(walks.length).fill(-1);
  for (let w = 0; w < walks.length; w++) {
    if (walks[w].area > 0) {
      faceIndexOfWalk[w] = faceWalk.length;
      faceWalk.push(w);
    }
  }
  // holes: an outer boundary (negative walk) belongs to the smallest face of ANOTHER component containing it
  const holesOf: number[][] = faceWalk.map(() => []);
  const containerOfWalk = new Int32Array(walks.length).fill(-1);
  for (let w = 0; w < walks.length; w++) {
    if (walks[w].area >= 0) continue;
    const v = tailOf(walks[w].halfEdges[0]);
    let best = -1;
    let bestArea = Infinity;
    for (let f = 0; f < faceWalk.length; f++) {
      const fw = walks[faceWalk[f]];
      if (fw.comp === walks[w].comp || fw.area >= bestArea) continue;
      if (pointInWalk(m, fw.halfEdges, tailOf, m.x[v], m.y[v])) {
        best = f;
        bestArea = fw.area;
      }
    }
    containerOfWalk[w] = best;
    if (best >= 0) holesOf[best].push(w);
  }
  const faceOf = new Int32Array(H).fill(-1);
  for (let h = 0; h < H; h++) {
    const w = walkOf[h];
    faceOf[h] = walks[w].area > 0 ? faceIndexOfWalk[w] : walks[w].area < 0 ? containerOfWalk[w] : -1;
  }
  return { walks, faceWalk, holesOf, faceOf };
}

/**
 * The faces named OUTRIGHT, as closed runs of vertex rows, for geometry
 * that knows its own topology.
 *
 * The half-edge walk below reads the faces off the drawn picture: it sorts
 * the edges at a vertex by angle and walks the smallest turn. That is the
 * right answer wherever the sketch's coordinates are a faithful flat
 * picture — the plane, the disk — and the wrong one on the sphere, whose
 * coordinates wrap and which has no exterior at all. A tiling knows which
 * corners go round which cell before anything is drawn, so it says so, and
 * every other member of `Faces` — the views, the columns, adjacency,
 * `boundaryEdges`, `contours()` — reads the same two arrays either way.
 *
 * Each cycle is a closed run of vertex ROWS, one wall after another with
 * that wall's own interior samples in between, all the cycles turning the
 * same way. A half-edge no cycle claims is OUTSIDE: that is the rim of a
 * finite patch of the plane or the disk, and on a full sphere there is
 * none.
 */
function fromCycles(
  m: Material,
  cycles: readonly (readonly number[])[],
  next: Int32Array,
  tailOf: (h: number) => number,
  headOf: (h: number) => number,
): { walks: Walk[]; faceWalk: number[]; holesOf: number[][]; faceOf: Int32Array } {
  const H = 2 * m.edgeCount;
  // The half-edge from one vertex row to another. Packed as one integer,
  // exactly as `checkPlanar` packs its pair: n² is under 2^53 for every
  // material that fits in memory.
  const halfOf = new Map<number, number>();
  for (let e = 0; e < m.edgeCount; e++) {
    halfOf.set(m.edgeList[2 * e] * m.n + m.edgeList[2 * e + 1], 2 * e);
    halfOf.set(m.edgeList[2 * e + 1] * m.n + m.edgeList[2 * e], 2 * e + 1);
  }
  const faceOf = new Int32Array(H).fill(-1);
  const walks: Walk[] = [];
  for (let f = 0; f < cycles.length; f++) {
    const cycle = cycles[f];
    if (cycle.length < 3) throw new Error(`faces: face ${f} is a run of ${cycle.length} vertices — a face is three or more`);
    const seq: number[] = [];
    for (let k = 0; k < cycle.length; k++) {
      const a = cycle[k];
      const b = cycle[(k + 1) % cycle.length];
      const h = halfOf.get(a * m.n + b);
      if (h === undefined) throw new Error(`faces: face ${f} runs from vertex ${a} to vertex ${b}, and no edge joins them`);
      if (faceOf[h] >= 0) throw new Error(`faces: faces ${faceOf[h]} and ${f} both run from vertex ${a} to vertex ${b} — two faces share a wall the other way round`);
      faceOf[h] = f;
      seq.push(h);
    }
    for (let k = 0; k < seq.length; k++) next[seq[k]] = seq[(k + 1) % seq.length];
    // The shoelace about a local origin, as the walk path takes it:
    // absolute coordinates cancel to zero far from (0, 0).
    const x0 = m.x[tailOf(seq[0])];
    const y0 = m.y[tailOf(seq[0])];
    let area = 0;
    for (const h of seq) {
      const a = tailOf(h);
      const b = headOf(h);
      area += (m.x[a] - x0) * (m.y[b] - y0) - (m.x[b] - x0) * (m.y[a] - y0);
    }
    walks.push({ halfEdges: seq, cycles: [seq], area: area / 2, comp: 0 });
  }
  return { walks, faceWalk: walks.map((_, f) => f), holesOf: walks.map(() => []), faceOf };
}

/**
 * One key per face: the lineage roots of its walls, deduplicated, sorted,
 * joined. A wall cut in half is still one wall, which is what the root is
 * for. The one place the shape of a face column's key is written.
 */
export function faceKeyOf(roots: Iterable<number>): string {
  return [...new Set(roots)].sort((a, b) => a - b).join(',');
}

/** The bounded faces of one planar state, with selections over them. */
export class Faces {
  readonly source: Material;
  readonly iteration: number;
  /** Face views, by index. */
  readonly faces: readonly Face[];
  /** @internal */ readonly next: Int32Array; // face-walk successor of a half-edge
  /** @internal */ readonly faceOf: Int32Array; // face index on a half-edge's left, -1 outside
  /** One key per face, built the first time a face column is read. */
  private readonly keyBox: { keys: string[] | null };

  /**
   * @internal Use `material.faces()`, or `facesFromCycles` for geometry
   * that names its own faces.
   */
  constructor(m: Material, given?: readonly (readonly number[])[]) {
    // Faces named outright are the authority on their own topology, and the
    // planarity check is a question about a drawn picture: skip it.
    if (given === undefined) checkPlanar(m);
    this.source = m;
    this.iteration = m.iteration;
    const n = m.n;
    const E = m.edgeCount;
    const H = 2 * E;
    // half-edge h = 2e (a → b) or 2e+1 (b → a); tailOf(h) is where it starts
    const tailOf = (h: number): number => (h & 1 ? m.edgeList[2 * (h >> 1) + 1] : m.edgeList[2 * (h >> 1)]);
    const headOf = (h: number): number => tailOf(h ^ 1);
    // Outgoing half-edges per vertex, sorted by angle — one run of rows per
    // vertex inside one array, rather than an array per vertex. Each run is
    // filled in half-edge order and sorted in place, which is the order the
    // per-vertex lists had.
    const start = new Int32Array(n + 1);
    for (let h = 0; h < H; h++) start[tailOf(h) + 1]++;
    for (let v = 0; v < n; v++) start[v + 1] += start[v];
    const outgoing = new Int32Array(H);
    const cursor = Int32Array.from(start.subarray(0, n));
    for (let h = 0; h < H; h++) outgoing[cursor[tailOf(h)]++] = h;
    // The angle of a half-edge is fixed, and a comparison sort asks for it
    // O(log k) times per half-edge: work it out once. Same number, same
    // order.
    const angle = new Float64Array(H);
    for (let h = 0; h < H; h++) {
      const tail = tailOf(h);
      const head = headOf(h);
      angle[h] = Math.atan2(m.y[head] - m.y[tail], m.x[head] - m.x[tail]);
    }
    const pos = new Int32Array(H);
    // A vertex has a handful of edges, so the run is put in order where it
    // lies — no view object per vertex, and no comparator call. The order is
    // total (angle, then half-edge), so it is the one order a sort could
    // have produced. A vertex with many edges gets a real sort.
    for (let v = 0; v < n; v++) {
      const from = start[v];
      const to = start[v + 1];
      if (to - from > 32) {
        outgoing.subarray(from, to).sort((p, q) => angle[p] - angle[q] || p - q);
      } else {
        for (let k = from + 1; k < to; k++) {
          const h = outgoing[k];
          const a = angle[h];
          let j = k - 1;
          while (j >= from && (angle[outgoing[j]] > a || (angle[outgoing[j]] === a && outgoing[j] > h))) {
            outgoing[j + 1] = outgoing[j];
            j--;
          }
          outgoing[j + 1] = h;
        }
      }
      for (let k = from; k < to; k++) pos[outgoing[k]] = k - from;
    }
    const next = new Int32Array(H);
    for (let h = 0; h < H; h++) {
      const twin = h ^ 1;
      const v = tailOf(twin);
      const from = start[v];
      const len = start[v + 1] - from;
      next[h] = outgoing[from + ((pos[twin] - 1 + len) % len)];
    }
    // Faces named outright replace the walk, the containment and the
    // outside; everything below this block reads only what both paths fill.
    const { walks, faceWalk, holesOf, faceOf } = given !== undefined
      ? fromCycles(m, given, next, tailOf, headOf)
      : fromWalk(m, start, outgoing, next, tailOf, headOf);
    // views
    const edgeLength = (h: number) => Math.hypot(m.x[headOf(h)] - m.x[tailOf(h)], m.y[headOf(h)] - m.y[tailOf(h)]);
    const perimeterOf = (seq: number[]) => {
      const count = new Map<number, number>();
      for (const h of seq) count.set(h >> 1, (count.get(h >> 1) ?? 0) + 1);
      let p = 0;
      for (const [e, c] of count) if (c === 1) p += edgeLength(2 * e);
      return p;
    };
    const contoursOf = (w: Walk): IsoContour[] => w.cycles.map((cycle) => contourOf(cycle));
    const contourOf = (cycle: number[]): IsoContour => {
      const pts = cycle.map((h) => Object.freeze([m.x[tailOf(h)], m.y[tailOf(h)]] as [number, number]));
      return Object.freeze({ pts: Object.freeze(pts) as unknown as [number, number][], closed: true }) as IsoContour;
    };
    const views: Face[] = [];
    // Navigation per face reads the collection's incidence, like the
    // collection's own `edges`/`points`/`boundaryEdges` restricted to one face.
    const faceProto = Object.create(viewProto(this, 'face')) as Face;
    const collection = this;
    Object.defineProperties(faceProto, {
      edges: { get(this: Face) { return new EdgeSelection(m, collection.edgeRowsWhere((l, r) => l === this.index || r === this.index)); } },
      points: { get(this: Face) { return this.edges.points; } },
      boundaryEdges: { get(this: Face) { return new EdgeSelection(m, collection.edgeRowsWhere((l, r) => (l === this.index) !== (r === this.index))); } },
      adjacent: { get(this: Face) { return new FaceSelection(collection, collection.adjacentRows(new Set([this.index]))); } },
    });
    Object.freeze(faceProto);
    for (let f = 0; f < faceWalk.length; f++) {
      const fw = walks[faceWalk[f]];
      let area = fw.area;
      let perimeter = perimeterOf(fw.halfEdges);
      const contours = contoursOf(fw);
      for (const hw of holesOf[f]) {
        area += walks[hw].area; // negative
        perimeter += perimeterOf(walks[hw].halfEdges);
        contours.push(...contoursOf(walks[hw]));
      }
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const c of contours) for (const [x, y] of c.pts) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
      let ma = 0;
      let mx = 0;
      let my = 0;
      for (const c of contours) {
        const mo = contourMoment(c);
        ma += mo.a;
        mx += mo.cx * mo.a;
        my += mo.cy * mo.a;
      }
      const centroid: [number, number] = ma !== 0 ? [mx / ma, my / ma] : [NaN, NaN];
      const view = Object.assign(Object.create(faceProto) as Face, { index: f, area, perimeter, bounds: Object.freeze({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }), centroid: Object.freeze(centroid) as unknown as [number, number] });
      // The contours are the face's own, but `contours()` is a call, like
      // every other area value's: it hangs off the view without joining the
      // view's data keys, so a face still spreads and serialises as the
      // plain record it is.
      const held = Object.freeze(contours) as unknown as IsoContour[];
      Object.defineProperty(view, 'contours', { value: () => held });
      views.push(view);
    }
    this.faces = Object.freeze(views);
    this.next = next;
    this.faceOf = faceOf;
    this.keyBox = { keys: null };
    // Face columns read flat, the way a vertex's do: `face.height`. The
    // values are keyed by the face's walls, so they are found once the
    // keys are known, and then baked onto the frozen view.
    const columns = Object.entries(m.faceAttrs);
    if (columns.length > 0) {
      const keys = this.keys();
      // A face whose walls are unchanged finds its value by key. A face
      // whose boundary moved inherits from the old face it shares the most
      // walls with — that is what `'nearest'` means for a thing that has no
      // position of its own — and `'drop'` lets a column stop at a boundary
      // change rather than follow it.
      const wallsOf = (key: string): string[] => (key === '' ? [] : key.split(','));
      // An index from WALL to the old keys that hold it, built once per
      // column. The straight reading — re-split every stored key for every
      // new face — is quadratic in the face count and was measured at
      // 621 ms for 1800 new faces against 29 ms for the rest of the work.
      // `order` keeps the map's own insertion order so the tie between two
      // old faces sharing the same number of walls breaks the way it always
      // did: the earliest written wins.
      const indexed = new Map<FaceColumn, { byWall: Map<string, string[]>; order: Map<string, number> }>();
      const indexOf = (column: FaceColumn) => {
        let built = indexed.get(column);
        if (built) return built;
        built = { byWall: new Map<string, string[]>(), order: new Map<string, number>() };
        let at = 0;
        for (const key of column.values.keys()) {
          built.order.set(key, at++);
          for (const w of wallsOf(key)) {
            const held = built.byWall.get(w);
            if (held) held.push(key);
            else built.byWall.set(w, [key]);
          }
        }
        indexed.set(column, built);
        return built;
      };
      for (let f = 0; f < views.length; f++) {
        const mine = wallsOf(keys[f]);
        for (const [name, column] of columns) {
          let value = column.values.get(keys[f]);
          // Only a face that appeared AFTER the column was written
          // inherits. A face the write saw and passed by has no value, and
          // taking a neighbour's would be the column spreading on its own.
          const isNew = !column.seen.has(keys[f]);
          if (value === undefined && isNew && column.transfer === 'nearest' && mine.length > 0) {
            const { byWall, order } = indexOf(column);
            // Only the old faces that share at least one wall are counted,
            // and each is reached through the walls this face actually has.
            const shared = new Map<string, number>();
            for (const w of mine) for (const key of byWall.get(w) ?? []) shared.set(key, (shared.get(key) ?? 0) + 1);
            let best = 0;
            let bestAt = Infinity;
            for (const [key, count] of shared) {
              const at = order.get(key)!;
              if (count > best || (count === best && at < bestAt)) {
                best = count;
                bestAt = at;
                value = column.values.get(key);
              }
            }
          }
          const settled = value ?? column.fallback;
          if (settled === undefined) continue; // a face this column never reached
          Object.defineProperty(views[f], name, { value: settled, enumerable: true });
        }
      }
    }
    for (const view of views) Object.freeze(view);
    Object.freeze(this);
  }

  /**
   * A key per face: the lineage roots of its boundary walls, sorted, joined.
   *
   * It is the walls that say which face this is. Two states of the same
   * material give a face the same key when its boundary is made of the same
   * walls, whatever the rows were renumbered to, and a wall that was merely
   * subdivided still counts — that is what the root is for.
   *
   * Built in ONE pass over `faceOf`: for each edge, if its two sides differ,
   * that edge is a wall of each side that is a face. Asking each face for
   * its `boundaryEdges` instead would be an O(E) scan per face.
   */
  keys(): readonly string[] {
    if (this.keyBox.keys) return this.keyBox.keys;
    const walls: number[][] = this.faces.map(() => []);
    const roots = this.source.edgeRoots;
    for (let e = 0; e < this.faceOf.length / 2; e++) {
      const l = this.faceOf[2 * e];
      const r = this.faceOf[2 * e + 1];
      if (l === r) continue; // inside a face, not a wall of it
      if (l >= 0) walls[l].push(roots[e]);
      if (r >= 0) walls[r].push(roots[e]);
    }
    // A wall cut in half is still one wall: the key is the SET of walls, so
    // a root that appears twice counts once. Without this, subdividing a
    // boundary would change the key of a face nothing else touched.
    const keys = walls.map(faceKeyOf);
    this.keyBox.keys = keys;
    return keys;
  }

  /** This face's key: the walls it is made of. */
  keyOf(face: Face): string {
    return this.keys()[face.index];
  }

  get length(): number {
    return this.faces.length;
  }

  at(i: number): Face {
    const f = this.faces[i];
    if (!Number.isInteger(i) || !f) throw new Error(`faces.at: no member ${i} (${this.faces.length} members)`);
    return f;
  }

  [Symbol.iterator](): Iterator<Face> {
    return this.faces[Symbol.iterator]();
  }

  map<T>(fn: (f: Face, index: number) => T): T[] {
    return this.faces.map(fn);
  }

  forEach(fn: (f: Face, index: number) => void): void {
    this.faces.forEach(fn);
  }

  find(fn: (f: Face, index: number) => boolean): Face | undefined {
    return this.faces.find(fn);
  }

  some(fn: (f: Face, index: number) => boolean): boolean {
    return this.faces.some(fn);
  }

  every(fn: (f: Face, index: number) => boolean): boolean {
    return this.faces.every(fn);
  }

  /** The faces on the two sides of a source edge: two for a wall between
   * cells, one for a wall on the outside or a spur inside a face, none
   * for an edge no face touches. The edge must be a view of the source
   * state. */
  /** @internal Use `edge.faces`. */
  facesOf(edge: Edge): Face[] {
    if (viewKind(edge) !== 'edge') throw new Error('faces.facesOf: expected an edge view');
    if (!ownedBy(edge, this.source)) throw new Error('faces.facesOf: that edge belongs to another state — take it from the material these faces were read from');
    const l = this.faceOf[2 * edge.index];
    const r = this.faceOf[2 * edge.index + 1];
    const out: Face[] = [];
    if (l >= 0) out.push(this.faces[l]);
    if (r >= 0 && r !== l) out.push(this.faces[r]);
    return out;
  }

  /** True when `face` is a view of this collection. */
  has(face: Face): boolean {
    if (viewKind(face) !== 'face') throw new Error('faces.has: expected a face view');
    return ownedBy(face, this);
  }

  /** @internal Rows of the faces across a wall from any of `selected`,
   * the members THEMSELVES EXCLUDED: one hop out, the meaning `adjacent`
   * has everywhere. Two selected faces sharing a wall name each other's
   * outside, not each other. */
  adjacentRows(selected: Set<number>): number[] {
    const out = new Set<number>();
    for (let e = 0; e < this.faceOf.length / 2; e++) {
      const l = this.faceOf[2 * e];
      const r = this.faceOf[2 * e + 1];
      if (l === r) continue;
      if (selected.has(l) && r >= 0 && !selected.has(r)) out.add(r);
      if (selected.has(r) && l >= 0 && !selected.has(l)) out.add(l);
    }
    return [...out].sort((p, q) => p - q);
  }

  /** @internal Edge rows chosen by the faces on their two sides
   * (`faceOf` of each half-edge, -1 outside). */
  edgeRowsWhere(pick: (left: number, right: number) => boolean): number[] {
    const rows: number[] = [];
    for (let e = 0; e < this.faceOf.length / 2; e++) if (pick(this.faceOf[2 * e], this.faceOf[2 * e + 1])) rows.push(e);
    return rows;
  }

  /** Every source edge incident to a bounded face, once: the walls, and
   * any dangling edge lying inside a face (both its sides are that face). */
  get edges(): EdgeSelection {
    return new EdgeSelection(this.source, this.edgeRowsWhere((l, r) => l >= 0 || r >= 0));
  }

  /** Endpoints of `edges`, once, in row order. */
  get points(): PointSelection {
    return this.edges.points;
  }

  /** Edges separating the union of all bounded faces from the outside:
   * walls between two faces and edges inside a face are not boundary. */
  boundaryEdges(): EdgeSelection {
    return new EdgeSelection(this.source, this.edgeRowsWhere((l, r) => (l >= 0) !== (r >= 0)));
  }

  /** Measure every face: geometric area and centroid, and with `field` its
   * integral, mean and density-weighted centre (see measure.ts). */
  measure(field?: (x: number, y: number) => number, opts?: MeasureOpts): FaceMeasurements {
    return measureFaces(this, this.faces, field, opts);
  }

  /**
   * The faces the given places fall in: one point, or a cloud of them.
   *
   * A place inside a face selects it; a place ON a wall selects nothing,
   * because a wall is where two faces stop rather than somewhere either
   * one holds; a place outside every face selects nothing. Several places
   * in the same face still name it once — a selection is a set. A face
   * with a hole does not hold what sits in the hole: the hole's own face
   * does.
   */
  containing(where: XY | PointsLike): FaceSelection {
    const rows: number[] = [];
    for (const [x, y] of queryPoints(where, 'faces.containing')) {
      const f = faceHolding(this.faces, x, y);
      if (f >= 0) rows.push(f);
    }
    return new FaceSelection(this, rows);
  }

  /** The faces `fn` picks — membership decided now and fixed. */
  filter(fn: (f: Face, index: number) => boolean): FaceSelection {
    const rows: number[] = [];
    this.faces.forEach((f, i) => { if (fn(f, i)) rows.push(f.index); });
    return new FaceSelection(this, rows);
  }

  /** Split the faces into selections by key: first-occurrence order. */
  groupBy<G>(classify: (f: Face, index: number) => G): FaceSelection<G>[] {
    return groupRows(this.faces, (f) => f.index, classify).map(({ key, rows }) => new FaceSelection(this, rows, key));
  }

  /** Closed contours around the union of every bounded face: inner walls
   * gone, holes against the outside kept. The same boundary as
   * `boundaryEdges()`, as loops a consumer of areas reads directly. */
  contours(): IsoContour[] {
    return this.filter(() => true).contours();
  }

  /** @internal Closed contours around the union of the given faces. A
   * half-edge is a boundary when its face is selected and its twin's is
   * not; contours follow face walks, rotating through selected faces at
   * a vertex, so regions touching at a point stay separate contours. */
  boundaryContours(selected: Set<number>): IsoContour[] {
    const m = this.source;
    const H = this.faceOf.length;
    const tailOf = (h: number): number => (h & 1 ? m.edgeList[2 * (h >> 1) + 1] : m.edgeList[2 * (h >> 1)]);
    const isBoundary = (h: number) => selected.has(this.faceOf[h]) && !selected.has(this.faceOf[h ^ 1]);
    const used = new Uint8Array(H);
    const out: IsoContour[] = [];
    for (let h0 = 0; h0 < H; h0++) {
      if (used[h0] || !isBoundary(h0)) continue;
      const seq: number[] = [];
      let h = h0;
      do {
        used[h] = 1;
        seq.push(h);
        let g = this.next[h];
        while (!isBoundary(g)) g = this.next[g ^ 1];
        h = g;
      } while (h !== h0);
      // a walk through a vertex twice (holes touching at a corner) is two contours, not a figure eight
      for (const cycle of splitWalk(seq, tailOf)) out.push({ pts: cycle.map((g) => [m.x[tailOf(g)], m.y[tailOf(g)]] as [number, number]), closed: true });
    }
    return out;
  }
}

/** Faces of one collection chosen by a filter; membership is fixed. A
 * selection is itself a face collection: iterate, `length`, `at`, `map`,
 * `filter`, `groupBy`; `key` is set on the selections `groupBy` makes. */
export class FaceSelection<K = undefined> implements Iterable<Face> {
  /** The exact face collection selected from. */
  readonly source: Faces;
  readonly indices: readonly number[];
  readonly key: K;
  private readonly set: Set<number>;

  /** @internal Use `faces.filter(pred)`. */
  constructor(source: Faces, indices: Iterable<number>, key?: K) {
    this.source = source;
    this.indices = Object.freeze(Array.from(new Set(indices)).sort((p, q) => p - q));
    this.set = new Set(this.indices);
    this.key = key as K;
    Object.freeze(this);
  }

  get length(): number {
    return this.indices.length;
  }

  get iteration(): number {
    return this.source.iteration;
  }

  at(i: number): Face {
    const row = this.indices[i];
    if (!Number.isInteger(i) || row === undefined) throw new Error(`faces.at: no member ${i} (${this.indices.length} members)`);
    return this.source.faces[row];
  }

  *[Symbol.iterator](): Iterator<Face> {
    for (const i of this.indices) yield this.source.faces[i];
  }

  map<T>(fn: (f: Face, index: number) => T): T[] {
    return this.indices.map((row, i) => fn(this.source.faces[row], i));
  }

  forEach(fn: (f: Face, index: number) => void): void {
    this.indices.forEach((row, i) => fn(this.source.faces[row], i));
  }

  find(fn: (f: Face, index: number) => boolean): Face | undefined {
    let i = 0;
    for (const f of this) if (fn(f, i++)) return f;
    return undefined;
  }

  some(fn: (f: Face, index: number) => boolean): boolean {
    return this.find(fn) !== undefined;
  }

  every(fn: (f: Face, index: number) => boolean): boolean {
    let i = 0;
    for (const f of this) if (!fn(f, i++)) return false;
    return true;
  }

  filter(fn: (f: Face, index: number) => boolean): FaceSelection<K> {
    const rows: number[] = [];
    let i = 0;
    for (const f of this) if (fn(f, i++)) rows.push(f.index);
    return new FaceSelection(this.source, rows, this.key);
  }

  groupBy<G>(classify: (f: Face, index: number) => G): FaceSelection<G>[] {
    return groupRows(this, (f) => f.index, classify).map(({ key, rows }) => new FaceSelection(this.source, rows, key));
  }

  /** The MEMBERS the given places fall in — the collection's `containing`
   * narrowed to this selection. A place in a face outside the selection
   * picks nothing. */
  containing(where: XY | PointsLike): FaceSelection<K> {
    const mine = this.set;
    const rows: number[] = [];
    for (const [x, y] of queryPoints(where, 'faces.containing')) {
      const f = faceHolding(this.source.faces, x, y);
      if (f >= 0 && mine.has(f)) rows.push(f);
    }
    return new FaceSelection(this.source, rows, this.key);
  }

  /** Every source edge incident to a selected face, once, including
   * internal walls between two selected faces and dangling edges inside
   * a selected face. */
  get edges(): EdgeSelection {
    const sel = this.set;
    return new EdgeSelection(this.source.source, this.source.edgeRowsWhere((l, r) => sel.has(l) || sel.has(r)));
  }

  /** Endpoints of `edges`, once, in row order. */
  get points(): PointSelection {
    return this.edges.points;
  }

  /** The faces across the walls of any selected face, one hop out, the
   * members excluded. Two selected faces sharing a wall are each other's
   * inside, not each other's neighbour; `sel.union(sel.adjacent())` is the
   * selection grown by a ring, and says so. */
  adjacent(): FaceSelection {
    return new FaceSelection(this.source, this.source.adjacentRows(this.set));
  }

  /** Edges between the selected union and its exterior: a wall with a
   * selected face on exactly one side. Walls between two selected faces
   * and edges inside a face are excluded; a hole's boundary stays. */
  boundaryEdges(): EdgeSelection {
    const sel = this.set;
    return new EdgeSelection(this.source.source, this.source.edgeRowsWhere((l, r) => sel.has(l) !== sel.has(r)));
  }

  /** Measure the selected faces (see `Faces.measure`). */
  measure(field?: (x: number, y: number) => number, opts?: MeasureOpts): FaceMeasurements {
    return measureFaces(this.source, this.indices.map((i) => this.source.faces[i]), field, opts);
  }

  /** True when `face` is a selected view OF THIS COLLECTION. */
  has(face: Face): boolean {
    const kind = viewKind(face);
    if (kind === 'vertex' || kind === 'edge') throw new Error(`selection.has: this is a face selection; ${kind === 'vertex' ? 'a vertex' : 'an edge'} view cannot be a member`);
    if (kind !== 'face') throw new Error('selection.has: expected a face view');
    return ownedBy(face, this.source) && this.set.has(face.index);
  }

  private same(other: FaceSelection<unknown>, what: string): void {
    if (!(other instanceof FaceSelection)) throw new Error(`selection.${what}: a face selection combines only with a face selection`);
    if (other.source !== this.source) throw new Error(`selection.${what}: the two selections come from different face collections`);
  }

  union(other: FaceSelection<unknown>): FaceSelection {
    this.same(other, 'union');
    return new FaceSelection(this.source, [...this.indices, ...other.indices]);
  }

  intersect(other: FaceSelection<unknown>): FaceSelection {
    this.same(other, 'intersect');
    return new FaceSelection(this.source, this.indices.filter((i) => other.set.has(i)));
  }

  subtract(other: FaceSelection<unknown>): FaceSelection {
    this.same(other, 'subtract');
    return new FaceSelection(this.source, this.indices.filter((i) => !other.set.has(i)));
  }

  /** Closed contours around the union of the selected faces: walls between
   * two selected faces vanish, walls against an unselected face or the
   * outside stay, holes stay holes. Empty selection, no contours. The same
   * boundary as `boundaryEdges()`, as loops. */
  contours(): IsoContour[] {
    if (this.length === 0) return [];
    return this.source.boundaryContours(this.set);
  }
}

/** Faces of a planar material — `material.faces()` as a function. */
export function faces(m: Material): Faces {
  return new Faces(m);
}

/**
 * The faces of a material that KNOWS its own topology, from explicit
 * cycles: each a closed run of vertex rows around one face, all turning
 * the same way, a wall's interior samples included in the run.
 *
 * The planarity check and the angular walk are skipped, because neither is
 * a question about the picture the cycles already answer. A half-edge no
 * cycle claims is outside; on a closed surface there is none.
 */
export function facesFromCycles(m: Material, cycles: readonly (readonly number[])[]): Faces {
  return new Faces(m, cycles);
}
