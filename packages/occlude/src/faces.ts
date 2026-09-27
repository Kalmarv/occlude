/**
 * Planarization, faces and boundaries over a material's sampled edges.
 *
 * `planarize(m)` makes every crossing and endpoint-on-edge contact a shared
 * vertex — explicitly, because the author asked. `m.faces` is a property:
 * the faces of that one state, worked out the first time it is read. A
 * word that knows its faces states them (a tiling, a grid, Voronoi cells,
 * a quadtree, in the order it made them, nested where it nests); any other
 * material's faces are read off the drawn picture by the planar walk
 * below. A face view has an area, a perimeter, bounds, closed contours the
 * drawing operations accept, its place in a hierarchy and what it came
 * from. Face selections pick faces with the same words as point and edge
 * selections, and `contours()` outlines the union of selected faces with
 * the walls between them removed.
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
import { mintIds, Material, materialFromParts, referenced, withFaces, type Edge, type Vertex, type FaceColumn, type PointsLike } from './material.js';
import { faceWords3 } from './three/api/words.js';
import { curvesOfRows, type Curve } from './curves.js';
import { writeFaces, writeFaceColumns, rebuild, PointRows, EdgeRows, type CellValue, type FaceSetOpts, type FaceRecordSetOpts } from './tables.js';
import { box, type Box } from './layout.js';
import type { XY } from './vec.js';
import { edgesOf, pointsOf, endpointRows, sameLineage } from './relation.js';
import { ownedBy, ownerOf, viewKind, viewProto, describe } from './views.js';
import { Selection, select, domainKind, isSelectionOf, rowRange, type Domain, type DomainKind, type Types, ROW_TYPES } from './selection.js';
import { contourMoment, curvedSpaceOf, measureFaces, spaceArea, spacePerimeter, type MeasureOpts } from './measure.js';
import type { IsoContour } from './isolines.js';
import { Column, at64, columnOf, kindOf, type AnyColumn, type ColumnLike } from './column.js';
import { carryLinks, derivation, linkRows, record, type RowSource } from './derivation.js';
import type { Placement } from './placement.js';
import { cornerIndex, cornersOfFaces, type Corner } from './corners.js';
import { triangulate } from './three/geometry/mesh3.js';

/** What a face came from, in the shape the word that made it says: a row
 * or a selection of the input (a Voronoi cell its site, a quadtree cell the
 * points it holds, a 3D face the face, edge or point it was made from), a
 * list of those when it came from several inputs, or a tile's placement.
 * Undefined for a face read off the drawn picture. */
export type FaceSource = RowSource | Placement;

const EVENT_TOL = 1e-9;

// ---- planarize ----------------------------------------------------------------------

/**
 * One source of a point at an event, a row like every other row: its point
 * columns read flat (`c.age`), beside its own words. A vertex that is there
 * already answers `vertex`, and its columns are its own. A point read along
 * an edge answers `edge` and `t`, its parameter from `edge.a` to `edge.b`,
 * and its columns are the edge's ends read `t` of the way along, by each
 * column's transfer. The views are of the value the word read.
 */
export type EventCandidate = {
  readonly vertex?: Vertex;
  readonly edge?: Edge;
  readonly t?: number;
} & { readonly [column: string]: number };

export interface PlanarEvent {
  position: [number, number];
  /** Deterministic: vertices first, in row order, then edges in row order. */
  candidates: EventCandidate[];
}

/** The words an event candidate answers of its own. A point column of one
 * of these names would read flat beside it, so `c.t` would mean two things. */
const CANDIDATE_WORDS: ReadonlySet<string> = new Set(['vertex', 'edge', 't']);

/**
 * @internal Refuse, by name, a point column that an event candidate would
 * read beside a word of its own. Asked where candidates are built — where a
 * `point` resolver is given, whatever the geometry, so one seed does not
 * pass where another throws. A column named `t` on a value that no resolver
 * reads is not a mistake.
 */
export function checkCandidateColumns(names: Iterable<string>, who: string): void {
  for (const name of names) {
    if (CANDIDATE_WORDS.has(name)) throw new Error(`${who}: the point column '${name}' has the name of a word of an event candidate (vertex, edge, t) — a point resolver cannot read it; give the column another name`);
  }
}

/** @internal A candidate: its own words, and its columns flat. */
export function eventCandidate(own: { vertex: Vertex } | { edge: Edge; t: number }, columns: Record<string, number>): EventCandidate {
  return Object.freeze(Object.assign(columns, own));
}

export interface PlanarizeOpts {
  /** Point columns at an event: the returned record overrides the
   * default, which is the first candidate's (a surviving vertex keeps its
   * own values; a crossing takes those interpolated along its lowest edge
   * row). A column the record leaves out keeps the default. A candidate
   * reads its columns flat (`c.age`) beside `vertex`, `edge` and `t`, so
   * with a resolver a point column of one of those names is an error. */
  point?: (event: PlanarEvent) => Record<string, number>;
  /** Edge columns for each child interval, merged over the parent's;
   * called once per final child, an unsplit edge with fraction 1. The
   * interval is `from` → `to` along the parent as stored, and `fraction`
   * is its share of the parent. */
  edges?: (parent: Edge, child: { from: number; to: number; fraction: number }) => Record<string, number>;
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
  const X = m.x;
  const Y = m.y;
  const L = m.edgeList;
  for (let i = 0; i < m.n; i++) {
    if (!Number.isFinite(X[i]) || !Number.isFinite(Y[i])) throw new Error(`${what}: vertex ${i} is not finite`);
  }
  const zero: number[] = [];
  for (let e = 0; e < m.edgeCount; e++) {
    const a = L[2 * e];
    const b = L[2 * e + 1];
    if (a === b || (X[a] === X[b] && Y[a] === Y[b])) zero.push(e);
  }
  if (zero.length) throw new Error(`${what}: zero-length edge${zero.length > 1 ? 's' : ''} ${zero.join(', ')} — remove or move ${zero.length > 1 ? 'them' : 'it'} first (attributes are never dropped silently)`);
}

/** A candidate's columns: the numeric point columns of `m` (`names`)
 * read `t` of the way from row `a` to row `b`, by the rule a split reads
 * them by. */
function columnsAlong(m: Material, names: readonly string[], a: number, b: number, t: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of names) {
    const col = m.attrs[name];
    const va = col[a];
    const vb = col[b];
    out[name] = m.transfers[name] === 'nearest' ? (t <= 0.5 ? va : vb) : va + (vb - va) * t;
  }
  return out;
}

/** What the resolver sets at an event, checked: numbers for columns the
 * material has (`names`). The rest of the row is the first candidate's —
 * candidates come in a fixed order (vertex row, then edge row), so where
 * they disagree the rule is stated: a vertex that survives keeps its own
 * values, and a crossing takes the values read along its lowest edge row,
 * the value a split of that edge would give, by the column's policy. */
function resolved(names: readonly string[], event: PlanarEvent, resolver: NonNullable<PlanarizeOpts['point']>): Record<string, number> {
  const chosen = resolver(event) ?? {};
  for (const name in chosen) {
    if (!names.includes(name)) throw new Error(`planarize: no attribute '${name}' — declare it first`);
    if (!Number.isFinite(chosen[name])) throw new Error(`planarize: '${name}' from the point resolver is not a finite number`);
  }
  return chosen;
}

/** Numeric columns of `cols` with the values of `patch` (row → name →
 * value) written over them: a resolver's word at the rows it answered. */
