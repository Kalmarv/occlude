/**
 * The sketch's geometry: what a coordinate means, what a length is worth,
 * and which chart the sheet draws it in.
 *
 * A SKETCH COORDINATE IS A POSITION BY STEPS FROM THE CENTRE. `(x, y)`
 * means x along the base geodesic — the horizontal through the drawable's
 * centre — and then y along the perpendicular geodesic there. These are
 * Fermi coordinates: a row `y = const` is an equidistant curve of the
 * base, a column `x = const` is a geodesic, and the whole plane is covered
 * once. So a sketch keeps writing the numbers it always wrote, and the
 * space says which place each pair names. `toChart` is that map and
 * `fromChart` its inverse; the flat plane fills both with the identity.
 *
 * Every member here takes and answers SKETCH coordinates, in drawable
 * units — the same bare numbers a sketch writes, 0 to 100 on the short
 * side. `project` is the one member that speaks of the sheet: it maps a
 * sketch coordinate through the chart to the paper, and the ink door
 * applies it once, last.
 *
 * CURVATURE IS ONE NUMBER, AND ITS SIGN IS THE GEOMETRY. One
 * construction draws all three: below zero the hyperbolic plane, at zero
 * the flat plane, above zero the sphere. The length the curvature fixes is
 * `ell = 1/√|K|`, and the metric is `ds² = c(y/ell)²·dx² + dy²` with `c`
 * the pair's cosine — `cosh` below zero, `cos` above. So a row `y = const`
 * is longer than the numbers on it in the disk and shorter on the sphere.
 * `K = 0` is not a small curvature. It is no curvature, and it runs the
 * flat code itself.
 *
 * The named forms are sugar for a number. `'hyperbolic'` with a radius `R`
 * is `K = −4/R²`, so `ell = R/2`; a larger radius is flatter.
 * `'spherical'` with a radius `R` is `K = +1/R²`, the sphere touching the
 * sheet at the drawable's centre, so `ell = R`.
 *
 * SPACE IS GEOMETRY AND PROJECTION IS PAPER. The curvature says how curved
 * the space is against the steps a sketch takes. The projection says which
 * chart the sheet is drawn in and HOW BIG it is drawn: `size` is where the
 * model's unit circle lands — the rim of the hyperbolic disk, or the
 * sphere's equator — and it fills the drawable unless the sketch says
 * otherwise. Nothing is out of bounds either way: the coordinates reach
 * the whole space, and the chart is where that space is DRAWN, not where
 * it stops.
 *
 * The maths runs in the model the geometry is cheapest in — the
 * hyperboloid below zero, the unit sphere above — because one sign turns
 * the first into the second, and both spell the Fermi map, the exponential
 * and the metric as three lines of arithmetic with no special cases.
 */

import { halfplane as hHalfplane } from './hyperbolic.js';
import type { Model, ModelDoor } from './placement.js';
import { mm, type L } from './units.js';
import { vx, vy, type Vec, type XY } from './vec.js';

export type SpaceKind = 'euclidean' | 'hyperbolic' | 'spherical';

/** The chart the sheet is drawn in. `'poincare'` and `'klein'` belong to
 * hyperbolic space; `'stereographic'`, `'gnomonic'` and `'orthographic'`
 * to spherical space. */
export type Projection = 'poincare' | 'klein' | 'halfplane' | 'stereographic' | 'gnomonic' | 'orthographic';

/** What a sketch declares for the chart: a name, or the same with the size
 * it is drawn at. */
export interface ProjectionSpec {
  kind: Projection;
  /** The radius on the page of the model's unit circle: the rim of the
   * hyperbolic disk, or where the sphere's equator lands. Default: the
   * largest circle the drawable holds. */
  size?: L;
}

export type ProjectionOption = Projection | ProjectionSpec;

/** What a sketch declares for the geometry: a kind by name, or the same
 * with the radius the kind reads as a curvature. */
export interface SpaceSpec {
  kind: SpaceKind;
  /** The radius the curvature names: `K = −4/radius²` in the disk
   * (default: 1.25 × the drawable's half-diagonal) or `K = +1/radius²`
   * on the sphere (default: the half-diagonal over √2, half the side of a
   * square drawable). How big the
   * picture is drawn is the projection's `size`, not this. */
  radius?: L;
}

/** The primary form: one curvature, in 1/unit² of the drawable. Below zero
 * is hyperbolic, zero is Euclidean, above zero is spherical. */
export interface CurvatureSpec {
  curvature: number;
}

export type SpaceOption = SpaceKind | SpaceSpec | CurvatureSpec;

/**
 * The resolved geometry of one run: the metric, the coordinates and the
 * chart, as data.
 *
 * Every member takes and answers SKETCH coordinates in drawable units.
 * `project` alone answers on the sheet.
 */
export interface Space {
  /** Which geometry this is, which is the SIGN of the curvature: the
   * curvature is the primary number and the kind is read off it. */
  kind: SpaceKind;
  /** `'none'` in Euclidean space, which has no chart to choose. */
  projection: Projection | 'none';
  /** The curvature `K`, in 1/unit² of the drawable: 0, `−4/radius²`,
   * `+1/radius²`. The one number the construction reads. */
  curvature: number;
  /** The radius the curvature names: `2/√|K|` below zero, `1/√K` above
   * (Infinity in Euclidean space). Geometry, not paper. */
  radius: number;
  /** How big the chart is drawn, in drawable units: where the model's unit
   * circle lands — the rim of the disk, or the sphere's equator (Infinity
   * in Euclidean space, which has no chart to size). Paper, not
   * geometry. */
  size: number;
  /** The point the coordinates are measured from: the drawable's centre,
   * which is `(0, 0)` of the space and its own sketch coordinate. */
  center: Vec;
  /** The metric: the length of the geodesic from `a` to `b`. */
  distance(a: XY, b: XY): number;
  /** The point reached from `p` by moving `|v|` along the direction `v`
   * names in the local frame — the equidistant direction and the
   * perpendicular geodesic direction at `p`. */
  exp(p: XY, v: XY): Vec;
  /** The direction and distance from `p` to `q`: `exp(p, log(p, q)) === q`. */
  log(p: XY, q: XY): Vec;
  /** `distance` between two points already lifted by `model.up`: the same
   * double, for a caller that lifts each point once and measures it many
   * times — a neighbour search, a force over a frozen state. */
  modelDistance(n: Model, m: Model): number;
  /** `log` from a lifted `n`, in the frame `model.frameAt` gives there, to
   * a lifted `m`: the same pair of doubles as `log` — or null at the point
   * opposite on the sphere, where `log` answers with the coordinates the
   * caller wrote, which a lifted point no longer has; ask `log` there. */
  modelLog(n: Model, frame: readonly [Model, Model], m: Model): Vec | null;
  /** The point a fraction `t` of the way along the geodesic from `a` to `b`. */
  geodesic(a: XY, b: XY, t: number): Vec;
  /** The circle of radius `r` about `c`, as `count` sketch points. */
  circle(c: XY, r: number, count: number): Vec[];
  /** Area of the space per unit of coordinate area: 1 at the centre. */
  density(p: XY): number;
  /** Sketch coordinates → the chart the projection draws, in drawable
   * units. The identity in the flat plane. */
  toChart(p: XY): Vec;
  /** The chart → sketch coordinates. */
  fromChart(z: XY): Vec;
  /** Sketch coordinates → sheet, or a non-finite pair where the point is
   * not on the sheet at all — the far hemisphere under `'gnomonic'` and
   * `'orthographic'`. The ink door reads that as "draw nothing here" and
   * ends the stroke at the boundary. */
  project(p: XY): Vec;
  /** Are geodesics straight lines on the sheet? */
  straight: boolean;
  /** The model this geometry's isometries are matrices on: what a
   * `Placement` of THIS space is built over. `t.station(…).placement()`,
   * a tiling's placements and `reflection(space.model, a, b)` all go
   * through it. */
  model: ModelDoor;
}

