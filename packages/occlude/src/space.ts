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
 * The hyperbolic space is the plane of curvature `−4/radius²`, drawn in a
 * Poincaré disk of radius `radius` about the drawable's centre. The metric
 * is normalised so one step at the centre is worth one drawable unit:
 * `ds² = cosh²(y/k)·dx² + dy²` with `k = radius/2`. A larger radius is
 * flatter, and the Euclidean limit is radius → ∞. Nothing is out of
 * bounds: the coordinates reach the whole plane, and the disk is where
 * that plane is DRAWN, not where it stops.
 *
 * The spherical space is the sphere of radius `radius`, touching the sheet
 * at the drawable's centre: `ds² = cos²(y/R)·dx² + dy²`, curvature
 * `+1/R²`, and the same one-unit-a-step normalisation. Its chart is the
 * stereographic picture from the point opposite the contact, where the
 * equator is the circle at twice the radius from the centre.
 *
 * The maths runs in the model each geometry is cheapest in — the
 * hyperboloid for the disk, the unit sphere for the sphere — because both
 * spell the Fermi map, the exponential and the metric as three lines of
 * arithmetic with no special cases.
 */

import { halfplane as hHalfplane } from './hyperbolic.js';
import type { L } from './units.js';
import { vx, vy, type Vec, type XY } from './vec.js';

export type SpaceKind = 'euclidean' | 'hyperbolic' | 'spherical';

/** The chart the sheet is drawn in. `'poincare'` and `'klein'` belong to
 * hyperbolic space; `'stereographic'`, `'gnomonic'` and `'orthographic'`
 * to spherical space. */
export type Projection = 'poincare' | 'klein' | 'halfplane' | 'stereographic' | 'gnomonic' | 'orthographic';

/** What a sketch declares: a kind by name, or the same with its radius. */
export interface SpaceSpec {
  kind: SpaceKind;
  /** The radius of the disk the plane is drawn in (hyperbolic; default
   * 1.25 × the drawable's half-diagonal) or the sphere's radius
   * (spherical; default half the drawable's short side). */
  radius?: L;
}

export type SpaceOption = SpaceKind | SpaceSpec;

/**
 * The resolved geometry of one run: the metric, the coordinates and the
 * chart, as data.
 *
 * Every member takes and answers SKETCH coordinates in drawable units.
 * `project` alone answers on the sheet.
 */
