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
import { bounds, unitScaleMm } from './state.js';
import { resolveLen, Len, type L } from './units.js';

interface FieldMeta {
  kind: 'scalar' | 'vector';
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

function wrap<F extends AnyField>(
  src: F,
  sample: (x: number, y: number) => number | [number, number],
): F {
  const out = ((x: number, y: number) => sample(x, y)) as F;
  if (isVector(src)) FIELD_META.set(out, { kind: 'vector' });
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
  return wrap(field, (x, y) => {
    // Sample through the inverse rotation.
    const ix = x * c + y * s;
    const iy = -x * s + y * c;
    const v = field(ix, iy);
    if (!vec || !Array.isArray(v)) return v as number;
    const [dx, dy] = v as [number, number];
    // Directions rotate forward; magnitudes are untouched by construction
    // (pure rotation preserves length).
    return [dx * c - dy * s, dx * s + dy * c];
  });
}

/** Translate a field by (dx, dy) — lengths accepted; arrows unchanged. */
export function translate<F extends AnyField>(field: F, dx: L, dy: L): F {
  const tx = userLen(dx);
  const ty = userLen(dy);
  return wrap(field, (x, y) => field(x - tx, y - ty));
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
  return wrap(field, (x, y) => {
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
  });
}

// ---- domain bounds -----------------------------------------------------

/** Point-in-shape in user units, honoring the value's own transform opts.
 * Supports the closed geometry kinds; open geoms (line) contain nothing. */
function containsPoint(shape: ShapeValue, x: number, y: number): boolean {
  // Undo the shape-level transform opts (translate → rotate → scale, the
  // same order the emit chain applies).
  const o = shape.opts;
  let px = x;
  let py = y;
  if (o.translate) {
    px -= userLen(o.translate[0]);
    py -= userLen(o.translate[1]);
  }
  if (o.rotate) {
    const th = (-o.rotate * Math.PI) / 180;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const rx = px * c - py * s;
    const ry = px * s + py * c;
    px = rx;
    py = ry;
  }
  if (o.scale !== undefined) {
    const [sx, sy] = typeof o.scale === 'number' ? [o.scale, o.scale] : o.scale;
    px /= sx;
    py /= sy;
  }
  const g = shape.geom;
  switch (g.kind) {
    case 'circle': {
      const cx = userLen(g.x);
      const cy = userLen(g.y);
      const r = userLen(g.r);
      return Math.hypot(px - cx, py - cy) <= r;
    }
    case 'ellipse': {
      const cx = userLen(g.x);
      const cy = userLen(g.y);
      const rx = userLen(g.rx);
      const ry = userLen(g.ry);
      const th = (-(g.rotation ?? 0) * Math.PI) / 180;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const lx = (px - cx) * c - (py - cy) * s;
      const ly = (px - cx) * s + (py - cy) * c;
      return (lx / rx) ** 2 + (ly / ry) ** 2 <= 1;
    }
    case 'rect': {
      const rx = userLen(g.x);
      const ry = userLen(g.y);
      const rw = userLen(g.w);
      const rh = userLen(g.h);
      const cx = g.anchor === 'center' ? rx - rw / 2 : rx;
      const cy = g.anchor === 'center' ? ry - rh / 2 : ry;
      return px >= cx && px <= cx + rw && py >= cy && py <= cy + rh;
    }
    case 'ngon': {
      const cx = userLen(g.x);
      const cy = userLen(g.y);
      const r = userLen(g.r);
      const rot = ((g.rotation ?? 0) * Math.PI) / 180 - Math.PI / 2;
      const pts: [number, number][] = [];
      for (let i = 0; i < g.sides; i++) {
        const a = rot + (i * 2 * Math.PI) / g.sides;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      return pointInLoops([pts], px, py);
    }
    case 'points':
      return pointInLoops([g.pts.map(([ax, ay]) => [userLen(ax), userLen(ay)])], px, py);
    case 'path': {
      // Flatten commands to polyline loops (curves sampled — the domain
      // test is sampled-precision by nature for sketch-time consumers).
      const loops: [number, number][][] = [];
      let cur: [number, number][] = [];
      let sx0 = 0;
      let sy0 = 0;
      for (const cmd of g.cmds) {
        if (cmd.op === 'move') {
          if (cur.length > 1) loops.push(cur);
          sx0 = userLen(cmd.x);
          sy0 = userLen(cmd.y);
          cur = [[sx0, sy0]];
        } else if (cmd.op === 'line') {
          cur.push([userLen(cmd.x), userLen(cmd.y)]);
        } else if (cmd.op === 'close') {
          if (cur.length > 1) loops.push(cur);
          cur = [[sx0, sy0]];
        } else if (cmd.op === 'bezier' || cmd.op === 'quad') {
          const last = cur[cur.length - 1] ?? [sx0, sy0];
          const ex = userLen(cmd.x);
          const ey = userLen(cmd.y);
          for (let t = 0.125; t <= 1.0001; t += 0.125) {
            if (cmd.op === 'bezier') {
              const c0x = userLen(cmd.c0x);
              const c0y = userLen(cmd.c0y);
              const c1x = userLen(cmd.c1x);
              const c1y = userLen(cmd.c1y);
              const u = 1 - t;
              cur.push([
                u ** 3 * last[0] + 3 * u * u * t * c0x + 3 * u * t * t * c1x + t ** 3 * ex,
                u ** 3 * last[1] + 3 * u * u * t * c0y + 3 * u * t * t * c1y + t ** 3 * ey,
              ]);
            } else {
              const qx = userLen(cmd.cx);
              const qy = userLen(cmd.cy);
              const u = 1 - t;
              cur.push([
                u * u * last[0] + 2 * u * t * qx + t * t * ex,
                u * u * last[1] + 2 * u * t * qy + t * t * ey,
              ]);
            }
          }
        } else if (cmd.op === 'arc') {
          // Sampled chord approximation, consistent with the sampled test.
          cur.push([userLen(cmd.x), userLen(cmd.y)]);
        }
      }
      if (cur.length > 1) loops.push(cur);
      return pointInLoops(loops, px, py, g.winding === 'evenodd');
    }
    default:
      return false; // open geometry contains nothing
  }
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
  const vec = isVector(field);
  return wrap(field, (x, y) => {
    if (!containsPoint(shape, x, y)) {
      return vec ? ([NaN, NaN] as [number, number]) : NaN;
    }
    return field(x, y);
  });
}
