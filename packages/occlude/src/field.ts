/**
 * Fields as citizens. A Field is an AUGMENTED CALLABLE — still a plain
 * `(x, y) => number` you can call and compose with lambdas (no combinator
 * API; JavaScript is the combination language) — carrying its transform
 * and domain bound inside the closure, so every consumer (isolines,
 * scatter, modifier rasters, fills) sees identical semantics through
 * ordinary invocation.
 *
 * Transforms are explicit verbs, never ambient (there is no "creation
 * context" in the declarative model): `rotate(f, θ)`, `translate(f, …)`,
 * `scale(f, …)`. Vector fields (deform) follow the iron-filings rule:
 * transforms act on coordinates and DIRECTIONS, never on magnitudes — a
 * rotated motif's wind rotates with it; a 2mm wobble stays 2mm at any
 * scale, because the pen didn't change. Wrap a custom vector lambda in
 * `vectorField(fn)` so the verbs know to turn its arrows.
 *
 * A direction with no front or back — the grain of a plank, a principal
 * curvature — is an AXIS field: `axisField(fn)` marks one, `across(f)` is
 * the perpendicular family of either kind, and a tracer that reads the mark
 * keeps one sign along a line the formula flips signs under.
 *
 * A field the library makes answers one point as well as two numbers:
 * `f(x, y)` and `f(p)`, `p` a pair or an `{ x, y }` record — the spelling
 * the vector arithmetic takes. That is every field verb here (`rotate`,
 * `translate`, `scale`, `within`, `grad`, `curl`, `across`) and the
 * toolkit's field words (`t.distanceTo`, `t.travelTime`, `t.noiseField`).
 * A field you write answers what you wrote; wrap it in a verb, or call it
 * `f(...p)`. The `sdf.*` words and the pure `distanceTo` are the fast
 * kernels behind these and stay `(x, y)`.
 *
 * `within(f, shape)` bounds a field's domain: outside, the field is ABSENT
 * (non-finite), and the convention holds — generators make nothing,
 * modifiers touch nothing. Nested bounds are a conjunction. Absence is any
 * non-finite sample, so hand-rolled `return NaN` holes fail soft the same
 * way; `within` is the deliberate tool.
 */

import type { FieldFn, LengthFn, VectorFieldFn } from './shapes.js';
import type { ShapeValue } from './api.js';
import { IDENTITY, invert, mul, rotate as mrotate, scale as mscale, translate as mtranslate, type Mat } from './matrix.js';
import { lowerToUserLoops, type Frame } from './record.js';
import { geomClosed } from './shapes.js';
import { vx, vy, type XY } from './vec.js';
import { resolveLen, Len, type L } from './units.js';

/** A `within()` bound as the encoder sees it: the shape, and the map from
 * the (outer) field's coordinates to the shape's own user space — the
 * verbs applied after the bound accumulate their inverses here. Lazy: a
 * translate resolves its lengths when the paper is known. */
export interface FieldBound {
  shape: ShapeValue;
  toBound: () => Mat;
}

interface FieldMeta {
  kind: 'scalar' | 'vector';
  /** A vector field whose SIGN carries no meaning — an axis, not an arrow.
   * It answers exactly as a vector field does; the mark is what tells a
   * tracer it may walk the other way along the same line. */
  axis?: true;
  /** The same field with every `within()` stripped — what the engine
   * rasterises (the bound is exact vector geometry, never a NaN hole in a
   * grid). Absent when the field has no bound. */
  unbounded?: AnyField;
  bounds?: FieldBound[];
}

/** What the encoder needs of a field: the unbounded function to rasterise
 * and the exact domain bounds to ship as regions. */
export function fieldMeta(fn: AnyField): { unbounded: AnyField; bounds: FieldBound[] } {
  const m = metaOf(fn);
  return { unbounded: m?.unbounded ?? fn, bounds: m?.bounds ?? [] };
}

const FIELD_META = new WeakMap<object, FieldMeta>();

function metaOf(fn: object): FieldMeta | undefined {
  return FIELD_META.get(fn);
}