/** The drawable a space is resolved against, in bare units. */
export interface SpaceFrame {
  w: number;
  h: number;
  cx: number;
  cy: number;
  /** A length in drawable units (`mm(…)` through the paper). */
  len(l: L): number;
}

// ---- the constructor words ------------------------------------------------

/**
 * The spaces a sketch may name, as data: `space: space.hyperbolic({ radius:
 * 90 })` in the config, or the bare string `space: 'hyperbolic'` for the
 * default radius. Pure — no paper, no seed — so this is a module import.
 */
export const space = {
  euclidean: (): SpaceSpec => ({ kind: 'euclidean' }),
  hyperbolic: (opts: { radius?: L } = {}): SpaceSpec =>
    opts.radius === undefined ? { kind: 'hyperbolic' } : { kind: 'hyperbolic', radius: opts.radius },
  spherical: (opts: { radius?: L } = {}): SpaceSpec =>
    opts.radius === undefined ? { kind: 'spherical' } : { kind: 'spherical', radius: opts.radius },
};

// ---- Euclidean ------------------------------------------------------------

const HYPERBOLIC_PROJECTIONS: readonly Projection[] = ['poincare', 'klein'];
const SPHERICAL_PROJECTIONS: readonly Projection[] = ['stereographic', 'gnomonic', 'orthographic'];

/** The flat plane's tangent frame: the sketch's own axes, everywhere. */
const PLANE_FRAME: [Model, Model] = [[1, 0, 0], [0, 1, 0]];

/**
 * The flat plane's model: homogeneous coordinates, where an isometry is
 * `[[R, t], [0, 1]]` and the third coordinate is not a length — hence
 * `sign: 0`. There is only one flat plane, so there is only one id.
 */
const PLANE_DOOR: ModelDoor = {
  kind: 'euclidean',
  sign: 0,
  id: 'euclidean',
  up: (p) => [vx(p), vy(p), 1],
  down: (n) => [n[0] / n[2], n[1] / n[2]],
  frameAt: () => PLANE_FRAME,
};

/** The flat plane: the formulas every spacing word already uses, and the
 * identity for every map. */
export function euclideanSpace(): Space {
  return {
    kind: 'euclidean',
    projection: 'none',
    curvature: 0,
    radius: Infinity,
    size: Infinity,
    center: [0, 0],
    distance: (a, b) => Math.hypot(vx(b) - vx(a), vy(b) - vy(a)),
    exp: (p, v) => [vx(p) + vx(v), vy(p) + vy(v)],
    log: (p, q) => [vx(q) - vx(p), vy(q) - vy(p)],
    modelDistance: (n, m) => Math.hypot(m[0] - n[0], m[1] - n[1]),
    modelLog: (n, _frame, m) => [m[0] - n[0], m[1] - n[1]],
    geodesic: (a, b, t) => [vx(a) + (vx(b) - vx(a)) * t, vy(a) + (vy(b) - vy(a)) * t],
    circle: (c, r, count) => {
      if (!(r > 0) || !(count >= 3)) return [];
      const n = Math.floor(count);
      const out: Vec[] = [];
      for (let k = 0; k < n; k++) {
        const th = (2 * Math.PI * k) / n;
        out.push([vx(c) + r * Math.cos(th), vy(c) + r * Math.sin(th)]);
      }
      return out;
    },
    density: () => 1,
    toChart: (p) => [vx(p), vy(p)],
    fromChart: (z) => [vx(z), vy(z)],
    project: (p) => [vx(p), vy(p)],
    straight: true,
    model: PLANE_DOOR,
  };
}

// ---- the one curved construction ------------------------------------------

/**
 * Everything the SIGN of the curvature decides, as data. The construction
 * itself is written once and reads this.
 *
 * `sign` is that sign, and it is also the sign the third coordinate takes
 * in the model's own product — `−1` for the Minkowski form of the
 * hyperboloid, `+1` for the ordinary dot of the sphere — and the sign that
 * turns the local frame over. So one number says Minkowski or Euclidean,
 * `cosh` or `cos`, and which way the meridians lean.
 */
interface Form {
  sign: -1 | 1;
  /** `sinh` below zero, `sin` above. */
  s(t: number): number;
  /** `cosh` below zero, `cos` above. */
  c(t: number): number;
  /** The inverse of `s`, over the model's own range. */
  as(t: number): number;
  /** The angle a model point makes with the base geodesic. On the
   * hyperboloid `x/w` is a `tanh` and the plane has no far side; on the
   * sphere `atan2` carries the coordinate round the back. */
  azimuth(y: number, x: number): number;
  /** Below this value of `s(g)` there is no one geodesic to walk. That is
   * the same place below zero; the sphere also has the point opposite, so
   * it keeps more margin. */
  eps: number;
}

/** Curvature below zero: the hyperboloid, and the hyperbolic pair. */
const NEGATIVE: Form = {
  sign: -1,
  s: Math.sinh,
  c: Math.cosh,
  as: Math.asinh,
  azimuth: (y, x) => Math.atanh(Math.min(1 - 1e-16, Math.max(-1 + 1e-16, y / x))),
  eps: 1e-15,
};

/** Curvature above zero: the sphere, and the circular pair. */
const POSITIVE: Form = {
  sign: 1,
  s: Math.sin,
  c: Math.cos,
  as: (t) => Math.asin(Math.max(-1, Math.min(1, t))),
  azimuth: Math.atan2,
  eps: 1e-12,
};

