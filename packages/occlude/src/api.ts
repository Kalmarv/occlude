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
import { grid as gridCells, type GridCell, type GridOptions } from './layout.js';
import { Shape, type PathCmd, type ShapeGeom } from './shapes.js';
import {
  bounds, chance, clip as legacyClip, margin, noise, pick, prob, push, rnd,
  sketch as legacySketch, stream, getState,
  type SketchOptions, type Winding,
} from './state.js';
import { invertRange, mapRange, normRange } from './random.js';
import { h, long, mm, s, w, Len, type L } from './units.js';

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
  /** Per-shape transform — identical to wrapping the shape in a group. */
  translate?: [L, L];
  /** Degrees; pivots around the user origin. */
  rotate?: number;
  scale?: number | [number, number];
}

export interface ShapeValue {
  readonly __occludeShape: true;
  readonly geom: ShapeGeom;
  readonly opts: ShapeOpts;
}

export interface GroupOpts {
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

// ---- combinators ----

export function group(opts: GroupOpts, ...children: Tree[]): GroupValue {
  return { __occludeGroup: true, opts, children };
}

export function clip(region: ShapeValue, ...children: Tree[]): ClipValue {
  return { __occludeClip: true, region, children };
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
  hatch: typeof hatch;
  crosshatch: typeof crosshatch;
  stipple: typeof stipple;
  rnd: typeof rnd;
  pick: typeof pick;
  chance: typeof chance;
  prob: typeof prob;
  noise: typeof noise;
  stream: typeof stream;
  map: typeof mapRange;
  norm: typeof normRange;
  invert: typeof invertRange;
  bounds: typeof bounds;
  /** Drawable extent in bare units — the same numbers `bounds()` returns. */
  width: number;
  height: number;
  cx: number;
  cy: number;
  grid: (opts: GridOptions) => GridCell[];
  noisyLine: typeof noisyLineValue;
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

const TOOLKIT_BASE = {
  circle, ellipse, rect, line, polygon, path, group, clip, mask,
  hatch, crosshatch, stipple,
  rnd, pick, chance, prob, noise, stream,
  map: mapRange, norm: normRange, invert: invertRange,
  bounds, grid: gridCells, noisyLine: noisyLineValue,
  mm, w, h, s, long,
};

interface EmitCtx {
  pen: string | undefined;
  z: number | undefined;
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
  emit(tree, { pen: cfg.pen, z: undefined });
}

function emit(tree: Tree, ctx: EmitCtx): void {
  if (!tree) return;
  if (Array.isArray(tree)) {
    for (const child of tree) emit(child, ctx);
    return;
  }
  if ((tree as GroupValue).__occludeGroup) {
    const g = tree as GroupValue;
    const inner: EmitCtx = {
      pen: g.opts.pen ?? ctx.pen,
      z: g.opts.z ?? ctx.z,
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
}
