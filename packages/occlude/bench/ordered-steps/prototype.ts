/** Experimental ordered editor. Deliberately NOT exported by occlude.
 * Selections capture IDs, views read live values; no deferred operations.
 * IDs last one iteration. Material output is compacted only at finish().
 */
import {
  Material,
  ownerOfView,
  viewKind,
  viewProto,
  type Vertex,
  type Edge,
  type XY,
  type SplitOpts,
} from "../../src/material.js";

export class Selection<T> implements Iterable<T> {
  private readonly members: readonly T[];
  constructor(items: Iterable<T>) {
    this.members = Object.freeze([...items]);
  }
  [Symbol.iterator]() {
    return this.members[Symbol.iterator]();
  }
  get length() {
    return this.members.length;
  }
  at(i: number): T {
    if (i < 0 || i >= this.length)
      throw new Error("selection index out of range");
    return this.members[i];
  }
  filter(fn: (item: T) => boolean) {
    return new Selection(this.members.filter(fn));
  }
  map<U>(fn: (item: T) => U): U[] {
    return this.members.map(fn);
  }
}

type Point = {
  x: number;
  y: number;
  attrs: Record<string, number>;
  alive: boolean;
  view: Vertex;
  incident: Set<number>;
};
type Link = {
  a: number;
  b: number;
  attrs: Record<string, number>;
  alive: boolean;
  view: Edge;
};
type PointTarget = Vertex | Iterable<Vertex>;
type EdgeTarget = Edge | Iterable<Edge>;
type Child =
  | {
      position: XY;
      attributes?: Record<string, number>;
      edgeAttributes?: Record<string, number>;
    }
  | { to: Vertex; edgeAttributes?: Record<string, number> };
type Cuts = Omit<SplitOpts, "at" | "attributes" | "parent"> & {
  at?: number | readonly number[];
};
const xy = (p: XY): [number, number] =>
  Array.isArray(p)
    ? [p[0], p[1]]
    : [(p as { x: number }).x, (p as { y: number }).y];
const finite = (n: number) => {
  if (!Number.isFinite(n)) throw new Error("nonfinite edit");
  return n;
};
const pair = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