/**
 * THE construction: the space of one curvature on the drawable, in Fermi
 * coordinates about `center`. The sign of `curvature` picks the geometry,
 * `ell` is the curvature length `1/√|K|` in drawable units, and `size` is
 * how big the chart is drawn on the page.
 *
 * The curvature and its length arrive together because each form of the
 * option fixes one of them exactly — `space.hyperbolic({ radius: R })`
 * fixes `ell = R/2`, and `{ curvature: K }` fixes `K` — and deriving
 * either from the other would round.
 *
 * A sketch coordinate `(x, y)` is the model point
 *
 *     n(a, b) = [s(a)·c(b), s(b), c(a)·c(b)],
 *     a = (x − cx)/ell,  b = (y − cy)/ell,
 *
 * with `(s, c)` the pair `(sinh, cosh)` or `(sin, cos)`: the base geodesic
 * walked to `a`, then the perpendicular there walked to `b`. The local
 * frame — the equidistant direction and the perpendicular geodesic
 * direction — is `∂a` normalised and `∂b`, which is already unit:
 *
 *     Ex = [c(a), 0, −σ·s(a)],  Ey = [−σ·s(a)·s(b), c(b), −σ·c(a)·s(b)],
 *
 * so `exp` is the plain model formula `n·c(t) + u·s(t)`, `log` reads the
 * components back with two products of the model's own form, and the area
 * element is `|c(b)|` — a row of coordinates is longer than the numbers on
 * it below zero and shorter above, which is the one way a flat grid can
 * hold a curved space.
 *
 * The model chart is one map too: a model point lands at
 * `n ↦ size·(nx, ny)/(1 + nw)`, so the model's unit circle — the
 * hyperbolic horizon, the sphere's equator — is drawn at `size` from the
 * centre. THE SIZE IS PAPER, NOT GEOMETRY. `ell` says how curved the space
 * is against the steps a sketch takes; `size` says how big that picture is
 * printed. At `size = 2·ell` a step at the centre is one drawable unit on
 * the page, and any other size scales the whole picture about the centre.
 *
 * `curvature` is never zero here: zero is the flat plane and it runs
 * `euclideanSpace`, which is the old code and not a limit of this one.
 *
 * `bow`, when the caller knows the paper, is the metric bow a stored
 * chord may keep (`geodesicBowOf`), and the model door carries it.
 */
export function curvedSpaceOf(
  center: XY,
  curvature: number,
  ell: number,
  projection: Projection,
  size: number,
  bow?: number,
): Space {
  const cx = vx(center);
  const cy = vy(center);
  const F = curvature < 0 ? NEGATIVE : POSITIVE;
  const sign = F.sign;
  /** The model's unit circle on the page: the drawn rim, or the equator. */
  const M = size;
  /** The model's own product: Minkowski below zero, the dot above. */
  const form = (u: Model, v: Model): number => u[0] * v[0] + u[1] * v[1] + sign * (u[2] * v[2]);
  /** Sketch coordinates → the model. */
  const up = (p: XY): Model => {
    const a = (vx(p) - cx) / ell;
    const b = (vy(p) - cy) / ell;
    const cb = F.c(b);
    return [F.s(a) * cb, F.s(b), F.c(a) * cb];
  };
  /** The model → sketch coordinates. Both readings are single valued, so
   * the map is one to one over the whole space. */
  const down = (n: Model): Vec => [cx + ell * F.azimuth(n[0], n[2]), cy + ell * F.as(n[1])];
  /** The local frame at a sketch point: `[equidistant, perpendicular]`. */
  const frameAt = (p: XY): [Model, Model] => {
    const a = (vx(p) - cx) / ell;
    const b = (vy(p) - cy) / ell;
    const sb = F.s(b);
    const f = -sign;
    return [
      [F.c(a), 0, f * F.s(a)],
      [f * F.s(a) * sb, F.c(b), f * F.c(a) * sb],
    ];
  };
  /** The model chart point of a model point, in drawable units. */
  const chart = (n: Model): Vec => {
    const w = 1 + n[2];
    return [cx + (M * n[0]) / w, cy + (M * n[1]) / w];
  };
  /** The geodesic length in the space's own unit, written through the
   * chord — `2·as(|Δ|/2)`, with `|Δ|` the model's own length of the
   * difference — which keeps every digit of a short step that an `acosh`
   * or an `acos` of a product would spend. */
  const gap = (n: Model, m: Model): number => {
    const d: Model = [n[0] - m[0], n[1] - m[1], n[2] - m[2]];
    return 2 * F.as(Math.sqrt(Math.max(0, form(d, d))) / 2);
  };
  /** The metric between two model points. */
  const measure = (n: Model, m: Model): number => ell * gap(n, m);
  /** `log` between two model points, in the frame at the first; null at
   * the point opposite, which `log` answers from the coordinates. */
  const toward = (n: Model, [ex, ey]: readonly [Model, Model], m: Model): Vec | null => {
    const g = gap(n, m);
    const sg = F.s(g);
    // No one geodesic: the same place, or — on the sphere alone — the
    // point opposite. Close by there is nowhere to go; a half-turn away
    // every direction is as good as another, so the coordinates' own
    // difference is the honest answer.
    if (!(sg > F.eps)) return g < 1 ? [0, 0] : null;
    const cg = F.c(g);
    // The unit tangent at `n` that points at `m`.
    const u: Model = [(m[0] - n[0] * cg) / sg, (m[1] - n[1] * cg) / sg, (m[2] - n[2] * cg) / sg];
    const s = ell * g;
    return [s * form(u, ex), s * form(u, ey)];
  };
  /**
   * The model chart → the sheet. Two of the charts ARE the model's own
   * picture and pass straight through; each of the others is one line over
   * it, written in the model's unit `M`.
   *
   * Klein is `z ↦ 2z/(1 + |z|²)`, where a geodesic is a chord and so draws
   * straight. Gnomonic is the sphere from its own centre, where every
   * geodesic draws straight and the equator runs off to infinity, and
   * orthographic is the sphere from far away, the near hemisphere inside a
   * circle of half the size. The last two answer NaN on the far side,
   * which is the ink door's word for "no place on the sheet".
   */
  const remap = (q: Vec): Vec => {
    if (projection === 'poincare' || projection === 'stereographic') return q;
    const zx = (q[0] - cx) / M;
    const zy = (q[1] - cy) / M;
    const r2 = zx * zx + zy * zy;
    if (projection === 'klein') {
      const m = 2 / (1 + r2);
      return [cx + M * zx * m, cy + M * zy * m];
    }
    if (projection === 'gnomonic') {
      const m = 1 - r2;
      if (!(m > 0)) return [NaN, NaN];
      return [cx + (q[0] - cx) / m, cy + (q[1] - cy) / m];
    }
    if (r2 > 1) return [NaN, NaN];
    return [cx + (q[0] - cx) / (1 + r2), cy + (q[1] - cy) / (1 + r2)];
  };
  return {
    kind: curvature < 0 ? 'hyperbolic' : 'spherical',
    projection,
    curvature,
    // The radius the curvature names: `2/√|K|` below zero, `1/√K` above.
    radius: curvature < 0 ? 2 * ell : ell,
    size: M,
    center: [cx, cy],
    distance: (a, b) => measure(up(a), up(b)),
    exp(p, v) {
      const s = Math.hypot(vx(v), vy(v));
      if (!(s > 0)) return [vx(p), vy(p)];
      const n = up(p);
      const [ex, ey] = frameAt(p);
      const dx = vx(v) / s;
      const dy = vy(v) / s;
      const u: Model = [ex[0] * dx + ey[0] * dy, ex[1] * dx + ey[1] * dy, ex[2] * dx + ey[2] * dy];
      const ct = F.c(s / ell);
      const st = F.s(s / ell);
      const out = down([n[0] * ct + u[0] * st, n[1] * ct + u[1] * st, n[2] * ct + u[2] * st]);
      return Number.isFinite(out[0]) && Number.isFinite(out[1]) ? out : [vx(p) + vx(v), vy(p) + vy(v)];
    },
    log: (p, q) => toward(up(p), frameAt(p), up(q)) ?? [vx(q) - vx(p), vy(q) - vy(p)],
    modelDistance: measure,
    modelLog: toward,
    geodesic(a, b, t) {
      // The ends are the points asked for, not the ends of a sampling.
      if (!(t > 0)) return [vx(a), vy(a)];
      if (t >= 1) return [vx(b), vy(b)];
      const n = up(a);
      const m = up(b);
      const g = gap(n, m);
      const sg = F.s(g);
      // The same place, or the point opposite: no arc to walk either way.
      if (!(sg > F.eps)) return [vx(a) + (vx(b) - vx(a)) * t, vy(a) + (vy(b) - vy(a)) * t];
      const k0 = F.s((1 - t) * g) / sg;
      const k1 = F.s(t * g) / sg;
      const out = down([n[0] * k0 + m[0] * k1, n[1] * k0 + m[1] * k1, n[2] * k0 + m[2] * k1]);
      return Number.isFinite(out[0]) && Number.isFinite(out[1])
        ? out
        : [vx(a) + (vx(b) - vx(a)) * t, vy(a) + (vy(b) - vy(a)) * t];
    },
    circle(c, r, count) {
      if (!(r > 0) || !(count >= 3)) return [];
      const n = Math.floor(count);
      const out: Vec[] = [];
      for (let i = 0; i < n; i++) {
        const th = (2 * Math.PI * i) / n;
        out.push(this.exp(c, [r * Math.cos(th), r * Math.sin(th)]));
      }
      return out;
    },
    /** `|c(y/ell)|`: how much of the space one unit of coordinate area
     * holds. It is 1 on the base geodesic, it grows away from it below
     * zero, and above zero it falls to nothing at the poles. */
    density: (p) => Math.abs(F.c((vy(p) - cy) / ell)),
    toChart: (p) => chart(up(p)),
    fromChart(z) {
      const zx = (vx(z) - cx) / M;
      const zy = (vy(z) - cy) / M;
      const d = 1 + sign * (zx * zx) + sign * (zy * zy);
      // Below zero the rim is infinitely far away, so a point at or past
      // it has no coordinates. The nearest place inside stands in, and
      // nothing throws: the caller is fitting a chart, not measuring.
      // Above zero `d` is never below 1 and this never runs.
      if (!(d > 0)) {
        const len = Math.hypot(zx, zy) || 1;
        const u = (1 - 1e-15) / len;
        return this.fromChart([cx + M * zx * u, cy + M * zy * u]);
      }
      return down([(2 * zx) / d, (2 * zy) / d, (1 - sign * (zx * zx) - sign * (zy * zy)) / d]);
    },
    project: (p) => remap(chart(up(p))),
    straight: projection === 'klein' || projection === 'gnomonic',
    // The model this geometry's isometries are 3×3 matrices on, made of
    // the maps the construction already has. Two spaces share a door when
    // they share a geometry, a centre and a curvature length; the chart's
    // `size` is paper and does not enter, because an isometry of the space
    // is the same isometry however big the picture is printed.
    model: {
      kind: curvature < 0 ? 'hyperbolic' : 'spherical',
      sign,
      id: `${curvature < 0 ? 'hyperbolic' : 'spherical'}:${cx}:${cy}:${ell}`,
      up,
      down,
      frameAt,
      ...(bow === undefined ? {} : { bow }),
    },
  };
}

