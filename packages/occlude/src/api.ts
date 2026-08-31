/**
 * The declarative surface: a sketch is a pure function from a toolkit to a
 * tree of shape values.
 *
 *   sketch(config, ({ ...toolkit }) => tree)
 *     toolkit: shapes, fills, group/clip/mask, rnd/noise/map, bounds, units
 *     tree:    Shape | Shape[] | nested arrays (flattened; order = draw order)
 *
 * Shapes are plain values — nothing records until the sketch is compiled for
 * a render. Every shape takes a trailing opts object:
 *
 *   { pen, fill, opaque, stroke, z }
 *   fill: implies opaque. opaque: hides what's beneath (no texture).
 *   stroke: false = no outline; a pen name overrides the stroke pen.
 *
 *   mask(shape)              → { ...shape, opaque: true, stroke: false }
 *   group(opts, ...children) → transform / pen / z defaults for children
 *   clip(shape, ...children) → children restricted to shape; shape not drawn
 *   path(opts?).moveTo()….build(opts?) → returns a Shape value (the builder
 *   stays usable — build() snapshots)
 */

import { crosshatch, hatch, stipple, type CustomFillFn, type FillSpec } from './fills.js';
import { ease } from './ease.js';
import { finiteCount } from './guard.js';
import { svg as svgValue } from './svgin.js';
import { label } from './font.js';
import { grid as gridCells, type GridCell, type GridOptions } from './layout.js';
import { Shape, type FieldFn, type ModifierValue, type PathCmd, type ShapeGeom, type VectorFieldFn } from './shapes.js';
import {
  bounds, chance, clip as legacyClip, margin, noise, pick, prob, push, rnd,
  sketch as legacySketch, stream, getState, unitScaleMm,
  type SketchOptions, type Winding,
} from './state.js';
import { invertRange, mapRange, normRange } from './random.js';
import {
  liftPoints, scatterPoints, triangulate, voronoi,
  type FieldFn2, type ScatterOpts,
} from './points.js';
import { solid } from './fills.js';
import { ui } from './ui.js';
import { h, long, mm, s, w, resolveLen, Len, type L } from './units.js';

// ---- values ----

export interface ShapeOpts {
  /** Pen for stroke and (by default) fill. */
  pen?: string;
  /** Fill texture — implies opaque. */
  fill?: FillSpec | CustomFillFn;
  /** Pen for the fill texture, when different from `pen`. */
  fillPen?: string;
  /** Opaque with no texture: hides what's beneath, only the stroke draws. */
  opaque?: boolean;
  /** `false` = no outline; a pen name overrides the stroke pen. */
  stroke?: string | false;
  /** Stacking override; default is tree order. */
  z?: number;
  /** rect only: anchor (x, y) at the 'corner' (default) or the 'center'
   * (p5 rectMode). The sketch config's `rectMode` sets the default. */
  mode?: 'corner' | 'center';
  /** Drop this fraction of the shape's FINAL visible strokes (0…1), after
   * occlusion and cleanup. Seeded — the distressed-plot modifier. A number
   * applies to everything; { stroke, fill } sets outline and fill ink
   * separately (e.g. { fill: 0.5 } erodes the texture, keeps the outline). */
  decimate?: number | FieldFn | { stroke?: number | FieldFn; fill?: number | FieldFn };
  /** Hand-tremor: displace final strokes with seeded smooth noise, AFTER
   * occlusion (line quality only). A length (bare units or mm()), or
   * { amount, wavelength } to also set the noise wavelength (default
   * mm(25)). */
  wobble?: L | FieldFn | { amount: L | FieldFn; wavelength?: L };
  /** Endpoint-join tolerance (a length; mm() recommended): after occlusion,
   * strokes of shapes that OPT IN are joined pen-down across gaps up to
   * this size — hatch rows serpentine into single strokes, trading tiny
   * visible connectors for most of the plot's pen lifts. Opt-in per shape
   * or group; borders/text simply don't set it. Debug view highlights the
   * connectors. */
  bridge?: L;
  /** Per-shape transform — identical to wrapping the shape in a group. */
  translate?: [L, L];
  /** Degrees; pivots around the user origin. */
  rotate?: number;
  scale?: number | [number, number];
  /** Ordered modifier stack, applied first-to-last. Stacks compose in
   * function-application order: this list runs first, then `modify()`
   * ancestors inside-out; the `decimate`/`wobble` shorthand opts run last,
   * in that fixed order. */
  modifiers?: ModifierValue[];
}

