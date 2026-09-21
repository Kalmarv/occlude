/**
 * The sketch's geometry: what a length is worth, and which chart the sheet
 * draws it in.
 *
 * A polar coordinate system is a CHART — it renames points and changes no
 * length. Hyperbolic geometry is a METRIC — it says what an infinitesimal
 * step is worth, and its curvature survives every chart. So the sketch
 * frame holds two settings, not one: a `space` (the metric) and a
 * `projection` (the chart the sheet is drawn in). `m.map` is the third
 * role, authoring coordinates, and needs no setting.
 *
 * Everything here is in DRAWABLE units — bare numbers, the same ones a
 * sketch writes, 0 to 100 on the short side. The hyperbolic space puts the
 * drawable inside a Poincaré disk about the drawable's centre, of radius
 * `radius` in drawable units: the model coordinate is `z = (p − c)/radius`,
 * the metric is `ds = |dp|/(1 − |z|²)` — normalised so one step at the
 * centre is worth one drawable unit — and the curvature is `−4/radius²`.
 * A larger radius is flatter, and the Euclidean limit is radius → ∞.
 *
 * The spherical space is the same sentence with the sign turned over: the
 * drawable is the stereographic picture of a sphere of radius `radius`
 * touching it at its centre, the model coordinate is `z = (p − c)/(2·radius)`
 * — so `|z| = tan(θ/2)` for the angle `θ` from the point of contact — the
 * metric is `ds = |dp|/(1 + |z|²)`, again one drawable unit a step at the
 * centre, and the curvature is `+1/radius²`. The near hemisphere is
 * `|z| < 1`, the whole sphere fits the chart but for the one point
 * opposite the contact, and a larger radius is flatter here too.
 *
 * The formulas are the Poincaré-disk formulas of `hyperbolic.ts` scaled to
 * this chart: that module measures with `ds = 2|dz|/(1 − |z|²)`, so a
 * length here is `radius/2` times a length there. The two hot readings,
 * `distance` and `density`, are spelled out rather than routed through the
 * complex helpers: they are read once per candidate point and once per
 * raster cell.
 *
 * The chart is where a sketch computes. `t.material`, `t.sample`,
 * `t.within` and `t.scatter` all answer in chart coordinates; the
 * projection is the LAST step of the ink door, so a drawing is projected
 * exactly once.
 */

import { apply as hApply, circle as hCircle, halfplane as hHalfplane, inverse as hInverse, translation as hTranslation } from './hyperbolic.js';
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
  /** The horizon, in drawable units (hyperbolic; default 1.25 × the
   * drawable's half-diagonal) or the sphere's radius (spherical; default
   * half the drawable's short side). */
  radius?: L;
}

export type SpaceOption = SpaceKind | SpaceSpec;

/**
 * The resolved geometry of one run: the metric and the chart, as data.
 *
 * Every member answers in drawable units, and every point is a chart
 * point. `project` is the only member that speaks of the sheet.
 */
export interface Space {
  kind: SpaceKind;
  /** `'none'` in Euclidean space, which has no chart to choose. */
  projection: Projection | 'none';
  /** In drawable units: 0, `−4/radius²`, `+1/radius²`. */
  curvature: number;
  /** The horizon in drawable units (Infinity in Euclidean space). */
  radius: number;
  /** The chart point the space is centred on. */
  center: Vec;
  /** The metric: the length of the geodesic from `a` to `b`. */
  distance(a: XY, b: XY): number;
  /** The point reached from `p` by moving `|v|` in `v`'s chart direction. */
  exp(p: XY, v: XY): Vec;
  /** The direction and distance from `p` to `q`: `exp(p, log(p, q)) === q`. */
  log(p: XY, q: XY): Vec;
  /** The point a fraction `t` of the way along the geodesic from `a` to `b`. */
  geodesic(a: XY, b: XY, t: number): Vec;
  /** The circle of radius `r` about `c`, as `count` chart points. */
  circle(c: XY, r: number, count: number): Vec[];
  /** Area of the space per unit of chart area: 1 at the centre, NaN where
   * the chart holds no place. */
  density(p: XY): number;
  /** Chart → sheet, or a non-finite pair where the chart point is not on
   * the sheet at all — the far hemisphere under `'gnomonic'` and
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

/** The flat plane: the formulas every spacing word already uses. */
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
    project: (p) => [vx(p), vy(p)],
    straight: true,
  };
}

