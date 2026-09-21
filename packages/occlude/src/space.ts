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
 * The formulas are the Poincaré-disk formulas of `hyperbolic.ts` scaled to
 * this chart: that module measures with `ds = 2|dz|/(1 − |z|²)`, so a
 * length here is `radius/2` times a length there. The two hot readings,
 * `distance` and `density`, are spelled out rather than routed through the
 * complex helpers, the same way `hyperbolic.field.*` spells them out: they
 * are read once per candidate point and once per raster cell.
 *
 * The chart is where a sketch computes. `t.material`, `t.sample`,
 * `t.within` and `t.scatter` all answer in chart coordinates; the
 * projection is the LAST step of the ink door, so a drawing is projected
 * exactly once.
 */

import { apply as hApply, circle as hCircle, inverse as hInverse, translation as hTranslation } from './hyperbolic.js';
import type { L } from './units.js';
import { vx, vy, type Vec, type XY } from './vec.js';

export type SpaceKind = 'euclidean' | 'hyperbolic' | 'spherical';

/** The chart the sheet is drawn in. `'poincare'` and `'klein'` belong to
 * hyperbolic space; `'stereographic'`, `'gnomonic'` and `'orthographic'`
 * to spherical space, which lands in the next step. */
export type Projection = 'poincare' | 'klein' | 'halfplane' | 'stereographic' | 'gnomonic' | 'orthographic';

/** What a sketch declares: a kind by name, or the same with its radius. */
export interface SpaceSpec {
  kind: SpaceKind;
  /** The horizon, in drawable units (hyperbolic) or the sphere's radius
   * (spherical). Default: 1.25 × the drawable's half-diagonal. */
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
  /** Chart → sheet. */
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
  spherical: (_opts: { radius?: L } = {}): SpaceSpec => {
    throw new Error("spherical space lands in the next step — this build holds space.euclidean() and space.hyperbolic({ radius })");
  },
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
    throw new Error("space: expected 'euclidean', 'hyperbolic', or space.hyperbolic({ radius })");
  }
  if (spec.kind === 'spherical') {
    throw new Error("space: 'spherical' lands in the next step — this build holds 'euclidean' and 'hyperbolic'");
  }
  if (spec.kind !== 'euclidean' && spec.kind !== 'hyperbolic') {
    throw new Error(`space: unknown space '${String(spec.kind)}' — 'euclidean' or 'hyperbolic'`);
  }
  if (spec.kind === 'euclidean') {
    if (projection !== undefined) {
      const family = familyOf(projection);
      throw new Error(
        family
          ? `projection: '${projection}' needs ${family} space — set space: '${family}' beside it`
          : `projection: '${projection}' is not a projection — ${named(HYPERBOLIC_PROJECTIONS)} belong to hyperbolic space`,
      );
    }
    return euclideanSpace();
  }
  const chosen: Projection = projection ?? 'poincare';
  if (chosen === 'halfplane') {
    throw new Error(`projection: 'halfplane' lands in a later step — hyperbolic space draws through ${named(HYPERBOLIC_PROJECTIONS)}`);
  }
  if (!HYPERBOLIC_PROJECTIONS.includes(chosen)) {
    const family = familyOf(chosen);
    throw new Error(
      family
        ? `projection: '${chosen}' belongs to ${family} space — hyperbolic space draws through ${named(HYPERBOLIC_PROJECTIONS)}`
        : `projection: unknown projection '${chosen}' — hyperbolic space draws through ${named(HYPERBOLIC_PROJECTIONS)}`,
    );
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