export interface Space {
  kind: SpaceKind;
  /** `'none'` in Euclidean space, which has no chart to choose. */
  projection: Projection | 'none';
  /** In drawable units: 0, `−4/radius²`, `+1/radius²`. */
  curvature: number;
  /** The radius of the disk the plane is drawn in, or the sphere's radius
   * (Infinity in Euclidean space). */
  radius: number;
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

/** The flat plane: the formulas every spacing word already uses, and the
 * identity for every map. */
export function euclideanSpace(): Space {
  return {
    kind: 'euclidean',
    projection: 'none',
    curvature: 0,
    radius: Infinity,
    center: [0, 0],
    distance: (a, b) => Math.hypot(vx(b) - vx(a), vy(b) - vy(a)),
    exp: (p, v) => [vx(p) + vx(v), vy(p) + vy(v)],
    log: (p, q) => [vx(q) - vx(p), vy(q) - vy(p)],
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
  };
}

// ---- hyperbolic -----------------------------------------------------------

/**
 * A point of the hyperboloid `x² + y² − w² = −1`, `w > 0`: the model the
 * hyperbolic plane is cheapest in. Written `[x, y, w]`, the timelike
 * coordinate last.
 */
type Hyp = readonly [number, number, number];

/** The Minkowski product `u·v = ux·vx + uy·vy − uw·vw`. A point of the
 * sheet has `n·n = −1`; a unit tangent there has `e·e = +1`. */
const mdot = (u: Hyp, v: Hyp): number => u[0] * v[0] + u[1] * v[1] - u[2] * v[2];

/**
 * The hyperbolic plane on the drawable: curvature `−4/R²`, one drawable
 * unit a step at the centre, drawn in a Poincaré disk of radius `R` about
 * `center`.
 *
 * `k = R/2` is the length the curvature fixes — the plane's own unit, in
 * drawable units. A sketch coordinate `(x, y)` is the hyperboloid point
 *
 *     n(a, b) = [sinh a · cosh b, sinh b, cosh a · cosh b],
 *     a = (x − cx)/k,  b = (y − cy)/k,
 *
 * which is the base geodesic `b = 0` walked to `a` and then the
 * perpendicular there walked to `b`. The disk point is `n ↦ (nx, ny)/(1 +
 * nw)`, scaled by `R`.
 *
 * The local frame at that point — the equidistant direction and the
 * perpendicular geodesic direction — is `∂a` normalised and `∂b`, which
 * is already unit:
 *
 *     Ex = [cosh a, 0, sinh a],   Ey = [sinh a · sinh b, cosh b, cosh a · sinh b].
 *
 * So `exp` is the plain hyperboloid formula `n·cosh(s/k) + u·sinh(s/k)`,
 * `log` reads the components back with two Minkowski products, and the
 * area element is `cosh b`: a row of coordinates is longer the further it
 * lies from the base, which is the one way a flat grid can hold a
 * hyperbolic plane.
 */
export function hyperbolicSpaceOf(center: Vec, radius: number, projection: 'poincare' | 'klein'): Space {
  const [cx, cy] = center;
  const R = radius;
  const k = R / 2;
  /** Sketch coordinates → the hyperboloid. */
  const up = (p: XY): Hyp => {
    const a = (vx(p) - cx) / k;
    const b = (vy(p) - cy) / k;
    const cb = Math.cosh(b);
    return [Math.sinh(a) * cb, Math.sinh(b), Math.cosh(a) * cb];
  };
  /** The hyperboloid → sketch coordinates. `tanh a = nx/nw` and `sinh b =
   * ny`, both single-valued, so the map is one to one over the plane. */
  const down = (n: Hyp): Vec => [cx + k * Math.atanh(Math.min(1 - 1e-16, Math.max(-1 + 1e-16, n[0] / n[2]))), cy + k * Math.asinh(n[1])];
  /** The local frame at a sketch point: `[equidistant, perpendicular]`. */
  const frameAt = (p: XY): [Hyp, Hyp] => {
    const a = (vx(p) - cx) / k;
    const b = (vy(p) - cy) / k;
    const sb = Math.sinh(b);
    return [
      [Math.cosh(a), 0, Math.sinh(a)],
      [Math.sinh(a) * sb, Math.cosh(b), Math.cosh(a) * sb],
    ];
  };
  /** The disk point of a hyperboloid point, in drawable units. */
  const disk = (n: Hyp): Vec => [cx + (R * n[0]) / (1 + n[2]), cy + (R * n[1]) / (1 + n[2])];
  /** The hyperbolic distance in the plane's own unit: `2·asinh(|Δ|/2)`
   * with `|Δ|` the Minkowski length of the difference, which keeps every
   * digit of a short step that `acosh` of a product would spend. */
  const gap = (n: Hyp, m: Hyp): number => {
    const d: Hyp = [n[0] - m[0], n[1] - m[1], n[2] - m[2]];
    return 2 * Math.asinh(Math.sqrt(Math.max(0, mdot(d, d))) / 2);
  };
  return {
    kind: 'hyperbolic',
    projection,
    curvature: -4 / (R * R),
    radius: R,
    center: [cx, cy],
    distance: (a, b) => k * gap(up(a), up(b)),
    exp(p, v) {
      const s = Math.hypot(vx(v), vy(v));
      if (!(s > 0)) return [vx(p), vy(p)];
      const n = up(p);
      const [ex, ey] = frameAt(p);
      const dx = vx(v) / s;
      const dy = vy(v) / s;
      const u: Hyp = [ex[0] * dx + ey[0] * dy, ex[1] * dx + ey[1] * dy, ex[2] * dx + ey[2] * dy];
      const ch = Math.cosh(s / k);
      const sh = Math.sinh(s / k);
      const out = down([n[0] * ch + u[0] * sh, n[1] * ch + u[1] * sh, n[2] * ch + u[2] * sh]);
      return Number.isFinite(out[0]) && Number.isFinite(out[1]) ? out : [vx(p) + vx(v), vy(p) + vy(v)];
    },
    log(p, q) {
      const n = up(p);
      const m = up(q);
      const g = gap(n, m);
      if (!(g > 0)) return [0, 0];
      const sh = Math.sinh(g);
      const ch = Math.cosh(g);
      // The unit tangent at `p` that points at `q`.
      const u: Hyp = [(m[0] - n[0] * ch) / sh, (m[1] - n[1] * ch) / sh, (m[2] - n[2] * ch) / sh];
      const [ex, ey] = frameAt(p);
      const s = k * g;
      return [s * mdot(u, ex), s * mdot(u, ey)];
    },
    geodesic(a, b, t) {
      // The ends are the points asked for, not the ends of a sampling.
      if (!(t > 0)) return [vx(a), vy(a)];
      if (t >= 1) return [vx(b), vy(b)];
      const n = up(a);
      const m = up(b);
      const g = gap(n, m);
      const sh = Math.sinh(g);
      if (!(sh > 1e-15)) return [vx(a) + (vx(b) - vx(a)) * t, vy(a) + (vy(b) - vy(a)) * t];
      const k0 = Math.sinh((1 - t) * g) / sh;
      const k1 = Math.sinh(t * g) / sh;
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
    /** `cosh(y/k)`: 1 on the base geodesic and growing away from it, which
     * is how much of the plane one unit of coordinate area holds. */
    density: (p) => Math.cosh((vy(p) - cy) / k),
    toChart: (p) => disk(up(p)),
    fromChart(z) {
      const zx = (vx(z) - cx) / R;
      const zy = (vy(z) - cy) / R;
      const q = 1 - zx * zx - zy * zy;
      // The rim is infinitely far away, so a point at or past it has no
      // coordinates. The nearest place inside stands in, and nothing
      // throws: the caller is fitting a chart, not measuring.
      if (!(q > 0)) {
        const len = Math.hypot(zx, zy) || 1;
        const s = (1 - 1e-15) / len;
        return this.fromChart([cx + R * zx * s, cy + R * zy * s]);
      }
      return down([(2 * zx) / q, (2 * zy) / q, (1 + zx * zx + zy * zy) / q]);
    },
    /** Poincaré is the chart itself; Klein is `z ↦ 2z/(1 + |z|²)`, where a
     * geodesic is a chord and so draws straight. */
    project(p) {
      const c = disk(up(p));
      if (projection !== 'klein') return c;
      const zx = (c[0] - cx) / R;
      const zy = (c[1] - cy) / R;
      const m = 2 / (1 + zx * zx + zy * zy);
      return [cx + R * zx * m, cy + R * zy * m];
    },
    straight: projection === 'klein',
  };
}

// ---- spherical ------------------------------------------------------------

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

/**
 * The sphere on the drawable: radius `R`, touching the sheet at `c`, seen
 * in the stereographic chart from the point opposite the contact.
 *
 * A sketch coordinate `(x, y)` is the sphere point
 *
 *     n(a, b) = [sin a · cos b, sin b, cos a · cos b],
 *     a = (x − cx)/R,  b = (y − cy)/R,
 *
 * the same construction as the disk's with the signs turned over: the
 * equator through the contact walked to `a`, then the meridian there
 * walked to `b`. The local frame is `Ex = [cos a, 0, −sin a]` and `Ey =
 * [−sin a · sin b, cos b, −cos a · sin b]`, and the area element is
 * `|cos b|` — a unit of coordinate area holds LESS of the sphere the
 * further it lies from the equator, which is the opposite of the disk.
 */
export function sphericalSpaceOf(center: Vec, radius: number, projection: 'stereographic' | 'gnomonic' | 'orthographic'): Space {
  const [cx, cy] = center;
  const R = radius;
  const up = (p: XY): Sphere => {
    const a = (vx(p) - cx) / R;
    const b = (vy(p) - cy) / R;
    const cb = Math.cos(b);
    return [Math.sin(a) * cb, Math.sin(b), Math.cos(a) * cb];
  };
  const down = (n: Sphere): Vec => [
    cx + R * Math.atan2(n[0], n[2]),
    cy + R * Math.asin(Math.max(-1, Math.min(1, n[1]))),
  ];
  const frameAt = (p: XY): [Sphere, Sphere] => {
    const a = (vx(p) - cx) / R;
    const b = (vy(p) - cy) / R;
    const sb = Math.sin(b);
    return [
      [Math.cos(a), 0, -Math.sin(a)],
      [-Math.sin(a) * sb, Math.cos(b), -Math.cos(a) * sb],
    ];
  };
  const dot3 = (u: Sphere, v: Sphere): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  /** The great-circle angle, written through the chord so a short step
   * keeps every digit it has. */
  const gap = (n: Sphere, m: Sphere): number =>
    2 * Math.asin(Math.min(1, Math.hypot(n[0] - m[0], n[1] - m[1], n[2] - m[2]) / 2));
  /** The chart point of a sphere point, in drawable units. */
  const chart = (n: Sphere): Vec => {
    const z = chartOfSphere(n);
    return [cx + 2 * R * z[0], cy + 2 * R * z[1]];
  };
  return {
    kind: 'spherical',
    projection,
    curvature: 1 / (R * R),
    radius: R,
    center: [cx, cy],
    distance: (a, b) => R * gap(up(a), up(b)),
    exp(p, v) {
      const s = Math.hypot(vx(v), vy(v));
      if (!(s > 0)) return [vx(p), vy(p)];
      const n = up(p);
      const [ex, ey] = frameAt(p);
      const dx = vx(v) / s;
      const dy = vy(v) / s;
      const u: Sphere = [ex[0] * dx + ey[0] * dy, ex[1] * dx + ey[1] * dy, ex[2] * dx + ey[2] * dy];
      const ca = Math.cos(s / R);
      const sa = Math.sin(s / R);
      return down([n[0] * ca + u[0] * sa, n[1] * ca + u[1] * sa, n[2] * ca + u[2] * sa]);
    },
    log(p, q) {
      const n = up(p);
      const m = up(q);
      const ang = gap(n, m);
      const c = Math.max(-1, Math.min(1, dot3(n, m)));
      // The component of `m` across `n` is the direction to walk. It
      // vanishes when the two points are the same and when they are
      // opposite, and opposite points have no one geodesic between them.
      const w: Sphere = [m[0] - n[0] * c, m[1] - n[1] * c, m[2] - n[2] * c];
      const wl = Math.hypot(w[0], w[1], w[2]);
      if (!(wl > 1e-15)) return ang < 1 ? [0, 0] : [vx(q) - vx(p), vy(q) - vy(p)];
      const u: Sphere = [w[0] / wl, w[1] / wl, w[2] / wl];
      const [ex, ey] = frameAt(p);
      const s = R * ang;
      return [s * dot3(u, ex), s * dot3(u, ey)];
    },
    geodesic(a, b, t) {
      if (!(t > 0)) return [vx(a), vy(a)];
      if (t >= 1) return [vx(b), vy(b)];
      const n = up(a);
      const m = up(b);
      const ang = gap(n, m);
      const sa = Math.sin(ang);
      // Same point, or opposite ones: no arc to walk either way.
      if (!(sa > 1e-12)) return [vx(a) + (vx(b) - vx(a)) * t, vy(a) + (vy(b) - vy(a)) * t];
      const k0 = Math.sin((1 - t) * ang) / sa;
      const k1 = Math.sin(t * ang) / sa;
      return down([n[0] * k0 + m[0] * k1, n[1] * k0 + m[1] * k1, n[2] * k0 + m[2] * k1]);
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
    density: (p) => Math.abs(Math.cos((vy(p) - cy) / R)),
    toChart: (p) => chart(up(p)),
    fromChart: (z) => down(sphereOfChart([(vx(z) - cx) / (2 * R), (vy(z) - cy) / (2 * R)])),
    /**
     * Stereographic is the chart itself. The other two show ONE
     * HEMISPHERE: gnomonic is the sphere from its own centre, where every
     * geodesic draws straight and the equator runs off to infinity;
     * orthographic is the sphere from far away, the near hemisphere inside
     * a circle of radius `R`. Both answer NaN on the far side, which is
     * the ink door's word for "no place on the sheet".
     */
    project(p) {
      const c = chart(up(p));
      if (projection === 'stereographic') return c;
      const zx = (c[0] - cx) / (2 * R);
      const zy = (c[1] - cy) / (2 * R);
      const q = zx * zx + zy * zy;
      if (projection === 'gnomonic') {
        const m = 1 - q;
        if (!(m > 0)) return [NaN, NaN];
        return [cx + (c[0] - cx) / m, cy + (c[1] - cy) / m];
      }
      if (q > 1) return [NaN, NaN];
      return [cx + (c[0] - cx) / (1 + q), cy + (c[1] - cy) / (1 + q)];
    },
    straight: projection === 'gnomonic',
  };
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

/**
 * The sketch's `space` and `projection` keys as one resolved record.
 *
 * Absent, the space is Euclidean and every word runs the code it always
 * ran. A `projection` with no space names the space it needs; a projection
 * from another family names that family.
 */
export function resolveSpace(
  option: SpaceOption | undefined,
  projection: Projection | undefined,
  frame: SpaceFrame,
): Space {
  const spec: SpaceSpec = option === undefined ? { kind: 'euclidean' } : typeof option === 'string' ? { kind: option } : option;
  if (!spec || typeof spec !== 'object' || typeof spec.kind !== 'string') {
    throw new Error("space: expected 'euclidean', 'hyperbolic', 'spherical', or space.hyperbolic({ radius })");
  }
  if (spec.kind !== 'euclidean' && spec.kind !== 'hyperbolic' && spec.kind !== 'spherical') {
    throw new Error(`space: unknown space '${String(spec.kind)}' — 'euclidean', 'hyperbolic' or 'spherical'`);
  }
  if (spec.kind === 'euclidean') {
    if (projection !== undefined) {
      const family = familyOf(projection);
      throw new Error(
        family
          ? `projection: '${projection}' needs ${family} space — set space: '${family}' beside it`
          : `projection: '${projection}' is not a projection — ${named(HYPERBOLIC_PROJECTIONS)} belong to hyperbolic space and ${named(SPHERICAL_PROJECTIONS)} to spherical`,
      );
    }
    return euclideanSpace();
  }
  const list = spec.kind === 'hyperbolic' ? HYPERBOLIC_PROJECTIONS : SPHERICAL_PROJECTIONS;
  const chosen: Projection = projection ?? list[0];
  if (chosen === 'halfplane' && spec.kind === 'hyperbolic') {
    throw new Error(`projection: 'halfplane' lands in a later step — hyperbolic space draws through ${named(HYPERBOLIC_PROJECTIONS)}`);
  }
  if (!list.includes(chosen)) {
    const family = familyOf(chosen);
    throw new Error(
      family
        ? `projection: '${chosen}' belongs to ${family} space — ${spec.kind} space draws through ${named(list)}`
        : `projection: unknown projection '${chosen}' — ${spec.kind} space draws through ${named(list)}`,
    );
  }
  if (spec.kind === 'spherical') {
    // The default sphere touches the drawable at its centre and its near
    // hemisphere fills the largest circle the drawable holds.
    const r = spec.radius === undefined ? Math.min(frame.w, frame.h) / 2 : frame.len(spec.radius);
    if (!(r > 0) || !Number.isFinite(r)) {
      throw new Error(`space: spherical radius must be a positive length in drawable units, got ${r}`);
    }
    return sphericalSpaceOf([frame.cx, frame.cy], r, chosen as 'stereographic' | 'gnomonic' | 'orthographic');
  }
  // The default disk holds the whole drawable with room to spare.
  const half = Math.hypot(frame.w, frame.h) / 2;
  const radius = spec.radius === undefined ? 1.25 * half : frame.len(spec.radius);
  if (!(radius > 0) || !Number.isFinite(radius)) {
    throw new Error(`space: hyperbolic radius must be a positive length in drawable units, got ${radius}`);
  }
  return hyperbolicSpaceOf([frame.cx, frame.cy], radius, chosen as 'poincare' | 'klein');
}

// ---- the model chart ------------------------------------------------------

/**
 * The similarity that carries a geometry's MODEL chart onto the drawable:
 * a point `z` of the model is the chart point `center + scale·z`.
 *
 * The hyperbolic model is the unit Poincaré disk, and the space's own disk
 * is where `|z| = 1`, so the scale is the radius. The spherical model is
 * the unit sphere's stereographic chart, and `|z| = 1` is the equator,
 * which sits at twice the radius from the point of contact. The flat plane
 * fixes no unit of length at all, so it answers null and the caller picks
 * a fit.
 */
export function modelChart(space: Space): { center: Vec; scale: number } | null {
  if (space.kind === 'hyperbolic') return { center: space.center, scale: space.radius };
  if (space.kind === 'spherical') return { center: space.center, scale: 2 * space.radius };
  return null;
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
    const R = space.radius;
    const [cx, cy] = space.center;
    const pa = space.toChart(a);
    const pb = space.toChart(b);
    const za: Vec = [(pa[0] - cx) / R, (pa[1] - cy) / R];
    const zb: Vec = [(pb[0] - cx) / R, (pb[1] - cy) / R];
    if (!(za[0] * za[0] + za[1] * za[1] < 1) || !(zb[0] * zb[0] + zb[1] * zb[1] < 1)) return null;
    if (Math.hypot(za[0] - zb[0], za[1] - zb[1]) < 1e-15) return null;
    const f = hHalfplane(za, zb);
    // The unit disk measures with `ds = 2|dz|/(1 − |z|²)` and this chart
    // with `ds = |dp|/(1 − |z|²)`, so a length here is `R/2` times one
    // there — the same scaling the metric itself takes.
    const k = R / 2;
    return (x, y) => k * f((x - cx) / R, (y - cy) / R);
  }
  if (space.kind === 'spherical') {
    const R = space.radius;
    const [cx, cy] = space.center;
    const chart = (p: readonly [number, number]): Sphere => {
      const q = space.toChart(p);
      return sphereOfChart([(q[0] - cx) / (2 * R), (q[1] - cy) / (2 * R)]);
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
      const n = sphereOfChart([(x - cx) / (2 * R), (y - cy) / (2 * R)]);
      return R * Math.asin(Math.max(-1, Math.min(1, n[0] * mx + n[1] * my + n[2] * mz)));
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
  let widest = 0;
  for (const c of contours) {
    if (!c.closed) continue;
    const a = chartArea(c.pts);
    if (Math.abs(a) > Math.abs(widest)) widest = a;
  }
  const sign = widest < 0 ? -1 : 1;
  const edges: ((x: number, y: number) => number)[] = [];
  for (const c of contours) {
    const n = c.closed ? c.pts.length : c.pts.length - 1;
    for (let i = 0; i < n; i++) {
      // A loop written with its first point repeated at the end closes
      // itself twice; the zero-length edge names no geodesic and drops.
      const f = edgeField(space, c.pts[i], c.pts[(i + 1) % c.pts.length]);
      if (f) edges.push(f);
    }
  }
  const n = edges.length;
  return (x, y) => {
    // One chart reading a sample, whatever the area's edge count.
    const q = space.toChart([x, y]);
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const v = sign * edges[i](q[0], q[1]);
      if (v < best) best = v;
    }
    return best;
  };
}