/**
 * The hyperbolic plane on the drawable, by its disk: curvature `−4/R²`,
 * drawn in a Poincaré disk of radius `size` about `center`. The curvature
 * length is `R/2`, and the disk is drawn at the plane's own scale unless
 * another size is asked for.
 */
export function hyperbolicSpaceOf(
  center: Vec,
  radius: number,
  projection: 'poincare' | 'klein',
  size: number = radius,
): Space {
  const ell = radius / 2;
  return curvedSpaceOf(center, -1 / (ell * ell), ell, projection, size);
}

/**
 * The sphere on the drawable, by its radius: curvature `+1/R²`, touching
 * the sheet at `center`, seen in the stereographic chart from the point
 * opposite the contact. The curvature length IS the radius, and the
 * equator is drawn at `size`.
 */
export function sphericalSpaceOf(
  center: Vec,
  radius: number,
  projection: 'stereographic' | 'gnomonic' | 'orthographic',
  size: number = 2 * radius,
): Space {
  return curvedSpaceOf(center, 1 / (radius * radius), radius, projection, size);
}

// ---- the unit sphere's own chart ------------------------------------------

/** A point of the unit sphere. The chart's own point of contact is `+z`. */
export type Sphere = readonly [number, number, number];

/**
 * The unit sphere's stereographic chart, from the point opposite `+z`:
 * the chart origin stands for `+z` and `|z| = tan(θ/2)` for the angle from
 * it. The spherical space and the spherical tiling both work in this one
 * chart, so the pair of maps lives once.
 */
export function sphereOfChart(z: XY): Sphere {
  const a = vx(z);
  const b = vy(z);
  const s = 1 + a * a + b * b;
  return [(2 * a) / s, (2 * b) / s, 2 / s - 1];
}

/** `n ↦ z`. The point opposite the contact has no chart point, and the
 * division says so by itself. */
export function chartOfSphere(n: Sphere): Vec {
  return [n[0] / (1 + n[2]), n[1] / (1 + n[2])];
}

// ---- the bow of a stored chord --------------------------------------------

/** The ink's tolerance on the sheet, in mm: the one `lowerToUserContours`
 * has always used for a curve, and a quarter of the thinnest nib the
 * library ships. A door's `bow` is judged against it. */
export const INK_TOL = 0.05;

/**
 * How much of a door's tolerance a STORED chord of a geodesic may spend.
 * The ink door draws the stored chord to its own tolerance on the sheet,
 * wherever it lands; the chord's bow off the geodesic is the share the
 * stored geometry adds on top, as much again: at worst twice the ink's
 * 0.05 mm, a tenth of a millimetre — a third of the thinnest nib, and
 * below a plotter's own repeatability.
 */
const GEODESIC_BOW_SHARE = 1;

/**
 * The most the chart magnifies anywhere on the drawable: sheet units per
 * unit of the space's metric, at its worst over every point the drawable
 * shows. A placement can carry a chord anywhere, so a bow judged in the
 * metric has to hold where the chart is widest.
 *
 * With `ℓ` the curvature length, `M` the chart's `size` and `r` the
 * farthest the drawable reaches from the centre (`reach`, its corner, in
 * drawable units), the charts are one line each, and every one of them is
 * widest at the centre or at the corner:
 *
 *   poincaré      r = M·tanh(s/2ℓ)       widest at the centre, M/2ℓ
 *   klein         r = M·tanh(s/ℓ)        widest at the centre, M/ℓ
 *   stereographic r = M·tan(s/2ℓ)        widest at the corner, (M² + r²)/2Mℓ
 *   gnomonic      r = (M/2)·tan(s/ℓ)     widest at the corner, (M/2ℓ)(1 + (2r/M)²)
 *   orthographic  r = (M/2)·sin(s/ℓ)     widest at the centre, M/2ℓ
 *
 * (the first two conformal, the last two widest along the radius). The
 * flat plane is 1.
 */
