/**
 * Corners: the face-vertex pairs of a geometry's stated faces.
 *
 * A face a word states (a tiling, a grid, a mesh) goes round a loop of
 * point rows. Each place the loop passes a point is a CORNER: one row per
 * face and point, in face order and round each face's loop. A corner is
 * where a value belongs to a face at one of its points and to neither
 * alone — a texture coordinate at a seam, a crease normal, a colour that
 * changes across an edge.
 *
 * `g.corners` is a selection like every other domain (selection.ts). A
 * corner row answers `index`, its `point` (the vertex view) and its `face`
 * (the face view), and its columns flat, of any kind (column.ts). The kind
 * has two relations — `sel.points`, `sel.faces` — and the one write,
 * `sel.set`. A geometry without stated faces has no corners: an empty
 * selection, not another type.
 *
 * Corners live and die with the faces they belong to. The corner columns
 * are held on the stated faces (`StatedFaces.corners`), so every write that
 * keeps the edges keeps them — a move, a column write, a transform — and a
 * write that changes the edges drops the stated faces, and their corners
 * with them. Across two states that both hold them, a corner is found by
 * its face and its point, never by its row.
 */

import { Material, referenced, type Vertex } from './material.js';
import { Column, at64, valueAt, type AnyColumn } from './column.js';
import { Selection, select, domainKind, isSelectionOf, rowRange, ROW_TYPES, type Domain, type DomainKind, type Types } from './selection.js';
import { pointsOf, sameLineage, unrelated } from './relation.js';
import { faceTableOf, type Face, type StatedFaces } from './faces.js';
import { viewProto, viewKind, ownedBy, ownerOfView } from './views.js';
import { writeCorners, type CellValue } from './tables.js';

/** A corner: one place a stated face's loop passes one of its points. */
export type Corner = {
  /** This corner's row in `g.corners` — a row of this state. */
  readonly index: number;
  /** The point this corner is at. */
  readonly point: Vertex;
  /** The face this corner belongs to. */
  readonly face: Face;
  readonly [ROW_TYPES]?: CornerTypes;
} & { readonly [column: string]: any };

/** The corner write: a value or a function of the corner, on these corners
 * or those `where` names. Corners take no options: they have no transfer —
 * they live and die with their face. */
export interface CornerSet {
  (column: string, value: CellValue | ((c: Corner) => CellValue | undefined), where?: Selection<Corner> | Corner | ((c: Corner) => unknown)): Material;
  (values: Record<string, CellValue | ((c: Corner) => CellValue | undefined)>, where?: Selection<Corner> | Corner | ((c: Corner) => unknown)): Material;
}

/** @internal What a selection of corners answers (see `ROW_TYPES`). */
export type CornerTypes = Types<{
  source: Material;
  points: Selection<Vertex>;
  faces: Selection<Face>;
  corners: Selection<Corner>;
  set: CornerSet;
}>;

/** The names a corner view owns: a column may not take one. */
export const RESERVED_CORNER_FIELDS: readonly string[] = ['index', 'id', 'point', 'face', 'source'];

// ---- the corner index of a statement --------------------------------------------

/** Where each corner of a statement is: its face row and its point row, and
 * where each face's corners start. */
export interface CornerIndex {
  readonly count: number;
  readonly face: Uint32Array;
  readonly point: Uint32Array;
  /** Per face row, its first corner row; one more entry, the count. */
  readonly start: Uint32Array;
}

const INDEXES = new WeakMap<object, CornerIndex>();

/** @internal The corners of stated faces: every face's runs, in order, a
 * corner per vertex. Kept per statement of loops, which every corner write
 * shares. */
export function cornerIndex(cycles: StatedFaces['cycles']): CornerIndex {
  let got = INDEXES.get(cycles);
  if (got !== undefined) return got;
  let count = 0;
  for (const runs of cycles) for (const run of runs) count += run.length;
  const face = new Uint32Array(count);
  const point = new Uint32Array(count);
  const start = new Uint32Array(cycles.length + 1);
  let c = 0;
  cycles.forEach((runs, f) => {
    start[f] = c;
    for (const run of runs) for (const p of run) { face[c] = f; point[c] = p; c++; }
  });
  start[cycles.length] = c;
  got = Object.freeze({ count, face, point, start });
  INDEXES.set(cycles, got);
  return got;
}

const EMPTY_INDEX: CornerIndex = Object.freeze({ count: 0, face: new Uint32Array(0), point: new Uint32Array(0), start: new Uint32Array(1) });

