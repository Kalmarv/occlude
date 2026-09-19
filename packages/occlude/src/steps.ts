/**
 * One step: how a pass's edits are recorded against a frozen state and
 * committed as the next one. `Next` is the edit vocabulary a rule sees;
 * `stepOnce` applies one batch — the order of resolution, the conflict
 * rules and the transfer of columns through moves, splits, removals and
 * connections are all here, and `Material.steps` is the loop over it.
 *
 * The state class and the selection classes come in through `StepKit`,
 * passed by `Material.steps`, so this module needs nothing of the material
 * module at runtime (types only) and no import cycle exists: material →
 * steps → { vec, views }.
 */

import { vx, vy, type XY } from './vec.js';
import { ownerOf, pairKey, viewKind } from './views.js';
import { mintIds, type Material, type Vertex, type Edge, type TransferPolicy, type EdgeTransfer, type Snapshot } from './material.js';
import type { PointSelection, EdgeSelection } from './relation.js';

/** What `stepOnce` needs from the material cluster, handed over by the
 * caller: the state constructor and the two selection classes it must
 * recognise. Typed, explicit and complete — nothing else of the sketch
 * reaches an edit batch. */
export interface StepKit {
  Material: new (
    x: Float64Array, y: Float64Array, attrs: Record<string, Float64Array>, edgeList: Uint32Array,
    carry?: {
      iteration?: number;
      history?: readonly Snapshot[];
      edgeAttrs?: Record<string, Float64Array>;
      transfers?: Record<string, TransferPolicy>;
      edgeTransfers?: Record<string, EdgeTransfer>;
      ids?: { points?: Float64Array; edges?: Float64Array; edgeRoots?: Float64Array };
    },
  ) => Material;
  PointSelection: typeof PointSelection;
  EdgeSelection: typeof EdgeSelection;
}

/** A child edge's inherited columns: a `'copy'` column carries the parent's
 * value, a `'distribute'` column the parent's value times the child's
 * share of the parent. */
export function inheritEdge(m: Material, parent: Record<string, number>, fraction: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name in parent) out[name] = m.edgeTransfers[name] === 'distribute' ? parent[name] * fraction : parent[name];
  return out;
}

// ---- one step ---------------------------------------------------------------------

/** A vertex added or split in this edit batch, usable before the batch
 * resolves — and only there: a handle carries its batch and is refused by
 * any other. Opaque: no coordinates to read. */
export interface Handle {
  readonly __handle: number;
  readonly __batch: object;
}

/** A point reference an edit accepts: a row of the current state, a
 * vertex view of the current state, or a handle from this batch. A bare
 * number always means a row. */
export type Ref = number | Vertex | Handle;

const isHandle = (r: unknown): r is Handle => typeof r === 'object' && r !== null && '__handle' in r;
const isVertexView = (r: unknown): r is Vertex => viewKind(r) === 'vertex';

/** One child of `extrude`: a new point (`position` + `attributes`) or an
 * existing target (`to`); either way an edge from the parent, carrying
 * `edgeAttributes` when edge columns are declared. A new point must name
 * every declared column, unless `extrude` runs with `inherit: true`, in
 * which case it starts from its parent's values and `attributes` are the
 * overrides. */
export type ChildSpec =
  | { position: XY; attributes?: Record<string, number>; edgeAttributes?: Record<string, number>; to?: undefined }
  | { to: Ref; edgeAttributes?: Record<string, number>; position?: undefined };

/** The interval of a split child edge in the ORIGINAL edge's parameter
 * space: `from` → `to`, and its share `fraction = to - from`. */
export interface ChildInterval {
  from: number;
  to: number;
  fraction: number;
}

export interface SplitOpts {
  /** Fraction along the edge (stored a → b), default 0.5; 0 or 1 return
   * the existing endpoint and create nothing. */
  at?: number;
  /** Point attributes for the inserted vertex, merged over the inherited
   * ones (declared transfer policies, interpolate by default): a partial
   * record, or a callback of the moved parent edge and `at`. */
  point?: Record<string, number> | ((e: Edge, at: number) => Record<string, number>);
  /** Edge attributes for each child edge, merged over the parent's
   * (updated) values: a partial record, or a callback of the moved parent
   * edge and the child's interval. */
  edges?: Record<string, number> | ((e: Edge, child: ChildInterval) => Record<string, number>);
  /** Migration: the pre-edge-column spelling of `point` (a full or partial
   * record, or a callback of the edge). */
  attributes?: Record<string, number> | ((e: Edge) => Record<string, number>);
  /** Migration: rewrite the START vertex's point attributes on split. Only
   * meaningful for the old "edge attribute on its start vertex" idiom;
   * real edge columns use `edges`. */
  parent?: (e: Edge) => Record<string, number>;
}