export interface ShapeValue {
  readonly __occludeShape: true;
  readonly geom: ShapeGeom;
  readonly opts: ShapeOpts;
}

export interface GroupOpts {
  /** Decimation default for children that don't set their own. */
  decimate?: number | FieldFn | { stroke?: number | FieldFn; fill?: number | FieldFn };
  /** Wobble default for children that don't set their own. */
  wobble?: L | FieldFn | { amount: L | FieldFn; wavelength?: L };
  /** Bridge default for children that don't set their own (opt-in join). */
  bridge?: L;
  /** Modifier stack for the subtree; nesting concatenates in
   * function-application order — inner stacks run before outer ones. */
  modifiers?: ModifierValue[];
  translate?: [L, L];
  /** Degrees. */
  rotate?: number;
  scale?: number | [number, number];
  /** Default pen for children that don't set one. */
  pen?: string;
  /** Default z for children that don't set one. */
  z?: number;
}

export interface GroupValue {
  readonly __occludeGroup: true;
  readonly opts: GroupOpts;
  readonly children: Tree[];
}

export interface ClipValue {
  readonly __occludeClip: true;
  readonly region: ShapeValue;
  readonly children: Tree[];
}

/** Falsy entries are skipped, so conditional composition reads naturally. */
export type Tree =
  | ShapeValue
  | GroupValue
  | ClipValue
  | Tree[]
  | null
  | undefined
  | false;

function shape(geom: ShapeGeom, opts: ShapeOpts = {}): ShapeValue {
  return { __occludeShape: true, geom, opts };
}

const isOpts = (v: unknown): v is ShapeOpts =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Len);

// ---- pure shape constructors ----

export function circle(x: L, y: L, r: L, opts?: ShapeOpts): ShapeValue {
  return shape({ kind: 'circle', x, y, r }, opts);
}

export function ellipse(
  x: L, y: L, rx: L, ry: L,
  rotation?: number | ShapeOpts,
  opts?: ShapeOpts,
): ShapeValue {
  if (isOpts(rotation)) return shape({ kind: 'ellipse', x, y, rx, ry, rotation: 0 }, rotation);
  return shape({ kind: 'ellipse', x, y, rx, ry, rotation: rotation ?? 0 }, opts);
}

export function rect(
  x: L, y: L, w: L, h: L,
  radius?: L | ShapeOpts,
  opts?: ShapeOpts,
): ShapeValue {
  const o = isOpts(radius) ? radius : opts;
  const r = isOpts(radius) ? 0 : (radius ?? 0);
  return shape({ kind: 'rect', x, y, w, h, radius: r, anchor: o?.mode }, o);
}

export function line(x1: L, y1: L, x2: L, y2: L, opts?: ShapeOpts): ShapeValue {
  return shape({ kind: 'line', x1, y1, x2, y2 }, opts);
}

export function polygon(points: [L, L][], opts?: ShapeOpts): ShapeValue;
export function polygon(
  x: L, y: L, sides: number, r: L, rotation?: number | ShapeOpts, opts?: ShapeOpts,
): ShapeValue;
export function polygon(
  a: L | [L, L][], b?: L | ShapeOpts, sides?: number, r?: L,
  rotation?: number | ShapeOpts, opts?: ShapeOpts,
): ShapeValue {
  if (Array.isArray(a)) return shape({ kind: 'points', pts: a }, b as ShapeOpts | undefined);
  if (isOpts(rotation)) {
    return shape(
      { kind: 'ngon', x: a, y: b as L, sides: sides!, r: r!, rotation: 0 },
      rotation,
    );
  }
  return shape(
    { kind: 'ngon', x: a, y: b as L, sides: sides!, r: r!, rotation: rotation ?? 0 },
    opts,
  );
}

/** Mutable builder; `build()` snapshots, so the builder stays extendable. */
export class PathValue {
  private cmds: PathCmd[] = [];
  constructor(private winding: Winding = 'nonzero') {}