/** Length resolution a verb is given: the toolkit passes the run's
 * (`t.translate` resolves `mm(…)`/`w(…)` against the paper); the module
 * form takes bare numbers only — user units need no frame. */
export type LenResolver = (l: L) => number;

const numbersOnly: LenResolver = (l) => {
  if (typeof l === 'number') return l;
  throw new Error('translate(field, …): a unit length (mm/w/h/inch) needs the run — use t.translate');
};

/** Mark a vector-valued field ((x, y) => [dx, dy]) so the transform verbs
 * rotate its arrows. `noiseField` returns pre-marked fields. */
export function vectorField(fn: VectorFieldFn): VectorFieldFn {
  FIELD_META.set(fn, { kind: 'vector' });
  return fn;
}

/** A direction field whose sign carries no meaning: `[1, 0]` and `[-1, 0]`
 * are the same axis. It answers as a vector field does, so every verb and
 * every consumer reads it the same way. */
export type AxisFieldFn = VectorFieldFn;

/**
 * Mark a direction field as UNORIENTED: an axis, not an arrow. The grain of
 * a plank, the long way across a brick, a principal curvature — each has a
 * direction with no front or back, and `[dx, dy]` and `[-dx, -dy]` say the
 * same thing. `t.streamlines` reads the mark and keeps its sign along the
 * line, so a field whose formula changes sign in the middle of the paper
 * still traces one unbroken line across it. `across(axes)` is the
 * perpendicular family, and the two woven together are a street plan.
 */
export function axisField(fn: AxisFieldFn): AxisFieldFn {
  // Marking a field that already has one (`axisField(grad(f))`) adds the
  // mark and keeps what it knows — its bounds and its unbounded twin.
  const m = metaOf(fn);
  if (m?.unbounded && m.unbounded !== fn) axisField(m.unbounded as AxisFieldFn);
  FIELD_META.set(fn, { ...m, kind: 'vector', axis: true });
  return fn;
}

/** Is this field unoriented — a direction a tracer may walk either way? */
export function isAxisField(fn: AnyField): boolean {
  return metaOf(fn)?.axis === true;
}

/**
 * The perpendicular family: every direction turned 90°. An axis field's
 * perpendicular is an axis field and a vector field's is a vector field, by
 * what the value answers — there is no mode flag. Trace a field and
 * `across` it in two pens and the marks cross at a right angle everywhere,
 * which is the woven look; `across(grad(f))` is `curl(f)` by another road.
 */
export function across(field: VectorFieldFn): PointField<VectorFieldFn> {
  const sample = (x: number, y: number): [number, number] => {
    const v = field(x, y) as unknown;
    if (typeof v === 'number') {
      throw new Error('across(field): a scalar field has no direction — use grad(f) or curl(f), or mark the function with vectorField/axisField');
    }
    if (!Array.isArray(v)) return [NaN, NaN];
    const [dx, dy] = v as [number, number];
    return [-dy, dx];
  };
  const out = atPoint<VectorFieldFn>(sample);
  const sm = metaOf(field);
  const meta: FieldMeta = { kind: 'vector' };
  if (sm?.axis) meta.axis = true;
  if (sm?.bounds && sm.bounds.length > 0) {
    meta.bounds = sm.bounds;
    meta.unbounded = across((sm.unbounded ?? field) as VectorFieldFn);
  }
  FIELD_META.set(out, meta);
  return out;
}

/** A vector field derived from a scalar one keeps the scalar's `within()`
 * bounds (NaN outside comes through the differences naturally, and the
 * engine still gets the bound as exact geometry). */
function derivedVector(src: FieldFn, sample: VectorFieldFn, again: (f: FieldFn) => VectorFieldFn): PointField<VectorFieldFn> {
  const out = atPoint<VectorFieldFn>(sample);
  const sm = metaOf(src);
  const meta: FieldMeta = { kind: 'vector' };
  if (sm?.bounds && sm.bounds.length > 0) {
    meta.bounds = sm.bounds;
    meta.unbounded = again((sm.unbounded ?? src) as FieldFn);
  }
  FIELD_META.set(out, meta);
  return out;
}