export function chartStretch(chart: Pick<Space, 'curvature' | 'projection' | 'size'>, reach: number): number {
  if (chart.curvature === 0) return 1;
  const ell = 1 / Math.sqrt(Math.abs(chart.curvature));
  const M = chart.size;
  const r = reach;
  switch (chart.projection) {
    case 'klein': return M / ell;
    case 'stereographic': return (M * M + r * r) / (2 * M * ell);
    case 'gnomonic': return (M / (2 * ell)) * (1 + (2 * r / M) ** 2);
    default: return M / (2 * ell);
  }
}

/**
 * The bow, in the space's own metric and in sketch units, a stored chord
 * of a geodesic may keep: `tol` (mm on the sheet, the ink's 0.05 by
 * default) where the drawable's chart is widest. `unitMm` is one drawable
 * unit in mm and `reach` the drawable's half-diagonal in drawable units.
 * A placement keeps every metric distance, so a chord within this of its
 * geodesic stays within `tol` of it, on the sheet, wherever a placement
 * puts it. The toolkit hands it to the space's door when it resolves the
 * space; the `line` material door, a tiling's walls and `m.transform` are
 * all sampled to it.
 */
export function geodesicBowOf(
  chart: Pick<Space, 'curvature' | 'projection' | 'size'>,
  unitMm: number,
  reach: number,
  tol = INK_TOL,
): number {
  return (GEODESIC_BOW_SHARE * tol) / (unitMm * chartStretch(chart, reach));
}

// ---- resolution -----------------------------------------------------------

const named = (list: readonly Projection[]): string => list.map((p) => `'${p}'`).join(', ');

/** Which family a projection belongs to, for the refusal that names it. */
function familyOf(p: Projection): SpaceKind | null {
  if (HYPERBOLIC_PROJECTIONS.includes(p)) return 'hyperbolic';
  if (SPHERICAL_PROJECTIONS.includes(p)) return 'spherical';
  if (p === 'halfplane') return 'hyperbolic';
  return null;
}

/** The geometry a curvature names: its sign, and nothing else. */
export function kindOfCurvature(k: number): SpaceKind {
  return k < 0 ? 'hyperbolic' : k > 0 ? 'spherical' : 'euclidean';
}

/** The chart a space draws in: the one the sketch named, or the first of
 * its own family. A projection from another family names that family. */
function chooseProjection(kind: 'hyperbolic' | 'spherical', projection: Projection | undefined): Projection {
  const list = kind === 'hyperbolic' ? HYPERBOLIC_PROJECTIONS : SPHERICAL_PROJECTIONS;
  const chosen: Projection = projection ?? list[0];
  if (chosen === 'halfplane' && kind === 'hyperbolic') {
    throw new Error(`projection: 'halfplane' lands in a later step — hyperbolic space draws through ${named(HYPERBOLIC_PROJECTIONS)}`);
  }
  if (!list.includes(chosen)) {
    const family = familyOf(chosen);
    throw new Error(
      family
        ? `projection: '${chosen}' belongs to ${family} space — ${kind} space draws through ${named(list)}`
        : `projection: unknown projection '${chosen}' — ${kind} space draws through ${named(list)}`,
    );
  }
  return chosen;
}

/** The refusal for a chart with no space to draw. */
function noSpaceFor(projection: Projection): never {
  const family = familyOf(projection);
  throw new Error(
    family
      ? `projection: '${projection}' needs ${family} space — set space: '${family}' beside it`
      : `projection: '${projection}' is not a projection — ${named(HYPERBOLIC_PROJECTIONS)} belong to hyperbolic space and ${named(SPHERICAL_PROJECTIONS)} to spherical`,
  );
}

/** The `projection` key as a kind and a size, whichever way it is written. */
function projectionSpec(option: ProjectionOption | undefined): { kind?: Projection; size?: L } {
  if (option === undefined) return {};
  if (typeof option === 'string') return { kind: option };
  if (typeof option !== 'object' || typeof option.kind !== 'string') {
    throw new Error("projection: expected a chart by name, or { kind, size } — 'poincare', 'klein', 'stereographic', 'gnomonic', 'orthographic'");
  }
  return { kind: option.kind, size: option.size };
}

/**
 * The space of one curvature, as data. This is the door `resolveSpace`
 * itself goes through, and the door a drawing takes when it wants a
 * geometry other than the run's own — three curvatures side by side in one
 * flat sketch, say. Pure: the centre and the size are given in drawable
 * units, so no paper and no seed are read.
 *
 * `curvature` is the number, and its sign is the geometry. `center` is the
 * point the coordinates are measured from. `projection` is the chart, and
 * it defaults to the first of the sign's own family. `size` is how big the
 * chart is drawn — the radius of the disk, or where the equator lands —
 * and it defaults to the space's own scale, where a step at the centre is
 * one drawable unit. `curvature: 0` answers the Euclidean record, which is
 * the flat code itself.
 */
export function spaceOf(opts: { curvature: number; center?: XY; projection?: Projection; size?: number }): Space {
  const k = opts.curvature;
  if (typeof k !== 'number' || !Number.isFinite(k)) {
    throw new Error(`space: curvature must be a finite number in 1/unit², got ${String(k)}`);
  }
  const kind = kindOfCurvature(k);
  if (kind === 'euclidean') {
    if (opts.projection !== undefined) noSpaceFor(opts.projection);
    return euclideanSpace();
  }
  const ell = 1 / Math.sqrt(Math.abs(k));
  const size = opts.size === undefined ? 2 * ell : opts.size;
  if (!(size > 0) || !Number.isFinite(size)) {
    throw new Error(`projection: size must be a positive length in drawable units, got ${size}`);
  }
  return curvedSpaceOf(opts.center ?? [0, 0], k, ell, chooseProjection(kind, opts.projection), size);
}

/** The radius of the sugar forms, with the default each one carries. */
function radiusOf(kind: 'hyperbolic' | 'spherical', given: L | undefined, frame: SpaceFrame): number {
  // Both defaults read the drawable's half-diagonal. The default disk holds
  // the whole drawable with room to spare. The default sphere is the
  // half-diagonal over √2 — half the side of a square drawable — so the
  // drawable's middle row reaches `max(w, h)/2 ÷ R` = at most π/2 on any
  // aspect: a wide drawable stays on the near side, its corners short of
  // the equator, and never wraps toward the antipode.
  const fallback = kind === 'spherical'
    ? Math.hypot(frame.w, frame.h) / (2 * Math.SQRT2)
    : 1.25 * (Math.hypot(frame.w, frame.h) / 2);
  const r = given === undefined ? fallback : frame.len(given);
  if (!(r > 0) || !Number.isFinite(r)) {
    throw new Error(`space: ${kind} radius must be a positive length in drawable units, got ${r}`);
  }
  return r;
}

/**
 * The sketch's `space` and `projection` keys as one resolved record.
 *
 * `space` is GEOMETRY: one curvature, with the named forms as sugar for
 * one. `projection` is PAPER: which chart, and how big it is drawn. The
 * two are independent — the same curvature at two sizes measures the same
 * and prints at two scales.
 *
 * Absent, the space is Euclidean and every word runs the code it always
 * ran. A `projection` with no space names the space it needs; a projection
 * from another family names that family.
 */