// ---- the domain ------------------------------------------------------------------

/** The corners of one state as a domain. */
export class CornerDomain implements Domain<Corner> {
  readonly kind: DomainKind = CORNERS;
  readonly dense = true;
  readonly index: CornerIndex;
  readonly stated: StatedFaces | undefined;
  private readonly views: (Corner | undefined)[] = [];
  private proto: object | null = null;
  private allRows: readonly number[] | null = null;
  private byKey: Map<string, number> | null = null;

  constructor(readonly source: Material) {
    this.stated = source.stated;
    this.index = this.stated === undefined ? EMPTY_INDEX : cornerIndex(this.stated.cycles);
  }

  get size(): number { return this.index.count; }
  all(): readonly number[] { return (this.allRows ??= rowRange(this.index.count)); }
  valid(r: number): boolean { return Number.isInteger(r) && r >= 0 && r < this.index.count; }

  /** The corner columns this state holds, by name. */
  columns(): Readonly<Record<string, AnyColumn>> {
    return this.stated?.corners ?? {};
  }

  row(r: number): Corner {
    const kept = this.views[r];
    if (kept !== undefined) return kept;
    const m = this.source;
    const index = this.index;
    const proto = (this.proto ??= Object.create(viewProto(this, 'corner'), {
      point: { get(this: Corner) { return m.vertex(index.point[this.index]); }, enumerable: false },
      face: { get(this: Corner) { return m.faces.at(index.face[this.index]); }, enumerable: false },
    }) as object);
    const v = Object.create(proto) as Record<string, unknown>;
    v.index = r;
    const cols = this.columns();
    for (const name in cols) {
      const col = cols[name];
      if (col instanceof Column) v[name] = at64(col, r);
      else if (col.kind.name === 'reference') {
        const id = valueAt(col, r) as number | null;
        Object.defineProperty(v, name, { get: () => referenced(m, id), enumerable: true });
      } else if (col.kind.name === 'vector') v[name] = Object.freeze(valueAt(col, r) as number[]);
      else v[name] = valueAt(col, r);
    }
    const out = Object.freeze(v) as unknown as Corner;
    this.views[r] = out;
    return out;
  }

  /** The corner rows at point row `p`, ascending: an index by point, made
   * the first time a point asks. */
  atPoint(p: number): number[] {
    let by = this.byPoint;
    if (by === null) {
      const lists: number[][] = [];
      for (let c = 0; c < this.index.count; c++) (lists[this.index.point[c]] ??= []).push(c);
      by = this.byPoint = lists;
    }
    return by[p] ?? [];
  }

  private byPoint: number[][] | null = null;

  /** A corner's identity: its minted id where the statement mints them,
   * else its face's id and its point's id. */
  keyOf(r: number): string {
    const ids = this.stated?.cornerIds;
    if (ids !== undefined) return `#${ids[r]}`;
    const m = this.source;
    const faceId = faceTableOf(m.faces).ids()[this.index.face[r]];
    return `${faceId}@${at64(m.store.pointIds, this.index.point[r])}`;
  }

  /** The row a corner key names here, or -1. */
  rowOfKey(key: string): number {
    if (this.byKey === null) {
      const map = new Map<string, number>();
      for (let r = 0; r < this.index.count; r++) if (!map.has(this.keyOf(r))) map.set(this.keyOf(r), r);
      this.byKey = map;
    }
    return this.byKey.get(key) ?? -1;
  }

  rowOf(v: unknown, who: string): number {
    if (viewKind(v) !== 'corner') {
      const kind = viewKind(v);
      throw new Error(`${who}: expected a corner — got ${kind !== undefined ? `a ${kind} view` : v instanceof Selection ? `a ${v.domain.kind.name} selection` : v === null ? 'null' : typeof v}`);
    }
    if (ownedBy(v as object, this)) return (v as Corner).index;
    const theirs = ownerOfView(v as object) as CornerDomain;
    if (theirs.source === this.source) return (v as Corner).index;
    if (!sameLineage(this.source, theirs.source)) return -1;
    return this.rowOfKey(theirs.keyOf((v as Corner).index));
  }