/**
 * Gradient of a scalar field by central differences: points uphill, its
 * length is the slope. `h` is the difference step in user units (default
 * 0.25 — a quarter of a percent of the short side). Streamlines of
 * `grad(distanceTo(loops))` run away from a shape; `deform` with it pushes
 * ink downhill.
 */
export function grad(field: FieldFn, h = 0.25): PointField<VectorFieldFn> {
  const sample: VectorFieldFn = (x, y) => [
    (field(x + h, y) - field(x - h, y)) / (2 * h),
    (field(x, y + h) - field(x, y - h)) / (2 * h),
  ];
  return derivedVector(field, sample, (f) => grad(f, h));
}

/**
 * Curl of a scalar field: the gradient turned 90°, so it runs ALONG the
 * field's contours and never converges (divergence-free). Streamlines of
 * `curl(noise)` are the flow-field look; streamlines of `curl(f)` at nib
 * spacing are the isolines of `f`, densely — one mechanism seen twice.
 */
export function curl(field: FieldFn, h = 0.25): PointField<VectorFieldFn> {
  const g = grad(field, h);
  const sample: VectorFieldFn = (x, y) => {
    const [gx, gy] = g(x, y);
    return [-gy, gx];
  };
  return derivedVector(field, sample, (f) => curl(f, h));
}

type AnyField = FieldFn | VectorFieldFn | LengthFn;

/** A field that answers one point as well as two numbers: `f(x, y)` and
 * `f(p)`. What the library hands back (see the note at the top). */
export type PointField<F extends AnyField> = F & ((p: XY) => ReturnType<F>);

/** `sample` as a field that also answers one point. Two numbers are the
 * field's own call, unchanged; a single point argument is read as `[x, y]`
 * or `{ x, y }`. */
function atPoint<F extends AnyField>(sample: (x: number, y: number) => ReturnType<F>): PointField<F> {
  return ((x: number | XY, y?: number) =>
    y === undefined && typeof x === 'object' && x !== null ? sample(vx(x), vy(x)) : sample(x as number, y as number)) as PointField<F>;
}

/** The same field, answering one point as well: the toolkit's door for a
 * field it makes. Its bounds and its marks come with it. */
export function pointField<F extends AnyField>(fn: F): PointField<F> {
  const out = atPoint<F>((x, y) => fn(x, y) as ReturnType<F>);
  const m = metaOf(fn);
  if (m) FIELD_META.set(out, m);
  return out;
}

/** What a prepared field keeps and what it gains. A VECTOR field stays
 * vector, because transforms rotate its arrows rather than scaling them; a
 * scalar stays scalar. Either way it comes back as the full callable, so a
 * lambda written with fewer parameters than the field protocol needs —
 * `within(() => 7, rect(…))`, `rotate((x) => x, 90)` — is still called as
 * `f(x, y)` and typechecks as one. */
export type Prepared<F extends AnyField> =
  F extends VectorFieldFn ? PointField<VectorFieldFn>
    : F extends FieldFn ? PointField<FieldFn>
      : PointField<LengthFn>;

function isVector(fn: AnyField): boolean {
  return metaOf(fn)?.kind === 'vector';
}

/** Wrap a field in a coordinate verb. `xf` is the verb's forward map on
 * coordinates (user units, lazy) and `again` re-applies the verb to the
 * source's unbounded twin, so bounds and the rasterisable field both
 * survive composition: bounds move with the verb (their to-bound map
 * gains the verb's inverse), the unbounded twin gets the verb too. */