export function resolveSpace(
  option: SpaceOption | undefined,
  projection: ProjectionOption | undefined,
  frame: SpaceFrame,
): Space {
  // The radius fixes the curvature LENGTH exactly (`R/2` in the disk, `R`
  // on the sphere) and the primary form fixes the CURVATURE, so each path
  // hands the construction the number it was given and derives the other.
  // Deriving both from one would round, and the suites pin the numbers.
  let kind: SpaceKind;
  let curvature = 0;
  let ell = 0;
  if (typeof option === 'object' && option !== null && 'curvature' in option) {
    const k = option.curvature;
    if (typeof k !== 'number' || !Number.isFinite(k)) {
      throw new Error(`space: curvature must be a finite number in 1/unit², got ${String(k)}`);
    }
    kind = kindOfCurvature(k);
    curvature = k;
    if (kind !== 'euclidean') ell = 1 / Math.sqrt(Math.abs(k));
  } else {
    const spec: SpaceSpec = option === undefined ? { kind: 'euclidean' } : typeof option === 'string' ? { kind: option } : option;
    if (!spec || typeof spec !== 'object' || typeof spec.kind !== 'string') {
      throw new Error("space: expected 'euclidean', 'hyperbolic', 'spherical', { curvature }, or space.hyperbolic({ radius })");
    }
    if (spec.kind !== 'euclidean' && spec.kind !== 'hyperbolic' && spec.kind !== 'spherical') {
      throw new Error(`space: unknown space '${String(spec.kind)}' — 'euclidean', 'hyperbolic' or 'spherical', or a curvature`);
    }
    kind = spec.kind;
    if (kind !== 'euclidean') {
      const radius = radiusOf(kind, spec.radius, frame);
      ell = kind === 'hyperbolic' ? radius / 2 : radius;
      curvature = (kind === 'hyperbolic' ? -1 : 1) / (ell * ell);
    }
  }
  const chart = projectionSpec(projection);
  if (kind === 'euclidean') {
    if (chart.kind !== undefined) noSpaceFor(chart.kind);
    if (chart.size !== undefined) {
      throw new Error("projection: a size needs a space to draw — set space: 'hyperbolic' or 'spherical' beside it");
    }
    return euclideanSpace();
  }
  // The chart fills the page unless the sketch says how big to draw it.
  const size = chart.size === undefined ? Math.min(frame.w, frame.h) / 2 : frame.len(chart.size);
  if (!(size > 0) || !Number.isFinite(size)) {
    throw new Error(`projection: size must be a positive length in drawable units, got ${size}`);
  }
  const projected = chooseProjection(kind, chart.kind);
  // The paper is in hand here, so the door takes the bow a stored chord
  // may keep: one drawable unit in mm, and the drawable's corner.
  const bow = geodesicBowOf({ curvature, projection: projected, size }, 1 / frame.len(mm(1)), Math.hypot(frame.w, frame.h) / 2);
  return curvedSpaceOf([frame.cx, frame.cy], curvature, ell, projected, size, bow);
}

// ---- the model chart ------------------------------------------------------

/**
 * The similarity that carries a geometry's MODEL chart onto the drawable:
 * a point `z` of the model is the chart point `center + scale·z`.
 *
 * The hyperbolic model is the unit Poincaré disk and the spherical model
 * is the unit sphere's stereographic chart, and in both of them `|z| = 1`
 * is drawn at the space's own `size` — the rim of the disk, the equator of
 * the sphere. The flat plane fixes no unit of length at all, so it answers
 * null and the caller picks a fit.
 */
export function modelChart(space: Space): { center: Vec; scale: number } | null {
  if (space.kind === 'euclidean') return null;
  return { center: space.center, scale: space.size };
}

/**
 * How a bucket grid laid out in sketch coordinates finds every point within
 * a METRIC radius, one query at a time — the neighbours every force reads.
 *
 * A row `y` is a distance from the base geodesic, so a point within `r`
 * lies within `r` of the query's row: the band of rows is the radius
 * itself. Along a row the metric is `c(y/ell)·dx`, and how far in x the
 * circle of radius `r` reaches depends on the QUERY's row alone: the
 * tangent geodesics from the base's pole give `sin(dx) = sin(ρ)/cos(b)` on
 * the sphere and `sinh(dx) = sinh(ρ)/cosh(b)` in the disk (`ρ = r/ell`,
 * `b = y/ell`, the query's row). The disk never reaches past `r`. The
 * sphere reaches further toward its poles, and every x when a pole lies
 * within `r` of the query — that one query then searches its band of rows
 * across the whole grid, and no other query pays for it.
 *
 * The sphere's coordinates also name each place more than once: x turns
 * round with a period of `2π·ell`, and a y past a pole is a place on the
 * other side. `home` is the one pair of each place — x within half a turn
 * of the centre, y between the poles, which is what `exp` answers — so a
 * grid of homes holds every place once, and a search near the seam wraps
 * by `period`. The disk and the plane are covered once: `home` is the
 * identity and `period` is Infinity.
 */
export interface BucketChart {
  /** The pair a point is bucketed at. */
  home(x: number, y: number): Vec;
  /** How far in x, from a home on row `y`, a point within `r` can lie:
   * Infinity when no x is too far. */
  reach(y: number, r: number): number;
  /** The x period of the homes: `2π·ell` on the sphere, else Infinity. */
  period: number;
}

/** Rounding margin on a reach: the formulas are exact, the doubles are not. */
const REACH_SLACK = 1 + 1e-9;

export function bucketChart(space: Space): BucketChart {
  const [cx, cy] = space.center;
  if (space.kind === 'spherical') {
    const ell = space.radius;
    const half = Math.PI * ell;
    const pole = Math.PI / 2;
    return {
      home(x, y) {
        // `exp` already answers homes; only a pair a sketch wrote itself
        // can lie outside and go round through the model.
        if (Math.abs(x - cx) < half && Math.abs(y - cy) <= pole * ell) return [x, y];
        return space.model.down(space.model.up([x, y]));
      },
      reach(y, r) {
        const b = Math.abs(y - cy) / ell;
        const rho = r / ell;
        if (!(b + rho < pole)) return Infinity;
        const w = ell * Math.asin(Math.min(1, Math.sin(rho) / Math.cos(b))) * REACH_SLACK;
        return w < half ? w : Infinity;
      },
      period: 2 * half,
    };
  }
  if (space.kind === 'hyperbolic') {
    const ell = space.radius / 2;
    return {
      home: (x, y) => [x, y],
      reach(y, r) {
        const w = ell * Math.asinh(Math.sinh(r / ell) / Math.cosh((y - cy) / ell)) * REACH_SLACK;
        // Far out `sinh` and `cosh` overflow; `r` itself always holds.
        return w < r ? w : r;
      },
      period: Infinity,
    };
  }
  return { home: (x, y) => [x, y], reach: (_y, r) => r, period: Infinity };
}

