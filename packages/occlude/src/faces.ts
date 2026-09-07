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
import { Material, brandView, inheritEdge, ownedBy, viewKind, type ChildInterval, type Edge } from './material.js';
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
function positionHash(x: number, y: number): number {
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

/** Exact classification of one pair of segments that share no vertex. */
function classify(s: Seg, u: Seg, out: Event[]): void {
  const o1 = orient2d(s.ax, s.ay, s.bx, s.by, u.ax, u.ay);
  const o2 = orient2d(s.ax, s.ay, s.bx, s.by, u.bx, u.by);
  const o3 = orient2d(u.ax, u.ay, u.bx, u.by, s.ax, s.ay);
  const o4 = orient2d(u.ax, u.ay, u.bx, u.by, s.bx, s.by);
  if (o1 === 0 && o2 === 0) {
    // collinear: any positive-length overlap is rejected; point contact means coincident endpoints (merged earlier)
    const dx = s.bx - s.ax;
    const dy = s.by - s.ay;
    const l2 = dx * dx + dy * dy;
    const p = ((u.ax - s.ax) * dx + (u.ay - s.ay) * dy) / l2;
    const q = ((u.bx - s.ax) * dx + (u.by - s.ay) * dy) / l2;
    const lo = Math.min(p, q);
    const hi = Math.max(p, q);
    if (hi > 0 && lo < 1) throw new Error(`planarize: edges ${s.row} and ${u.row} overlap along a positive length — collinear overlaps are not supported; repair the input`);
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
    const ti = o3 / (o3 - o4);
    const tj = o1 / (o1 - o2);
    out.push({ kind: 'cross', i: s.row, ti, j: u.row, tj, x: s.ax + (s.bx - s.ax) * ti, y: s.ay + (s.by - s.ay) * ti });
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
    throw new Error(`planarize: edges ${s.row} and ${u.row} overlap along a positive length from vertex ${shared} — collinear overlaps are not supported; repair the input`);
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
  const byPos = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    if (!participates[i]) continue;
    const k = `${m.x[i]},${m.y[i]}`;
    const list = byPos.get(k) ?? [];
    list.push(i);
    byPos.set(k, list);
  }
  const mergedRows = new Map<number, number[]>(); // representative → every row merged into it
  for (const rows of byPos.values()) {
    if (rows.length < 2) continue;
    const r = rows[0];
    for (const i of rows) rep[i] = r;
    mergedRows.set(r, rows);
  }

  // ---- segments on representatives; duplicate pairs are overlaps ----
  const segs: Seg[] = [];
  const seenPair = new Map<string, number>();
  for (let e = 0; e < E; e++) {
    const a = rep[m.edgeList[2 * e]];
    const b = rep[m.edgeList[2 * e + 1]];
    if (a === b) throw new Error(`planarize: edge ${e} joins two coincident endpoints — a zero-length edge after merging`);
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    const dup = seenPair.get(key);
    if (dup !== undefined) throw new Error(`planarize: edges ${dup} and ${e} are the same segment — duplicate edges are overlaps and are not supported`);
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
  const crossOf = new Map<string, number>(); // "i,j" (i < j) → event
  const contactOf = new Map<string, number>(); // "vertex,edge" → event
  const contactsAt = new Map<number, number[]>(); // vertex → its contact events
  for (let k = 0; k < events.length; k++) {
    const ev = events[k];
    if (ev.kind === 'cross') crossOf.set(`${ev.i},${ev.j}`, k);
    else {
      contactOf.set(`${ev.vertex},${ev.edge}`, k);
      const list = contactsAt.get(ev.vertex) ?? [];
      list.push(k);
      contactsAt.set(ev.vertex, list);
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
      const bc = crossOf.get(b < c ? `${b},${c}` : `${c},${b}`);
      if (bc === undefined) return false;
      return near(paramOf(bc, b), paramOf(p, b)) && near(paramOf(bc, c), paramOf(q, c));
    }
    const contact = (ep.kind === 'contact' ? ep : eq) as Extract<Event, { kind: 'contact' }>;
    const cross = ep.kind === 'contact' ? q : p;
    const b = otherEdge(cross, edge);
    const onB = contactOf.get(`${contact.vertex},${b}`);
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
  for (let i = 0; i < n; i++) {
    if (rep[i] !== i) continue;
    rowMap[i] = ox.length;
    ox.push(m.x[i]);
    oy.push(m.y[i]);
    const resolved = resolvedAttrs.get(i);
    for (const name of names) oattrs[name].push(resolved ? resolved[name] : m.attrs[name][i]);
  }
  const roots = Array.from(new Set(parent.map((_, g) => find(g)))).filter((g) => !groupVertex.has(g));
  roots.sort((a, b) => groupKey.get(a)![0] - groupKey.get(b)![0] || groupKey.get(a)![1] - groupKey.get(b)![1]);
  const groupRow = new Map<number, number>();
  for (const g of roots) {
    const mentions = groupEdges.get(g)!.slice().sort((p, q) => p.edge - q.edge || p.t - q.t);
    const seen = new Set<number>();
    const candidates: EventCandidate[] = [];
    for (const { edge, t } of mentions) {
      if (seen.has(edge)) continue;
      seen.add(edge);
      candidates.push({ edge, t, attrs: interpolateAttrs(m, segs[edge].a, segs[edge].b, t) });
    }
    const pos = groupPos.get(g)!;
    const event: PlanarEvent = { position: pos, candidates };
    const attrs = names.length ? reconcile(m, event, opts.point, 'the crossing') : {};
    groupRow.set(g, ox.length);
    ox.push(pos[0]);
    oy.push(pos[1]);
    for (const name of names) oattrs[name].push(attrs[name]);
  }
  const rowOfGroup = (g: number): number => {
    const r = find(g);
    const v = groupVertex.get(r);
    return v !== undefined ? rowMap[rep[v]] : groupRow.get(r)!;
  };

  // ---- child edges in parent, parameter order ----
  const edges: number[] = [];
  const eattrs: Record<string, number[]> = {};
  for (const name of enames) eattrs[name] = [];
  for (let e = 0; e < E; e++) {
    const s = segs[e];
    const stops: { t: number; row: number }[] = [{ t: 0, row: rowMap[s.a] }];
    let lastGroup = -1;
    for (const c of cutsByEdge[e].sort((p, q) => p.t - q.t)) {
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
    const parentView = m.edge(e);
    const parentAttrs: Record<string, number> = {};
    for (const name of enames) parentAttrs[name] = m.edgeAttrs[name][e];
    for (let k = 0; k + 1 < stops.length; k++) {
      const child: ChildInterval = { from: stops[k].t, to: stops[k + 1].t, fraction: stops[k + 1].t - stops[k].t };
      const extra = opts.edges ? opts.edges(parentView, child) : {};
      for (const name in extra) {
        if (!enames.includes(name)) throw new Error(`planarize: no edge attribute '${name}' — declare it with edgeAttribute()`);
        if (!Number.isFinite(extra[name])) throw new Error(`planarize: '${name}' for a child edge is not a finite number`);
      }
      edges.push(stops[k].row, stops[k + 1].row);
      const inherited = inheritEdge(m, parentAttrs, child.fraction);
      for (const name of enames) eattrs[name].push(name in extra ? extra[name] : inherited[name]);
    }
  }
  const attrs: Record<string, Float64Array> = {};
  for (const name of names) attrs[name] = Float64Array.from(oattrs[name]);
  const edgeAttrs: Record<string, Float64Array> = {};
  for (const name of enames) edgeAttrs[name] = Float64Array.from(eattrs[name]);
  return new Material(Float64Array.from(ox), Float64Array.from(oy), attrs, Uint32Array.from(edges), 0, [], edgeAttrs, { ...m.transfers }, { ...m.edgeTransfers });
}

// ---- faces ----------------------------------------------------------------------------

/** A bounded region of one planar state, read-only. */
export interface Face {
  /** Row in the face collection it came from — not an identity. */
  index: number;
  /** Filled area in squared material units: outer minus holes. */
  area: number;
  /** Outer and hole boundaries; retraced bridges and branches excluded. */
  perimeter: number;
  bounds: { x: number; y: number; w: number; h: number };
  /** Closed contours: the outer boundary with positive signed area
   * (counter-clockwise in a y-up reading), holes negative. Bridges and
   * branches inside the face are not part of them. */
  contours: IsoContour[];
}

interface Walk {
  halfEdges: number[]; // in walk order
  area: number; // signed shoelace of the raw walk
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

/** The bounded faces of one planar state, with selections over them. */
export class Faces {
  readonly source: Material;
  readonly iteration: number;
  /** Face views, by index. */
  readonly faces: readonly Face[];
  /** @internal */ readonly next: Int32Array; // face-walk successor of a half-edge
  /** @internal */ readonly faceOf: Int32Array; // face index on a half-edge's left, -1 outside

  /** @internal Use `material.faces()`. */
  constructor(m: Material) {
    checkPlanar(m);
    this.source = m;
    this.iteration = m.iteration;
    const n = m.n;
    const E = m.edgeCount;
    const H = 2 * E;
    // half-edge h = 2e (a → b) or 2e+1 (b → a); tailOf(h) is where it starts
    const tailOf = (h: number): number => (h & 1 ? m.edgeList[2 * (h >> 1) + 1] : m.edgeList[2 * (h >> 1)]);
    const headOf = (h: number): number => tailOf(h ^ 1);
    // outgoing half-edges per vertex, sorted by angle
    const outgoing: number[][] = Array.from({ length: n }, () => []);
    for (let h = 0; h < H; h++) outgoing[tailOf(h)].push(h);
    const angle = (h: number) => Math.atan2(m.y[headOf(h)] - m.y[tailOf(h)], m.x[headOf(h)] - m.x[tailOf(h)]);
    const pos = new Int32Array(H);
    for (let v = 0; v < n; v++) {
      const list = outgoing[v];
      list.sort((p, q) => angle(p) - angle(q) || p - q);
      for (let k = 0; k < list.length; k++) pos[list[k]] = k;
    }
    const next = new Int32Array(H);
    for (let h = 0; h < H; h++) {
      const twin = h ^ 1;
      const list = outgoing[tailOf(twin)];
      next[h] = list[(pos[twin] - 1 + list.length) % list.length];
    }
    // components over vertices
    const comp = new Int32Array(n).fill(-1);
    let comps = 0;
    const adjRows = outgoing;
    for (let v = 0; v < n; v++) {
      if (comp[v] !== -1 || adjRows[v].length === 0) continue;
      const stack = [v];
      comp[v] = comps;
      while (stack.length) {
        const u = stack.pop()!;
        for (const h of adjRows[u]) {
          const w = headOf(h);
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
      let area = 0;
      const x0 = m.x[tailOf(h0)]; // shoelace about a local origin: absolute coordinates cancel to zero far from (0, 0)
      const y0 = m.y[tailOf(h0)];
      do {
        walkOf[h] = walks.length;
        seq.push(h);
        const a = tailOf(h);
        const b = headOf(h);
        area += (m.x[a] - x0) * (m.y[b] - y0) - (m.x[b] - x0) * (m.y[a] - y0);
        h = next[h];
      } while (h !== h0);
      walks.push({ halfEdges: seq, area: area / 2, comp: comp[tailOf(h0)] });
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
    // views
    const edgeLength = (h: number) => Math.hypot(m.x[headOf(h)] - m.x[tailOf(h)], m.y[headOf(h)] - m.y[tailOf(h)]);
    const perimeterOf = (seq: number[]) => {
      const count = new Map<number, number>();
      for (const h of seq) count.set(h >> 1, (count.get(h >> 1) ?? 0) + 1);
      let p = 0;
      for (const [e, c] of count) if (c === 1) p += edgeLength(2 * e);
      return p;
    };
    const contoursOf = (seq: number[]): IsoContour[] => splitWalk(seq, tailOf).map((cycle) => contourOf(cycle));
    const contourOf = (cycle: number[]): IsoContour => {
      const pts = cycle.map((h) => Object.freeze([m.x[tailOf(h)], m.y[tailOf(h)]] as [number, number]));
      return Object.freeze({ pts: Object.freeze(pts) as unknown as [number, number][], closed: true }) as IsoContour;
    };
    const views: Face[] = [];
    for (let f = 0; f < faceWalk.length; f++) {
      const fw = walks[faceWalk[f]];
      let area = fw.area;
      let perimeter = perimeterOf(fw.halfEdges);
      const contours = contoursOf(fw.halfEdges);
      for (const hw of holesOf[f]) {
        area += walks[hw].area; // negative
        perimeter += perimeterOf(walks[hw].halfEdges);
        contours.push(...contoursOf(walks[hw].halfEdges));
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
      const view: Face = { index: f, area, perimeter, bounds: Object.freeze({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }), contours: Object.freeze(contours) as unknown as IsoContour[] };
      brandView(view, this, 'face');
      Object.freeze(view);
      views.push(view);
    }
    this.faces = Object.freeze(views);
    this.next = next;
    this.faceOf = faceOf;
    Object.freeze(this);
  }

  get size(): number {
    return this.faces.length;
  }

  map<T>(fn: (f: Face, index: number) => T): T[] {
    return this.faces.map(fn);
  }

  /** True when `face` is a view of this collection. */
  has(face: Face): boolean {
    if (viewKind(face) !== 'face') throw new Error('faces.has: expected a face view');
    return ownedBy(face, this);
  }

  /** The faces `where` picks — membership decided now and fixed. */
  select(where: (f: Face) => boolean): FaceSelection {
    const rows: number[] = [];
    for (const f of this.faces) if (where(f)) rows.push(f.index);
    return new FaceSelection(this, rows);
  }

  /** Outline of the union of every bounded face: inner walls gone, holes
   * against the outside kept. */
  boundaries(): IsoContour[] {
    return this.select(() => true).boundaries();
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

/** Faces of one collection chosen by a predicate; membership is fixed. */
export class FaceSelection {
  /** The exact face collection selected from. */
  readonly source: Faces;
  readonly indices: readonly number[];
  private readonly set: Set<number>;

  /** @internal Use `faces.select(pred)`. */
  constructor(source: Faces, indices: Iterable<number>) {
    this.source = source;
    this.indices = Object.freeze(Array.from(new Set(indices)).sort((p, q) => p - q));
    this.set = new Set(this.indices);
    Object.freeze(this);
  }

  get size(): number {
    return this.indices.length;
  }

  get iteration(): number {
    return this.source.iteration;
  }

  /** The selected faces as the collection's own views. */
  get faces(): Face[] {
    return this.indices.map((i) => this.source.faces[i]);
  }

  map<T>(fn: (f: Face, index: number) => T): T[] {
    return this.faces.map(fn);
  }

  /** True when `face` is a selected view OF THIS COLLECTION. */
  has(face: Face): boolean {
    const kind = viewKind(face);
    if (kind === 'vertex' || kind === 'edge') throw new Error(`selection.has: this is a face selection; ${kind === 'vertex' ? 'a vertex' : 'an edge'} view cannot be a member`);
    if (kind !== 'face') throw new Error('selection.has: expected a face view');
    return ownedBy(face, this.source) && this.set.has(face.index);
  }

  private same(other: FaceSelection, what: string): void {
    if (!(other instanceof FaceSelection)) throw new Error(`selection.${what}: a face selection combines only with a face selection`);
    if (other.source !== this.source) throw new Error(`selection.${what}: the two selections come from different face collections`);
  }

  union(other: FaceSelection): FaceSelection {
    this.same(other, 'union');
    return new FaceSelection(this.source, [...this.indices, ...other.indices]);
  }

  intersect(other: FaceSelection): FaceSelection {
    this.same(other, 'intersect');
    return new FaceSelection(this.source, this.indices.filter((i) => other.set.has(i)));
  }

  subtract(other: FaceSelection): FaceSelection {
    this.same(other, 'subtract');
    return new FaceSelection(this.source, this.indices.filter((i) => !other.set.has(i)));
  }

  /** Closed contours around the union of the selected faces: walls between
   * two selected faces vanish, walls against an unselected face or the
   * outside stay, holes stay holes. Empty selection, no contours. */
  boundaries(): IsoContour[] {
    if (this.size === 0) return [];
    return this.source.boundaryContours(this.set);
  }
}

/** Faces of a planar material — `material.faces()` as a function. */
export function faces(m: Material): Faces {
  return new Faces(m);
}