function wrap<F extends AnyField>(
  src: F,
  sample: (x: number, y: number) => number | Len | readonly [number, number] | readonly number[],
  xf?: () => Mat,
  again?: (f: F) => Prepared<F>,
): Prepared<F> {
  // The wrapped callable IS the field; the cast states that a lambda of the
  // right kind is one, which a conditional return type cannot prove.
  const out = atPoint<F>(sample as (x: number, y: number) => ReturnType<F>) as unknown as Prepared<F>;
  const sm = metaOf(src);
  const meta: FieldMeta = { kind: sm?.kind ?? 'scalar' };
  // A verb moves an axis field's lines; it does not give them a front.
  if (sm?.axis) meta.axis = true;
  if (sm?.bounds && sm.bounds.length > 0 && xf && again) {
    meta.bounds = sm.bounds.map((b) => ({
      shape: b.shape,
      toBound: () => mul(b.toBound(), invert(xf())),
    }));
    meta.unbounded = again((sm.unbounded ?? src) as F);
  }
  FIELD_META.set(out, meta);
  return out;
}

/** A field verb's pivot: a point, and only a point. A field has no bounds
 * and no area, so it has no middle and no centroid to name. */
function fieldPivot(verb: string, opts: { origin?: unknown } | undefined): [number, number] | null {
  const o = opts?.origin;
  if (o === undefined) return null;
  if (o === 'center' || o === 'centroid') {
    throw new Error(`${verb}: a field has no bounds, so it has no '${o}' — give the point, e.g. { origin: [t.bounds().cx, t.bounds().cy] }`);
  }
  const x = Array.isArray(o) ? o[0] : (o as { x?: unknown } | null)?.x;
  const y = Array.isArray(o) ? o[1] : (o as { y?: unknown } | null)?.y;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`${verb}: origin is a point ([x, y] or { x, y }) — got ${typeof o === 'string' ? `'${o}'` : JSON.stringify(o)}`);
  }
  return [x, y];
}

/** A verb about a pivot: move the pivot to the user origin, apply, move it
 * back. With no pivot the verb is itself. */
function aboutPivot<F extends AnyField>(field: F, pivot: [number, number] | null, verb: (f: F) => Prepared<F>): Prepared<F> {
  if (!pivot) return verb(field);
  const [px, py] = pivot;
  return translate(verb(translate(field, -px, -py) as unknown as F) as unknown as F, px, py);
}

/**
 * Rotate a field by `deg` about `origin` (a point; the user origin by
 * default). Scalar fields: the value landscape turns. Vector fields: the
 * arrows turn too — squash a photo of iron filings and the filings turn
 * with it.
 */
export function rotate<F extends AnyField>(field: F, deg: number, opts?: { origin?: XY }): Prepared<F> {
  const pivot = fieldPivot('rotate', opts);
  if (pivot) return aboutPivot(field, pivot, (f) => rotate(f, deg));
  const th = (deg * Math.PI) / 180;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const vec = isVector(field);
  return wrap(
    field,
    (x, y) => {
      // Sample through the inverse rotation.
      const ix = x * c + y * s;
      const iy = -x * s + y * c;
      const v = field(ix, iy);
      if (!vec || !Array.isArray(v)) return v as number;
      const [dx, dy] = v as [number, number];
      // Directions rotate forward; magnitudes are untouched by construction
      // (pure rotation preserves length).
      return [dx * c - dy * s, dx * s + dy * c];
    },
    () => mrotate(th),
    (f) => rotate(f, deg),
  );
}

/** Translate a field by (dx, dy) — lengths accepted; arrows unchanged.
 * Lengths resolve LAZILY, at the first sample: a field built at module
 * scope (before the sketch's paper/aspect exist) still resolves `mm(10)`
 * against the paper it renders on. */
export function translate<F extends AnyField>(field: F, dx: L, dy: L, len: LenResolver = numbersOnly): Prepared<F> {
  let t: [number, number] | null = null;
  const at = (): [number, number] => (t ??= [len(dx), len(dy)]);
  return wrap(
    field,
    (x, y) => {
      const [tx, ty] = at();
      return field(x - tx, y - ty);
    },
    () => mtranslate(...at()),
    (f) => translate(f, dx, dy, len),
  );
}