export class OrderedEditor {
  private ps: Point[] = [];
  private es: Link[] = [];
  private pointRefs = new WeakMap<object, number>();
  private edgeRefs = new WeakMap<object, number>();
  private snapshots = new WeakMap<
    object,
    { points: number[]; edges: number[] }
  >();
  private pairs = new Map<string, number>();
  private descendants = new Map<
    number,
    { from: number; to: number; edge: number }[]
  >();
  private closed = false;
  private pointProto: object;
  constructor(readonly prev: Material) {
    // Prototype-only provenance bridge: original vertices retain prev ownership
    // so existing radial forces preserve self/connected exclusions. This is NOT
    // a complete mutable Material identity contract; see the experiment report.
    this.pointProto = viewProto(prev, "vertex");
    for (const p of prev.points)
      this.createPoint(
        [p.x, p.y],
        Object.fromEntries(Object.keys(prev.attrs).map((k) => [k, p[k]])),
        true,
      );
    for (const e of prev.edges)
      this.connect(this.ps[e.a.index].view, this.ps[e.b.index].view, {
        ...e.attrs,
      });
  }
  private assertOpen() {
    if (this.closed) throw new Error("editor belongs to a finished iteration");
  }
  get points() {
    this.assertOpen();
    return new Selection(this.ps.filter((p) => p.alive).map((p) => p.view));
  }
  get edges() {
    this.assertOpen();
    return new Selection(this.es.filter((e) => e.alive).map((e) => e.view));
  }
  private pointId(p: Vertex, alive = true): number {
    this.assertOpen();
    let id = this.pointRefs.get(p);
    const owner = ownerOfView(p);
    if (id === undefined && viewKind(p) === "vertex") {
      if (owner === this.prev) id = p.index < this.prev.n ? p.index : undefined;
      else if (owner) id = this.snapshots.get(owner)?.points[p.index];
    }
    if (id === undefined || !this.ps[id])
      throw new Error("foreign or stale point reference");
    if (alive && !this.ps[id].alive) throw new Error("point was removed");
    return id;
  }
  private edgeId(e: Edge, alive = true): number {
    this.assertOpen();
    let id = this.edgeRefs.get(e);
    const owner = ownerOfView(e);
    if (id === undefined && viewKind(e) === "edge") {
      if (owner === this.prev)
        id = e.index < this.prev.edgeCount ? e.index : undefined;
      else if (owner) id = this.snapshots.get(owner)?.edges[e.index];
    }
    if (id === undefined || !this.es[id])
      throw new Error("foreign or stale edge reference");
    if (alive && !this.es[id].alive)
      throw new Error("edge was replaced or disconnected");
    return id;
  }
  private pointList(target: PointTarget, alive = true) {
    const refs =
      Symbol.iterator in target
        ? [...(target as Iterable<Vertex>)]
        : [target as Vertex];
    return [...new Set(refs.map((p) => this.pointId(p, alive)))];
  }
  private edgeList(target: EdgeTarget, alive = true) {
    const refs =
      Symbol.iterator in target
        ? [...(target as Iterable<Edge>)]
        : [target as Edge];
    return [...new Set(refs.map((e) => this.edgeId(e, alive)))];
  }
  private attributes(
    values: Record<string, number>,
    schema: object,
    complete = false,
  ) {
    if (complete)
      for (const key of Object.keys(schema))
        if (!(key in values)) throw new Error(`missing attribute ${key}`);
    for (const [key, value] of Object.entries(values)) {
      if (!(key in schema)) throw new Error(`undeclared attribute ${key}`);
      finite(value);
    }
    return { ...values };
  }
  private createPoint(
    position: XY,
    attrs: Record<string, number>,
    original = false,
  ): Vertex {
    this.assertOpen();
    const [x, y] = xy(position).map(finite);
    const id = this.ps.length;
    const p: Point = {
      x,
      y,
      attrs: this.attributes(attrs, this.prev.attrs, true),
      alive: true,
      view: null!,
      incident: new Set(),
    };
    const view = Object.create(original ? this.pointProto : null);
    Object.defineProperty(view, "index", { enumerable: true, value: id });
    for (const key of ["x", "y", ...Object.keys(attrs)])
      Object.defineProperty(view, key, {
        enumerable: true,
        get: () => {
          this.assertOpen();
          if (!p.alive) throw new Error("point was removed");
          return key === "x" ? p.x : key === "y" ? p.y : p.attrs[key];
        },
      });
    p.view = Object.freeze(view);
    this.ps.push(p);
    this.pointRefs.set(view, id);
    return view;
  }
  addPoint(position: XY, attributes: Record<string, number> = {}) {
    return this.createPoint(position, attributes);
  }
  move(target: PointTarget, by: XY | ((p: Vertex) => XY)) {
    const ids = this.pointList(target);
    for (const id of ids) {
      const p = this.ps[id];
      if (!p.alive) throw new Error("point was removed during move");
      const [dx, dy] = xy(typeof by === "function" ? by(p.view) : by);
      if (!p.alive) throw new Error("point was removed during move");
      const x = finite(p.x + finite(dx)),
        y = finite(p.y + finite(dy));
      p.x = x;
      p.y = y;
    }
  }
  set(
    target: PointTarget,
    attrs: Record<string, number> | ((p: Vertex) => Record<string, number>),
  ) {
    for (const id of this.pointList(target)) {
      const p = this.ps[id];
      const values = this.attributes(
        typeof attrs === "function" ? attrs(p.view) : attrs,
        this.prev.attrs,
      );
      if (!p.alive) throw new Error("point was removed during set");
      Object.assign(p.attrs, values);
    }
  }
  setEdge(target: Edge, attrs: Record<string, number>) {
    this.setEdges(target, attrs);
  }
  setEdges(
    target: EdgeTarget,
    attrs: Record<string, number> | ((e: Edge) => Record<string, number>),
  ) {
    for (const id of this.edgeList(target)) {
      const e = this.es[id];
      const values = this.attributes(
        typeof attrs === "function" ? attrs(e.view) : attrs,
        this.prev.edgeAttrs,
      );
      if (!e.alive) throw new Error("edge was replaced during set");
      Object.assign(e.attrs, values);
    }
  }
  connect(a: Vertex, b: Vertex, attrs: Record<string, number> = {}): Edge {
    const ai = this.pointId(a),
      bi = this.pointId(b);
    if (ai === bi) throw new Error("self connection");
    const key = pair(ai, bi),
      existing = this.pairs.get(key);
    this.attributes(attrs, this.prev.edgeAttrs);
    if (existing !== undefined) return this.es[existing].view;
    const id = this.es.length;
    const e: Link = {
      a: ai,
      b: bi,
      attrs: this.attributes(attrs, this.prev.edgeAttrs, true),
      alive: true,
      view: null!,
    };
    const check = () => {
      this.assertOpen();
      if (!e.alive) throw new Error("edge was replaced or disconnected");
    };
    const view: Edge = Object.freeze({
      index: id,
      get a() {
        check();
        return a;
      },
      get b() {
        check();
        return b;
      },
      get length() {
        check();
        return Math.hypot(a.x - b.x, a.y - b.y);
      },
      get attrs() {
        check();
        return Object.freeze({ ...e.attrs });
      },
    });
    // Always expose live endpoints, even when connect received frozen prev views.
    a = this.ps[ai].view;
    b = this.ps[bi].view;
    e.view = view;
    this.es.push(e);
    this.edgeRefs.set(view, id);
    this.pairs.set(key, id);
    this.ps[ai].incident.add(id);
    this.ps[bi].incident.add(id);
    return view;
  }
  disconnect(target: EdgeTarget) {
    for (const id of this.edgeList(target, false)) {
      const e = this.es[id];
      if (!e.alive) continue;
      e.alive = false;
      this.pairs.delete(pair(e.a, e.b));
      this.ps[e.a].incident.delete(id);
      this.ps[e.b].incident.delete(id);
    }
  }
  remove(target: PointTarget) {
    for (const id of this.pointList(target, false)) {
      const p = this.ps[id];
      if (!p.alive) continue;
      for (const edge of [...p.incident]) this.disconnect(this.es[edge].view);
      p.alive = false;
    }
  }
  extend(
    target: PointTarget,
    spec: (p: Vertex) => Child | Child[],
    opts: { inherit?: boolean } = {},
  ) {
    for (const id of this.pointList(target)) {
      const p = this.ps[id];
      if (!p.alive) throw new Error("parent was removed during extend");
      const value = spec(p.view);
      for (const child of Array.isArray(value) ? value : [value]) {
        const to =
          "to" in child
            ? child.to
            : this.addPoint(child.position, {
                ...(opts.inherit ? p.attrs : {}),
                ...child.attributes,
              });
        this.connect(p.view, to, child.edgeAttributes);
      }
    }
  }
  split(target: Edge, opts: Cuts & { at: readonly number[] }): Vertex[];
  split(target: Edge, opts?: Cuts & { at?: number }): Vertex;
  split(target: Edge, opts: Cuts = {}): Vertex | Vertex[] {
    const id = this.edgeId(target, false);
    const e = this.es[id];
    const requested = Array.isArray(opts.at)
      ? [...opts.at]
      : ([opts.at ?? 0.5] as number[]);
    for (const t of requested)
      if (!Number.isFinite(t) || t < 0 || t > 1)
        throw new Error("split parameter outside [0, 1]");
    if (!e.alive) {
      const result = requested.map((t) => {
        const resolved = this.resolveSplit(id, t);
        return this.split(this.es[resolved.edge].view, {
          ...opts,
          at: resolved.t,
        });
      });
      return Array.isArray(opts.at) ? result : result[0];
    }
    const cuts = [...new Set(requested.filter((t) => t > 0 && t < 1))].sort(
      (a, b) => a - b,
    );
    const a = this.ps[e.a].view,
      b = this.ps[e.b].view;
    const refs = new Map<number, Vertex>([
      [0, a],
      [1, b],
    ]);
    for (const t of cuts) {
      const attrs: Record<string, number> = {};
      for (const name of Object.keys(this.prev.attrs)) {
        const transfer = this.prev.transfers[name] ?? "interpolate";
        attrs[name] =
          transfer === "nearest"
            ? t <= 0.5
              ? a[name]
              : b[name]
            : a[name] + (b[name] - a[name]) * t;
      }
      Object.assign(
        attrs,
        typeof opts.point === "function" ? opts.point(e.view, t) : opts.point,
      );
      refs.set(
        t,
        this.addPoint([a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t], attrs),
      );
    }
    if (cuts.length) {
      const ts = [0, ...cuts, 1];
      const attrs = ts.slice(1).map((to, i) => {
        const from = ts[i],
          fraction = to - from;
        const result = Object.fromEntries(
          Object.entries(e.attrs).map(([k, v]) => [
            k,
            this.prev.edgeTransfers[k] === "distribute" ? v * fraction : v,
          ]),
        );
        return Object.assign(
          result,
          typeof opts.edges === "function"
            ? opts.edges(e.view, { from, to, fraction })
            : opts.edges,
        );
      });
      this.disconnect(e.view);
      const children = [];
      for (let i = 0; i < ts.length - 1; i++) {
        const child = this.connect(
          refs.get(ts[i])!,
          refs.get(ts[i + 1])!,
          attrs[i],
        );
        children.push({ from: ts[i], to: ts[i + 1], edge: this.edgeId(child) });
      }
      this.descendants.set(id, children);
    }
    const result = requested.map((t) => refs.get(t)!);
    return Array.isArray(opts.at) ? result : result[0];
  }
  /** Original parameter intervals survive splits; the cut uses the selected
   * descendant's CURRENT geometry. A deleted interval does not redirect a cut. */
  private resolveSplit(edge: number, t: number): { edge: number; t: number } {
    while (!this.es[edge].alive) {
      const children = this.descendants.get(edge);
      if (!children)
        throw new Error("split interval was deleted or disconnected");
      const child = children.find((c) => t >= c.from && t <= c.to);
      if (!child) throw new Error("split interval no longer exists");
      t = (t - child.from) / (child.to - child.from);
      edge = child.edge;
    }
    return { edge, t };
  }
  splitEdges(target: Iterable<Edge>, opts: Cuts = {}) {
    const ids = this.edgeList(target, false);
    for (const id of ids) {
      if (Array.isArray(opts.at))
        this.split(this.es[id].view, { ...opts, at: opts.at });
      else
        this.split(this.es[id].view, {
          ...opts,
          at: opts.at as number | undefined,
        });
    }
  }
  /** Explicit immutable conversion for existing force/query APIs. Never automatic. */
  snapshot(): Material {
    this.assertOpen();
    const points = this.ps.flatMap((p, i) => (p.alive ? [i] : [])),
      edges = this.es.flatMap((e, i) => (e.alive ? [i] : []));
    const rows = new Map(points.map((id, i) => [id, i]));
    const output = new Material(
      Float64Array.from(points, (id) => this.ps[id].x),
      Float64Array.from(points, (id) => this.ps[id].y),
      Object.fromEntries(
        Object.keys(this.prev.attrs).map((k) => [
          k,
          Float64Array.from(points, (id) => this.ps[id].attrs[k]),
        ]),
      ),
      Uint32Array.from(
        edges.flatMap((id) => [
          rows.get(this.es[id].a)!,
          rows.get(this.es[id].b)!,
        ]),
      ),
      this.prev.iteration + 1,
      [],
      Object.fromEntries(
        Object.keys(this.prev.edgeAttrs).map((k) => [
          k,
          Float64Array.from(edges, (id) => this.es[id].attrs[k]),
        ]),
      ),
      { ...this.prev.transfers },
      { ...this.prev.edgeTransfers },
    );
    this.snapshots.set(output, { points, edges });
    return output;
  }
  finish() {
    const result = this.snapshot();
    this.closed = true;
    return result;
  }
  abort() {
    this.closed = true;
  }
}

export function orderedSteps(
  seed: Material,
  count: number,
  rule: (prev: Material, current: OrderedEditor, k: number) => void,
): Material {
  if (!Number.isInteger(count) || count < 0)
    throw new Error("step count must be a non-negative integer");
  let prev = seed;
  for (let k = 0; k < count; k++) {
    const current = new OrderedEditor(prev);
    try {
      rule(prev, current, k);
      prev = current.finish();
    } catch (error) {
      current.abort();
      throw error;
    }
  }
  return prev;
}