// ---- hyperbolic -----------------------------------------------------------

/**
 * The hyperbolic plane on the drawable: a Poincaré disk of radius `R`
 * about `c`, with the metric normalised to one drawable unit a step at the
 * centre.
 *
 * `hyperbolic.ts` measures the unit disk with `ds = 2|dz|/(1 − |z|²)`; this
 * chart is that disk stretched by `R` and measured with `ds = |dp|/(1 −
 * |z|²)`, so a length here is `R/2` times a length there. Every formula
 * below is that one scaling applied to the module's own.
 */
export function hyperbolicSpaceOf(center: Vec, radius: number, projection: 'poincare' | 'klein'): Space {
  const [cx, cy] = center;
  const R = radius;
  const model = (p: XY): Vec => [(vx(p) - cx) / R, (vy(p) - cy) / R];
  const chart = (z: XY): Vec => [cx + R * vx(z), cy + R * vy(z)];
  const inside = (z: Vec): boolean => z[0] * z[0] + z[1] * z[1] < 1;
  return {
    kind: 'hyperbolic',
    projection,
    // A metric scaled by k has its curvature divided by k²; the unit disk's
    // is −1 and k is R/2.
    curvature: -4 / (R * R),
    radius: R,
    center: [cx, cy],
    /**
     * `R·artanh|(a − b)/(1 − conj(a)·b)|` — `hyperbolic.distance` spelled
     * out and scaled.
     *
     * PAST THE HORIZON THE CHART IS WHAT IS LEFT. The rim is infinitely
     * far away, so a point at or beyond it is not a place and the metric
     * has nothing to say about it. Every word here then falls back to the
     * chart — this distance to the chart distance, `geodesic` to the
     * chord, `exp` to standing still — so a sketch whose coordinates run
     * off the edge of the space draws flat there instead of drawing
     * infinities. `density` is the one exception: it answers NaN, which is
     * how every field consumer already reads "not a place", and it is what
     * keeps `t.scatter` from putting points there.
     */
    distance(a, b) {
      const ax = (vx(a) - cx) / R;
      const ay = (vy(a) - cy) / R;
      const bx = (vx(b) - cx) / R;
      const by = (vy(b) - cy) / R;
      const dx = ax - bx;
      const dy = ay - by;
      // `conj(a)·b = (ax·bx + ay·by) + i(ax·by − ay·bx)`.
      const ex = 1 - (ax * bx + ay * by);
      const ey = -(ax * by - ay * bx);
      const q = ex * ex + ey * ey;
      const t = q > 0 ? Math.sqrt((dx * dx + dy * dy) / q) : 1;
      if (!(t < 1)) return Math.hypot(vx(b) - vx(a), vy(b) - vy(a));
      return R * Math.atanh(t);
    },
    exp(p, v) {
      const z = model(p);
      const s = Math.hypot(vx(v), vy(v));
      if (!(s > 0) || !inside(z)) return [vx(p), vy(p)];
      const th = Math.atan2(vy(v), vx(v));
      // A point `s` from the centre sits at `tanh(s_h/2)` in the model, and
      // `s_h = 2s/R`; the slide that carries the origin to `z` keeps
      // directions at the origin, because its derivative there is `1 − |z|²`,
      // a positive real.
      const rho = Math.tanh(s / R);
      const out = chart(hApply(hTranslation(z[0], z[1]), [rho * Math.cos(th), rho * Math.sin(th)]));
      return Number.isFinite(out[0]) && Number.isFinite(out[1]) ? out : [vx(p) + vx(v), vy(p) + vy(v)];
    },
    log(p, q) {
      const z = model(p);
      const w = model(q);
      if (!inside(z) || !inside(w)) return [vx(q) - vx(p), vy(q) - vy(p)];
      const u = hApply(hInverse(hTranslation(z[0], z[1])), w);
      const rho = Math.hypot(u[0], u[1]);
      if (!(rho > 0)) return [0, 0];
      if (!(rho < 1)) return [vx(q) - vx(p), vy(q) - vy(p)];
      const s = R * Math.atanh(rho);
      const th = Math.atan2(u[1], u[0]);
      return [s * Math.cos(th), s * Math.sin(th)];
    },
    geodesic(a, b, t) {
      // The ends are the points asked for, not the ends of a sampling —
      // the same promise `hyperbolic.geodesic` makes.
      if (!(t > 0)) return [vx(a), vy(a)];
      if (t >= 1) return [vx(b), vy(b)];
      const za = model(a);
      const zb = model(b);
      // Past the horizon there is no geodesic to walk: the chord is the
      // best effort, and nothing throws.
      if (!inside(za) || !inside(zb)) {
        return [vx(a) + (vx(b) - vx(a)) * t, vy(a) + (vy(b) - vy(a)) * t];
      }
      const home = hInverse(hTranslation(za[0], za[1]));
      const u = hApply(home, zb);
      const rho = Math.hypot(u[0], u[1]);
      if (!(rho > 0)) return chart(za);
      const chord: Vec = [vx(a) + (vx(b) - vx(a)) * t, vy(a) + (vy(b) - vy(a)) * t];
      // Rounding can put `u` a hair outside the disk even when `b` is
      // inside it; there is no arc to walk then, so the chord stands in.
      if (!(rho < 1)) return chord;
      // The whole segment is `2·artanh(rho)` long, so the point at fraction
      // `t` sits at `tanh(t·artanh(rho))` from `a` in the frame.
      const k = Math.tanh(t * Math.atanh(rho)) / rho;
      const out = chart(hApply(hTranslation(za[0], za[1]), [u[0] * k, u[1] * k]));
      return Number.isFinite(out[0]) && Number.isFinite(out[1]) ? out : chord;
    },
    circle(c, r, count) {
      const z = model(c);
      if (!(r > 0) || !inside(z)) return [];
      return hCircle(z, (2 * r) / R, { count: Math.floor(count) }).map(chart);
    },
    /** `(1/(1 − |z|²))²`: 1 at the centre and growing without bound toward
     * the horizon, which is how much of the plane one unit of chart area
     * holds. */
    density(p) {
      const zx = (vx(p) - cx) / R;
      const zy = (vy(p) - cy) / R;
      const q = 1 - zx * zx - zy * zy;
      if (!(q > 0)) return NaN;
      return 1 / (q * q);
    },
    /** Poincaré is the chart itself; Klein is `z ↦ 2z/(1 + |z|²)`, where a
     * geodesic is a chord and so draws straight. */
    project:
      projection === 'klein'
        ? (p) => {
            const z = model(p);
            const k = 2 / (1 + z[0] * z[0] + z[1] * z[1]);
            return chart([z[0] * k, z[1] * k]);
          }
        : (p) => [vx(p), vy(p)],
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
 * `z = (p − c)/(2R)` is the model coordinate, so `|z| = tan(θ/2)` for the
 * angle `θ` from the contact point: the equator is `|z| = 1`, the near
 * hemisphere everything inside it, and the far hemisphere everything
 * outside — reaching the whole way out, because the one point opposite the
 * contact is the one place the chart has no room for.
 *
 * The chart is CONFORMAL, which is what makes the rest short: a chart
 * direction and the sphere direction it stands for make the same angle
 * with every other, so the tangent frame `basis` below is orthonormal and
 * turning a chart direction into a sphere direction, or back, is two dot
 * products. `exp`, `log`, `geodesic` and `circle` are then the plain
 * spherical formulas — turn about the centre, great-circle angle, slerp,
 * small circle — carried through it.
 */
export function sphericalSpaceOf(center: Vec, radius: number, projection: 'stereographic' | 'gnomonic' | 'orthographic'): Space {
  const [cx, cy] = center;
  const R = radius;
  const model = (p: XY): Vec => [(vx(p) - cx) / (2 * R), (vy(p) - cy) / (2 * R)];
  const chart = (z: Vec): Vec => [cx + 2 * R * z[0], cy + 2 * R * z[1]];
  const up = sphereOfChart;
  const down = chartOfSphere;
  /** The orthonormal tangent frame at `z` that the chart axes stand for:
   * `d` in the chart is `d.x·e0 + d.y·e1` on the sphere, and back the same
   * way. (Both are `∂n/∂z` over `|∂n/∂z| = 2/s`.) */
  const basis = (z: Vec): [Sphere, Sphere] => {
    const a = z[0];
    const b = z[1];
    const s = 1 + a * a + b * b;
    return [
      [(s - 2 * a * a) / s, (-2 * a * b) / s, (-2 * a) / s],
      [(-2 * a * b) / s, (s - 2 * b * b) / s, (-2 * b) / s],
    ];
  };
  const dot3 = (u: Sphere, v: Sphere): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const finite = (v: Vec): boolean => Number.isFinite(v[0]) && Number.isFinite(v[1]);
  return {
    kind: 'spherical',
    projection,
    curvature: 1 / (R * R),
    radius: R,
    center: [cx, cy],
    /**
     * The great-circle length. Written through the chord — `|n_a − n_b|/2
     * = |z_a − z_b| / √((1 + |z_a|²)(1 + |z_b|²))` — so that a short step
     * keeps every digit it has, which `acos` of a dot product would spend.
     */
    distance(a, b) {
      const za = model(a);
      const zb = model(b);
      const qa = 1 + za[0] * za[0] + za[1] * za[1];
      const qb = 1 + zb[0] * zb[0] + zb[1] * zb[1];
      const half = Math.hypot(za[0] - zb[0], za[1] - zb[1]) / Math.sqrt(qa * qb);
      return 2 * R * Math.asin(Math.min(1, half));
    },
    exp(p, v) {
      const len = Math.hypot(vx(v), vy(v));
      if (!(len > 0)) return [vx(p), vy(p)];
      const z = model(p);
      const n = up(z);
      const [e0, e1] = basis(z);
      const kx = vx(v) / len;
      const ky = vy(v) / len;
      // The tangent direction the chart direction stands for.
      const u: Sphere = [e0[0] * kx + e1[0] * ky, e0[1] * kx + e1[1] * ky, e0[2] * kx + e1[2] * ky];
      const ang = len / R;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const out = chart(down([n[0] * ca + u[0] * sa, n[1] * ca + u[1] * sa, n[2] * ca + u[2] * sa]));
      return finite(out) ? out : [vx(p) + vx(v), vy(p) + vy(v)];
    },
    log(p, q) {
      const za = model(p);
      const zb = model(q);
      const na = up(za);
      const nb = up(zb);
      const c = Math.max(-1, Math.min(1, dot3(na, nb)));
      const ang = Math.acos(c);
      // The component of `n_b` across `n_a` is the direction to walk. It
      // vanishes when the two points are the same and when they are
      // opposite, and opposite points have no one geodesic between them —
      // the chart offset is the best effort, as it is past the horizon in
      // the hyperbolic space.
      const w: Sphere = [nb[0] - na[0] * c, nb[1] - na[1] * c, nb[2] - na[2] * c];
      const wl = Math.hypot(w[0], w[1], w[2]);
      if (!(wl > 1e-15)) return ang < 1 ? [0, 0] : [vx(q) - vx(p), vy(q) - vy(p)];
      const u: Sphere = [w[0] / wl, w[1] / wl, w[2] / wl];
      const [e0, e1] = basis(za);
      const dx = dot3(u, e0);
      const dy = dot3(u, e1);
      const dl = Math.hypot(dx, dy);
      if (!(dl > 0)) return [vx(q) - vx(p), vy(q) - vy(p)];
      const s = R * ang;
      return [(s * dx) / dl, (s * dy) / dl];
    },
    geodesic(a, b, t) {
      // The ends are the points asked for, as everywhere else.
      if (!(t > 0)) return [vx(a), vy(a)];
      if (t >= 1) return [vx(b), vy(b)];
      const chord: Vec = [vx(a) + (vx(b) - vx(a)) * t, vy(a) + (vy(b) - vy(a)) * t];
      const na = up(model(a));
      const nb = up(model(b));
      const c = Math.max(-1, Math.min(1, dot3(na, nb)));
      const ang = Math.acos(c);
      const sa = Math.sin(ang);
      // Same point, or opposite ones: no arc to walk either way.
      if (!(sa > 1e-12)) return chord;
      const k0 = Math.sin((1 - t) * ang) / sa;
      const k1 = Math.sin(t * ang) / sa;
      const out = chart(down([na[0] * k0 + nb[0] * k1, na[1] * k0 + nb[1] * k1, na[2] * k0 + nb[2] * k1]));
      return finite(out) ? out : chord;
    },
    circle(c, r, count) {
      if (!(r > 0) || !(count >= 3)) return [];
      const z = model(c);
      const n = up(z);
      const [e0, e1] = basis(z);
      const ang = r / R;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const k = Math.floor(count);
      const out: Vec[] = [];
      for (let i = 0; i < k; i++) {
        const th = (2 * Math.PI * i) / k;
        const ux = Math.cos(th);
        const uy = Math.sin(th);
        out.push(chart(down([
          n[0] * ca + (e0[0] * ux + e1[0] * uy) * sa,
          n[1] * ca + (e0[1] * ux + e1[1] * uy) * sa,
          n[2] * ca + (e0[2] * ux + e1[2] * uy) * sa,
        ])));
      }
      return out;
    },
    /** `(1/(1 + |z|²))²`: 1 at the point of contact and falling away from
     * it, so a unit of chart area holds LESS of the sphere the further out
     * it sits. The sphere's area is finite, so unlike the hyperbolic
     * density this one never asks a flood where to stop. */
    density(p) {
      const z = model(p);
      const q = 1 + z[0] * z[0] + z[1] * z[1];
      return 1 / (q * q);
    },
    /**
     * Stereographic is the chart itself. The other two show ONE
     * HEMISPHERE: gnomonic is the sphere from its own centre, where every
     * geodesic draws straight and the equator runs off to infinity;
     * orthographic is the sphere from far away, the near hemisphere inside
     * a circle of radius `R`. Both answer NaN on the far side, which is
     * the ink door's word for "no place on the sheet".
     */
    project:
      projection === 'stereographic'
        ? (p) => [vx(p), vy(p)]
        : projection === 'gnomonic'
          ? (p) => {
            const z = model(p);
            const k = 1 - z[0] * z[0] - z[1] * z[1];
            if (!(k > 0)) return [NaN, NaN];
            return [cx + (vx(p) - cx) / k, cy + (vy(p) - cy) / k];
          }
          : (p) => {
            const z = model(p);
            const q = z[0] * z[0] + z[1] * z[1];
            if (q > 1) return [NaN, NaN];
            return [cx + (vx(p) - cx) / (1 + q), cy + (vy(p) - cy) / (1 + q)];
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
  // The default horizon puts the drawable's corners at |z| = 0.8, so the
  // whole sheet is a place and nothing sits at infinity.
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
 * The hyperbolic model is the unit Poincaré disk, and the space's own
 * horizon is where `|z| = 1`, so the scale is the radius. The spherical
 * model is the unit sphere's stereographic chart, and `|z| = 1` is the
 * equator, which sits at twice the radius from the point of contact. The
 * flat plane fixes no unit of length at all, so it answers null and the
 * caller picks a fit.
 */
export function modelChart(space: Space): { center: Vec; scale: number } | null {
  if (space.kind === 'hyperbolic') return { center: space.center, scale: space.radius };
  if (space.kind === 'spherical') return { center: space.center, scale: 2 * space.radius };
  return null;
}

// ---- the metric as a distance field ---------------------------------------

/** Where the space has a place at all: the chart holds points the geometry
 * does not — everything at or past the hyperbolic horizon. `density` is
 * the reading that already says so, with NaN, and every field consumer
 * reads a non-finite sample as absent. */
const placeOf = (space: Space): ((x: number, y: number) => boolean) => {
  if (space.kind !== 'hyperbolic') return () => true;
  return (x, y) => {
    const d = space.density([x, y]);
    return Number.isFinite(d) && d > 0;
  };
};

/**
 * The signed distance to the space's circle of radius `r` about `center`:
 * POSITIVE INSIDE, like `sdf.circle`, and measured by the metric.
 *
 * Its zero set is exactly the loop `circle(cx, cy, r)` draws in this
 * space, and its other level sets are the circles about the same centre —
 * so `t.isolines` over it draws rings evenly spaced in the space's own
 * metric rather than on the sheet.
 */
export function spaceCircleField(space: Space, center: XY, r: number): (x: number, y: number) => number {
  const c: Vec = [vx(center), vy(center)];
  const place = placeOf(space);
  return (x, y) => (place(x, y) ? r - space.distance(c, [x, y]) : NaN);
}

/**
 * The signed distance to one edge of an area, read as a GEODESIC of the
 * space and extended to the whole geodesic: positive on the LEFT of
 * `a → b`. Null where the two points name no geodesic.
 */
function edgeField(space: Space, a: readonly [number, number], b: readonly [number, number]): ((x: number, y: number) => number) | null {
  if (space.kind === 'hyperbolic') {
    const R = space.radius;
    const [cx, cy] = space.center;
    const za: Vec = [(a[0] - cx) / R, (a[1] - cy) / R];
    const zb: Vec = [(b[0] - cx) / R, (b[1] - cy) / R];
    if (!(za[0] * za[0] + za[1] * za[1] < 1) || !(zb[0] * zb[0] + zb[1] * zb[1] < 1)) return null;
    if (Math.hypot(za[0] - zb[0], za[1] - zb[1]) < 1e-15) return null;
    const f = hHalfplane(za, zb);
    // The unit disk measures with `ds = 2|dz|/(1 − |z|²)` and this chart
    // with `ds = |dp|/(1 − |z|²)`, so a length here is `R/2` times one
    // there — the same scaling every other member of this space applies.
    const k = R / 2;
    return (x, y) => k * f((x - cx) / R, (y - cy) / R);
  }
  if (space.kind === 'spherical') {
    const R = space.radius;
    const [cx, cy] = space.center;
    const na = sphereOfChart([(a[0] - cx) / (2 * R), (a[1] - cy) / (2 * R)]);
    const nb = sphereOfChart([(b[0] - cx) / (2 * R), (b[1] - cy) / (2 * R)]);
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

/** The chart's signed area of a loop: its sign is the loop's winding, and
 * both charts here keep orientation, so it is the space's winding too. */
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
 * cell, which is what a tiling's cell and a polygon of geodesics are. The
 * closed loops are oriented by the widest of them, so a hole keeps the
 * opposite sign and reads as a hole. An OPEN contour has no inside: its
 * edges are its segments and nothing wraps, so a two-point line answers
 * the signed distance to its geodesic, positive on the left, and
 * `t.isolines` over it draws that geodesic's equidistant curves.
 *
 * Outside the space — past the hyperbolic horizon — the answer is NaN, and
 * a field consumer reads that as "no place": `t.isolines` truncates a
 * contour open there and `t.scatter` places nothing.
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
  const place = placeOf(space);
  return (x, y) => {
    if (!place(x, y)) return NaN;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const v = sign * edges[i](x, y);
      if (v < best) best = v;
    }
    return best;
  };
}
