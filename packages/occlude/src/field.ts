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
 * `within(f, shape)` bounds a field's domain: outside, the field is ABSENT
 * (non-finite), and the convention holds — generators make nothing,
 * modifiers touch nothing. Nested bounds are a conjunction. Absence is any
 * non-finite sample, so hand-rolled `return NaN` holes fail soft the same
 * way; `within` is the deliberate tool.
 */

import type { FieldFn, VectorFieldFn } from './shapes.js';
import type { ShapeValue } from './api.js';
import { IDENTITY, invert, mul, rotate as mrotate, scale as mscale, translate as mtranslate, type Mat } from './matrix.js';
import { lowerToUserLoops, makeFrame, userPointMm, type Frame } from './record.js';
import { geomClosed } from './shapes.js';
import { bounds, getPaperHint, getState, unitScaleMm } from './state.js';
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

/** Sketch-time length resolution (mm via the paper hint), mirroring the
 * points/isolines environments. */
function userLen(l: L): number {
  if (typeof l === 'number') {
    const b = bounds();
    return resolveLen(l, { innerW: b.w, innerH: b.h });
  }
  if (l instanceof Len && l.kind === 'mm') return l.value / unitScaleMm();
  const b = bounds();
  return resolveLen(l, { innerW: b.w, innerH: b.h });
}

/** Mark a vector-valued field ((x, y) => [dx, dy]) so the transform verbs
 * rotate its arrows. `noiseField` returns pre-marked fields. */
export function vectorField(fn: VectorFieldFn): VectorFieldFn {
  FIELD_META.set(fn, { kind: 'vector' });
  return fn;
}

type AnyField = FieldFn | VectorFieldFn;

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
  sample: (x: number, y: number) => number | [number, number],
  xf?: () => Mat,
  again?: (f: F) => F,
): F {
  const out = ((x: number, y: number) => sample(x, y)) as F;
  const sm = metaOf(src);
  const meta: FieldMeta = { kind: sm?.kind ?? 'scalar' };
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

/**
 * Rotate a field by `deg` about the user origin. Scalar fields: the value
 * landscape turns. Vector fields: the arrows turn too — squash a photo of
 * iron filings and the filings turn with it.
 */
export function rotate<F extends AnyField>(field: F, deg: number): F {
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
export function translate<F extends AnyField>(field: F, dx: L, dy: L): F {
  let t: [number, number] | null = null;
  const at = (): [number, number] => (t ??= [userLen(dx), userLen(dy)]);
  return wrap(
    field,
    (x, y) => {
      const [tx, ty] = at();
      return field(x - tx, y - ty);
    },
    () => mtranslate(...at()),
    (f) => translate(f, dx, dy),
  );
}

/**
 * Scale a field about the user origin. Sampling coordinates scale; output
 * MAGNITUDES never do (a 2mm wobble is 2mm at any motif size — the pen
 * didn't change). Non-uniform scale tilts vector directions with the
 * squash, magnitude preserved.
 */
export function scale<F extends AnyField>(field: F, s: number | [number, number]): F {
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

/** Flattened user-space loops per bound shape, lowered LAZILY on the first
 * sample — the sketch's paper/aspect/rectMode are established by then even
 * for a bound built at module scope. */
const BOUND_LOOPS = new WeakMap<ShapeValue, [number, number][][]>();

function sketchFrame(): Frame {
  const { w, h } = getPaperHint();
  return makeFrame(getState(), w, h, false);
}

/** Point-in-shape in user units, through the one lowerer (rectMode, arc
 * commands, curve flattening, transform opts — exactly what the shape
 * inks), with the geometry's own winding rule. */
function containsPoint(shape: ShapeValue, x: number, y: number): boolean {
  let loops = BOUND_LOOPS.get(shape);
  const frame = sketchFrame();
  if (!loops) {
    const o = shape.opts;
    loops = lowerToUserLoops(
      shape.geom,
      { translate: o.translate, rotate: o.rotate, scale: o.scale },
      frame,
    );
    BOUND_LOOPS.set(shape, loops);
  }
  const [px, py] = userPointMm(x, y, frame);
  const g = shape.geom;
  const evenodd = g.kind === 'path' && g.winding === 'evenodd';
  return pointInLoops(loops, px, py, evenodd);
}

/** Even-odd (or nonzero) ray cast over polyline loops. */
function pointInLoops(
  loops: [number, number][][],
  x: number,
  y: number,
  evenodd = true,
): boolean {
  let crossings = 0;
  let windingN = 0;
  for (const loop of loops) {
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = loop[i];
      const [bx, by] = loop[(i + 1) % n];
      if (ay > y !== by > y) {
        const xi = ax + ((y - ay) / (by - ay)) * (bx - ax);
        if (xi > x) {
          crossings++;
          windingN += by > ay ? 1 : -1;
        }
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
export function within<F extends AnyField>(field: F, shape: ShapeValue): F {
  if (!geomClosed(shape.geom)) {
    throw new Error('within() bound must be a closed shape (close() the path, or use a region)');
  }
  const vec = isVector(field);
  const out = wrap(field, (x, y) => {
    if (!containsPoint(shape, x, y)) {
      return vec ? ([NaN, NaN] as [number, number]) : NaN;
    }
    return field(x, y);
  });
  // Engine consumers get the bound as exact geometry, not a NaN hole: the
  // raster is of the field WITHOUT this bound, the shape travels beside it.
  const inner = fieldMeta(field);
  FIELD_META.set(out, {
    kind: vec ? 'vector' : 'scalar',
    unbounded: inner.unbounded,
    bounds: [...inner.bounds, { shape, toBound: () => IDENTITY }],
  });
  return out;
}