function patched(cols: Record<string, AnyColumn>, patch: ReadonlyMap<number, Readonly<Record<string, number>>>): Record<string, AnyColumn> {
  if (patch.size === 0) return cols;
  const flats = new Map<string, Float64Array>();
  for (const [row, values] of patch) {
    for (const name in values) {
      let flat = flats.get(name);
      if (flat === undefined) flats.set(name, (flat = (cols[name] as Column).copy()));
      flat[row] = values[name];
    }
  }
  const out = { ...cols };
  for (const [name, flat] of flats) out[name] = Column.of(flat);
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
  const X = m.x;
  const Y = m.y;
  const L = m.edgeList;
  // The numeric columns: what a candidate carries and a resolver may set.
  const names = Object.keys(m.attrs);
  if (opts.point !== undefined) checkCandidateColumns(names, 'planarize');
  const enames = Object.keys(m.edgeAttrs);

  // ---- merge exactly coincident endpoints of the network ----
  const rep = new Int32Array(n);
  for (let i = 0; i < n; i++) rep[i] = i;
  const participates = new Uint8Array(n);
  for (let e = 0; e < E; e++) {
    participates[L[2 * e]] = 1;
    participates[L[2 * e + 1]] = 1;
  }
  // Exact coincidence, hashed rather than spelled out: `positionHash` keys
  // the bit patterns (0 and −0 together, as `===` has them), and the
  // coordinates themselves decide inside the bucket. A bucket holds one
  // position in practice; a hash collision only costs the compare.
  const mergedRows = new Map<number, number[]>(); // representative → every row merged into it
  const byPos = new Map<number, number | number[]>();
  for (let i = 0; i < n; i++) {
    if (!participates[i]) continue;
    const x = X[i];
    const y = Y[i];
    const h = positionHash(x, y);
    const slot = byPos.get(h);
    if (slot === undefined) { byPos.set(h, i); continue; }
    let r = -1;
    if (typeof slot === 'number') {
      if (X[slot] === x && Y[slot] === y) r = slot;
      else byPos.set(h, [slot, i]);
    } else {
      for (const other of slot) if (X[other] === x && Y[other] === y) { r = other; break; }
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
    const a = rep[L[2 * e]];
    const b = rep[L[2 * e + 1]];
    if (a === b) throw new Error(`planarize: edge ${e} joins two coincident endpoints — a zero-length edge after merging`);
    const key = a < b ? a * n + b : b * n + a;
    const dup = seenPair.get(key);
    if (dup !== undefined) throw new Error(`planarize: edges ${dup} and ${e} are the same segment — duplicate edges are overlaps and are not supported — m.merge() resolves overlaps and duplicates`);
    seenPair.set(key, e);
    segs.push({ a, b, ax: X[a], ay: Y[a], bx: X[b], by: Y[b], row: e });
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
      groupPos.set(g, [X[ev.vertex], Y[ev.vertex]]);
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

  // ---- point columns at existing vertices: merged rows and contacts reconcile alike ----
  // A vertex keeps its own values; the resolver, when there is one and
  // columns of numbers for it to set, has its word at every event.
  const pointWords = new Map<number, Record<string, number>>();
  const contactVertices = new Set<number>();
  for (const v of groupVertex.values()) contactVertices.add(rep[v]);
  const touched = new Set<number>([...mergedRows.keys(), ...contactVertices]);
  const resolver = names.length > 0 ? opts.point : undefined;
  if (resolver) {
    for (const v of Array.from(touched).sort((p, q) => p - q)) {
      const rows = mergedRows.get(v) ?? [v];
      const candidates: EventCandidate[] = rows.map((i) => eventCandidate({ vertex: m.vertex(i) }, columnsAlong(m, names, i, i, 0)));
      const contacts = rows.flatMap((i) => contactsAt.get(i) ?? []).map((k) => events[k] as Extract<Event, { kind: 'contact' }>).sort((p, q) => p.edge - q.edge);
      for (const c of contacts) candidates.push(eventCandidate({ edge: m.edge(c.edge), t: c.t }, columnsAlong(m, names, segs[c.edge].a, segs[c.edge].b, c.t)));
      if (candidates.length < 2) continue;
      pointWords.set(v, resolved(names, { position: [X[v], Y[v]], candidates }, resolver));
    }
  }

  // ---- rows: surviving source vertices, then new event vertices ----
  const rowMap = new Int32Array(n).fill(-1);
  const points = new PointRows(m, 'planarize');
  const edges = new EdgeRows(m);
  // What the resolvers said, by row of the answer.
  const pointPatch = new Map<number, Record<string, number>>();
  const edgePatch = new Map<number, Record<string, number>>();
  // A vertex that survives planarizing is the vertex it was. Coincident
  // endpoints merge into the lowest row, and that row's identity is the one
  // that carries; the others are gone. A crossing is a new vertex.
  for (let i = 0; i < n; i++) {
    if (rep[i] !== i) continue;
    rowMap[i] = points.keep(i);
    const words = pointWords.get(i);
    if (words !== undefined) pointPatch.set(rowMap[i], words);
  }
  const roots = Array.from(new Set(parent.map((_, g) => find(g)))).filter((g) => !groupVertex.has(g));
  roots.sort((a, b) => groupKey.get(a)![0] - groupKey.get(b)![0] || groupKey.get(a)![1] - groupKey.get(b)![1]);
  const groupRow = new Map<number, number>();
  // A crossing lies on the input edges that meet there: its `source`. A
  // vertex that survives is the vertex it was, and says nothing new.
  const pointSource: (number[] | undefined)[] = [];
  // One block of ids for the crossings, in the order the loop would have
  // asked for them one at a time — the same numbers, without an array per
  // vertex. A material with no columns asks no candidate anything: the
  // candidates exist for the resolver, and there is nothing to resolve.
  const crossingIds = mintIds(roots.length);
  for (let r = 0; r < roots.length; r++) {
    const g = roots[r];
    // A crossing's columns are read along its lowest edge row.
    const mentions = groupEdges.get(g)!.slice().sort((p, q) => p.edge - q.edge || p.t - q.t);
    const first = mentions[0];
    const pos = groupPos.get(g)!;
    pointSource[points.length] = Array.from(new Set(groupEdges.get(g)!.map((q) => q.edge))).sort((p, q) => p - q);
    const row = points.between(segs[first.edge].a, segs[first.edge].b, first.t, pos[0], pos[1], crossingIds[r]);
    groupRow.set(g, row);
    if (resolver) {
      const seen = new Set<number>();
      const candidates: EventCandidate[] = [];
      for (const { edge, t } of mentions) {
        if (seen.has(edge)) continue;
        seen.add(edge);
        candidates.push(eventCandidate({ edge: m.edge(edge), t }, columnsAlong(m, names, segs[edge].a, segs[edge].b, t)));
      }
      pointPatch.set(row, resolved(names, { position: pos, candidates }, resolver));
    }
  }
  const ox = points.x;
  const oy = points.y;
  const rowOfGroup = (g: number): number => {
    const r = find(g);
    const v = groupVertex.get(r);
    return v !== undefined ? rowMap[rep[v]] : groupRow.get(r)!;
  };

  // ---- child edges in parent, parameter order ----
  // Every piece is a piece of one input edge: its `source`.
  const edgeSource: number[] = [];
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
    const parentView = opts.edges !== undefined ? m.edge(e) : undefined!;
    for (let k = 0; k + 1 < stops.length; k++) {
      edgeSource.push(e);
      // A piece of a wall is a new edge, and still that wall: a fresh id,
      // the parent's root, the parent's columns and a distributed one its
      // share. An edge no crossing touched comes through this loop as its
      // own single child: the edge it was.
      const child = { from: stops[k].t, to: stops[k + 1].t, fraction: stops[k + 1].t - stops[k].t };
      if (stops.length === 2) edges.keep(e, stops[k].row, stops[k + 1].row);
      else edges.from(e, stops[k].row, stops[k + 1].row, child.fraction);
      if (opts.edges === undefined) continue;
      const extra = opts.edges(parentView, child);
      for (const name in extra) {
        if (!enames.includes(name)) throw new Error(`planarize: no edge column '${name}' — declare it with edges.set()`);
        if (!Number.isFinite(extra[name])) throw new Error(`planarize: '${name}' for a child edge is not a finite number`);
      }
      edgePatch.set(edges.length - 1, extra);
    }
  }
  const made = { ...points.done(), ...edges.done() };
  const out = rebuild(m, { ...made, attrs: patched(made.attrs, pointPatch), edgeAttrs: patched(made.edgeAttrs, edgePatch) }, { iteration: 0 });
  pointSource.length = ox.length;
  linkRows(out, {
    points: { source: { of: m, domain: 'edges', many: pointSource } },
    edges: { source: { of: m, domain: 'edges', rows: Int32Array.from(edgeSource) } },
  });
  return record(out, derivation('planarize', [m], { ...opts }));
}

// ---- faces ----------------------------------------------------------------------------

/**
 * `out` (the edges of face `f`, extracted in the order `rows` names them)
 * with every wall stored the way the face runs round: the outer boundary
 * with the face on its left — positive signed area, counter-clockwise when
 * y points up — and a hole the other way. A station's normal is the
 * tangent turned to the left, so `along` on a face's walls points into the
 * face. An edge with the face on both sides (a bridge or a spur inside it)
 * keeps the direction it was stored in.
 */
function faceWise(out: Material, rows: readonly number[], inside: (leaf: number) => boolean, faceOf: Int32Array): Material {
  const list = out.edgeList;
  let edges: Uint32Array | undefined;
  for (let k = 0; k < rows.length; k++) {
    const forward = inside(faceOf[2 * rows[k]]);
    const backward = inside(faceOf[2 * rows[k] + 1]);
    if (!backward || forward) continue;
    edges ??= Uint32Array.from(list);
    edges[2 * k] = list[2 * k + 1];
    edges[2 * k + 1] = list[2 * k];
  }
  if (!edges) return out;
  return rebuild(out, { edgeList: Column.of(edges) });
}

/**
 * The stated faces `rows` of `table`, in that order, as a value of their
 * own that keeps the statement: the edges `edgeRows` (every edge of those
 * faces, in that order), their ends and the loops' points in row order,
 * each loop renamed to the new rows, and every column — point, edge, face
 * and corner — with the ids, the kernel's names and the fixed triangles of
 * what it keeps. Built through `materialFromParts`. With `wind`, an edge
 * whose face (`wind` of the leaf on its left) is only on its right is
 * turned round, as `faceWise` does.
 *
 * Undefined when the faces are read off the picture, or when a face named
 * is not one loop — it has holes, or it holds others — which a face part
 * cannot say: the caller extracts the edges, and the faces are read off
 * the picture again.
 */
function extractStated(table: FaceTable, rows: readonly number[], edgeRows: readonly number[], wind: ((leaf: number) => boolean) | null): Material | undefined {
  const m = table.source;
  const stated = m.stated;
  if (stated === undefined) return undefined;
  const cycles = stated.cycles;
  for (const f of rows) if (cycles[f].length !== 1) return undefined;
  const s = m.store;
  const list = s.edgeList;
  const taken = new Set<number>();
  for (const e of edgeRows) {
    taken.add(list.get(2 * e));
    taken.add(list.get(2 * e + 1));
  }
  for (const f of rows) for (const p of cycles[f][0]) taken.add(p);
  const pointRows = [...taken].sort((a, b) => a - b);
  const rowMap = new Map<number, number>();
  pointRows.forEach((p, k) => rowMap.set(p, k));
  const edges = new Uint32Array(2 * edgeRows.length);
  edgeRows.forEach((e, k) => {
    let a = list.get(2 * e);
    let b = list.get(2 * e + 1);
    if (wind !== null && wind(table.faceOf[2 * e + 1]) && !wind(table.faceOf[2 * e])) [a, b] = [b, a];
    edges[2 * k] = rowMap.get(a)!;
    edges[2 * k + 1] = rowMap.get(b)!;
  });
  const pointCols: Record<string, AnyColumn> = {};
  for (const name of s.attrNames) pointCols[name] = kindOf(s.attrs[name]).of(s.attrs[name].gather(pointRows));
  const edgeCols: Record<string, AnyColumn> = {};
  for (const name of s.edgeAttrNames) edgeCols[name] = kindOf(s.edgeAttrs[name]).of(s.edgeAttrs[name].gather(edgeRows));
  // The corners of the faces kept, face by face and round each loop.
  const index = cornerIndex(cycles);
  const cornerRows: number[] = [];
  for (const f of rows) for (let c = index.start[f]; c < index.start[f + 1]; c++) cornerRows.push(c);
  const cornerColumns: Record<string, AnyColumn> = {};
  for (const [name, col] of Object.entries(stated.corners ?? {})) cornerColumns[name] = kindOf(col).of(col.gather(cornerRows));
  const pick = <T,>(of: ArrayLike<T> | undefined, at: readonly number[]): T[] | undefined => (of === undefined ? undefined : at.map((r) => of[r]));
  const pointKeys = s.pointKeys?.flat();
  const edgeKeys = s.edgeKeys?.flat();
  const out = materialFromParts({
    x: s.x.gather(pointRows),
    y: s.y.gather(pointRows),
    pointCols,
    edges,
    edgeCols,
    faces: rows.map((f) => ({
      loop: cycles[f][0].map((p) => rowMap.get(p)!),
      ...(stated.triangles?.[f] !== undefined ? { triangles: stated.triangles[f] } : {}),
    })),
    ids: {
      points: Float64Array.from(pointRows, (p) => at64(s.pointIds, p)),
      edges: Float64Array.from(edgeRows, (e) => at64(s.edgeIds, e)),
      edgeRoots: Float64Array.from(edgeRows, (e) => at64(s.edgeRoots, e)),
      faces: pick(stated.faceIds, rows),
      corners: pick(stated.cornerIds, cornerRows),
    },
    keys: {
      points: pick(pointKeys, pointRows),
      edges: pick(edgeKeys, edgeRows),
      faces: pick(stated.faceKeys, rows),
      corners: pick(stated.cornerKeys, cornerRows),
    },
    ...(stated.source !== undefined ? { source: { faces: (k: number) => table.sourceAt(rows[k]) } } : {}),
    space: m.space,
    key: m.key,
    origin: m.origin,
    orientation: m.orientation,
    radialCentre: m.radialCentre,
    transfers: m.transfers,
    edgeTransfers: m.edgeTransfers,
    // A face keeps its walls and their lineage, so its key: the face
    // columns go as they are held.
    faceColumns: m.faceAttrs,
    cornerColumns,
  });
  return carryLinks(m, out);
}

/**
 * The faces `rows` of `table` stated on `out`, a value extracted from the
 * table's state that keeps its point ids, when one of them has a hole:
 * each face's runs — the outer, then its holes — renamed to the rows of
 * `out`, in the order given. Read off the picture again, a hole's ring
 * would be a face of its own; stated, an extracted face is the face it
 * was. Faces of one run each read back as they were, and stay read off the
 * picture; a face that holds others is left to the picture too.
 */
function stateExtracted(table: FaceTable, rows: readonly number[], out: Material): Material {
  const ids = table.source.store.pointIds;
  const cycles: number[][][] = [];
  let holed = false;
  for (const f of rows) {
    const runs = table.runsOf(f);
    if (runs.length === 0) return out;
    if (runs.length > 1) holed = true;
    const face: number[][] = [];
    for (const run of runs) {
      const renamed = run.map((p) => out.rowOfPoint(at64(ids, p) as Vertex['id']));
      if (renamed.some((r) => r < 0)) return out;
      face.push(renamed);
    }
    cycles.push(face);
  }
  return holed ? withFaces(out, { cycles }) : out;
}

/**
 * One face of a geometry, read-only: a region its walls bound.
 *
 * Its face columns read flat — `f.height` — the way a vertex's own columns
 * do, which is why the face's own words are reserved names. A face column
 * is DENSE: every face has a number for every face column; a face no write
 * reached and that inherits nothing reads the column's `fallback`, or 0.
 *
 * Faces may nest. A word that divides a region again and again — a
 * quadtree — states every region from the root to the leaves, and a face
 * answers `parent`, `children`, `depth` and `leaf`; the partition is
 * `faces.filter((f) => f.leaf)`. A face of a geometry that does not nest
 * is a root and a leaf.
 */
export interface Face {
  /** This face's row in `g.faces` — a row of this state, not an identity. */
  readonly index: number;
  /** @internal The face's identity: the lineage of its walls. */
  readonly id: FaceId;
  /** Filled area in squared material units: outer minus holes. */
  readonly area: number;
  /** Outer and hole boundaries; retraced bridges and branches excluded. */
  readonly perimeter: number;
  /** The face's box, as a rect record (`x`, `y`, `w`, `h`, `cx`, `cy`) —
   * an area in its own right. */
  readonly bounds: Box;
  /** Geometric centroid of the filled area, holes respected; `[NaN, NaN]`
   * for a degenerate face. A face of a value in space has three numbers. */
  readonly centroid: readonly [number, number] | readonly [number, number, number];
  /** Steps from the root: 0 for a face nothing holds. */
  readonly depth: number;
  /** The side the face looks to, a unit 3-vector: `[0, 0, 1]` for a face in
   * the plane; for a face of a value in space, its own. */
  readonly normal: readonly [number, number, number];
  /** This face's corners, round its loop: none for a face read off the
   * picture (corners.ts). */
  readonly corners: Selection<Corner>;
  /** True for a face that holds no other face. */
  readonly leaf: boolean;
  /** This face's edges in the geometry, once: its walls and any edge
   * inside it (for a face that holds others, the walls between them). */
  readonly edges: Selection<Edge>;
  /** Endpoints of `edges`, once, in row order. */
  readonly points: Selection<Vertex>;
  /** Edges between this face and anything else (another face or the
   * outside): the walls; edges inside the face are not boundary. */
  readonly boundaryEdges: Selection<Edge>;
  /** The faces across this face's walls, as a selection of the same
   * collection: neighbours share an edge, not merely a vertex, and neither
   * holds the other. */
  readonly adjacent: Selection<Face>;
  /** The face that holds this one, or undefined for a root. */
  readonly parent: Face | undefined;
  /** The faces this one holds, one step down, in row order; empty for a leaf. */
  readonly children: Selection<Face>;
  /**
   * What this face came from, in the shape the word that made it says: a
   * Voronoi cell's site (a point of the sites), a quadtree cell's points (a
   * selection of the input), a tile's placement, a 3D face the face, edge
   * or point it was made from. Undefined for a face read off the drawn
   * picture.
   */
  readonly source: FaceSource;
  /** Closed contours: the outer boundary with positive signed area
   * (counter-clockwise in a y-up reading), holes negative. Bridges and
   * branches inside the face are not part of them.
   *
   * A method, not a property, because every area value answers `contours()`
   * — a face, a face collection, a material and a plain contour record are
   * all read the same way by `polygon`, `distanceTo` and `t.within`. */
  contours(): IsoContour[];
  /** Independent material of this face: its edges and corners, every
   * column and every id kept — the selection word, on one face. */
  extract(): Material;
  readonly [ROW_TYPES]?: FaceTypes;
  /** The face columns, read flat. */
  readonly [column: string]: any;
}

/**
 * @internal Faces a word states outright, carried on the material that
 * word made (`Material.stated`).
 *
 * `t.tiling`, `t.grid`, `t.voronoi` and `t.quadtree` know their faces
 * before anything is drawn, so they say so: which runs of corners go round
 * which face, in the order they made them, which face holds which, and
 * what each came from. A write that leaves the edges alone keeps them (a
 * move, a column write). In the plane a write that changes the edges drops
 * them, and the faces of that state are read off the picture by the planar
 * walk, their columns carried by wall lineage; in space, where the faces
 * are only what is stated, it keeps each face it still names (`restated`).
 */
export interface StatedFaces {
  /**
   * Per face row: the closed runs of VERTEX ROWS that bound it, each with
   * the face on its left — an outer run turns with positive signed area, a
   * hole's the other way; a wall's interior samples are in the run. A face
   * that holds others has none: its area is theirs.
   */
  readonly cycles: readonly (readonly (readonly number[])[])[];
  /** Per face row, the row of the face that holds it, -1 for a root.
   * Absent: no face holds another. Every parent comes before its children. */
  readonly parent?: Int32Array;
  /** What face `f` came from, in the word's own shape; read the first time
   * it is asked for. Absent: nothing. */
  readonly source?: (f: number) => FaceSource;
  /** The edge list the faces were stated over. */
  readonly edgeList: ColumnLike<Uint32Array>;
  /** The edge ids the faces were stated over. */
  readonly edgeIds: ColumnLike<Float64Array>;
  /**
   * The corner columns, by name, of any kind (column.ts): one row per
   * corner — each face's runs in order, a corner per vertex of a run
   * (corners.ts). Absent: the corners hold no columns. They go wherever
   * the statement goes, and a write that drops it drops them.
   */
  readonly corners?: Readonly<Record<string, AnyColumn>>;
  /** Minted ids, one per face row and one per corner row, for a statement
   * that mints them (a 3D value's faces); absent, a face is known by its
   * walls. Internal: the engine's identity, never a sketch's. */
  readonly faceIds?: Float64Array;
  readonly cornerIds?: Float64Array;
  /** The kernel's names of the faces and of the corners (see
   * `MaterialStore.pointKeys`). */
  readonly faceKeys?: readonly string[];
  readonly cornerKeys?: readonly string[];
  /**
   * A fixed triangulation per face row, where the statement has one: the
   * face's triangles as positions round its loop (0 is the loop's first
   * point), three a triangle; a face
   * without one is undefined. The loops own it: it goes wherever they go,
   * and a write that drops the statement drops it.
   */
  readonly triangles?: readonly (readonly number[] | undefined)[];
}

/** @internal `stated`, when a state has exactly the edges it was stated
 * over; undefined when a write changed them. */
export function statedFor(stated: StatedFaces | undefined, edgeList: Column<Uint32Array>, edgeIds: Column): StatedFaces | undefined {
  if (stated === undefined) return undefined;
  // A write that kept the edges kept their columns, or the leaves of them:
  // what is shared is not read.
  if (!columnOf(stated.edgeList).sameValues(edgeList)) return undefined;
  if (!columnOf(stated.edgeIds).sameValues(edgeIds)) return undefined;
  return stated;
}

/** @internal What a write leaves of the rows a statement of faces names:
 * the state it read and the new state's rows. */
export interface Restatement {
  /** The state the write read, whose rows the statement names. */
  readonly from: Material;
  readonly n: number;
  readonly pointIds: Column;
  readonly edgeList: Column<Uint32Array>;
  readonly edgeIds: Column;
  /** The new state's positions, for the corners a side threads through. */
  readonly x: Column;
  readonly y: Column;
  readonly z: Column;
}

/**
 * @internal The faces a statement still names in space, after a write that
 * changed the edges. In the plane the picture says what the faces are and
 * a changed edge list drops the statement (`statedFor`). In space the
 * faces exist only as stated, so a write keeps each one by row identity:
 * a face whose points and sides are all still there is kept as it was; a
 * side that a split or a replace swapped for a chain of new points (each
 * on two edges only) runs through that chain, a corner at each new point,
 * its fixed triangle fanned across the chain; a face that lost a point or
 * a side is gone, as a removed row is. The rows it keeps keep their ids,
 * names, columns and `source`.
 */
export function restated(stated: StatedFaces, next: Restatement): StatedFaces | undefined {
  const from = next.from;
  const newRow = new Map<number, number>();
  const ids = next.pointIds.flat();
  for (let i = 0; i < next.n; i++) newRow.set(ids[i], i);
  const oldIds = from.store.pointIds.flat();
  const rowOf = (p: number): number => newRow.get(oldIds[p]) ?? -1;
  // The points the faces are made of: a side runs from one to another, and
  // any other point on two edges only is a point a side can run through.
  const had = new Set<number>();
  for (const runs of stated.cycles) for (const run of runs) for (const p of run) had.add(oldIds[p]);
  const list = next.edgeList.flat();
  const pair = (a: number, b: number): number => (a < b ? a * 0x100000000 + b : b * 0x100000000 + a);
  const edgeAt = new Set<number>();
  const around = new Map<number, number[]>();
  for (let e = 0; e < list.length / 2; e++) {
    const a = list[2 * e];
    const b = list[2 * e + 1];
    edgeAt.add(pair(a, b));
    for (const [u, v] of [[a, b], [b, a]]) if (!had.has(ids[u])) (around.get(u) ?? around.set(u, []).get(u)!).push(v);
  }
  // The points between two corners: a chain of points no face is made of,
  // each on exactly two edges, from `a` to `b`.
  const chain = (a: number, b: number): number[] | undefined => {
    for (let e = 0; e < list.length / 2; e++) {
      let start = -1;
      if (list[2 * e] === a) start = list[2 * e + 1];
      else if (list[2 * e + 1] === a) start = list[2 * e];
      if (start < 0 || had.has(ids[start])) continue;
      const out: number[] = [];
      let prev = a;
      let at = start;
      while (!had.has(ids[at])) {
        const next = around.get(at)!;
        if (next.length !== 2 || out.length > list.length) break;
        out.push(at);
        const step = next[0] === prev ? next[1] : next[0];
        prev = at;
        at = step;
      }
      if (at === b && out.length > 0) return out;
    }
    return undefined;
  };
  const x = next.x.flat();
  const y = next.y.flat();
  const z = next.z.flat();
  const length = (a: number, b: number): number => Math.hypot(x[b] - x[a], y[b] - y[a], z[b] - z[a]);
  // Per kept face: its new runs, and for each of its corners the old corner
  // it is (t = 0), or the two old corners of the side it sits on and how far
  // along that side it is.
  const cornerAt = cornerIndex(stated.cycles);
  const keptFaces: number[] = [];
  const cycles: (readonly number[])[][] = [];
  const cornerFrom: [number, number, number][] = [];
  const triangles: (readonly number[] | undefined)[] = [];
  stated.cycles.forEach((runs, f) => {
    const newRuns: number[][] = [];
    const corners: [number, number, number][] = [];
    const place: number[][] = [];
    let first = cornerAt.start[f];
    for (const run of runs) {
      const out: number[] = [];
      const at: number[] = [];
      for (let k = 0; k < run.length; k++) {
        const a = rowOf(run[k]);
        const b = rowOf(run[(k + 1) % run.length]);
        if (a < 0 || b < 0) return;
        at.push(out.length);
        out.push(a);
        corners.push([first + k, first + k, 0]);
        if (edgeAt.has(pair(a, b))) continue;
        const through = chain(a, b);
        if (through === undefined) return;
        const all = [a, ...through, b];
        let total = 0;
        for (let q = 1; q < all.length; q++) total += length(all[q - 1], all[q]);
        let walked = 0;
        for (let q = 1; q < all.length - 1; q++) {
          walked += length(all[q - 1], all[q]);
          out.push(all[q]);
          corners.push([first + k, first + ((k + 1) % run.length), total > 0 ? walked / total : 0.5]);
        }
      }
      if (out.length < 3 || new Set(out).size !== out.length) return;
      newRuns.push(out);
      place.push(at);
      first += run.length;
    }
    keptFaces.push(f);
    cycles.push(newRuns);
    for (const corner of corners) cornerFrom.push(corner);
    triangles.push(fanned(stated.triangles?.[f], stated.cycles[f][0]?.length ?? 0, place[0], newRuns[0], x, y, z));
  });
  if (keptFaces.length === 0) return undefined;
  const corners: Record<string, AnyColumn> | undefined = stated.corners === undefined ? undefined : {};
  for (const name in stated.corners ?? {}) {
    const col = stated.corners![name];
    const values: unknown[] = [];
    for (let i = 0; i < cornerFrom.length; i++) {
      const [a, b, t] = cornerFrom[i];
      values.push(t === 0 ? col.get(a) : cornerBetween(col, a, b, t));
    }
    corners![name] = (kindOf(col) as { from(v: readonly unknown[]): AnyColumn }).from(values);
  }
  const fresh = cornerFrom.filter(([, , t]) => t !== 0).length;
  const minted = fresh > 0 ? mintIds(fresh) : undefined;
  let m = 0;
  const cornerIds = stated.cornerIds === undefined ? undefined : Float64Array.from(cornerFrom, ([a, , t]) => (t === 0 ? stated.cornerIds![a] : minted![m++]));
  const faceOf = new Int32Array(stated.cycles.length).fill(-1);
  keptFaces.forEach((f, i) => { faceOf[f] = i; });
  const source = stated.source;
  return {
    cycles: Object.freeze(cycles.map((runs) => Object.freeze(runs))),
    ...(stated.parent !== undefined ? { parent: Int32Array.from(keptFaces, (f) => (stated.parent![f] < 0 ? -1 : faceOf[stated.parent![f]])) } : {}),
    ...(source !== undefined ? { source: (f: number) => source(keptFaces[f]) } : {}),
    edgeList: next.edgeList,
    edgeIds: next.edgeIds,
    ...(corners !== undefined ? { corners: Object.freeze(corners) } : {}),
    ...(stated.faceIds !== undefined ? { faceIds: Float64Array.from(keptFaces, (f) => stated.faceIds![f]) } : {}),
    ...(cornerIds !== undefined ? { cornerIds } : {}),
    ...(stated.faceKeys !== undefined ? { faceKeys: Object.freeze(keptFaces.map((f) => stated.faceKeys![f])) } : {}),
    ...(stated.cornerKeys !== undefined ? { cornerKeys: Object.freeze(cornerFrom.map(([a, , t]) => (t === 0 ? stated.cornerKeys![a] : ''))) } : {}),
    ...(stated.triangles !== undefined ? { triangles: Object.freeze(triangles) } : {}),
  };
}

/** A face's fixed triangles after its sides took new points: a triangle
 * with no side threaded stays as it was; one with a threaded side becomes
 * the polygon of its corners and the new points on its sides, ear clipped
 * as a new face is. Positions are round the new loop (`at` says where each
 * old one went). A polygon with no ear leaves the face without fixed
 * triangles: it is ear clipped whole when read. */
function fanned(own: readonly number[] | undefined, size: number, at: readonly number[], loop: readonly number[], x: Float64Array, y: Float64Array, z: Float64Array): readonly number[] | undefined {
  if (own === undefined) return undefined;
  const count = loop.length;
  if (count === size) return own;
  const positions = loop.map((v) => [x[v], y[v], z[v]] as [number, number, number]);
  const out: number[] = [];
  for (let k = 0; k + 2 < own.length; k += 3) {
    const polygon: number[] = [];
    for (let s = 0; s < 3; s++) {
      const u = own[k + s];
      const v = own[k + ((s + 1) % 3)];
      polygon.push(at[u]);
      // A side of the loop, run the loop's way: the new points on it.
      if (v === (u + 1) % size) for (let q = (at[u] + 1) % count; q !== at[v]; q = (q + 1) % count) polygon.push(q);
    }
    if (polygon.length === 3) { out.push(...polygon); continue; }
    let clipped: [number, number, number][];
    try { clipped = triangulate(positions, polygon); } catch { return undefined; }
    if (clipped.length !== polygon.length - 2) return undefined;
    for (const t of clipped) out.push(...t);
  }
  return Object.freeze(out);
}

/** A corner column's value `t` of the way from corner `a` to corner `b`:
 * numbers and vectors between, any other kind the nearer one's (the first
 * on a tie), as a split's point takes a point column. */
function cornerBetween(col: AnyColumn, a: number, b: number, t: number): unknown {
  const va = col.get(a);
  const vb = col.get(b);
  if (typeof va === 'number') return va + ((vb as number) - va) * t;
  if (Array.isArray(va) && kindOf(col).name === 'vector') return va.map((v, k) => v + ((vb as number[])[k] - v) * t);
  return t <= 0.5 ? va : vb;
}

/** One bounded region as the walk or a statement found it: the half-edge
 * runs that bound it (retraced parts gone), every half-edge it passed (a
 * bridge twice), and its signed area. */
interface Region {
  cycles: number[][];
  halfEdges: number[];
  area: number;
}

/** Throw unless `m` is a valid planar embedding as far as its edges go. */
function checkPlanar(m: Material): void {
  validate(m, 'faces');
  const X = m.x;
  const Y = m.y;
  const L = m.edgeList;
  const segs: Seg[] = [];
  // the unordered pair packs into one exact integer while n² < 2^53 — that is
  // every material whose coordinates fit in memory
  const seenPair = new Set<number>();
  for (let e = 0; e < m.edgeCount; e++) {
    const a = L[2 * e];
    const b = L[2 * e + 1];
    const key = a < b ? a * m.n + b : b * m.n + a;
    if (seenPair.has(key)) throw new Error(`faces: duplicate edge ${e} — duplicate edges are overlaps and are not supported`);
    seenPair.add(key);
    segs.push({ a, b, ax: X[a], ay: Y[a], bx: X[b], by: Y[b], row: e });
  }
  // A distinct vertex at an already-claimed position throws at once, so a
  // bucket only ever holds vertices whose hashes collided but whose
  // coordinates differ; it stays one deep in practice.
  const byPos = new Map<number, number | number[]>();
  const claim = (v: number): void => {
    const x = X[v];
    const y = Y[v];
    const h = positionHash(x, y);
    const slot = byPos.get(h);
    if (slot === undefined) { byPos.set(h, v); return; }
    if (typeof slot === 'number') {
      if (slot === v) return;
      if (X[slot] === x && Y[slot] === y) throw new Error(`faces: vertices ${slot} and ${v} coincide but are distinct — run planarize() first`);
      byPos.set(h, [slot, v]);
      return;
    }
    for (const other of slot) {
      if (other === v) return;
      if (X[other] === x && Y[other] === y) throw new Error(`faces: vertices ${other} and ${v} coincide but are distinct — run planarize() first`);
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
            const d = Math.hypot(X[a] - X[b], Y[a] - Y[b]);
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
  const X = m.x;
  const Y = m.y;
  let inside = false;
  for (let k = 0; k < walk.length; k++) {
    const a = tail(walk[k]);
    const b = tail(walk[(k + 1) % walk.length]);
    const ax = X[a];
    const ay = Y[a];
    const bx = X[b];
    const by = Y[b];
    if (ay > py !== by > py) {
      const x = ax + ((py - ay) * (bx - ax)) / (by - ay);
      if (px < x) inside = !inside;
    }
  }
  return inside;
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

/** The leaf face row holding (x, y), or −1, by `faceHolding`'s rule, with
 * the leaves bucketed by their bounds. */
export function faceLocator(cells: FaceTable): (x: number, y: number) => number {
  const leaves = cells.faces.filter((f) => f.leaf);
  const boxes = new Float64Array(4 * leaves.length);
  leaves.forEach((f, i) => boxes.set([f.bounds.x, f.bounds.y, f.bounds.x + f.bounds.w, f.bounds.y + f.bounds.h], 4 * i));
  const grid = boxGrid(boxes);
  return (x, y) => faceHolding(grid.near(x, y, x, y).sort((a, b) => a - b).map((i) => leaves[i]), x, y);
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
): { regions: Region[]; faceOf: Int32Array } {
  const X = m.x;
  const Y = m.y;
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
  interface Walk { halfEdges: number[]; cycles: number[][]; area: number; comp: number }
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
      const x0 = X[tailOf(cycle[0])]; // shoelace about a local origin: absolute coordinates cancel to zero far from (0, 0)
      const y0 = Y[tailOf(cycle[0])];
      for (const c of cycle) {
        const a = tailOf(c);
        const b = headOf(c);
        area += (X[a] - x0) * (Y[b] - y0) - (X[b] - x0) * (Y[a] - y0);
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
  // A face's own walk is its region; a hole joins it below, and only then
  // are the walk's lists copied.
  const regions: Region[] = faceWalk.map((w) => walks[w]);
  const joined = new Uint8Array(faceWalk.length);
  const containerOfWalk = new Int32Array(walks.length).fill(-1);
  for (let w = 0; w < walks.length; w++) {
    if (walks[w].area >= 0) continue;
    const v = tailOf(walks[w].halfEdges[0]);
    let best = -1;
    let bestArea = Infinity;
    for (let f = 0; f < faceWalk.length; f++) {
      const fw = walks[faceWalk[f]];
      if (fw.comp === walks[w].comp || fw.area >= bestArea) continue;
      if (pointInWalk(m, fw.halfEdges, tailOf, X[v], Y[v])) {
        best = f;
        bestArea = fw.area;
      }
    }
    containerOfWalk[w] = best;
    if (best >= 0) {
      if (!joined[best]) {
        joined[best] = 1;
        const own = regions[best];
        regions[best] = { cycles: own.cycles.slice(), halfEdges: own.halfEdges.slice(), area: own.area };
      }
      const r = regions[best];
      r.area += walks[w].area; // negative
      for (const c of walks[w].cycles) r.cycles.push(c);
      for (const h of walks[w].halfEdges) r.halfEdges.push(h);
    }
  }
  const faceOf = new Int32Array(H).fill(-1);
  for (let h = 0; h < H; h++) {
    const w = walkOf[h];
    faceOf[h] = walks[w].area > 0 ? faceIndexOfWalk[w] : walks[w].area < 0 ? containerOfWalk[w] : -1;
  }
  return { regions, faceOf };
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
 * every other member of the face table — the views, the columns, adjacency,
 * `boundaryEdges`, `contours()` — reads the same two arrays either way.
 *
 * A half-edge no run claims is OUTSIDE: that is the rim of a finite patch
 * of the plane or the disk, and on a full sphere there is none. A face with
 * no runs holds other faces and is none of the half-edges' own.
 */
function fromCycles(
  m: Material,
  stated: readonly (readonly (readonly number[])[])[],
  next: Int32Array,
  tailOf: (h: number) => number,
  headOf: (h: number) => number,
  start: Int32Array,
  outgoing: Int32Array,
): { regions: (Region | null)[]; faceOf: Int32Array } {
  const X = m.x;
  const Y = m.y;
  const H = 2 * m.edgeCount;
  // The half-edge from one vertex row to another: a vertex has a handful
  // of edges, so its run of outgoing half-edges is read where it lies.
  const halfOf = (a: number, b: number): number | undefined => {
    for (let k = start[a]; k < start[a + 1]; k++) if (headOf(outgoing[k]) === b) return outgoing[k];
    return undefined;
  };
  const faceOf = new Int32Array(H).fill(-1);
  const regions: (Region | null)[] = [];
  for (let f = 0; f < stated.length; f++) {
    const runs = stated[f];
    if (runs.length === 0) {
      regions.push(null);
      continue;
    }
    const region: Region = { cycles: [], halfEdges: [], area: 0 };
    for (const cycle of runs) {
      if (cycle.length < 3) throw new Error(`faces: face ${f} has a run of ${cycle.length} vertices — a run is three or more`);
      const seq: number[] = [];
      for (let k = 0; k < cycle.length; k++) {
        const a = cycle[k];
        const b = cycle[(k + 1) % cycle.length];
        const h = a < m.n && b < m.n ? halfOf(a, b) : undefined;
        if (h === undefined) throw new Error(`faces: face ${f} runs from vertex ${a} to vertex ${b}, and no edge joins them`);
        if (faceOf[h] >= 0) throw new Error(`faces: faces ${faceOf[h]} and ${f} both run from vertex ${a} to vertex ${b} — two faces share a wall the other way round`);
        faceOf[h] = f;
        seq.push(h);
      }
      for (let k = 0; k < seq.length; k++) next[seq[k]] = seq[(k + 1) % seq.length];
      // The shoelace about a local origin, as the walk path takes it:
      // absolute coordinates cancel to zero far from (0, 0).
      const x0 = X[tailOf(seq[0])];
      const y0 = Y[tailOf(seq[0])];
      let area = 0;
      for (const h of seq) {
        const a = tailOf(h);
        const b = headOf(h);
        area += (X[a] - x0) * (Y[b] - y0) - (X[b] - x0) * (Y[a] - y0);
      }
      region.area += area / 2;
      region.cycles.push(seq);
      for (const h of seq) region.halfEdges.push(h);
    }
    regions.push(region);
  }
  return { regions, faceOf };
}

/**
 * One key per face: the lineage roots of its walls, deduplicated, sorted,
 * joined. A wall cut in half is still one wall, which is what the root is
 * for. The one place the shape of a face column's key is written.
 */
export function faceKeyOf(roots: Iterable<number>): string {
  return [...new Set(roots)].sort((a, b) => a - b).join(',');
}

/**
 * @internal One id per face of one state, from the faces' keys in row
 * order: the key, and where two faces have the same walls — a figure eight
 * drawn as one subdivided edge — the later ones told apart by their place
 * among them (`key#1`, `key#2`). What a face column is keyed by, and what
 * `FaceTable.ids` answers.
 */
export function faceIdsOf(keys: readonly string[]): FaceId[] {
  const seen = new Map<string, number>();
  return keys.map((key) => {
    const k = seen.get(key) ?? 0;
    seen.set(key, k + 1);
    return (k === 0 ? key : `${key}#${k}`) as FaceId;
  });
}

/** The walls of a face id: its key's lineage roots, as strings. */
const wallsOf = (id: string): string[] => {
  const hash = id.indexOf('#');
  const key = hash < 0 ? id : id.slice(0, hash);
  return key === '' ? [] : key.split(',');
};

/**
 * @internal The id of every face a statement names, worked out from its
 * runs and the edges of `m` — the same ids `FaceTable.ids()` reads off the
 * incidence, without building the table: each face's walls are the edges
 * its runs pass that have another face (or none) on their other side, each
 * wall its lineage root. For faces that do not nest; a face that holds
 * others has none. A run side no edge joins keys nothing.
 */
export function statedFaceIds(m: Material, cycles: StatedFaces['cycles']): FaceId[] {
  const list = m.store.edgeList;
  const roots = m.store.edgeRoots;
  const n = Math.max(1, m.n);
  // Half-edge claims: which face runs along each edge which way.
  const edgeAt = new Map<number, number>();
  for (let e = 0; e < m.edgeCount; e++) {
    const a = list.get(2 * e);
    const b = list.get(2 * e + 1);
    edgeAt.set(a * n + b, 2 * e);
    edgeAt.set(b * n + a, 2 * e + 1);
  }
  const faceOf = new Int32Array(2 * m.edgeCount).fill(-1);
  cycles.forEach((runs, f) => {
    for (const run of runs) for (let k = 0; k < run.length; k++) {
      const h = edgeAt.get(run[k] * n + run[(k + 1) % run.length]);
      if (h !== undefined) faceOf[h] = f;
    }
  });
  const walls: number[][] = cycles.map(() => []);
  for (let e = 0; e < m.edgeCount; e++) {
    const l = faceOf[2 * e];
    const r = faceOf[2 * e + 1];
    if (l === r) continue;
    const root = at64(roots, e);
    if (l >= 0) walls[l].push(root);
    if (r >= 0) walls[r].push(root);
  }
  return faceIdsOf(walls.map(faceKeyOf));
}

/**
 * @internal Face columns for faces a word states: each face's key from the
 * edges its runs pass (the ids the material is about to carry, every edge
 * its own root), and one column per entry of `values`, every face
 * written. What `faces.set` would write on the state, without reading its
 * faces first. For faces that do not nest.
 */
export function statedColumns(
  cycles: readonly (readonly (readonly number[])[])[],
  vertexCount: number,
  edgeList: Uint32Array,
  edgeIds: Float64Array,
  values: Readonly<Record<string, (f: number) => number>>,
): Record<string, FaceColumn> {
  const n = Math.max(1, vertexCount);
  const edgeAt = new Map<number, number>();
  for (let e = 0; e < edgeList.length / 2; e++) {
    edgeAt.set(edgeList[2 * e] * n + edgeList[2 * e + 1], e);
    edgeAt.set(edgeList[2 * e + 1] * n + edgeList[2 * e], e);
  }
  const keys = faceIdsOf(cycles.map((runs) => faceKeyOf(runs.flatMap((run) => run.map((v, k) => edgeIds[edgeAt.get(v * n + run[(k + 1) % run.length])!])))));
  const seen = new Set<string>(keys);
  const out: Record<string, FaceColumn> = {};
  for (const [name, value] of Object.entries(values)) {
    out[name] = { values: new Map(keys.map((key, f) => [key, value(f)])), transfer: 'nearest', seen };
  }
  return out;
}

/**
 * The identity of one face, for as long as its walls last: the lineage
 * roots of its walls, deduplicated, sorted and joined — the face's key. A
 * wall cut in half is still that wall, so the id holds across `steps`, a
 * transform, and a `planarize` that leaves the wall where it was. Opaque:
 * compare it, keep it in a set, never parse it.
 */
export type FaceId = string & { readonly __faceId: unique symbol };

/** Which faces a face write names: a face selection (of this state or an
 * earlier one), one face, a list of faces, or a predicate over the faces. */
export type FaceWhere = Selection<Face> | Face | readonly Face[] | ((f: Face) => unknown) | undefined;

/** The face write: a value or a function of the face, on these faces or
 * those `where` names, with the options record `{ transfer, fallback }`
 * last. */
export interface FaceSet {
  (column: string, value: CellValue | ((f: Face) => CellValue | undefined), where?: FaceWhere, opts?: FaceSetOpts): Material;
  (column: string, value: CellValue | ((f: Face) => CellValue | undefined), opts: FaceSetOpts): Material;
  (values: Record<string, CellValue | ((f: Face) => CellValue | undefined)>, where?: FaceWhere, opts?: FaceRecordSetOpts): Material;
  (values: Record<string, CellValue | ((f: Face) => CellValue | undefined)>, opts: FaceRecordSetOpts): Material;
}

/** @internal What a selection of faces answers (see `ROW_TYPES`). */
export type FaceTypes = Types<{
  owner: Material;
  points: Selection<Vertex>;
  edges: Selection<Edge>;
  faces: Selection<Face>;
  corners: Selection<Corner>;
  curves: Selection<Curve>;
  contours: () => IsoContour[];
  boundaryEdges: () => Selection<Edge>;
  measure: (field?: (x: number, y: number) => number, opts?: MeasureOpts) => Material;
  extract: () => Material;
  set: FaceSet;
}>;

/**
 * The faces of one state as a domain: a face row is a face view, its
 * identity is its walls' lineage (`face.id`), and its neighbours are the
 * faces across its walls.
 */
class FaceDomain implements Domain<Face> {
  readonly kind: DomainKind = FACES;
  readonly dense = true;
  constructor(readonly table: FaceTable) {}
  get owner(): Material { return this.table.source; }
  get size(): number { return this.table.faces.length; }
  all(): readonly number[] { return this.table.allRows(); }
  valid(r: number): boolean { return r >= 0 && r < this.table.faces.length && Number.isInteger(r); }
  row(r: number): Face { return this.table.faces[r]; }
  /** A face is who its walls are (`face.id`). */
  keyOf(r: number): unknown { return this.table.ids()[r]; }
  rowOfKey(key: unknown): number { return this.table.rowOfFace(key as FaceId); }
  locate(v: unknown, who: string): { domain: Domain<Face>; row: number } | null {
    if (v === undefined || v === null) return null;
    if (viewKind(v) !== 'face') throw new Error(`${who}: expected a face view — got ${describe(v)}`);
    return { domain: (ownerOf(v as object) as FaceTable).domain, row: (v as Face).index };
  }
  shares(other: Domain<Face>): boolean { return sameLineage(this.table.source, other.owner as Material); }
  neighbours(r: number): readonly number[] { return this.table.neighbours()[r]; }
}

type FaceSel = Selection<any> & { readonly owner: Material; readonly domain: FaceDomain };

/** The edges of the selected faces, row order: an edge with a selected
 * face (or a face a selected face holds) on either side. */
const faceEdgeRows = (sel: FaceSel): number[] => {
  const table = sel.domain.table;
  const inside = table.leafTest((f) => sel.holds(f));
  return table.edgeRowsWhere((l, r) => inside(l) || inside(r));
};

const FACES: DomainKind = domainKind('face', 'faces', {
  /** The corners: the ends of `edges`, once, in row order. A point
   * consumer handed the selection itself reads each face as its centroid
   * instead; this is the word for the corners. */
  points: { get(this: FaceSel) { return pointsOf(this.owner, endpointRows(edgesOf(this.owner, faceEdgeRows(this), undefined, true)), undefined, true); } },
  /** Every edge of a selected face, once, in row order: the walls, the
   * walls between two selected faces, and a spur inside a face. */
  edges: { get(this: FaceSel) { return edgesOf(this.owner, faceEdgeRows(this), undefined, true); } },
  /** Itself. */
  faces: { get(this: FaceSel) { return this; } },
  /** The corners of the selected faces, face by face and round each face:
   * the stated faces' corners (corners.ts); none where the faces are read
   * off the picture. */
  corners: { get(this: FaceSel): Selection<Corner> { return cornersOfFaces(this.owner, this.indices); } },
  /** The walls of the faces as curves: each wall once, so `strokes(cells)`
   * draws a wall two faces share one time, not twice. */
  curves: { get(this: FaceSel): Selection<Curve> { return curvesOfRows(this, this.owner, faceEdgeRows(this)); } },
  /** The edges between the selected union and the rest: a wall with a
   * selected face on exactly one side. Walls between two selected faces
   * and edges inside a face are left out; a hole's boundary stays. */
  boundaryEdges: { value(this: FaceSel): Selection<Edge> {
    const table = this.domain.table;
    const inside = table.leafTest((f) => this.holds(f));
    return edgesOf(this.owner, table.edgeRowsWhere((l, r) => inside(l) !== inside(r)), undefined, true);
  } },
  /**
   * Measure the selected faces, and answer the geometry with the
   * measurements as face columns on them (measure.ts): `orientation`,
   * `elongation`, `inscribedX`, `inscribedY`, `inscribedRadius` always,
   * and with `field` its `integral`, `mean`, `samples`, `weightedX` and
   * `weightedY`. The faces keep their order, source and nesting.
   */
  measure: { value(this: FaceSel, field?: (x: number, y: number) => number, opts?: MeasureOpts): Material {
    const table = this.domain.table;
    const rows = this.members === null ? table.allRows() : this.members;
    return setFaceColumns(table, rows, measureFaces(table, rows.map((i) => table.faces[i]), field, opts));
  } },
  /** Closed contours around the union of the selected faces: walls between
   * two selected faces vanish, walls against an unselected face or the
   * outside stay, holes stay holes. The same boundary as `boundaryEdges()`,
   * as loops. */
  contours: { value(this: FaceSel): IsoContour[] {
    if (this.length === 0) return [];
    return this.domain.table.boundaryContours((f) => this.holds(f));
  } },
  /** Independent material of the selected faces: their edges and corners,
   * every point and edge column, the face columns, and the ids — an
   * extracted face is the face it was, so its columns and its id carry. */
  extract: { value(this: FaceSel): Material {
    const edgeRows = faceEdgeRows(this);
    const table = this.domain.table;
    return extractStated(table, this.indices, edgeRows, null) ?? stateExtracted(table, this.indices, edgesOf(this.owner, edgeRows, undefined, true).extract());
  } },
  /**
   * The material with face columns set on these faces — every one, or those
   * `where` names: a face selection, one face, or a predicate. A value is a
   * number or a function of the face; the record form sets several columns
   * in ONE instant, every function reading the faces as they were.
   *
   * A face is keyed by the walls it is made of, so a face column follows
   * the material through anything that leaves those walls alone. A column
   * is DENSE: a face this write passes by keeps what it had, and a face
   * nothing ever reached reads the column's `fallback`, or 0. When the
   * walls change, a new face takes the value of the old face it shares the
   * most walls with (`transfer: 'nearest'`, the default) or the column
   * stops there (`'drop'`). A value that is not finite leaves that face as
   * it was.
   */
  set: { value(this: FaceSel, ...args: unknown[]): Material { return writeFaces(this, args); } },
});

/** Is `v` a selection of a material's faces? */
export const isFaceSelection = (v: unknown): v is Selection<Face> => isSelectionOf(v, FACES);

/** @internal The face table behind a face selection. */
export function faceTableOf(sel: Selection<Face>): FaceTable {
  return (sel.domain as unknown as FaceDomain).table;
}

/**
 * The bounded regions of `m`, with the half-edge incidence a face table
 * reads: the regions the runs `cycles` name, when a word stated them, or
 * those the planar walk reads off the picture. `faceOf` is the region on
 * each half-edge's left (-1 outside), `next` the successor of each
 * half-edge round its region, the smallest turn where no region claims it.
 */
function regionsOf(m: Material, cycles?: readonly (readonly (readonly number[])[])[]): { regions: (Region | null)[]; faceOf: Int32Array; next: Int32Array } {
  // Faces named outright are the authority on their own topology, and the
  // planarity check is a question about a drawn picture: skip it.
  if (cycles === undefined) checkPlanar(m);
  const n = m.n;
  const E = m.edgeCount;
  const H = 2 * E;
  const X = m.x;
  const Y = m.y;
  const L = m.edgeList;
  // half-edge h = 2e (a → b) or 2e+1 (b → a); tailOf(h) is where it starts
  const tailOf = (h: number): number => (h & 1 ? L[2 * (h >> 1) + 1] : L[2 * (h >> 1)]);
  const headOf = (h: number): number => tailOf(h ^ 1);
  // Outgoing half-edges per vertex — one run of rows per vertex inside
  // one array, rather than an array per vertex, filled in half-edge order.
  const start = new Int32Array(n + 1);
  for (let h = 0; h < H; h++) start[tailOf(h) + 1]++;
  for (let v = 0; v < n; v++) start[v + 1] += start[v];
  const outgoing = new Int32Array(H);
  const cursor = Int32Array.from(start.subarray(0, n));
  for (let h = 0; h < H; h++) outgoing[cursor[tailOf(h)]++] = h;
  // Each run sorted by angle, in place, where the walk needs it: the
  // angle of a half-edge is fixed, and a comparison sort asks for it
  // O(log k) times per half-edge, so it is worked out once. A vertex has
  // a handful of edges, so the run is put in order where it lies — no
  // view object per vertex, and no comparator call. The order is total
  // (angle, then half-edge), so it is the one order a sort could have
  // produced. A vertex with many edges gets a real sort.
  const angle = new Float64Array(H);
  const pos = new Int32Array(H);
  const sortRun = (v: number): void => {
    const from = start[v];
    const to = start[v + 1];
    for (let k = from; k < to; k++) {
      const h = outgoing[k];
      const head = headOf(h);
      angle[h] = Math.atan2(Y[head] - Y[v], X[head] - X[v]);
    }
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
  };
  /** The smallest turn after `h`: the half-edge leaving `h`'s head just
   * clockwise of the way back, from a sorted run at that head. */
  const turnAfter = (h: number): number => {
    const twin = h ^ 1;
    const v = tailOf(twin);
    const from = start[v];
    const len = start[v + 1] - from;
    return outgoing[from + ((pos[twin] - 1 + len) % len)];
  };
  const next = new Int32Array(H);
  let found: { regions: (Region | null)[]; faceOf: Int32Array };
  if (cycles !== undefined) {
    // Faces named outright replace the walk, the containment and the
    // outside, and their runs say each claimed half-edge's successor. Only
    // a half-edge no run claims — the rim of a patch — takes the smallest
    // turn, so only the vertices it reaches are sorted.
    found = fromCycles(m, cycles, next, tailOf, headOf, start, outgoing);
    const sorted = new Uint8Array(n);
    for (let h = 0; h < H; h++) {
      if (found.faceOf[h] >= 0) continue;
      const v = headOf(h);
      if (!sorted[v]) {
        sorted[v] = 1;
        sortRun(v);
      }
    }
    for (let h = 0; h < H; h++) if (found.faceOf[h] < 0) next[h] = turnAfter(h);
  } else {
    for (let v = 0; v < n; v++) sortRun(v);
    for (let h = 0; h < H; h++) next[h] = turnAfter(h);
    found = fromWalk(m, start, outgoing, next, tailOf, headOf);
  }
  return { ...found, next };
}

/**
 * @internal The regions the planar walk reads off `m`, each as its runs of
 * vertex rows with the region on the left — the outer run first, then its
 * holes — in walk order. What a word that reads its faces off the picture
 * states them from, without building a face table.
 */
export function walkRuns(m: Material): number[][][] {
  const L = m.edgeList;
  const tailOf = (h: number): number => (h & 1 ? L[2 * (h >> 1) + 1] : L[2 * (h >> 1)]);
  return regionsOf(m).regions.map((r) => r!.cycles.map((cycle) => cycle.map(tailOf)));
}

/** No faces stated: what a value in space without a statement has. */
const NO_CYCLES: StatedFaces['cycles'] = Object.freeze([]);

/**
 * @internal The faces of one state: the face views, the incidence every
 * selection of them reads, the nesting, and the keys and ids that say who
 * each face is. One per state; `material.faces` is its `all`.
 *
 * The incidence is kept on the LEAVES: `faceOf` names, for each half-edge,
 * the leaf on its left. A face that holds others is the union of the
 * leaves under it, so every question about it — its edges, its walls, its
 * outline — is the same question asked of those leaves together.
 */
export class FaceTable<F extends Face = Face> {
  /** The material state the faces were read from. */
  readonly source: Material;
  /** Face views, by row. */
  readonly faces: readonly F[];
  /** The domain every selection of these faces shares. */
  readonly domain: FaceDomain;
  /** @internal */ readonly next: Int32Array; // face-walk successor of a half-edge
  /** @internal */ readonly faceOf: Int32Array; // leaf row on a half-edge's left, -1 outside
  /** @internal Per face row, the row that holds it (-1 for a root); null
   * when no face holds another. */
  readonly parentOf: Int32Array | null;
  /** One key per face, built the first time a face column is read; the
   * ids and the row of each id, the first time an id is asked for; the
   * neighbour lists and the whole selection, the first time they are. */
  private readonly keyBox: {
    keys: string[] | null; ids: FaceId[] | null; rowOf: Map<string, number> | null; all: readonly number[] | null;
    neighbours: readonly (readonly number[])[] | null; children: readonly (readonly number[])[] | null;
    sources: (FaceSource | typeof NO_SOURCE)[] | null; selection?: Selection<Face>;
  };
  /** @internal What each face carries of each face column, before the
   * column's `fallback`: its own value, or the one it inherited. A face the
   * column never reached has none. What a face write keeps of a column. */
  readonly carried: ReadonlyMap<string, readonly unknown[]>;
  private readonly sourceOf: ((f: number) => FaceSource) | undefined;
  /** The half-edge runs of each leaf (null for a face that holds others). */
  private readonly regions: readonly (Region | null)[];

  /** @internal Face `f`'s runs of vertex rows, the face on their left:
   * the outer run first, then its holes; none for a face that holds others. */
  runsOf(f: number): number[][] {
    const region = this.regions[f];
    if (region === null) return [];
    const L = this.source.edgeList;
    return region.cycles.map((cycle) => cycle.map((h) => (h & 1 ? L[2 * (h >> 1) + 1] : L[2 * (h >> 1)])));
  }

  /** @internal Use `material.faces`. `stated` is the material's own
   * statement of its faces, when a word made it with one. */
  constructor(m: Material, stated?: StatedFaces) {
    this.source = m;
    // The planar walk reads x and y: in space it would read a shadow of the
    // edges, not faces. A value with a z has the faces it states, or none.
    const inSpace = m.store.attrs.z instanceof Column;
    const { regions, faceOf, next } = regionsOf(m, stated?.cycles ?? (inSpace ? NO_CYCLES : undefined));
    const tailOf = (h: number): number => (h & 1 ? m.edgeList[2 * (h >> 1) + 1] : m.edgeList[2 * (h >> 1)]);
    const F = regions.length;
    const parentOf = stated?.parent !== undefined && stated.parent.some((p) => p >= 0) ? stated.parent : null;
    this.parentOf = parentOf;
    this.sourceOf = stated?.source;
    this.regions = regions;
    // views
    // A value in space measures its walls in space, and each face's normal,
    // area and centroid on its fixed triangles (`faceWords3`).
    const z = inSpace ? m.attrs.z : null;
    const edgeLength = z === null
      ? (e: number) => Math.hypot(m.x[m.edgeList[2 * e + 1]] - m.x[m.edgeList[2 * e]], m.y[m.edgeList[2 * e + 1]] - m.y[m.edgeList[2 * e]])
      : (e: number) => { const a = m.edgeList[2 * e]; const b = m.edgeList[2 * e + 1]; return Math.hypot(m.x[b] - m.x[a], m.y[b] - m.y[a], z[b] - z[a]); };
    const measured = new Map<number, { readonly normal: readonly [number, number, number]; readonly area: number; readonly centroid: readonly [number, number, number] }>();
    const spaceWords = (f: number) => {
      let got = measured.get(f);
      if (got === undefined) {
        got = faceWords3(m, f);
        measured.set(f, got);
      }
      return got;
    };
    const perimeterOf = (seq: number[]) => {
      const count = new Map<number, number>();
      for (const h of seq) count.set(h >> 1, (count.get(h >> 1) ?? 0) + 1);
      let p = 0;
      for (const [e, c] of count) if (c === 1) p += edgeLength(e);
      return p;
    };
    const contourOf = (cycle: number[]): IsoContour => {
      const pts = cycle.map((h) => Object.freeze([m.x[tailOf(h)], m.y[tailOf(h)]] as [number, number]));
      return Object.freeze({ pts: Object.freeze(pts) as unknown as [number, number][], closed: true }) as IsoContour;
    };
    const views: Face[] = [];
    // Depth from the root, and whether anything is held: a face's parent
    // comes before it, so one pass down the rows settles both.
    const depth = new Int32Array(F);
    const holds = new Uint8Array(F);
    if (parentOf !== null) {
      for (let f = 0; f < F; f++) {
        const p = parentOf[f];
        if (p >= 0) {
          depth[f] = depth[p] + 1;
          holds[p] = 1;
        }
      }
    }
    // Navigation per face reads the collection's incidence, like the
    // collection's own `edges`/`points`/`boundaryEdges` restricted to one face.
    const faceProto = Object.create(viewProto(this, 'face')) as Face;
    const collection = this;
    const oneFace = (f: number) => collection.leafTest((g) => g === f);
    Object.defineProperties(faceProto, {
      edges: { get(this: Face) { const inside = oneFace(this.index); return edgesOf(m, collection.edgeRowsWhere((l, r) => inside(l) || inside(r)), undefined, true); } },
      points: { get(this: Face) { return this.edges.points; } },
      boundaryEdges: { get(this: Face) { const inside = oneFace(this.index); return edgesOf(m, collection.edgeRowsWhere((l, r) => inside(l) !== inside(r)), undefined, true); } },
      adjacent: { get(this: Face) { return select(collection.domain, collection.neighbours()[this.index], undefined, true); } },
      parent: { get(this: Face) { const p = parentOf === null ? -1 : parentOf[this.index]; return p >= 0 ? collection.faces[p] : undefined; } },
      children: { get(this: Face) { return select(collection.domain, collection.childRows()[this.index], undefined, true); } },
      source: { get(this: Face) { return collection.sourceAt(this.index); } },
      depth: { get(this: Face) { return depth[this.index]; } },
      // The face's corners, round its loop (corners.ts); none where the
      // faces are read off the picture.
      corners: { get(this: Face) { return cornersOfFaces(m, [this.index]); } },
      // The side the face looks to: +z for a face in the plane (its outer
      // run turns counter-clockwise), the 3D layer's for a value in space.
      normal: { get(this: Face) { return z === null ? PLANE_NORMAL : spaceWords(this.index).normal; } },
      leaf: { get(this: Face) { return holds[this.index] === 0; } },
      // The face's identity: its walls' lineage, read the first time any
      // face of the collection is asked.
      id: { get(this: Face) { return collection.ids()[this.index]; } },
      // The selection word on one face: its edges and corners as material,
      // every column and id kept, as the selection of this one face gives —
      // and each wall stored the face's way round, so the chains it answers
      // wind as `contours()` does whatever order the walls were built in.
      extract: { value(this: Face) {
        const edges = this.edges;
        const inside = oneFace(this.index);
        return extractStated(collection, [this.index], edges.indices, inside) ?? stateExtracted(collection, [this.index], faceWise(edges.extract(), edges.indices, inside, collection.faceOf));
      } },
      // One word for a face's middle: an edge answers `center`, a face
      // `centroid` — the area's, not the box's — and says so by name.
      center: { get(this: Face): never { throw new Error("face.center: a face's middle is its centroid — f.centroid"); } },
    });
    Object.freeze(faceProto);
    const curved = curvedSpaceOf(m.space);
    for (let f = 0; f < F; f++) {
      const region = regions[f];
      if (region === null) {
        // A face that holds others: filled in below, from its leaves.
        views.push(undefined as unknown as Face);
        continue;
      }
      const area = region.area;
      const perimeter = perimeterOf(region.halfEdges);
      const contours = region.cycles.map(contourOf);
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
      const view = Object.assign(Object.create(faceProto) as Face, {
        index: f, area, perimeter, bounds: Object.freeze(box(x0, y0, x1 - x0, y1 - y0)), centroid: Object.freeze(centroid) as unknown as [number, number],
      });
      // In a curved space the face is measured in the space: its area is
      // the space's density over the region its walls enclose, and its
      // perimeter each wall's length in the space. Both are read the first
      // time they are asked and kept, and stay data keys of the record.
      if (curved) {
        let spaceAreaOf: number | undefined;
        let spacePerimeterOf: number | undefined;
        Object.defineProperty(view, 'area', { enumerable: true, get: () => (spaceAreaOf ??= spaceArea(curved, contours)) });
        Object.defineProperty(view, 'perimeter', { enumerable: true, get: () => (spacePerimeterOf ??= spacePerimeter(curved, contours)) });
      }
      // The contours are the face's own, but `contours()` is a call, like
      // every other area value's: it hangs off the view without joining the
      // view's data keys, so a face still spreads and serialises as the
      // plain record it is.
      const held = Object.freeze(contours) as unknown as IsoContour[];
      Object.defineProperty(view, 'contours', { value: () => held });
      if (z !== null) {
        // In space, the area and centroid are the face's own, in space.
        Object.defineProperty(view, 'area', { enumerable: true, get: () => spaceWords(f).area });
        Object.defineProperty(view, 'centroid', { enumerable: true, get: () => spaceWords(f).centroid });
      }
      views.push(view);
    }
    this.faces = views as readonly Face[] as readonly F[];
    this.next = next;
    this.faceOf = faceOf;
    this.keyBox = { keys: null, ids: null, rowOf: null, all: null, neighbours: null, children: null, sources: null };
    this.domain = new FaceDomain(this as unknown as FaceTable);
    if (parentOf !== null) this.fillHolders(views, faceProto, depth, holds, curved, regions.map((r) => (r === null ? 0 : r.area)));
    Object.freeze(views);
    // Face columns read flat, the way a vertex's do: `face.height`. The
    // values are keyed by the face's walls, so they are found once the
    // keys are known, and then baked onto the frozen view.
    const columns = Object.entries(m.faceAttrs);
    const carried = new Map<string, unknown[]>();
    for (const [name] of columns) carried.set(name, new Array<unknown>(views.length).fill(undefined));
    this.carried = carried;
    if (columns.length > 0) {
      // By id: two faces with the same walls are two faces.
      const keys = this.ids();
      // A face whose walls are unchanged finds its value by key. A face
      // whose boundary moved inherits from the old face it shares the most
      // walls with — that is what `'nearest'` means for a thing that has no
      // position of its own — and `'drop'` lets a column stop at a boundary
      // change rather than follow it.
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
          // inherits. A face the write saw and passed by has no value of
          // its own, and taking a neighbour's would be the column
          // spreading on its own.
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
          carried.get(name)![f] = value;
          // Dense: a face every write passed by and that inherits nothing
          // reads the column's fallback, or its kind's default — 0 for a
          // number. A reference reads as the row it names, when asked.
          const kind = column.kind;
          if (kind === undefined) Object.defineProperty(views[f], name, { value: value ?? column.fallback ?? 0, enumerable: true });
          else if (kind.name === 'reference') {
            const id = (value ?? null) as number | null;
            Object.defineProperty(views[f], name, { get: () => referenced(m, id), enumerable: true });
          } else Object.defineProperty(views[f], name, { value: value !== undefined ? value : column.fallback !== undefined ? column.fallback : kind.default, enumerable: true });
        }
      }
    }
    for (const view of views) Object.freeze(view);
    Object.freeze(this);
  }

  /** The views of the faces that hold others, from their leaves: area and
   * centroid summed, bounds joined, perimeter and outline read off the
   * walls between the face's leaves and the rest. */
  private fillHolders(views: Face[], faceProto: Face, depth: Int32Array, holds: Uint8Array, curved: ReturnType<typeof curvedSpaceOf>, flatArea: readonly number[]): void {
    const parentOf = this.parentOf!;
    const F = views.length;
    const m = this.source;
    // Children before parents: rows by depth, deepest first.
    const order = Array.from({ length: F }, (_, f) => f).sort((a, b) => depth[b] - depth[a] || a - b);
    const area = new Float64Array(F);
    const weight = new Float64Array(F);
    const mx = new Float64Array(F);
    const my = new Float64Array(F);
    const box4 = new Float64Array(4 * F);
    for (let f = 0; f < F; f++) box4.set([Infinity, Infinity, -Infinity, -Infinity], 4 * f);
    const perimeter = new Float64Array(F);
    // Every wall once: its length goes to each face it bounds.
    const z = m.store.attrs.z instanceof Column ? m.attrs.z : null;
    const X = m.x;
    const Y = m.y;
    const L = m.edgeList;
    const edgeLength = (e: number) => {
      const a = L[2 * e];
      const b = L[2 * e + 1];
      return z === null ? Math.hypot(X[b] - X[a], Y[b] - Y[a]) : Math.hypot(X[b] - X[a], Y[b] - Y[a], z[b] - z[a]);
    };
    this.eachWall((e, faces) => { const len = edgeLength(e); for (const f of faces) perimeter[f] += len; });
    for (const f of order) {
      if (holds[f]) continue;
      const v = views[f];
      area[f] = v.area;
      // The centroid is a chart reading: weighed by the flat area.
      const a = flatArea[f];
      if (Number.isFinite(v.centroid[0])) {
        weight[f] = a;
        mx[f] = a * v.centroid[0];
        my[f] = a * v.centroid[1];
      }
      box4.set([v.bounds.x, v.bounds.y, v.bounds.x + v.bounds.w, v.bounds.y + v.bounds.h], 4 * f);
    }
    for (const f of order) {
      const p = parentOf[f];
      if (holds[f]) {
        const x0 = box4[4 * f];
        const y0 = box4[4 * f + 1];
        const collection = this;
        let held: IsoContour[] | undefined;
        const view = Object.assign(Object.create(faceProto) as Face, {
          index: f,
          area: area[f],
          perimeter: perimeter[f],
          bounds: Object.freeze(box(x0, y0, box4[4 * f + 2] - x0, box4[4 * f + 3] - y0)),
          centroid: Object.freeze((weight[f] !== 0 ? [mx[f] / weight[f], my[f] / weight[f]] : [NaN, NaN]) as [number, number]),
        });
        Object.defineProperty(view, 'contours', { value: () => (held ??= Object.freeze(collection.boundaryContours((g) => g === f, collection.halfEdgesUnder(f).sort((a, b) => a - b))) as unknown as IsoContour[]) });
        if (curved) {
          let spacePerimeterOf: number | undefined;
          Object.defineProperty(view, 'perimeter', { enumerable: true, get: () => (spacePerimeterOf ??= spacePerimeter(curved, view.contours())) });
        }
        views[f] = view;
      }
      if (p < 0) continue;
      area[p] += area[f];
      weight[p] += weight[f];
      mx[p] += mx[f];
      my[p] += my[f];
      box4[4 * p] = Math.min(box4[4 * p], box4[4 * f]);
      box4[4 * p + 1] = Math.min(box4[4 * p + 1], box4[4 * f + 1]);
      box4[4 * p + 2] = Math.max(box4[4 * p + 2], box4[4 * f + 2]);
      box4[4 * p + 3] = Math.max(box4[4 * p + 3], box4[4 * f + 3]);
    }
  }

  /**
   * @internal A test over LEAF rows: is this leaf (or -1, the outside) one
   * of the faces `held` names, or held by one? The one reading every face
   * question takes of the leaves: a face that holds others is its leaves.
   */
  leafTest(held: (f: number) => boolean): (leaf: number) => boolean {
    const parentOf = this.parentOf;
    if (parentOf === null) return (l) => l >= 0 && held(l);
    return (l) => {
      for (let a = l; a >= 0; a = parentOf[a]) if (held(a)) return true;
      return false;
    };
  }

  /** @internal Every wall — an edge with a different leaf on each side —
   * with the faces it bounds: every face that holds one side and not the
   * other. Without nesting, the two leaves themselves. */
  private eachWall(visit: (e: number, faces: readonly number[]) => void): void {
    const parentOf = this.parentOf;
    const faces: number[] = [];
    for (let e = 0; e < this.faceOf.length / 2; e++) {
      const l = this.faceOf[2 * e];
      const r = this.faceOf[2 * e + 1];
      if (l === r) continue; // inside a face, not a wall of it
      faces.length = 0;
      if (parentOf === null) {
        if (l >= 0) faces.push(l);
        if (r >= 0) faces.push(r);
      } else {
        for (let a = l; a >= 0; a = parentOf[a]) if (!this.holdsLeaf(a, r)) faces.push(a);
        for (let a = r; a >= 0; a = parentOf[a]) if (!this.holdsLeaf(a, l)) faces.push(a);
      }
      visit(e, faces);
    }
  }

  /** @internal Does face `f` hold leaf `l` (or is it `l`)? */
  private holdsLeaf(f: number, l: number): boolean {
    const parentOf = this.parentOf;
    for (let a = l; a >= 0; a = parentOf === null ? -1 : parentOf[a]) if (a === f) return true;
    return false;
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
   * that edge is a wall of each face it bounds. Asking each face for its
   * `boundaryEdges` instead would be an O(E) scan per face.
   */
  keys(): readonly string[] {
    if (this.keyBox.keys) return this.keyBox.keys;
    const walls: number[][] = this.faces.map(() => []);
    const roots = this.source.edgeRoots;
    if (this.parentOf === null) {
      for (let e = 0; e < this.faceOf.length / 2; e++) {
        const l = this.faceOf[2 * e];
        const r = this.faceOf[2 * e + 1];
        if (l === r) continue; // inside a face, not a wall of it
        if (l >= 0) walls[l].push(roots[e]);
        if (r >= 0) walls[r].push(roots[e]);
      }
    } else {
      this.eachWall((e, faces) => { for (const f of faces) walls[f].push(roots[e]); });
    }
    // A wall cut in half is still one wall: the key is the SET of walls, so
    // a root that appears twice counts once. Without this, subdividing a
    // boundary would change the key of a face nothing else touched.
    const keys = walls.map(faceKeyOf);
    this.keyBox.keys = keys;
    return keys;
  }

  /**
   * One id per face: its key, and where two faces of one state have the
   * same walls — a figure eight drawn as one subdivided edge — the later
   * ones in row order are told apart by their place among them. Ids are
   * unique within a state and stable across states for every face whose
   * walls are.
   */
  ids(): readonly FaceId[] {
    return (this.keyBox.ids ??= faceIdsOf(this.keys()));
  }

  /** The face row an id is at in this state, or -1 when no face here has
   * those walls. */
  rowOfFace(id: FaceId): number {
    let map = this.keyBox.rowOf;
    if (!map) {
      map = new Map();
      this.ids().forEach((id, row) => map!.set(id, row));
      this.keyBox.rowOf = map;
    }
    return map.get(id) ?? -1;
  }

  /** @internal Every face row, ascending, built once. */
  allRows(): readonly number[] {
    return (this.keyBox.all ??= rowRange(this.faces.length));
  }

  /** @internal What face `f` came from, read once and kept, so two reads
   * of one face's source are the same value. */
  sourceAt(f: number): FaceSource {
    if (this.sourceOf === undefined) return undefined;
    const box = (this.keyBox.sources ??= new Array<FaceSource | typeof NO_SOURCE>(this.faces.length).fill(NO_SOURCE));
    const kept = box[f];
    return kept !== NO_SOURCE ? kept : (box[f] = this.sourceOf(f));
  }

  /** @internal The rows each face holds one step down, in row order. */
  childRows(): readonly (readonly number[])[] {
    if (this.keyBox.children) return this.keyBox.children;
    const lists: number[][] = this.faces.map(() => []);
    if (this.parentOf !== null) this.parentOf.forEach((p, f) => { if (p >= 0) lists[p].push(f); });
    const frozen = Object.freeze(lists.map((l) => Object.freeze(l)));
    this.keyBox.children = frozen;
    return frozen;
  }

  /** @internal The faces across a wall from each face, each once, in row
   * order: neighbours share an edge, not merely a vertex, and neither holds
   * the other. One pass over the walls, built the first time a relation
   * asks. */
  neighbours(): readonly (readonly number[])[] {
    if (this.keyBox.neighbours) return this.keyBox.neighbours;
    const sets = this.faces.map(() => new Set<number>());
    const parentOf = this.parentOf;
    for (let e = 0; e < this.faceOf.length / 2; e++) {
      const l = this.faceOf[2 * e];
      const r = this.faceOf[2 * e + 1];
      if (l === r || l < 0 || r < 0) continue;
      if (parentOf === null) {
        sets[l].add(r);
        sets[r].add(l);
        continue;
      }
      const left: number[] = [];
      const right: number[] = [];
      for (let a = l; a >= 0; a = parentOf[a]) if (!this.holdsLeaf(a, r)) left.push(a);
      for (let a = r; a >= 0; a = parentOf[a]) if (!this.holdsLeaf(a, l)) right.push(a);
      for (const a of left) for (const b of right) {
        sets[a].add(b);
        sets[b].add(a);
      }
    }
    const lists = Object.freeze(sets.map((s) => Object.freeze([...s].sort((a, b) => a - b))));
    this.keyBox.neighbours = lists;
    return lists;
  }

  /** @internal The selection of every face: what `m.faces` answers, one
   * per state. */
  get all(): Selection<F> {
    return (this.keyBox.selection ??= select(this.domain, null)) as unknown as Selection<F>;
  }

  /** @internal The faces on the two sides of a source edge, as `edge.faces`
   * answers them: the leaf on its left, then the one on its right, each
   * once — two for a wall between cells, one for a wall on the outside or
   * a spur inside a face, none for an edge no face touches. The edge must
   * be a view of the source state. */
  facesOf(edge: Edge): Selection<F> {
    if (viewKind(edge) !== 'edge') throw new Error('edge.faces: expected an edge view');
    if (!ownedBy(edge, this.source)) throw new Error('edge.faces: that edge belongs to another state — take it from the material these faces were read from');
    const l = this.faceOf[2 * edge.index];
    const r = this.faceOf[2 * edge.index + 1];
    const out: number[] = [];
    if (l >= 0) out.push(l);
    if (r >= 0 && r !== l) out.push(r);
    return select(this.domain, out, undefined, true) as unknown as Selection<F>;
  }

  /** @internal Edge rows chosen by the leaves on their two sides
   * (`faceOf` of each half-edge, -1 outside). */
  edgeRowsWhere(pick: (left: number, right: number) => boolean): number[] {
    const rows: number[] = [];
    for (let e = 0; e < this.faceOf.length / 2; e++) if (pick(this.faceOf[2 * e], this.faceOf[2 * e + 1])) rows.push(e);
    return rows;
  }

  /** @internal The half-edges on the left of the leaves face `f` holds
   * (itself, for a leaf). */
  private halfEdgesUnder(f: number): number[] {
    const out: number[] = [];
    const stack = [f];
    const children = this.childRows();
    while (stack.length) {
      const g = stack.pop()!;
      const region = this.regions[g];
      if (region !== null) for (const h of region.halfEdges) out.push(h);
      for (const c of children[g]) stack.push(c);
    }
    return out;
  }

  /** @internal Closed contours around the union of the selected faces. A
   * half-edge is a boundary when its leaf is selected (or held by a
   * selected face) and its twin's is not; contours follow face walks,
   * rotating through selected faces at a vertex, so regions touching at a
   * point stay separate contours. */
  boundaryContours(selected: (face: number) => boolean, starts?: readonly number[]): IsoContour[] {
    const m = this.source;
    const H = this.faceOf.length;
    const X = m.x;
    const Y = m.y;
    const L = m.edgeList;
    const tailOf = (h: number): number => (h & 1 ? L[2 * (h >> 1) + 1] : L[2 * (h >> 1)]);
    const inside = this.leafTest(selected);
    const isBoundary = (h: number) => inside(this.faceOf[h]) && !inside(this.faceOf[h ^ 1]);
    const used = new Uint8Array(H);
    const out: IsoContour[] = [];
    const count = starts === undefined ? H : starts.length;
    for (let k = 0; k < count; k++) {
      const h0 = starts === undefined ? k : starts[k];
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
      for (const cycle of splitWalk(seq, tailOf)) out.push({ pts: cycle.map((g) => [X[tailOf(g)], Y[tailOf(g)]] as [number, number]), closed: true });
    }
    return out;
  }
}

/** The normal of a face in the plane. */
const PLANE_NORMAL: readonly [number, number, number] = Object.freeze([0, 0, 1] as [number, number, number]);

/** A face whose source has not been read yet. */
const NO_SOURCE = Symbol('unread');

/**
 * A face collection read as POINTS: each face's centroid, in the
 * selection's order, a degenerate face (no area, no centroid) left out.
 * The one reading every point consumer gives a face collection or
 * selection — `dots`, `distanceTo`, `material`, `connect.*`, the forces —
 * while `faces.points` stays the word for the corners. Null for anything
 * that is not a face selection.
 */
export function faceCentroids(v: unknown): [number, number][] | null {
  if (!isFaceSelection(v)) return null;
  const out: [number, number][] = [];
  for (const f of v) {
    const [x, y] = f.centroid;
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}

/** @internal The face table of a material read off its picture, whatever
 * it states: the planar walk. `material.faces` keeps one per state. */
export function faceTable(m: Material): FaceTable {
  return new FaceTable(m);
}

/**
 * @internal A measurement's columns written onto faces `rows` of `table`:
 * the geometry of those faces with every column set, each read against
 * the faces as they were. A value that is not finite is still written — a
 * measurement that has no answer for a face says so with NaN. A column the
 * write did not reach on some face reads its fallback, as every face
 * column does.
 */
function setFaceColumns(table: FaceTable, rows: readonly number[], columns: Readonly<Record<string, ArrayLike<number>>>): Material {
  return writeFaceColumns(table, rows, columns, true);
}