/**
 * The next state under construction. Every vertex and edge starts as a
 * copy of the current one, so a rule only states what changes. All
 * callbacks and selectors see the FROZEN current state; no edit changes
 * what a later callback reads. Order of resolution: moves and attribute
 * writes first (moves add up, the last write of a field wins), then structural requests —
 * removals, disconnections, splits (sorted along each original edge),
 * added points, connections — then one compaction. A conflicting batch
 * (see the table in the docs) throws and publishes nothing.
 */
/** A row of the current state's edge list, or an edge view of it. */
export type EdgeRef = number | Edge;
/** One pass reads a frozen material and batches edits for its output. */
export type StepRule = (prev: Material, next: Next, k: number) => void;
/** The everyday step, without the pass ceremony: `{ move, set }` fields over
 * every point of the pass's input. (A bare callback is not a shorthand:
 * TypeScript cannot tell a one-parameter point field from a rule.) */
export type StepShorthand = { readonly move?: XY | ((p: Vertex) => XY); readonly set?: Record<string, number> | ((p: Vertex) => Record<string, number>) };
export function isStepShorthand(rule: StepRule | StepShorthand): rule is StepShorthand {
  return typeof rule === 'object' && rule !== null;
}
export function stepRuleOf(shorthand: StepShorthand): StepRule {
  const { move, set } = shorthand;
  if (move === undefined && set === undefined) throw new Error('a steps shorthand needs a move field, a set field, or both');
  return (prev, next) => {
    if (set !== undefined) next.set(prev.points, set);
    if (move !== undefined) next.move(prev.points, move);
  };
}
export interface StepsOptions {
  /** Capture after every m complete iterations, plus the initial and final states. */
  every?: number;
}

/** How a motif lands on an edge. */
export interface ReplaceOpts {
  /** Mirror the motif across the edge. The callback sees the edge and the
   * step, so alternating on the step grows a curve inward and outward by
   * turns. Which side is "outward" depends on the seed's winding. */
  flip?: boolean | ((e: Edge, k: number) => boolean);
}

export interface Next {
  /** Displace selected points. Callbacks read this pass's input; moves add up. */
  move(points: PointSelection, by: XY | ((p: Vertex) => XY)): void;
  move(point: Ref, by: XY): void;
  /** Write selected point attributes; the last write of a field wins. */
  set(points: PointSelection, attrs: Record<string, number> | ((p: Vertex) => Record<string, number>)): void;
  set(point: Ref, attrs: Record<string, number>): void;
  /** Write attributes of one edge or a selection of this pass's input edges. */
  setEdge(edge: EdgeRef, attrs: Record<string, number>): void;
  setEdges(edges: EdgeSelection, attrs: Record<string, number> | ((e: Edge) => Record<string, number>)): void;
  /** Add a point. Every declared point column must be given. */
  addPoint(position: XY, attributes: Record<string, number>): Handle;
  /** Connect input points or handles created in this pass. */
  connect(a: Ref, b: Ref, edgeAttributes?: Record<string, number>): void;
  /** Remove edges, keeping their points. Repeated requests are harmless. */
  disconnect(edges: EdgeSelection): void;
  disconnect(edge: EdgeRef): void;
  /** Delete points and their incident edges; never join their neighbours. */
  remove(points: PointSelection): void;
  remove(point: Ref): void;
  /** Split an edge. Several requests on one edge are resolved together. */
  split(edge: EdgeRef, opts?: SplitOpts): Ref;
  /** Split selected input edges. To select by completed movement, use a later pass. */
  splitEdges(edges: EdgeSelection, opts?: SplitOpts): void;
  /** Swap every selected edge for a motif. The edge goes, and the motif's
   * one open chain takes its place between the same two points, scaled and
   * turned to the edge. Point columns interpolate and edge columns inherit,
   * exactly as a split's children do. This is the substitution an L-system
   * is made of: a Koch curve is one motif and four steps. */
  replace(edges: EdgeSelection, motif: Material, opts?: ReplaceOpts): void;
  /** Create children connected to selected parents. Children do not enter the
   * parent selection. With inherit, parent attributes precede explicit overrides. */
  extrude(points: PointSelection, spec: (p: Vertex) => ChildSpec | ChildSpec[], opts?: { inherit?: boolean }): void;
}