/**
 * How far a bucket search widens over one box — the scatter's — from the
 * space's `density`: how much longer a length of the SPACE can be in the
 * sketch's own coordinates — `1/sqrt(density)` at its thinnest, and never
 * below 1. Not the chart's magnification on the sheet, which is
 * `chartStretch` above.
 *
 * `density` is the area of the space one unit of coordinate area holds, so
 * `sqrt(density)` is the linear factor and a coordinate step of `dp` is
 * worth `sqrt(density)·dp`. A bucket grid is laid out in coordinates while
 * every radius here is a length of the space, so a search has to be
 * widened by this factor or it will not reach the neighbour it was meant
 * to find.
 *
 * The flat plane reads 1 everywhere and the disk never reads below it —
 * `cosh` of the distance from the base row — so both answer 1 and their
 * searches are the numbers they always were. The sphere reads `|cos|` of
 * that distance, which is at most 1 and VANISHES at the poles of the base
 * row, where a whole row of coordinates is one place. The reading depends
 * on the row alone, so the smallest over a box is at one of its two rows
 * unless a pole lies between them, and then it is nothing at all: no
 * bucket search is wide enough, and the answer says so with Infinity,
 * which the caller reads as "search the whole grid".
 */
export function bucketStretch(space: Space, bounds: { x: number; y: number; w: number; h: number }): number {
  if (space.kind !== 'spherical') return 1;
  const R = space.radius;
  const cy = space.center[1];
  const b0 = (bounds.y - cy) / R;
  const b1 = (bounds.y + bounds.h - cy) / R;
  // Some `π/2 + nπ` between the two rows is a pole of the base.
  const holdsPole = Math.ceil((b0 - Math.PI / 2) / Math.PI) <= Math.floor((b1 - Math.PI / 2) / Math.PI);
  if (holdsPole) return Infinity;
  const low = Math.min(space.density([bounds.x, bounds.y]), space.density([bounds.x, bounds.y + bounds.h]));
  if (!(low > 0)) return Infinity;
  return low >= 1 ? 1 : 1 / Math.sqrt(low);
}

/**
 * The largest `density` the space reaches over a box of sketch
 * coordinates: the bound a rejection draw uniform per area of the space
 * accepts against. The density reads the row alone (`|c((y − cy)/ℓ)|`),
 * so the answer is exact: the cosh of the row farthest from the centre in
 * the disk, and on the sphere 1 when the box holds a row `cy + kπR`, else
 * the larger of its two edge rows. Flat, 1.
 */
export function densityCeiling(space: Space, bounds: { x: number; y: number; w: number; h: number }): number {
  if (space.kind === 'euclidean') return 1;
  const edges = Math.max(space.density([bounds.x, bounds.y]), space.density([bounds.x, bounds.y + bounds.h]));
  if (space.kind === 'hyperbolic') return edges;
  const R = space.radius;
  const cy = space.center[1];
  const u0 = (bounds.y - cy) / (Math.PI * R);
  const u1 = (bounds.y + bounds.h - cy) / (Math.PI * R);
  return Math.ceil(u0) <= Math.floor(u1) ? 1 : edges;
}

// ---- the sheet back to the space ------------------------------------------

/**
 * The inverse of `project`: a point on the sheet, in drawable units, to
 * the sketch coordinate drawn there — or a non-finite pair where the sheet
 * shows no place of the space at all: past the rim of the disk, or outside
 * the hemisphere a `'gnomonic'` or `'orthographic'` chart draws.
 *
 * `fromChart` inverts the MODEL chart only. The Klein, gnomonic and
 * orthographic charts are each one line over it (`project` says which),
 * and this undoes that line first. The flat plane is the identity.
 *
 * The engine reads a field through this: it samples on the sheet, and a
 * field is written in sketch coordinates.
 */
export function fromSheet(space: Space, q: XY): Vec {
  if (space.kind === 'euclidean') return [vx(q), vy(q)];
  const [cx, cy] = space.center;
  const M = space.size;
  const wx = (vx(q) - cx) / M;
  const wy = (vy(q) - cy) / M;
  const r2 = wx * wx + wy * wy;
  const none: Vec = [NaN, NaN];
  // The factor that carries the drawn point back to the model chart.
  let k: number;
  switch (space.projection) {
    case 'poincare':
      // The rim is infinitely far away: at or past it is no place.
      return r2 < 1 ? space.fromChart(q) : none;
    case 'stereographic':
      return space.fromChart(q);
    case 'klein':
      // `w = 2z/(1 + |z|²)`, so `z = w/(1 + √(1 − |w|²))`.
      if (!(r2 < 1)) return none;
      k = 1 / (1 + Math.sqrt(1 - r2));
      break;
    case 'gnomonic':
      // `w = z/(1 − |z|²)` for `|z| < 1`: the smaller root.
      k = 2 / (1 + Math.sqrt(1 + 4 * r2));
      break;
    case 'orthographic':
      // `w = z/(1 + |z|²)` for `|z| ≤ 1`, which is `|w| ≤ 1/2`.
      if (!(4 * r2 <= 1)) return none;
      k = 2 / (1 + Math.sqrt(1 - 4 * r2));
      break;
    default:
      return space.fromChart(q);
  }
  return space.fromChart([cx + M * wx * k, cy + M * wy * k]);
}

// ---- the metric as a distance field ---------------------------------------

/**
 * The signed distance to one edge of an area, read as a GEODESIC of the
 * space and extended to the whole geodesic: positive on the LEFT of
 * `a → b`. Null where the two points name no geodesic.
 *
 * The ends come in as SKETCH coordinates and the answer reads a CHART
 * point, because a geodesic is a circle meeting the rim at right angles,
 * or a great circle, and that is a sentence the chart can say in a few
 * flops. A sample is one point and an area has many edges, so the caller
 * charts the sample once and hands it to every edge.
 */
function edgeField(space: Space, a: readonly [number, number], b: readonly [number, number]): ((x: number, y: number) => number) | null {
  if (space.kind === 'hyperbolic') {
    const M = space.size;
    const [cx, cy] = space.center;
    const pa = space.toChart(a);
    const pb = space.toChart(b);
    const za: Vec = [(pa[0] - cx) / M, (pa[1] - cy) / M];
    const zb: Vec = [(pb[0] - cx) / M, (pb[1] - cy) / M];
    if (!(za[0] * za[0] + za[1] * za[1] < 1) || !(zb[0] * zb[0] + zb[1] * zb[1] < 1)) return null;
    if (Math.hypot(za[0] - zb[0], za[1] - zb[1]) < 1e-15) return null;
    const f = hHalfplane(za, zb);
    // The unit disk measures with `ds = 2|dz|/(1 − |z|²)`, and the space's
    // own length is `ell` times that, whatever size the disk is drawn at.
    const ell = space.radius / 2;
    return (x, y) => ell * f((x - cx) / M, (y - cy) / M);
  }
  if (space.kind === 'spherical') {
    const M = space.size;
    const ell = space.radius;
    const [cx, cy] = space.center;
    const chart = (p: readonly [number, number]): Sphere => {
      const q = space.toChart(p);
      return sphereOfChart([(q[0] - cx) / M, (q[1] - cy) / M]);
    };
    const na = chart(a);
    const nb = chart(b);
    // The great circle through the two points is the plane they span with
    // the centre; its unit normal is their cross product, and the signed
    // angle a point makes with that plane is the distance to it. The
    // chart keeps orientation, so `a × b` points to the LEFT of `a → b`.
    const m: Sphere = [
      na[1] * nb[2] - na[2] * nb[1],
      na[2] * nb[0] - na[0] * nb[2],
      na[0] * nb[1] - na[1] * nb[0],
    ];
    const len = Math.hypot(m[0], m[1], m[2]);
    // The same point twice, or two opposite ones: no one great circle.
    if (!(len > 1e-12)) return null;
    const mx = m[0] / len;
    const my = m[1] / len;
    const mz = m[2] / len;
    return (x, y) => {
      const n = sphereOfChart([(x - cx) / M, (y - cy) / M]);
      return ell * Math.asin(Math.max(-1, Math.min(1, n[0] * mx + n[1] * my + n[2] * mz)));
    };
  }
  return null;
}