  moveTo(x: L, y: L): this {
    this.cmds.push({ op: 'move', x, y });
    return this;
  }
  lineTo(x: L, y: L): this {
    this.cmds.push({ op: 'line', x, y });
    return this;
  }
  bezierTo(c0x: L, c0y: L, c1x: L, c1y: L, x: L, y: L): this {
    this.cmds.push({ op: 'bezier', c0x, c0y, c1x, c1y, x, y });
    return this;
  }
  quadTo(cx: L, cy: L, x: L, y: L): this {
    this.cmds.push({ op: 'quad', cx, cy, x, y });
    return this;
  }
  /** Minor arc to (x, y); the sign of r picks the side of the chord. */
  arcTo(x: L, y: L, r: L): this {
    this.cmds.push({ op: 'arc', x, y, r });
    return this;
  }
  close(): this {
    this.cmds.push({ op: 'close' });
    return this;
  }
  build(opts: ShapeOpts = {}): ShapeValue {
    return shape(
      { kind: 'path', cmds: this.cmds.map((c) => ({ ...c })), winding: this.winding },
      opts,
    );
  }
}

export function path(opts: { winding?: Winding } = {}): PathValue {
  return new PathValue(opts.winding ?? 'nonzero');
}

// ---- sequence helpers ----

/**
 * Call `fn(i, t)` n times and collect the results — the loop idiom of the
 * tree model. `i` is the index (0…n−1); `t` is normalised 0…1 across the
 * sequence (0 when n === 1), so interpolating along the run is one
 * expression: `times(40, (k, t) => rect(0, t * height, …))`.
 */
export function times<T>(n: number, fn: (k: number, t: number) => T): T[] {
  const count = finiteCount('times', n);
  const out: T[] = [];
  for (let k = 0; k < count; k++) out.push(fn(k, count > 1 ? k / (count - 1) : 0));
  return out;
}

/** Integers [0, n) — or [a, b) with an optional step — for mapping/nesting. */
export function range(n: number): number[];
export function range(a: number, b: number, step?: number): number[];
export function range(a: number, b?: number, step = 1): number[] {
  const [lo, hi] = b === undefined ? [0, a] : [a, b];
  finiteCount('range', step === 0 ? Infinity : Math.abs(hi - lo) / Math.abs(step));
  const out: number[] = [];
  if (step > 0) for (let v = lo; v < hi; v += step) out.push(v);
  else if (step < 0) for (let v = lo; v > hi; v += step) out.push(v);
  return out;
}

// ---- combinators ----

export function group(opts: GroupOpts, ...children: Tree[]): GroupValue {
  return { __occludeGroup: true, opts, children };
}