  resolve(other: Selection<any>, who: string): number[] {
    if (other.domain.kind !== CORNERS) throw new Error(`${who}: expected corners — a corner selection — got ${other.domain.kind.plural}`);
    const theirs = other.domain as CornerDomain;
    if (theirs.source === this.source) return [...other.indices];
    if (!sameLineage(this.source, theirs.source)) throw unrelated(who);
    const out: number[] = [];
    for (const r of other.indices) {
      const here = this.rowOfKey(theirs.keyOf(r));
      if (here >= 0) out.push(here);
    }
    return out;
  }

  on(state: unknown, who: string): Domain<Corner> {
    if (!(state instanceof Material)) throw new Error(`${who}: expected the geometry to read the corners on`);
    return cornerDomain(state);
  }
}

/** @internal The corner domain of a geometry, made once per state. */
export function cornerDomain(m: Material): CornerDomain {
  return ((m.domainBox.corners as CornerDomain | null) ??= new CornerDomain(m)) as CornerDomain;
}

/** @internal The corners of `m`, `rows` of them (null: every one). */
export function cornersOf(m: Material, rows: readonly number[] | null = null): Selection<Corner> {
  return select(cornerDomain(m), rows, undefined, true);
}

/** @internal The corners of the faces `faceRows` of `m`, face by face. */
export function cornersOfFaces(m: Material, faceRows: readonly number[]): Selection<Corner> {
  const d = cornerDomain(m);
  const out: number[] = [];
  for (const f of faceRows) {
    if (f + 1 >= d.index.start.length) continue;
    for (let c = d.index.start[f]; c < d.index.start[f + 1]; c++) out.push(c);
  }
  return select(d, out, undefined, true);
}

/** @internal The corners at point row `p` of `m`, in row order. */
export function cornersAtPoint(m: Material, p: number): Selection<Corner> {
  const d = cornerDomain(m);
  return select(d, d.atPoint(p), undefined, true);
}

/** @internal The faces that meet point row `p` of `m`, in row order: the
 * faces of its corners where the faces are stated, else the faces on the
 * sides of its edges. */
export function facesAtPoint(m: Material, p: number): Selection<Face> {
  const faces = m.faces;
  if (m.stated !== undefined) {
    const d = cornerDomain(m);
    return select(faces.domain, once(d.atPoint(p).map((c) => d.index.face[c])), undefined, true);
  }
  const table = faceTableOf(faces);
  const rows: number[] = [];
  // A value with an area of its own reads its faces there, by edge id.
  const own = table.source === m;
  for (const i of m.incidentEdgeRows(p)) {
    const e = own ? i : table.source.rowOfEdge(at64(m.store.edgeIds, i) as never);
    if (e < 0) continue;
    const l = table.faceOf[2 * e];
    const r = table.faceOf[2 * e + 1];
    if (l >= 0) rows.push(l);
    if (r >= 0) rows.push(r);
  }
  return select(faces.domain, once(rows), undefined, true);
}

type CornerSel = Selection<Corner> & { readonly source: Material; readonly domain: CornerDomain };

/** Rows once each, ascending. */
const once = (rows: Iterable<number>): number[] => [...new Set(rows)].sort((a, b) => a - b);

const CORNERS: DomainKind = domainKind('corner', 'corners', {
  /** The points the corners are at, each once, in row order. */
  points: { get(this: CornerSel) { const d = this.domain; return pointsOf(this.source, once(this.indices.map((c) => d.index.point[c])), undefined, true); } },
  /** The faces the corners belong to, each once, in row order. */
  faces: { get(this: CornerSel) { const d = this.domain; return select(this.source.faces.domain, once(this.indices.map((c) => d.index.face[c])), undefined, true); } },
  /** Itself. */
  corners: { get(this: CornerSel) { return this; } },
  /** The geometry with corner columns set on these corners, or on those
   * `where` names among them: one instant, each value of any kind. */
  set: { value(this: CornerSel, ...args: unknown[]): Material { return writeCorners(this, args); } },
}, {
  adjacent: 'a corner has no neighbours of its own — its face is c.face, its point c.point',
  connected: 'a corner has no neighbours of its own — its face is c.face, its point c.point',
  components: 'a corner has no neighbours of its own — its face is c.face, its point c.point',
  near: 'corners have no place of their own — ask the points: sel.points.near(p, { radius })',
  add: 'corners come with their faces — a geometry states its faces and their corners',
  remove: 'corners go with their faces',
  extract: 'corners belong to their faces — extract the faces: sel.faces.extract()',
});

/** Is `v` a selection of a geometry's corners? */
export const isCornerSelection = (v: unknown): v is Selection<Corner> => isSelectionOf(v, CORNERS);