/** @internal Every declared column named (unless `complete: false`), no unknown name, every value finite. */
export function checkAttrs(attrs: Record<string, number>, names: string[], what: string, opts: { complete?: boolean } = {}): void {
  if (opts.complete !== false) {
    for (const name of names) {
      if (!(name in attrs)) throw new Error(`steps: must give '${name}' for ${what} (every attribute is a choice)`);
    }
  }
  for (const name in attrs) {
    if (!names.includes(name)) throw new Error(`steps: no attribute '${name}' — declare it first`);
  }
  for (const name in attrs) {
    if (!Number.isFinite(attrs[name])) throw new Error(`steps: '${name}' for ${what} is not a finite number`);
  }
}

function finiteXY(v: XY, what: string): [number, number] {
  const x = vx(v);
  const y = vy(v);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`steps: ${what} is not finite`);
  return [x, y];
}

interface SplitRequest {
  at: number;
  point?: SplitOpts['point'];
  edges?: SplitOpts['edges'];
  attributes?: SplitOpts['attributes'];
  parent?: SplitOpts['parent'];
  /** Handle allotted to the inserted vertex (bulk splits get none). */
  handle?: number;
}

/** @internal Apply one pass to `cur` and return the committed next state. */
export function stepOnce(cur: Material, k: number, rule: StepRule, iteration: number, kit: StepKit): Material {
  const { Material, PointSelection, EdgeSelection } = kit;
  const n = cur.n;
  const m = cur.edgeCount;
  const names = cur.attrNames;
  const enames = cur.edgeAttrNames;
  const batch = {};

  // ---- what the rule records ----
  const nx = Float64Array.from(cur.x);
  const ny = Float64Array.from(cur.y);
  const nattrs: Record<string, Float64Array> = {};
  for (const name of names) nattrs[name] = Float64Array.from(cur.attrs[name]);
  const neattrs: Record<string, Float64Array> = {};
  for (const name of enames) neattrs[name] = Float64Array.from(cur.edgeAttrs[name]);
  const touchedPoint = new Set<number>(); // rows an explicit move/set named
  const touchedEdge = new Set<number>(); // edge rows setEdge/setEdges named
  const removed = new Set<number>();
  const disconnected = new Set<number>();
  const splits = new Map<number, SplitRequest[]>(); // by ORIGINAL edge row
  const added: { x: number; y: number; attrs: Record<string, number> }[] = [];
  const links: { a: Ref; b: Ref; attrs: Record<string, number> }[] = [];

  const rowOf = (r: Ref, what: string): number => {
    if (r instanceof EdgeSelection) throw new Error(`steps: ${what} needs a point selection, not edges`);
    if (isHandle(r)) throw new Error(`steps: ${what} cannot be a handle here`);
    if (isVertexView(r)) {
      if (ownerOf(r) === cur) return r.index;
      // The same vertex, held from an earlier state: found by who it is.
      const row = cur.rowOfPoint(r.id);
      if (row < 0) throw new Error(`steps: ${what} is not a vertex of this state — it is of another material, or this state no longer has it`);
      return row;
    }
    if (!Number.isInteger(r) || r < 0 || r >= n) throw new Error(`steps: ${what}: no vertex ${String(r)} in this state (${n} rows)`);
    return r;
  };
  const edgeRow = (e: EdgeRef, what: string): number => {
    if (typeof e === 'number') {
      if (!Number.isInteger(e) || e < 0 || e >= m) throw new Error(`steps: ${what}: no edge ${e} in this state (${m} edges)`);
      return e;
    }
    if (viewKind(e) !== 'edge') throw new Error(`steps: ${what} must be an edge row or view`);
    if (ownerOf(e as unknown as Vertex) === cur) return e.index;
    const row = cur.rowOfEdge(e.id);
    if (row < 0) throw new Error(`steps: ${what} is not an edge of this state — it is of another material, or a split retired it`);
    return row;
  };
  // A selection from an EARLIER state of the same evolution is re-bound by
  // identity rather than refused: the rows are that state's numbering, but
  // the points are the same points. Members that are gone are skipped. A
  // selection of a material with no shared identity re-binds to nothing,
  // and the verb then does nothing — which is what "skip what is gone"
  // means when everything is gone.
  const pointRows = (selection: PointSelection, what: string): readonly number[] => {
    if (!(selection instanceof PointSelection)) throw new Error(`steps: ${what} needs a point selection — use prev.points.filter(...)`);
    return selection.source === cur ? selection.indices : selection.in(cur).indices;
  };
  const edgeRows = (selection: EdgeSelection, what: string): readonly number[] => {
    if (!(selection instanceof EdgeSelection)) throw new Error(`steps: ${what} needs an edge selection — use prev.edges.filter(...)`);
    return selection.source === cur ? selection.indices : selection.in(cur).indices;
  };
  const writePoint = (index: number, attrs: Record<string, number>) => {
    for (const [name, v] of Object.entries(attrs)) {
      const col = nattrs[name];
      if (!col) throw new Error(`steps: no attribute '${name}' — declare it first`);
      if (!Number.isFinite(v)) throw new Error(`steps: '${name}' is not a finite number`);
      col[index] = v;
    }
  };
  const writeEdge = (row: number, attrs: Record<string, number>) => {
    for (const [name, v] of Object.entries(attrs)) {
      const col = neattrs[name];
      if (!col) throw new Error(`steps: no edge attribute '${name}' — declare it with edgeAttribute()`);
      if (!Number.isFinite(v)) throw new Error(`steps: '${name}' is not a finite number`);
      col[row] = v;
    }
  };
  // Options are recorded as they are at the call: a plain record is
  // copied, a callback stays a function (it runs on the moved state).
  const byValue = <T,>(v: T): T => (v !== null && typeof v === 'object' ? ({ ...(v as object) } as T) : v);
  const splitRequest = (opts: SplitOpts, at: number): SplitRequest => ({
    at, point: byValue(opts.point), edges: byValue(opts.edges), attributes: byValue(opts.attributes), parent: opts.parent,
  });
  const recordSplit = (row: number, req: SplitRequest) => {
    const list = splits.get(row) ?? [];
    list.push(req);
    splits.set(row, list);
  };

  const next: Next = {
    move(target: Ref | PointSelection, by: XY | ((p: Vertex) => XY)) {
      const rows = target instanceof PointSelection ? pointRows(target, 'move') : [rowOf(target, 'move')];
      for (const row of rows) {
        const [dx, dy] = finiteXY(typeof by === 'function' ? by(cur.vertex(row)) : by, 'a move');
        nx[row] += dx; ny[row] += dy; touchedPoint.add(row);
      }
    },
    set(target: Ref | PointSelection, attrs: Record<string, number> | ((p: Vertex) => Record<string, number>)) {
      const rows = target instanceof PointSelection ? pointRows(target, 'set') : [rowOf(target, 'set')];
      for (const row of rows) {
        writePoint(row, typeof attrs === 'function' ? attrs(cur.vertex(row)) : attrs);
        touchedPoint.add(row);
      }
    },
    setEdge(edge, attrs) {
      const row = edgeRow(edge, 'setEdge'); writeEdge(row, attrs); touchedEdge.add(row);
    },
    setEdges(selection, attrs) {
      for (const row of edgeRows(selection, 'setEdges')) {
        writeEdge(row, typeof attrs === 'function' ? attrs(cur.edge(row)) : attrs);
        touchedEdge.add(row);
      }
    },
    addPoint(position, attributes) {
      checkAttrs(attributes, names, 'a new vertex');
      const [x, y] = finiteXY(position, 'a new vertex');
      added.push({ x, y, attrs: { ...attributes } });
      return { __handle: added.length - 1, __batch: batch };
    },
    connect(a, b, edgeAttributes = {}) {
      // unknown names fail now; completeness is judged once we know the
      // pair is new (an existing pair is left as it is and needs nothing)
      checkAttrs(edgeAttributes, enames, 'a new edge', { complete: false });
      links.push({ a, b, attrs: { ...edgeAttributes } });
    },
    disconnect(target: EdgeRef | EdgeSelection) {
      const rows = target instanceof EdgeSelection ? edgeRows(target, 'disconnect') : [edgeRow(target, 'disconnect')];
      for (const row of rows) disconnected.add(row);
    },
    remove(target: Ref | PointSelection) {
      const rows = target instanceof PointSelection ? pointRows(target, 'remove') : [rowOf(target, 'remove')];
      for (const row of rows) removed.add(row);
    },
    split(edge, opts = {}) {
      const row = edgeRow(edge, 'split');
      const asked = opts.at ?? 0.5;
      if (!Number.isFinite(asked)) throw new Error(`steps: split at ${asked} — must be within [0, 1]`);
      // An edge runs 0…1; a split asked for past either end lands on that end.
      const at = Math.min(Math.max(asked, 0), 1);
      if (at === 0 || at === 1) {
        // Nothing is created, so the overrides, which describe what a
        // created point or child edge would carry, have nothing to apply
        // to: the existing endpoint is returned as it is. A `firstHit` that
        // touches a vertex lands here, and a join rule should not have to
        // special-case it.
        return at === 0 ? cur.edgeList[2 * row] : cur.edgeList[2 * row + 1];
      }
      const handle = added.length;
      added.push({ x: NaN, y: NaN, attrs: {} }); // placeholder: resolved by the split
      recordSplit(row, { ...splitRequest(opts, at), handle });
      return { __handle: handle, __batch: batch };
    },
    replace(selection, motif, opts = {}) {
      // The motif's CHAIN, not its rows. A material's row order is an
      // accident of how it was built — a split point is inserted after its
      // edge's start, and an added point goes last — so threading rows
      // would silently draw a different motif than the one on screen.
      const chains = motif.curves();
      if (chains.length !== 1) throw new Error(`steps: replace: a motif is one open chain, and this one has ${chains.length === 0 ? 'none' : String(chains.length)}. Give the motif's points the edges that join them in order.`);
      if (chains[0].closed) throw new Error('steps: replace: a motif is an open chain, and this one is closed');
      const pts = chains[0].pts;
      if (pts.length < 2) throw new Error('steps: replace: a motif needs at least two points');
      const [mx0, my0] = pts[0];
      const [mx1, my1] = pts[pts.length - 1];
      const mdx = mx1 - mx0;
      const mdy = my1 - my0;
      const span = mdx * mdx + mdy * mdy;
      if (!(span > 0)) throw new Error('steps: replace: a motif must start and end at different points');
      // The motif in its own frame: along the line from first to last, and
      // across it. Both are fractions of the motif's own span, so the shape
      // rides any edge at any length and any angle.
      const local = pts.slice(1, -1).map(([px, py]) => {
        const ux = px - mx0;
        const uy = py - my0;
        return [(ux * mdx + uy * mdy) / span, (ux * -mdy + uy * mdx) / span] as [number, number];
      });
      const rows = edgeRows(selection, 'replace');
      if (rows.length === 0) return;
      const names = cur.attrNames;
      const edgeNames = cur.edgeAttrNames;
      const flip = opts.flip;
      for (const row of rows) {
        const e = cur.edge(row);
        disconnected.add(row);
        const ex = e.b.x - e.a.x;
        const ey = e.b.y - e.a.y;
        const across = (typeof flip === 'function' ? flip(e, k) : flip === true) ? -1 : 1;
        // A motif point stands between the edge's ends, so it inherits from
        // them the way a split point does: the declared transfer policy,
        // interpolating by default. Every declared column must be given,
        // because a column is never dropped in silence.
        const inherit = (at: number): Record<string, number> => {
          const out: Record<string, number> = {};
          for (const name of names) {
            const va = e.a[name];
            const vb = e.b[name];
            out[name] = cur.transfers[name] === 'nearest' ? (at <= 0.5 ? va : vb) : va + (vb - va) * at;
          }
          return out;
        };
        const childEdge = edgeNames.length > 0 ? inheritEdge(cur, e.attrs, 1 / (local.length + 1)) : undefined;
        let from: Ref = e.a;
        for (const [along, off] of local) {
          const o = off * across;
          const handle = next.addPoint([e.a.x + along * ex - o * ey, e.a.y + along * ey + o * ex], inherit(along));
          next.connect(from, handle, childEdge);
          from = handle;
        }
        next.connect(from, e.b, childEdge);
      }
    },
    splitEdges(selection, opts = {}) {
      const rows = edgeRows(selection, 'splitEdges');
      const asked = opts.at ?? 0.5;
      if (!Number.isFinite(asked)) throw new Error(`steps: splitEdges at ${asked} — must be within [0, 1]`);
      const at = Math.min(Math.max(asked, 0), 1);
      if (at === 0 || at === 1) {
        if (opts.point || opts.edges || opts.attributes || opts.parent) throw new Error('steps: a split at an endpoint creates nothing — point/edge overrides would modify existing data');
        return;
      }
      for (const row of rows) recordSplit(row, splitRequest(opts, at));
    },
    extrude(selection, spec, opts) {
      const rows = pointRows(selection, 'extrude');
      const inherit = opts?.inherit === true;
      const inherited = (p: Vertex): Record<string, number> => {
        const out: Record<string, number> = {};
        for (const name of names) out[name] = cur.attrs[name][p.index];
        return out;
      };
      for (const row of rows) {
        const p = cur.vertex(row);
        const specs = spec(p);
        for (const sp of Array.isArray(specs) ? specs : [specs]) {
          const hasPos = sp.position !== undefined;
          const hasTo = sp.to !== undefined;
          if (hasPos === hasTo) throw new Error('steps: extrude needs exactly one of { position } (a new child) or { to } (an existing target)');
          const own = (sp as { attributes?: Record<string, number> }).attributes ?? {};
          const target: Ref = hasPos ? next.addPoint(sp.position!, inherit ? { ...inherited(p), ...own } : own) : sp.to!;
          next.connect(p.index, target, sp.edgeAttributes ?? {});
        }
      }
    },
  };
  rule(cur, next, k);

  // ---- the moved state: split transfer callbacks read it ----
  // The same rows, moved: the split callbacks read this state and must see
  // the identities they will be asked about.
  const moved = new Material(nx, ny, nattrs, cur.edgeList, { iteration: iteration, history: [], edgeAttrs: neattrs, transfers: { ...cur.transfers }, edgeTransfers: { ...cur.edgeTransfers }, ids: { points: Float64Array.from(cur.pointIds), edges: Float64Array.from(cur.edgeIds), edgeRoots: Float64Array.from(cur.edgeRoots) } });

  const movedEdges = moved.edges;

  // ---- conflicts ----
  const incident = (row: number) => removed.has(cur.edgeList[2 * row]) || removed.has(cur.edgeList[2 * row + 1]);
  for (const row of removed) {
    if (touchedPoint.has(row)) throw new Error(`steps: vertex ${row} is removed and also moved or set in this step — use a selector that excludes it`);
  }
  for (const [row] of splits) {
    if (disconnected.has(row)) throw new Error(`steps: edge ${row} is split and disconnected in the same step`);
    if (incident(row)) throw new Error(`steps: edge ${row} is split but one of its vertices is removed in this step`);
  }
  for (const row of touchedEdge) {
    if (disconnected.has(row)) throw new Error(`steps: edge ${row} has attributes set and is disconnected in the same step`);
  }

  // ---- resolve splits per original edge: sorted, deduplicated, one definition each ----
  interface Cut { at: number; row: number; point: Record<string, number>; explicit: Record<string, number> }
  const cutsByEdge = new Map<number, Cut[]>();
  const childEdgeOverride = new Map<number, SplitOpts['edges']>();
  const sameDef = (a: unknown, b: unknown) => a === b || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
  // Legacy `parent` rewrites land on the moved columns, but every split
  // inherits from the state as it stood BEFORE any of them: the frozen
  // moved state is what all callbacks read, so a rewrite on one edge can
  // never change what a split on another edge inherits.
  const inheritFrom: Record<string, Float64Array> = {};
  const anyParent = Array.from(splits.values()).some((reqs) => reqs.some((r) => r.parent));
  for (const name of names) inheritFrom[name] = anyParent ? Float64Array.from(nattrs[name]) : nattrs[name];
  for (const [row, reqs] of splits) {
    const parentEdge = movedEdges.at(row);
    // legacy `parent`: rewrite the start vertex's point attributes
    for (const r of reqs) {
      if (r.parent) {
        const upd = r.parent(parentEdge);
        writePoint(parentEdge.a.index, upd);
      }
    }
    // one child-edge definition per parent per batch
    let edgesDef: SplitOpts['edges'] = undefined;
    let haveDef = false;
    for (const r of reqs) {
      if (r.edges === undefined) continue;
      if (!haveDef) { edgesDef = r.edges; haveDef = true; }
      else if (!sameDef(edgesDef, r.edges)) throw new Error(`steps: edge ${row} is split with two different child-edge definitions in one step`);
    }
    childEdgeOverride.set(row, edgesDef);
    // inherited point attributes at each parameter, then explicit overrides
    const byAt = new Map<number, Cut>();
    const pa = parentEdge.a;
    const pb = parentEdge.b;
    const inherit = (at: number): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const name of names) {
        const va = inheritFrom[name][pa.index];
        const vb = inheritFrom[name][pb.index];
        out[name] = cur.transfers[name] === 'nearest' ? (at <= 0.5 ? va : vb) : va + (vb - va) * at;
      }
      return out;
    };
    for (const r of reqs) {
      const explicit: Record<string, number> = {};
      const legacy = typeof r.attributes === 'function' ? r.attributes(parentEdge) : r.attributes;
      if (legacy) Object.assign(explicit, legacy);
      const pt = typeof r.point === 'function' ? r.point(parentEdge, r.at) : r.point;
      if (pt) Object.assign(explicit, pt);
      for (const name in explicit) {
        if (!names.includes(name)) throw new Error(`steps: no attribute '${name}' — declare it first`);
        if (!Number.isFinite(explicit[name])) throw new Error(`steps: '${name}' for a split vertex is not a finite number`);
      }
      const existing = byAt.get(r.at);
      if (existing) {
        // the same parameter twice: explicit overrides may agree or add, never disagree
        for (const name in explicit) {
          if (name in existing.explicit && existing.explicit[name] !== explicit[name]) {
            throw new Error(`steps: edge ${row} split at ${r.at} twice with conflicting '${name}' (${existing.explicit[name]} vs ${explicit[name]})`);
          }
          existing.explicit[name] = explicit[name];
          existing.point[name] = explicit[name];
        }
        continue;
      }
      byAt.set(r.at, { at: r.at, row: -1, point: { ...inherit(r.at), ...explicit }, explicit });
    }
    const cuts = Array.from(byAt.values()).sort((p, q) => p.at - q.at);
    cutsByEdge.set(row, cuts);
    // handles for split vertices resolve to the cut at their parameter
    for (const r of reqs) if (r.handle !== undefined) (added[r.handle] as { cutOf?: [number, number] }).cutOf = [row, r.at];
  }

  // ---- compact rows: survivors in order, split vertices after their edge's start row, new points last ----
  const rowMap = new Int32Array(n).fill(-1);
  const ox: number[] = [];
  const oy: number[] = [];
  const oattrs: Record<string, number[]> = {};
  for (const name of names) oattrs[name] = [];
  // Identity rides beside the coordinates: a survivor's id is pushed where
  // its position is, and a row that did not exist before takes a fresh one.
  const oids: number[] = [];
  const mint = (): number => (mintIds(1)[0]);
  const cutRow = new Map<string, number>(); // `${edge}@${at}` → row
  const insertAfter = new Map<number, [number, Cut][]>();
  for (const [row, cuts] of cutsByEdge) {
    const a = cur.edgeList[2 * row];
    const list = insertAfter.get(a) ?? [];
    for (const c of cuts) list.push([row, c]);
    insertAfter.set(a, list);
  }
  for (let i = 0; i < n; i++) {
    if (removed.has(i)) continue;
    rowMap[i] = ox.length;
    ox.push(nx[i]);
    oy.push(ny[i]);
    oids.push(cur.pointIds[i]);
    for (const name of names) oattrs[name].push(nattrs[name][i]);
    for (const [row, c] of insertAfter.get(i) ?? []) {
      const e = movedEdges.at(row);
      cutRow.set(`${row}@${c.at}`, ox.length);
      ox.push(e.a.x + (e.b.x - e.a.x) * c.at);
      oy.push(e.a.y + (e.b.y - e.a.y) * c.at);
      oids.push(mint()); // a vertex where an edge was cut is a new vertex
      for (const name of names) oattrs[name].push(c.point[name]);
    }
  }
  const handleRow = new Int32Array(added.length).fill(-1);
  for (let h = 0; h < added.length; h++) {
    const cutOf = (added[h] as { cutOf?: [number, number] }).cutOf;
    if (cutOf) {
      handleRow[h] = cutRow.get(`${cutOf[0]}@${cutOf[1]}`)!;
      continue;
    }
    handleRow[h] = ox.length;
    ox.push(added[h].x);
    oy.push(added[h].y);
    oids.push(mint());
    for (const name of names) oattrs[name].push(added[h].attrs[name]);
  }

  // ---- edges: survivors (split into chains), then new connections ----
  const edges: number[] = [];
  const eattrs: Record<string, number[]> = {};
  for (const name of enames) eattrs[name] = [];
  const eids: number[] = [];
  const eroots: number[] = [];
  /** A new edge row. `id` is its own; `root` is the wall it descends from,
   * which is itself unless a split made it. */
  const pushEdge = (a: number, b: number, attrs: Record<string, number>, id = mint(), root = id) => {
    edges.push(a, b);
    eids.push(id);
    eroots.push(root);
    for (const name of enames) eattrs[name].push(attrs[name]);
  };
  for (let e = 0; e < m; e++) {
    if (disconnected.has(e) || incident(e)) continue;
    const a = rowMap[cur.edgeList[2 * e]];
    const b = rowMap[cur.edgeList[2 * e + 1]];
    const parentAttrs: Record<string, number> = {};
    for (const name of enames) parentAttrs[name] = neattrs[name][e];
    const cuts = cutsByEdge.get(e);
    if (!cuts) {
      // Nothing cut it: this is the same edge it was.
      pushEdge(a, b, parentAttrs, cur.edgeIds[e], cur.edgeRoots[e]);
      continue;
    }
    const override = childEdgeOverride.get(e);
    const stops = [0, ...cuts.map((c) => c.at), 1];
    const rows = [a, ...cuts.map((c) => cutRow.get(`${e}@${c.at}`)!), b];
    for (let i = 0; i + 1 < stops.length; i++) {
      const child: ChildInterval = { from: stops[i], to: stops[i + 1], fraction: stops[i + 1] - stops[i] };
      const extra = typeof override === 'function' ? override(movedEdges.at(e), child) : override ?? {};
      for (const name in extra) {
        if (!enames.includes(name)) throw new Error(`steps: no edge attribute '${name}' — declare it with edgeAttribute()`);
        if (!Number.isFinite(extra[name])) throw new Error(`steps: '${name}' for a child edge is not a finite number`);
      }
      // A child is a new edge with a new id, but it is still a piece of the
      // wall its parent was: the root carries, so a face that lost nothing
      // but a subdivision still shares its boundary.
      pushEdge(rows[i], rows[i + 1], { ...inheritEdge(cur, parentAttrs, child.fraction), ...extra }, mint(), cur.edgeRoots[e]);
    }
  }
  const resolve = (r: Ref, what: string): number => {
    if (isHandle(r)) {
      if (r.__batch !== batch) throw new Error(`steps: ${what}: that handle belongs to another edit batch (another step)`);
      if (r.__handle < 0 || r.__handle >= added.length) throw new Error(`steps: ${what}: unknown handle`);
      return handleRow[r.__handle];
    }
    const row = rowOf(r, what);
    if (removed.has(row)) throw new Error(`steps: ${what}: vertex ${row} is removed in this step`);
    return rowMap[row];
  };
  const have = new Set<number>();
  for (let e = 0; e < edges.length; e += 2) have.add(pairKey(edges[e], edges[e + 1]));
  for (const l of links) {
    const ra = resolve(l.a, 'connect');
    const rb = resolve(l.b, 'connect');
    // A link whose ends resolve to one vertex is no edge; it is dropped, the
    // way an existing pair is left as it is.
    if (ra === rb) continue;
    const key = pairKey(ra, rb);
    if (have.has(key)) continue; // an existing pair is left as it is
    checkAttrs(l.attrs, enames, 'a new edge');
    have.add(key);
    pushEdge(ra, rb, l.attrs);
  }

  const attrs: Record<string, Float64Array> = {};
  for (const name of names) attrs[name] = Float64Array.from(oattrs[name]);
  const edgeAttrs: Record<string, Float64Array> = {};
  for (const name of enames) edgeAttrs[name] = Float64Array.from(eattrs[name]);
  return new Material(Float64Array.from(ox), Float64Array.from(oy), attrs, Uint32Array.from(edges), { iteration: iteration, history: [], edgeAttrs: edgeAttrs, transfers: { ...cur.transfers }, edgeTransfers: { ...cur.edgeTransfers }, ids: { points: Float64Array.from(oids), edges: Float64Array.from(eids), edgeRoots: Float64Array.from(eroots) } });
}