export function clip(region: ShapeValue, ...children: Tree[]): ClipValue {
  return { __occludeClip: true, region, children };
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

type DecimateArg =
  | number
  | FieldFn
  | { stroke?: number | FieldFn; fill?: number | FieldFn };
type WobbleArg = L | FieldFn | { amount: L | FieldFn; wavelength?: L };

function decimateValue(p: DecimateArg): ModifierValue {
  const [stroke, fill] =
    typeof p === 'number' || typeof p === 'function' ? [p, p] : [p.stroke ?? 0, p.fill ?? 0];
  const c = (v: number | FieldFn): number | FieldFn => (typeof v === 'number' ? clamp01(v) : v);
  return { __occludeModifier: true, kind: 'decimate', stroke: c(stroke), fill: c(fill) };
}

function wobbleValue(a: WobbleArg): ModifierValue {
  if (typeof a === 'object' && !(a instanceof Len) && 'amount' in a) {
    return { __occludeModifier: true, kind: 'wobble', amount: a.amount, wavelength: a.wavelength };
  }
  return { __occludeModifier: true, kind: 'wobble', amount: a };
}

/**
 * Hand-tremor: seeded smooth-noise displacement of final strokes, applied
 * AFTER occlusion so the hidden-line result is exact and only the ink
 * trembles. With children it wraps the subtree; with no children it
 * returns a modifier value for a `modifiers: [...]` stack.
 */
export function wobble(amount: WobbleArg): ModifierValue;
export function wobble(amount: WobbleArg, ...children: [Tree, ...Tree[]]): GroupValue;
export function wobble(amount: WobbleArg, ...children: Tree[]): GroupValue | ModifierValue {
  if (children.length === 0) return wobbleValue(amount);
  return { __occludeGroup: true, opts: { wobble: amount }, children };
}

/**
 * Drop `p` (0…1) of the final visible strokes — computed AFTER occlusion,
 * seeded by the sketch seed. The distressed-plot modifier. With children
 * it wraps the subtree; with no children it returns a modifier value for a
 * `modifiers: [...]` stack.
 */
export function decimate(p: DecimateArg): ModifierValue;
export function decimate(p: DecimateArg, ...children: [Tree, ...Tree[]]): GroupValue;
export function decimate(p: DecimateArg, ...children: Tree[]): GroupValue | ModifierValue {
  if (children.length === 0) return decimateValue(p);
  return { __occludeGroup: true, opts: { decimate: p }, children };
}

const isLen = (v: unknown): v is L => typeof v === 'number' || v instanceof Len;

/**
 * Chop final strokes into dashes by physical length, AFTER occlusion. The
 * pattern is phase-continuous along each outline (occlusion cuts and arc
 * joints never reset it), and on closed shapes the period is snapped to
 * divide the contour length so the pattern meets itself seamlessly.
 * `gap` defaults to `len`; `offset` shifts the pattern. The cuts are
 * exact sub-ranges — curves stay curves. With children it wraps the
 * subtree; alone it returns a modifier value.
 */
export function dash(len: L, gap?: L, offset?: L): ModifierValue;
export function dash(len: L, gap: L, ...children: [Tree, ...Tree[]]): GroupValue;
export function dash(
  len: L, gap: L, offset: L, ...children: [Tree, ...Tree[]]
): GroupValue;
export function dash(
  len: L,
  ...rest: (L | Tree)[]
): GroupValue | ModifierValue {
  const lens: L[] = [];
  let i = 0;
  while (i < rest.length && lens.length < 2 && isLen(rest[i])) {
    lens.push(rest[i] as L);
    i++;
  }
  const children = rest.slice(i) as Tree[];
  const value: ModifierValue = {
    __occludeModifier: true, kind: 'dash', len, gap: lens[0] ?? len, offset: lens[1],
  };
  if (children.length === 0) return value;
  return { __occludeGroup: true, opts: { modifiers: [value] }, children };
}

/**
 * Chaikin corner-rounding on the shape's geometry, BEFORE occlusion — the
 * smoothed outline is what occludes. Each pass rounds every corner; a few
 * passes approach a spline. Curves flatten to polylines here.
 */
export function smooth(passes?: number): ModifierValue;
export function smooth(passes: number, ...children: [Tree, ...Tree[]]): GroupValue;
export function smooth(passes = 2, ...children: Tree[]): GroupValue | ModifierValue {
  const value: ModifierValue = { __occludeModifier: true, kind: 'smooth', passes };
  if (children.length === 0) return value;
  return { __occludeGroup: true, opts: { modifiers: [value] }, children };
}

/**
 * Midpoint-displacement fracture, BEFORE occlusion: contours are resampled
 * at `detail` spacing (default mm(1.5)) and vertices jittered by up to
 * `amount` — jagged edges (coastlines, stone), vs wobble's smooth tremor.
 */
export function roughen(amount: L | FieldFn, detail?: L): ModifierValue;
export function roughen(
  amount: L | FieldFn,
  detail: L | undefined,
  ...children: [Tree, ...Tree[]]
): GroupValue;
export function roughen(
  amount: L | FieldFn,
  detail?: L,
  ...children: Tree[]
): GroupValue | ModifierValue {
  const value: ModifierValue = { __occludeModifier: true, kind: 'roughen', amount, detail };
  if (children.length === 0) return value;
  return { __occludeGroup: true, opts: { modifiers: [value] }, children };
}

/**
 * Displace shape geometry by a vector field, BEFORE occlusion — the
 * deformed silhouette is what hides things (occluded shapes peek through).
 * The conscious-choice stage: wrapped shapes' curves shatter into
 * polylines entering the solve, and only they pay for it. Pass
 * `{ field, detail }` to control the resampling step (default mm(2)).
 */
export function deform(
  field: VectorFieldFn | { field: VectorFieldFn; detail?: L },
): ModifierValue;
export function deform(
  field: VectorFieldFn | { field: VectorFieldFn; detail?: L },
  ...children: [Tree, ...Tree[]]
): GroupValue;
export function deform(
  field: VectorFieldFn | { field: VectorFieldFn; detail?: L },
  ...children: Tree[]
): GroupValue | ModifierValue {
  const cfg = typeof field === 'function' ? { field } : field;
  const value: ModifierValue = {
    __occludeModifier: true, kind: 'deform', field: cfg.field, detail: cfg.detail,
  };
  if (children.length === 0) return value;
  return { __occludeGroup: true, opts: { modifiers: [value] }, children };
}

/**
 * A ready-made tremor vector field for `deform`: seeded simplex noise,
 * `amount` and `wavelength` in user units.
 */
export function noiseField(amount: number, wavelength = 25): VectorFieldFn {
  return (x, y) => [
    amount * noise(x / wavelength, y / wavelength),
    amount * noise(x / wavelength + 213.7, y / wavelength - 118.3),
  ];
}

/**
 * Apply an ordered modifier stack to the subtree: `modify([smooth(2),
 * wobble(mm(1)), decimate(0.2)], ...shapes)` — entries run first-to-last
 * on each shape's final program; nested stacks compose inner-first.
 */
export function modify(mods: ModifierValue[], ...children: Tree[]): GroupValue {
  return { __occludeGroup: true, opts: { modifiers: mods }, children };
}

/** Occludes everything beneath it and draws nothing at all. */
export function mask(sv: ShapeValue): ShapeValue {
  return { ...sv, opts: { ...sv.opts, opaque: true, stroke: false, fill: undefined } };
}

/** A hand-drawn-looking line built from the sketch's noise stream. */
function noisyLineValue(
  x1: L, y1: L, x2: L, y2: L,
  o: { points?: number; scale?: number; amplitude?: number; offset?: number } = {},
  shapeOpts?: ShapeOpts,
): ShapeValue {
  const { points = 64, scale = 3, amplitude = 1, offset = 0 } = o;
  const nominal = { innerW: 100, innerH: 100 };
  const res = (v: L): number => (v instanceof Len ? resolveNominal(v, nominal) : v);
  const [ax, ay, bx, by] = [res(x1), res(y1), res(x2), res(y2)];
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const p = path();
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    const falloff = Math.sin(Math.PI * t) ** 0.5;
    const n = noise(offset + t * scale, offset * 7.31) * amplitude * falloff;
    const px = ax + dx * t + nx * n;
    const py = ay + dy * t + ny * n;
    if (i === 0) p.moveTo(px, py);
    else p.lineTo(px, py);
  }
  return p.build(shapeOpts);
}