/** The signed area of a loop in sketch coordinates: its sign is the loop's
 * winding, and the coordinates keep orientation, so it is the space's
 * winding too. */
function chartArea(loop: readonly (readonly [number, number])[]): number {
  let sum = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i];
    const q = loop[(i + 1) % loop.length];
    sum += p[0] * q[1] - q[0] * p[1];
  }
  return sum / 2;
}

/** One boundary of an area, with its own closure — what every area
 * consumer already reads off its input. */
export interface SpaceContour {
  pts: readonly (readonly [number, number])[];
  closed: boolean;
}

/**
 * The signed distance to an area whose edges are GEODESICS of the space:
 * the smallest of its edges' half-plane distances, positive inside.
 *
 * Every edge is read as the whole geodesic it lies on, and the value at a
 * point is therefore its distance to the nearest edge — exact for a convex
 * cell, which is what a tiling's cell and a polygon of geodesics are, and
 * as close as the boundary's own sampling for anything else. The closed
 * loops are oriented by the widest of them, so a hole keeps the opposite
 * sign and reads as a hole. An OPEN contour has no inside: its edges are
 * its segments and nothing wraps, so a two-point line answers the signed
 * distance to its geodesic, positive on the left, and `t.isolines` over it
 * draws that geodesic's equidistant curves.
 */
export function spaceAreaField(space: Space, contours: readonly SpaceContour[]): (x: number, y: number) => number {
  const { sign, edges } = areaEdges(space, contours);
  const n = edges.length;
  return (x, y) => {
    // One chart reading a sample, whatever the area's edge count.
    const q = space.toChart([x, y]);
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const v = sign * edges[i].f(q[0], q[1]);
      if (v < best) best = v;
    }
    return best;
  };
}

/** What `spaceAreaNearest` answers at a point. */
export interface SpaceAreaReading {
  /** The signed distance, positive inside: `spaceAreaField`'s own number. */
  distance: number;
  /** The nearest boundary point: the foot of the perpendicular geodesic on
   * the nearest edge's geodesic. The point itself when nothing is near. */
  nearest: Vec;
  /** The unit direction, in the local frame at the point, in which the
   * distance grows fastest: along the geodesic to `nearest`, away from it
   * inside and toward it outside. Zero when the area has no edge. */
  inward: Vec;
}

/**
 * `spaceAreaField` with the POINT it measured to: the distance, the
 * nearest boundary point, and the inward direction there.
 *
 * The field already chooses the nearest edge to answer its number, so the
 * point is read off that edge and nothing is differenced. An edge's
 * geodesic is the model's plane through the origin with unit normal `m`;
 * the foot of `n` is `n − ⟨n, m⟩·m`, put back on the model, and the inward
 * direction is `m` read in the point's own frame — which is exact on the
 * boundary itself, where the direction to the nearest point is not.
 */
export function spaceAreaNearest(space: Space, contours: readonly SpaceContour[]): (x: number, y: number) => SpaceAreaReading {
  const { sign, edges } = areaEdges(space, contours);
  const door = space.model;
  const form = (u: Model, v: Model): number => u[0] * v[0] + u[1] * v[1] + door.sign * (u[2] * v[2]);
  return (x, y) => {
    const q = space.toChart([x, y]);
    let best = Infinity;
    let at = -1;
    for (let i = 0; i < edges.length; i++) {
      const v = sign * edges[i].f(q[0], q[1]);
      if (v < best) {
        best = v;
        at = i;
      }
    }
    if (at < 0 || !edges[at].m) return { distance: best, nearest: [x, y], inward: [0, 0] };
    const m = edges[at].m!;
    const n = door.up([x, y]);
    const k = form(n, m);
    const v: Model = [n[0] - k * m[0], n[1] - k * m[1], n[2] - k * m[2]];
    const len = Math.sqrt(Math.abs(form(v, v)));
    const nearest = len > 0 ? door.down([v[0] / len, v[1] / len, v[2] / len]) : ([x, y] as Vec);
    const [ex, ey] = door.frameAt([x, y]);
    const gx = sign * form(ex, m);
    const gy = sign * form(ey, m);
    const g = Math.hypot(gx, gy);
    return { distance: best, nearest, inward: g > 0 ? [gx / g, gy / g] : [0, 0] };
  };
}

/**
 * The edges of an area as the space reads them: each edge's signed
 * distance in the chart (`edgeField`) and the unit normal of its geodesic
 * in the model, oriented the same way — positive on the LEFT of `a → b` —
 * and the sign that makes the inside positive. The closed loops are
 * oriented by the widest of them, so a hole keeps the opposite sign.
 */
function areaEdges(space: Space, contours: readonly SpaceContour[]): {
  sign: number;
  edges: { f: (x: number, y: number) => number; m: Model | null }[];
} {
  let widest = 0;
  for (const c of contours) {
    if (!c.closed) continue;
    const a = chartArea(c.pts);
    if (Math.abs(a) > Math.abs(widest)) widest = a;
  }
  const sign = widest < 0 ? -1 : 1;
  const door = space.model;
  const G = door.sign;
  const edges: { f: (x: number, y: number) => number; m: Model | null }[] = [];
  for (const c of contours) {
    const n = c.closed ? c.pts.length : c.pts.length - 1;
    for (let i = 0; i < n; i++) {
      // A loop written with its first point repeated at the end closes
      // itself twice; the zero-length edge names no geodesic and drops.
      const a = c.pts[i];
      const b = c.pts[(i + 1) % c.pts.length];
      const f = edgeField(space, a, b);
      if (!f) continue;
      // The plane of the geodesic: `G·(A × B)` is orthogonal to both ends
      // in the model's own form, and it points LEFT of `a → b`, as `f` is
      // positive there.
      const A = door.up(a);
      const B = door.up(b);
      const cx = A[1] * B[2] - A[2] * B[1];
      const cy = A[2] * B[0] - A[0] * B[2];
      const cz = A[0] * B[1] - A[1] * B[0];
      const mz = G * cz;
      const len = Math.sqrt(Math.abs(cx * cx + cy * cy + G * mz * mz));
      edges.push({ f, m: len > 0 ? [cx / len, cy / len, mz / len] : null });
    }
  }
  return { sign, edges };
}