/**
 * Scale a field about `origin` (a point; the user origin by default).
 * Sampling coordinates scale; output
 * MAGNITUDES never do (a 2mm wobble is 2mm at any motif size — the pen
 * didn't change). Non-uniform scale tilts vector directions with the
 * squash, magnitude preserved.
 */
export function scale<F extends AnyField>(field: F, s: number | [number, number], opts?: { origin?: XY }): Prepared<F> {
  const pivot = fieldPivot('scale', opts);
  if (pivot) return aboutPivot(field, pivot, (f) => scale(f, s));
  const [sx, sy] = typeof s === 'number' ? [s, s] : s;
  const vec = isVector(field);
  return wrap(
    field,
    (x, y) => {
      const v = field(x / sx, y / sy);
      if (!vec || !Array.isArray(v)) return v as number;
      const [dx, dy] = v as [number, number];
      const mag = Math.hypot(dx, dy);
      if (!(mag > 0)) return [0, 0];
      // Direction through the linear part, renormalized; magnitude kept.
      const tx = dx * sx;
      const ty = dy * sy;
      const tm = Math.hypot(tx, ty);
      if (!(tm > 0)) return [0, 0];
      return [(tx / tm) * mag, (ty / tm) * mag];
    },
    () => mscale(sx, sy),
    (f) => scale(f, s),
  );
}

// ---- domain bounds -----------------------------------------------------

/** A bound shape's flattened loops as an edge table bucketed by y-band, so a
 * containment query touches only the edges that can span its y — the ray
 * cast itself is unchanged (same edges, same arithmetic, integer counts).
 * Lowered LAZILY on the first sample: the sketch's paper/aspect/rectMode
 * are established by then even for a bound built at module scope. */
interface LoopIndex {
  ax: Float64Array;
  ay: Float64Array;
  bx: Float64Array;
  by: Float64Array;
  /** Union bbox of every loop. */
  x0: number; y0: number; x1: number; y1: number;
  bandH: number;
  nb: number;
  /** CSR: edges of band k are items[start[k]..start[k + 1]]. */
  start: Int32Array;
  items: Int32Array;
}

function indexLoops(loops: [number, number][][]): LoopIndex {
  let ne = 0;
  for (const l of loops) ne += l.length;
  const ax = new Float64Array(ne), ay = new Float64Array(ne);
  const bx = new Float64Array(ne), by = new Float64Array(ne);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let k = 0;
  for (const loop of loops) {
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      const [px, py] = loop[i];
      const [qx, qy] = loop[(i + 1) % n];
      ax[k] = px; ay[k] = py; bx[k] = qx; by[k] = qy;
      x0 = Math.min(x0, px); x1 = Math.max(x1, px);
      y0 = Math.min(y0, py); y1 = Math.max(y1, py);
      k++;
    }
  }
  const nb = Math.max(1, Math.min(4096, Math.ceil(Math.sqrt(ne))));
  const bandH = ne > 0 && y1 > y0 ? (y1 - y0) / nb : 1;
  const bandOf = (y: number): number => Math.min(nb - 1, Math.max(0, Math.floor((y - y0) / bandH)));
  const count = new Int32Array(nb + 1);
  for (let e = 0; e < ne; e++) {
    const lo = bandOf(Math.min(ay[e], by[e]));
    const hi = bandOf(Math.max(ay[e], by[e]));
    for (let b = lo; b <= hi; b++) count[b + 1]++;
  }
  for (let b = 0; b < nb; b++) count[b + 1] += count[b];
  const start = count;
  const fill = start.slice(0, nb);
  const items = new Int32Array(start[nb]);
  for (let e = 0; e < ne; e++) {
    const lo = bandOf(Math.min(ay[e], by[e]));
    const hi = bandOf(Math.max(ay[e], by[e]));
    for (let b = lo; b <= hi; b++) items[fill[b]++] = e;
  }
  return { ax, ay, bx, by, x0, y0, x1, y1, bandH, nb, start, items };
}

/** A prepared bound and the frame it was built for. The loops depend on the
 * frame (units, rectMode, origin, yUp), so a shape reused under a different
 * paper rebuilds instead of answering out of the old frame. */