function resolveNominal(v: Len, ctx: { innerW: number; innerH: number }): number {
  switch (v.kind) {
    case 'short': return v.value;
    case 'w': return (v.value / 100) * ctx.innerW;
    case 'h': return (v.value / 100) * ctx.innerH;
    case 'long': return v.value;
    case 'mm': return v.value;
  }
}

// ---- the sketch ----

export interface SketchConfig extends Omit<SketchOptions, 'seed'> {
  seed?: 'url' | number | string;
  /** Percent inset from the paper edge. */
  margin?: number;
  /** Default pen for shapes that don't set one. */
  pen?: string;
}

export interface Toolkit {
  circle: typeof circle;
  ellipse: typeof ellipse;
  rect: typeof rect;
  line: typeof line;
  polygon: typeof polygon;
  path: typeof path;
  group: typeof group;
  clip: typeof clip;
  mask: typeof mask;
  decimate: typeof decimate;
  wobble: typeof wobble;
  modify: typeof modify;
  dash: typeof dash;
  smooth: typeof smooth;
  roughen: typeof roughen;
  deform: typeof deform;
  noiseField: typeof noiseField;
  label: typeof label;
  hatch: typeof hatch;
  crosshatch: typeof crosshatch;
  stipple: typeof stipple;
  solid: typeof solid;
  ui: typeof ui;
  rnd: typeof rnd;
  pick: typeof pick;
  chance: typeof chance;
  prob: typeof prob;
  noise: typeof noise;
  stream: typeof stream;
  map: typeof mapRange;
  norm: typeof normRange;
  invert: typeof invertRange;
  ease: typeof ease;
  times: typeof times;
  range: typeof range;
  bounds: typeof bounds;
  /** Drawable extent in bare units — the same numbers `bounds()` returns. */
  width: number;
  height: number;
  cx: number;
  cy: number;
  grid: (opts: GridOptions) => GridCell[];
  scatter: typeof scatter;
  points: typeof pointsOf;
  voronoi: typeof voronoi;
  triangulate: typeof triangulate;
  noisyLine: typeof noisyLineValue;
  svg: typeof svgValue;
  mm: typeof mm;
  w: typeof w;
  h: typeof h;
  s: typeof s;
  long: typeof long;
}

export interface SketchDef {
  readonly __occludeSketch: true;
  readonly config: SketchConfig;
  readonly fn: (toolkit: Toolkit) => Tree;
}

export function isSketch(v: unknown): v is SketchDef {
  return typeof v === 'object' && v !== null && (v as SketchDef).__occludeSketch === true;
}

/**
 * Define a sketch (declarative form), or reset the legacy recording state
 * when called with only a config (old-style sketches keep working).
 */
export function sketch(config: SketchConfig, fn: (toolkit: Toolkit) => Tree): SketchDef;
export function sketch(config?: SketchOptions): void;
export function sketch(
  config: SketchConfig = {},
  fn?: (toolkit: Toolkit) => Tree,
): SketchDef | void {
  if (!fn) {
    legacySketch(config);
    return;
  }
  return { __occludeSketch: true, config, fn };
}

/** Environment handed to the points module: seeded stream, drawable
 * bounds, and sketch-time length resolution (mm via the paper hint). */
function pointsEnv(): import('./points.js').PointsEnv {
  const b = bounds();
  const st = stream('__points');
  return {
    rnd: () => st.rnd(),
    bounds: { x: 0, y: 0, w: b.w, h: b.h },
    len: (l) => {
      if (typeof l === 'object' && l !== null && (l as Len).kind === 'mm') {
        return (l as Len).value / unitScaleMm();
      }
      return resolveLen(l, { innerW: b.w, innerH: b.h });
    },
  };
}

/** Field-modulated Poisson-disk points; `.settle(n)` refines toward the
 * weighted Linde-Buzo-Gray distribution. */
function scatter(field: FieldFn2 | undefined, opts: ScatterOpts): import('./points.js').Points;
function scatter(opts: ScatterOpts): import('./points.js').Points;
function scatter(
  a: FieldFn2 | ScatterOpts | undefined,
  b?: ScatterOpts,
): import('./points.js').Points {
  const field = typeof a === 'function' ? a : undefined;
  const opts = (typeof a === 'function' || a === undefined ? b : a) as ScatterOpts;
  if (!opts?.spacing) throw new Error('scatter: { spacing } is required');
  return scatterPoints(pointsEnv(), field, opts);
}

/** Lift any point array into the Points vocabulary (relax/settle/cells/mesh). */
function pointsOf(
  raw: readonly ({ x: number; y: number } | [number, number])[],
  opts: { field?: FieldFn2; spacing?: L; resolution?: number } = {},
): import('./points.js').Points {
  return liftPoints(pointsEnv(), raw, opts);
}

const TOOLKIT_BASE = {
  circle, ellipse, rect, line, polygon, path, group, clip, mask, decimate, wobble, modify,
  dash, smooth, roughen, deform, noiseField, label,
  hatch, crosshatch, stipple, solid, ui,
  rnd, pick, chance, prob, noise, stream,
  map: mapRange, norm: normRange, invert: invertRange, ease,
  times, range,
  bounds, grid: gridCells, noisyLine: noisyLineValue, svg: svgValue,
  scatter, points: pointsOf, voronoi, triangulate,
  mm, w, h, s, long,
};

interface EmitCtx {
  pen: string | undefined;
  z: number | undefined;
  decimate: DecimateArg | undefined;
  wobble: WobbleArg | undefined;
  bridge: L | undefined;
  /** Inherited modifier stack, deepest ancestors first. */
  modifiers: ModifierValue[];
}

/**
 * Compile a sketch definition into the recording state (from which the
 * renderer encodes the scene). `hostDefaults.marginPct` applies only when the
 * sketch config doesn't set a margin.
 */