/** What a sketch-time bound needs of the run: the frame it lowers against
 * and a per-run memo of lowered shapes (one shape bounds many fields). */
export interface BoundEnv {
  frame: Frame;
  cache: WeakMap<object, unknown>;
}

function containsTest(shape: ShapeValue, env: BoundEnv): (x: number, y: number) => boolean {
  const frame = env.frame;
  let loops = env.cache.get(shape) as LoopIndex | undefined;
  if (!loops) {
    const o = shape.opts;
    loops = indexLoops(
      lowerToUserLoops(
        shape.geom,
        // The toolkit hands a bound over with its pivot resolved to a point.
        { translate: o.translate, rotate: o.rotate, scale: o.scale, origin: o.origin as readonly [L, L] | undefined },
        frame,
      ),
    );
    env.cache.set(shape, loops);
  }
  // exactly what `userPointMm(x, y, frame)` resolves each coordinate to
  const inner = frame.inner;
  const g = shape.geom;
  const evenodd = (g.kind === 'path' || g.kind === 'area') && g.winding === 'evenodd';
  return (x, y) => pointInLoops(loops, resolveLen(x, inner), resolveLen(y, inner), evenodd);
}

/** Even-odd (or nonzero) ray cast over the indexed loops: only the edges in
 * the query's y-band are visited; every edge that can span y is there. */
function pointInLoops(idx: LoopIndex, x: number, y: number, evenodd = true): boolean {
  if (x < idx.x0 || x > idx.x1 || y < idx.y0 || y > idx.y1) return false;
  const b = Math.min(idx.nb - 1, Math.max(0, Math.floor((y - idx.y0) / idx.bandH)));
  const { ax, ay, bx, by, items } = idx;
  let crossings = 0;
  let windingN = 0;
  for (let k = idx.start[b], end = idx.start[b + 1]; k < end; k++) {
    const e = items[k];
    const eay = ay[e];
    const eby = by[e];
    if (eay > y !== eby > y) {
      const xi = ax[e] + ((y - eay) / (eby - eay)) * (bx[e] - ax[e]);
      if (xi > x) {
        crossings++;
        windingN += eby > eay ? 1 : -1;
      }
    }
  }
  return evenodd ? crossings % 2 === 1 : windingN !== 0;
}

/**
 * Bound a field to a shape's region: outside, the field is ABSENT
 * (NaN scalar / NaN vector). Its own verb, not a `clip` overload — clip
 * returns tree content, within returns a field. Nested bounds are a
 * conjunction. Generators make nothing where a field is absent; modifiers
 * touch nothing. Engine-consumed modifier fields get soft (grid-scale)
 * edges from the raster's fail-open; sketch-time consumers (isolines,
 * scatter, fills) get this test's exactness.
 */
export function within<F extends AnyField>(field: F, shape: ShapeValue, env: BoundEnv): Prepared<F> {
  if (!geomClosed(shape.geom)) {
    throw new Error('within() bound must be a closed shape (close() the path, or use a region)');
  }
  const vec = isVector(field);
  // lowered at the first sample against the run's frame, which is fixed
  // for the run — a bound belongs to the execution that made it
  let contains: ((x: number, y: number) => boolean) | null = null;
  const out = wrap(field, (x, y) => {
    if (contains === null) contains = containsTest(shape, env);
    if (!contains(x, y)) {
      return vec ? ([NaN, NaN] as [number, number]) : NaN;
    }
    return field(x, y);
  });
  // Engine consumers get the bound as exact geometry, not a NaN hole: the
  // raster is of the field WITHOUT this bound, the shape travels beside it.
  const inner = fieldMeta(field);
  FIELD_META.set(out, {
    kind: vec ? 'vector' : 'scalar',
    ...(isAxisField(field) ? { axis: true as const } : {}),
    unbounded: inner.unbounded,
    bounds: [...inner.bounds, { shape, toBound: () => IDENTITY }],
  });
  return out;
}