export function compileSketch(
  def: SketchDef,
  hostDefaults: { marginPct?: number } = {},
): void {
  const cfg = def.config;
  legacySketch({
    aspect: cfg.aspect,
    seed: cfg.seed ?? 'url',
    origin: cfg.origin,
    yUp: cfg.yUp,
    rectMode: cfg.rectMode,
  });
  margin(cfg.margin ?? hostDefaults.marginPct ?? 0);
  const b = bounds();
  const toolkit: Toolkit = {
    ...TOOLKIT_BASE,
    width: b.w,
    height: b.h,
    cx: b.cx,
    cy: b.cy,
  };
  const tree = def.fn(toolkit);
  emit(tree, { pen: cfg.pen, z: undefined, decimate: undefined, wobble: undefined, bridge: undefined, modifiers: [] });
}

function emit(tree: Tree, ctx: EmitCtx): void {
  if (!tree) return;
  if (Array.isArray(tree)) {
    for (const child of tree) emit(child, ctx);
    return;
  }
  if ((tree as unknown as ModifierValue).__occludeModifier) {
    const m = tree as unknown as ModifierValue;
    throw new Error(
      `${m.kind}(…) with no children is a modifier value, not a drawable — ` +
        `wrap shapes (${m.kind}(…, ...shapes)) or pass it via { modifiers: [...] } / modify()`,
    );
  }
  if ((tree as GroupValue).__occludeGroup) {
    const g = tree as GroupValue;
    const inner: EmitCtx = {
      pen: g.opts.pen ?? ctx.pen,
      z: g.opts.z ?? ctx.z,
      decimate: g.opts.decimate ?? ctx.decimate,
      wobble: g.opts.wobble ?? ctx.wobble,
      bridge: g.opts.bridge ?? ctx.bridge,
      // Function-application order: deeper stacks run before shallower.
      modifiers: g.opts.modifiers ? [...g.opts.modifiers, ...ctx.modifiers] : ctx.modifiers,
    };
    const { translate, rotate, scale } = g.opts;
    if (translate || rotate !== undefined || scale !== undefined) {
      push({ translate, rotate, scale }, () => {
        for (const child of g.children) emit(child, inner);
      });
    } else {
      for (const child of g.children) emit(child, inner);
    }
    return;
  }
  if ((tree as ClipValue).__occludeClip) {
    const c = tree as ClipValue;
    const regionShape = new Shape(c.region.geom);
    legacyClip(regionShape, () => {
      for (const child of c.children) emit(child, ctx);
    });
    return;
  }
  emitShape(tree as ShapeValue, ctx);
}

function emitShape(sv: ShapeValue, ctx: EmitCtx): void {
  const o = sv.opts;
  if (o.translate || o.rotate !== undefined || o.scale !== undefined) {
    const { translate, rotate, scale } = o;
    push({ translate, rotate, scale }, () =>
      emitShape({ ...sv, opts: { ...o, translate: undefined, rotate: undefined, scale: undefined } }, ctx),
    );
    return;
  }
  const sh = new Shape(sv.geom);
  const basePen = o.pen ?? ctx.pen ?? getState().currentPen;
  const strokePen = o.stroke === false ? null : typeof o.stroke === 'string' ? o.stroke : basePen;
  if (strokePen === null) sh.noStroke();
  else sh.stroke(strokePen);
  if (o.fill) {
    sh.fill(o.fill, o.fillPen ?? basePen);
  } else if (o.opaque) {
    sh.fill(undefined, o.fillPen ?? basePen);
  }
  const z = o.z ?? ctx.z;
  if (z !== undefined) sh.z(z);
  // The shape's final program, function-application order: own stack, then
  // inherited modify() stacks inside-out, then the legacy kind-keyed
  // shorthand (decimate before wobble — the old fixed pipeline order; the
  // nearest declaration overrides, exactly as before).
  const program: ModifierValue[] = [...(o.modifiers ?? []), ...ctx.modifiers];
  const dec = o.decimate ?? ctx.decimate;
  if (dec !== undefined) program.push(decimateValue(dec));
  const wob = o.wobble ?? ctx.wobble;
  if (wob !== undefined) program.push(wobbleValue(wob));
  sh.modifiers = program;
  const bridge = o.bridge ?? ctx.bridge;
  if (bridge !== undefined) sh.bridge = bridge;
}
