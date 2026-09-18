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

import {Mesh,type EdgeAttributes} from './three/api/mesh.js';
import type {Attributes3} from './three/geometry/surface.js';
import {sampleSurfacePoints,scatterSurfacePoints,type SurfaceSamples,type SurfaceSamplingOptions,type SurfaceScatterOptions} from './three/api/sampling.js';
import {SurfaceCurves} from './three/api/supported.js';
import {sampleSurfaceCurves,type CurveSamples,type CurveSamplingOptions} from './three/api/curveSampling.js';
import {ProjectedCurves,projectedStrokes,isProjectedStrokes,emitProjectedStrokes,type ProjectedStrokes,type ProjectedStrokeOptions} from './three/api/projected.js';
import type { LineArtScene3, SceneCompute3 } from './three/scene.js';
import { isDrawing3, retainDrawing3, cameraDrawing3, type Drawing3 } from './three/drawing.js';
import type { Camera3 } from './three/camera.js';
import { bindModeling3 } from './three/modeling.js';
import { resolveTree3, classifyForRun3, strokesForRun3 } from './three/resolve.js';
import { checkDrawRequest, type DrawRequest, type PlanOptions } from './plan.js';
import { lowerToUserContours } from './record.js';
import { fill, rulings, type CustomFillFn, type FillSpec } from './fills.js';
import { ease } from './ease.js';
import { finiteCount } from './guard.js';
import { svg as svgValue } from './svgin.js';
import { label } from './font.js';
import { grid as gridCells, type GridCell, type GridOptions } from './layout.js';
import { type FieldAlign, Shape, geomClosed, type FieldFn, type LengthFn, type ModifierValue, type PathCmd, type ShapeGeom, type VectorFieldFn } from './shapes.js';
import { Execution, type ExecutionInputs, type PaperSpec, type SketchOptions, type Winding } from './execution.js';
import type { PenDef } from './pens.js';
import { invertRange, mapRange, normRange } from './random.js';
import {
  scatterPoints, throwPoints, relaxMaterial, settleMaterial, withinRegion,
  type RelaxOpts, type SettleOpts, type Bounds as PointBounds, type FieldFn2, type ScatterOpts, type ThrowOpts,
} from './points.js';
import { isolinesOf, type IsoContour, type IsoOpts } from './isolines.js';
import { ridgesOf, type RidgeOpts } from './ridges.js';
import { streamlinesOf, type StreamOpts } from './streamlines.js';
import { unitMm } from './record.js';
import { boundaryLoops, numericLoops, type Boundary, type LoopPoints } from './boundary.js';
import {
  Material, material as materialOf, alongChain, checkSampling, isStations, stationsMaterial,
  withinMaterial, type PointsLike, type Station, type Transfer,
} from './material.js';
import { PointSelection } from './relation.js';
import { Faces, FaceSelection, type Face } from './faces.js';
import { voronoi } from './voronoi.js';
import { quadtree, type QuadtreeOpts } from './quadtree.js';
import { distanceTo } from './distance.js';
import {
  rotate as rotateField, scale as scaleField, translate as translateField,
  vectorField as vectorFieldMark, within as withinField, type BoundEnv, type Prepared,
} from './field.js';
import { areaFill, interiorPoint } from './area.js';
import { ui } from './ui.js';
import { asset as assetOf, image as imageOf, type ImagePlacement } from './imageAsset.js';
import { h, long, mm, s, w, resolveLen, Len, type L } from './units.js';
import { synth as synthPure, type SynthOpts } from './synth.js';

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
  decimate?:
    | number
    | FieldFn
    | { stroke?: number | FieldFn; fill?: number | FieldFn; align?: FieldAlign };
  /** Hand-tremor: displace final strokes with seeded smooth noise, AFTER
   * occlusion (line quality only). A length (bare units or mm()), or
   * { amount, wavelength } to also set the noise wavelength (default
   * mm(25)). */
  wobble?: L | FieldFn | { amount: L | LengthFn; wavelength?: L; align?: FieldAlign };
  /** Endpoint-join tolerance (a length; mm() recommended): after occlusion,
   * strokes of shapes that OPT IN are joined pen-down across gaps up to
   * this size — hatch rows serpentine into single strokes, trading tiny
   * visible connectors for most of the plot's pen lifts. Opt-in per shape
   * or group; borders/text simply don't set it. Debug view highlights the
   * connectors. */
  bridge?: L;
  /** Preserve each authored contour and its visibility gaps through routing. */
  preserveStroke?: boolean;
  /** Internal stable source/style/pass key for source-linked modifiers. */
  strokeSeed?: number;
  /** Select intervals of a source polyline in segment-index + fraction units.
   * Post modifiers evaluate on the full polyline before trimming; gaps remain
   * protected through planning. Not compatible with pre-stage modifiers. */
  strokeRanges?: readonly (readonly [number, number])[];
  /** Per-shape transform — identical to wrapping the shape in a group. */
  translate?: readonly [L, L];
  /** Degrees; pivots around `origin` (the user origin by default). */
  rotate?: number;
  scale?: number | readonly [number, number];
  /** Pivot for `rotate` and `scale`: `[x, y]` in user coordinates, or
   * `'center'` for the centre of the drawable. Scaling about the middle of
   * the sheet is `{ scale: s, origin: 'center' }`. */
  origin?: readonly [L, L] | 'center';
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
  wobble?: L | FieldFn | { amount: L | LengthFn; wavelength?: L };
  /** Bridge default for children that don't set their own (opt-in join). */
  bridge?: L;
  /** Modifier stack for the subtree; nesting concatenates in
   * function-application order — inner stacks run before outer ones. */
  modifiers?: ModifierValue[];
  translate?: readonly [L, L];
  /** Degrees; pivots around `origin`. */
  rotate?: number;
  scale?: number | readonly [number, number];
  /** Pivot for `rotate` and `scale`: `[x, y]` in user coordinates, or
   * `'center'` for the centre of the drawable. */
  origin?: readonly [L, L] | 'center';
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
  /** Complement: children keep the OUTSIDE of the region. */
  readonly invert: boolean;
  readonly children: Tree[];
}

/** Region complement marker made by `invert()` — legal only where a region
 * is consumed (clip's first argument). */
export interface InvertValue {
  readonly __occludeInvert: true;
  readonly shape: ShapeValue;
}

/** Falsy entries are skipped, so conditional composition reads naturally. */
export type Tree =
  | ShapeValue
  | LineArtScene3
  | Drawing3
  | ProjectedStrokes
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

/** A shape value, as opposed to any other area input. */
const isShapeValue = (v: unknown): v is ShapeValue =>
  typeof v === 'object' && v !== null && '__occludeShape' in v;

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

/** A closed boundary as plain points. Open input gets its closing chord. */
export type Contour = [L, L][];

/**
 * One stroke per contour, all with the same options — for a material's
 * chains, a selection's, `segmentRuns` output or any contour records:
 * `strokes(m, { pen })`, `strokes(sel, …)`, `strokes(segmentRuns(m, key), …)`.
 * A decision per contour (a pen by run key, a width by chain) stays a
 * `.map`: nothing here assigns pens from keys.
 */
export function strokes(source:ProjectedCurves,opts?:ProjectedStrokeOptions):ProjectedStrokes;
export function strokes(source:readonly IsoContour[]|{curves():IsoContour[]},opts?:ShapeOpts):ShapeValue[];
export function strokes(
  source: readonly IsoContour[] | { curves(): IsoContour[] } | ProjectedCurves,
  opts?: ShapeOpts | ProjectedStrokeOptions,
): ShapeValue[] | ProjectedStrokes {
  if(source instanceof ProjectedCurves)return projectedStrokes(source,opts);
  const contours = Array.isArray(source) ? (source as readonly IsoContour[]) : (source as { curves(): IsoContour[] }).curves();
  return contours.map((c) => stroke(c, opts));
}

export interface PolygonOpts extends ShapeOpts {
  /** Fill rule where boundaries nest or cross. `'evenodd'` (default): every
   * enclosed boundary is a hole, whatever its orientation — a ring is an
   * annulus, a pentagram has an empty pentagon. `'nonzero'`: the pentagram
   * is solid; orientation decides holes. */
  winding?: Winding;
}

/** Loops for any area input, in the coordinates given: a shape is lowered
 * through the one lowerer, so it agrees with what the shape itself inks; a
 * face, loops, a chain material or a selection come from the boundary
 * contract. */
function areaLoops(run: Execution | null, input: Boundary | ShapeValue, who: string): LoopPoints[] {
  if (isShapeValue(input)) {
    if (!run) throw new Error(`${who}: a shape area is lowered by the toolkit — use t.${who}`);
    return shapeContours(run, input, undefined).map((c) => c.pts);
  }
  return boundaryLoops(input, who);
}

/** `areaLoops` for a consumer that computes with the coordinates: a length
 * such as `mm(10)` is a drawing unit the sketch must resolve first. */
function numericAreaLoops(run: Execution | null, input: Boundary | ShapeValue, who: string): [number, number][][] {
  return numericLoops(areaLoops(run, input, who), who);
}

/**
 * An area from its boundaries — the engine's Region concept as a value.
 * One loop or several (`[x, y][]`), contour records, a face (its contours
 * are the outer boundary and the holes), a chain material
 * (`t.material(rect(…))`, `t.isolines(…)`), or a shape, whose boundary is
 * taken and whose own drawing options are not: the result clips, fills,
 * masks, and stamps as one thing. No geometry is computed; open contours
 * get their closing chord; a branching material is refused. `winding`
 * picks the fill rule; `'evenodd'` (the default) makes every enclosed
 * boundary a hole whatever its orientation, so this reads a ring as an
 * annulus and a pentagram as an empty pentagon. `path({ winding })` is the
 * other spelling: there the geometry's own orientation decides, as in SVG.
 */
export function polygon(contours: Boundary | Contour | Contour[] | ShapeValue, opts: PolygonOpts = {}): ShapeValue {
  const { winding: given, ...rest } = opts;
  // The source is the authority for the fill rule, and a path carries one:
  // `polygon(somePath)` keeps it, and `opts.winding` overrides it. Loops and
  // faces have no rule of their own, so they read even-odd as before.
  const fromSource = isShapeValue(contours) && (contours.geom.kind === 'path' || contours.geom.kind === 'area') ? contours.geom.winding : undefined;
  const winding = given ?? fromSource ?? 'evenodd';
  // A shape is an area input; its outline is lowered when the drawing is
  // recorded, against the run's frame — pure here, no run in hand.
  if (isShapeValue(contours)) {
    const o = contours.opts;
    return shape({ kind: 'area', of: { geom: contours.geom, opts: { translate: o.translate, rotate: o.rotate, scale: o.scale, origin: o.origin } }, winding }, rest);
  }
  const loops = areaLoops(null, contours, 'polygon');
  const cmds: PathCmd[] = [];
  for (const loop of loops) {
    if (loop.length < 2) continue;
    cmds.push({ op: 'move', x: loop[0][0], y: loop[0][1] });
    for (let k = 1; k < loop.length; k++) {
      cmds.push({ op: 'line', x: loop[k][0], y: loop[k][1] });
    }
    cmds.push({ op: 'close' });
  }
  return shape({ kind: 'path', cmds, winding }, rest);
}

/**
 * The region word, one spelling. `within(field, shape)` bounds a field's
 * domain (the field is ABSENT outside — see field.ts). Everything else keeps
 * only what lies INSIDE the area:
 *
 * - a material: its edges cut where they cross the boundary, the outside
 *   dropped, so a chord built long enough to be sure of crossing a frame
 *   ends ON the frame (columns keep their declared transfer policy);
 * - a point selection: the points inside, as a selection of the same source,
 *   so it still chains and still works as `{ where }` in a step rule;
 * - a face collection: the faces lying entirely inside — nothing is clipped,
 *   a straddling face is simply not kept.
 *
 * `area` is anything an area consumer takes: a shape (lowered here, through
 * the one lowerer), a face, loops, a chain material or a selection. A face
 * collection takes `{ faces: 'contained' | 'centroid' }` (see WithinFaces).
 */
/** How `within` decides that a face belongs to an area. `'contained'` (the
 * default) keeps a face with no contour point strictly outside the area, no
 * edge crossing its boundary, and none of the area's own loops (a hole, an
 * island) lying strictly inside it — so a cell whose wall runs ALONG the
 * boundary belongs to it. `'centroid'` keeps a face whose geometric centre is
 * inside the area, so a cell the boundary cuts through is kept whole, and its
 * ink may reach past the edge by up to that cell. */
export interface WithinFaces {
  faces?: 'contained' | 'centroid';
}

export interface Within {
  <F extends FieldFn | VectorFieldFn | LengthFn>(field: F, area: ShapeValue): Prepared<F>;
  (material: Material, area: Boundary | ShapeValue, opts?: { transfer?: Record<string, Transfer> }): Material;
  (points: PointSelection, area: Boundary | ShapeValue): PointSelection;
  (faces: Faces | FaceSelection, area: Boundary | ShapeValue, opts?: WithinFaces): FaceSelection;
}

export function withinAny<F extends FieldFn | VectorFieldFn | LengthFn>(run: Execution, field: F, area: ShapeValue): Prepared<F>;
export function withinAny(run: Execution, material: Material, area: Boundary | ShapeValue, opts?: { transfer?: Record<string, Transfer> }): Material;
export function withinAny(run: Execution, points: PointSelection, area: Boundary | ShapeValue): PointSelection;
export function withinAny(run: Execution, faces: Faces | FaceSelection, area: Boundary | ShapeValue, opts?: WithinFaces): FaceSelection;

export function withinAny(
  run: Execution,
  x: FieldFn | VectorFieldFn | LengthFn | Material | PointSelection | Faces | FaceSelection,
  area: Boundary | ShapeValue,
  opts: { transfer?: Record<string, Transfer>; faces?: 'contained' | 'centroid' } = {},
): FieldFn | VectorFieldFn | LengthFn | Material | PointSelection | FaceSelection {
  if (typeof x === 'function') return withinField(x, area as ShapeValue, boundEnv(run));
  if (opts.faces !== undefined && opts.faces !== 'contained' && opts.faces !== 'centroid') {
    throw new Error(`within: faces must be 'contained' or 'centroid', got '${String(opts.faces)}'`);
  }
  const loops = numericAreaLoops(run, area, 'within');
  // The FILLED REGION, not the contours: under a nonzero rule an interior
  // contour has fill on both sides and is not a boundary at all, so points on
  // it are inside, material along it is not cut, and a face may cross or
  // enclose it. A shape area brings its own rule; loops and faces carry none
  // and read even-odd, exactly as `distanceTo` documents.
  const shapeArea = isShapeValue(area) ? area : null;
  const rule = shapeArea && (shapeArea.geom.kind === 'path' || shapeArea.geom.kind === 'area') ? shapeArea.geom.winding : 'evenodd';
  const fill = areaFill(loops, rule);
  const inside = fill.at;
  if (x instanceof Material) {
    if (opts.faces !== undefined) throw new Error("within: 'faces' is for a face collection — a material is cut at the boundary");
    return withinMaterial(x, loops, { ...opts, inside, crossings: fill.crossings });
  }
  if (x instanceof PointSelection) return x.filter((p) => inside(p.x, p.y) > 0);
  const faces: Faces | FaceSelection = x;
  if (opts.transfer !== undefined) throw new Error("within: 'transfer' is for a material — a face is kept whole or not at all");
  if (opts.faces === 'centroid') {
    // Geometric centres: no field is measured, so no raster is built.
    const measured = faces.measure();
    return faces.filter((f) => {
      const [cx, cy] = measured.forFace(f).centroid;
      return inside(cx, cy) > 0;
    });
  }
  // A face is kept whole or not kept at all: nothing of it is clipped. It
  // belongs to the area when no edge crosses the boundary and no point of it
  // is strictly outside — so a cell whose wall RUNS ALONG the boundary is in
  // (the artist means the cells that belong to the frame, and the frame's own
  // cells share its edges), while a face merely touching it from outside is
  // not.
  const keep = (f: Face): boolean => {
    if (f.contours.length === 0) return false;
    for (const c of f.contours) {
      for (let k = 0; k < c.pts.length; k++) {
        const p = c.pts[k];
        if (!(inside(p[0], p[1]) >= 0)) return false;
        const q = c.pts[(k + 1) % c.pts.length];
        // Only a REAL boundary stops a face: an interior contour may be crossed
        // freely, since the fill is on both of its sides.
        if (fill.crossings(p[0], p[1], q[0], q[1]).length > 0) return false;
      }
    }
    // A face must also have somewhere of its own inside the fill: a wall it
    // shares with the boundary says nothing by itself, and the same walls bound
    // the annulus and the hole it encloses.
    const probe = interiorPoint(f.contours.map((c) => c.pts));
    if (probe && !(inside(probe[0], probe[1]) > 0)) return false;
    // Every vertex inside and no edge crossing still leaves the reverse case: a
    // real boundary — a hole, or an island — lying strictly inside the face,
    // whose excluded space the face would cover. Each real segment is tested at
    // its ends and its middle; the face's own contours say what is inside IT,
    // so a wall the face shares with the boundary is ON it, not in it, and
    // passes.
    const faceInside = distanceTo(f.contours);
    for (const s of fill.boundary) {
      const [ax, ay, bx, by] = s;
      if (faceInside(ax, ay) > 0 || faceInside(bx, by) > 0 || faceInside((ax + bx) / 2, (ay + by) / 2) > 0) return false;
    }
    return true;
  };
  return x instanceof Faces ? x.filter(keep) : x.filter(keep);
}

/** Regular n-gon: `sides` vertices on a circle of radius `r`, the first at
 * `rotation` degrees. */
export function ngon(
  x: L, y: L, sides: number, r: L, rotation?: number | ShapeOpts, opts?: ShapeOpts,
): ShapeValue {
  if (isOpts(rotation)) {
    return shape({ kind: 'ngon', x, y, sides, r, rotation: 0 }, rotation);
  }
  return shape({ kind: 'ngon', x, y, sides, r, rotation: rotation ?? 0 }, opts);
}

/**
 * Draw along a contour with the pen — `polygon`'s open-minded sibling. A
 * bare `[x, y][]` strokes an OPEN polyline (polygon always closes); an
 * `IsoContour` honors its `closed` flag, so isolines/rings stamp with the
 * right seams and the right open ends in one call; `strokes(material)`
 * does it for every chain of a material.
 */
export function stroke(
  contour: IsoContour | [L, L][],
  opts?: ShapeOpts,
): ShapeValue {
  const pts = Array.isArray(contour) ? contour : contour.pts;
  const closed = Array.isArray(contour) ? false : contour.closed;
  const cmds: PathCmd[] = [];
  if (pts.length > 0) {
    cmds.push({ op: 'move', x: pts[0][0], y: pts[0][1] });
    for (let i = 1; i < pts.length; i++) {
      cmds.push({ op: 'line', x: pts[i][0], y: pts[i][1] });
    }
    if (closed) cmds.push({ op: 'close' });
  }
  return shape({ kind: 'path', cmds, winding: 'nonzero' }, opts);
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

export function clip(region: ShapeValue | InvertValue, ...children: Tree[]): ClipValue {
  const inv = (region as InvertValue).__occludeInvert === true;
  return {
    __occludeClip: true,
    region: inv ? (region as InvertValue).shape : (region as ShapeValue),
    invert: inv,
    children,
  };
}

/**
 * Complement a region: `clip(invert(shape), ...children)` keeps the
 * children's ink OUTSIDE the shape instead of inside. A region annotation,
 * not a drawable — returning it in the tree fails loudly.
 */
export function invert(shape: ShapeValue): InvertValue {
  return { __occludeInvert: true, shape };
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

type DecimateArg =
  | number
  | FieldFn
  | { stroke?: number | FieldFn; fill?: number | FieldFn; align?: FieldAlign };
type WobbleArg = L | FieldFn | { amount: L | LengthFn; wavelength?: L; align?: FieldAlign };

function decimateValue(p: DecimateArg): ModifierValue {
  const [stroke, fill, align] =
    typeof p === 'number' || typeof p === 'function'
      ? [p, p, undefined]
      : [p.stroke ?? 0, p.fill ?? 0, p.align];
  const c = (v: number | FieldFn): number | FieldFn => (typeof v === 'number' ? clamp01(v) : v);
  return { __occludeModifier: true, kind: 'decimate', stroke: c(stroke), fill: c(fill), align };
}

function wobbleValue(a: WobbleArg): ModifierValue {
  if (typeof a === 'object' && !(a instanceof Len) && 'amount' in a) {
    return {
      __occludeModifier: true, kind: 'wobble',
      amount: a.amount, wavelength: a.wavelength, align: a.align,
    };
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
type RoughenArg = L | FieldFn | { amount: L | FieldFn; detail?: L; align?: FieldAlign };

export function roughen(amount: RoughenArg, detail?: L): ModifierValue;
export function roughen(
  amount: RoughenArg,
  detail: L | undefined,
  ...children: [Tree, ...Tree[]]
): GroupValue;
export function roughen(
  amount: RoughenArg,
  detail?: L,
  ...children: Tree[]
): GroupValue | ModifierValue {
  const cfg =
    typeof amount === 'object' && !(amount instanceof Len) && 'amount' in amount
      ? amount
      : { amount, detail };
  const value: ModifierValue = {
    __occludeModifier: true, kind: 'roughen',
    amount: cfg.amount, detail: cfg.detail ?? detail, align: cfg.align,
  };
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
  field: VectorFieldFn | { field: VectorFieldFn; detail?: L; align?: FieldAlign },
): ModifierValue;
export function deform(
  field: VectorFieldFn | { field: VectorFieldFn; detail?: L; align?: FieldAlign },
  ...children: [Tree, ...Tree[]]
): GroupValue;
export function deform(
  field: VectorFieldFn | { field: VectorFieldFn; detail?: L; align?: FieldAlign },
  ...children: Tree[]
): GroupValue | ModifierValue {
  const cfg = typeof field === 'function' ? { field } : field;
  const value: ModifierValue = {
    __occludeModifier: true, kind: 'deform',
    field: cfg.field, detail: cfg.detail, align: cfg.align,
  };
  if (children.length === 0) return value;
  return { __occludeGroup: true, opts: { modifiers: [value] }, children };
}

/**
 * A ready-made tremor vector field for `deform`: seeded simplex noise,
 * `amount` and `wavelength` in user units.
 */
function noiseFieldOf(noise: (x: number, y?: number, z?: number) => number, amount: number, wavelength = 25): VectorFieldFn {
  return vectorFieldMark((x, y) => [
    amount * noise(x / wavelength, y / wavelength),
    amount * noise(x / wavelength + 213.7, y / wavelength - 118.3),
  ]);
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
  noise: (x: number, y?: number, z?: number) => number,
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
  /** Inset from the paper edge: a percent of the short paper side, or a
   * physical length (`mm(10)`, `inch(0.5)`). A composition setting. */
  margin?: L;
  /** The sheet, declared here — `paper({ width, height, color })` or a
   * library model — and then the same everywhere the sketch runs. Without
   * it the host's paper applies. */
  paper?: PaperSpec;
  /** The sketch's pens by name: `{ blue: fineliner({ color: '#2457D6' }),
   * fine: pen({ width: mm(0.3) }), lib: 'stabilo-88-blue' }` — a
   * definition, a library model's instance, or a library pen's name. The
   * FIRST entry is the default pen for shapes that name none; without
   * `pens` the library's first pen is. Names resolve here first, then in
   * the captured library, so `stroke: 'blue'` and `stroke: 'micron-03'`
   * both work. */
  pens?: Readonly<Record<string, (Omit<PenDef, 'name'> & { name?: string }) | string>>;
}

/** The toolkit a sketch receives: bound to its execution (`bindToolkit`).
 * One surface, defined once, by the binder. */
export type Toolkit = ReturnType<typeof bindToolkit>;

export interface SketchDef {
  readonly __occludeSketch: true;
  readonly config: SketchConfig;
  /** A synchronous tree, or a promise of one when the function is `async`. */
  readonly fn: (toolkit: Toolkit) => Tree | Promise<Tree>;
}

/** An explicitly asynchronous sketch; ordinary sketches retain their synchronous contract. */
export interface AsyncSketchDef {
  readonly __occludeAsyncSketch: true;
  readonly config: SketchConfig;
  readonly fn: (toolkit: Toolkit) => Tree | Promise<Tree>;
}

/** `sketchAsync` definitions, and `sketch` definitions whose function is
 * `async`: anything on the toolkit may be awaited inside either. */
export function isSketchAsync(v: unknown): v is AsyncSketchDef {
  if (typeof v !== 'object' || v === null) return false;
  if ((v as AsyncSketchDef).__occludeAsyncSketch === true) return true;
  const fn = (v as SketchDef).__occludeSketch === true ? (v as SketchDef).fn : undefined;
  return typeof fn === 'function' && fn.constructor?.name === 'AsyncFunction';
}

export function sketchAsync(config: SketchConfig, fn: AsyncSketchDef['fn']): AsyncSketchDef {
  if (typeof fn !== 'function') throw new Error('sketchAsync(config, fn): expected a sketch function');
  return { __occludeAsyncSketch: true, config, fn };
}

export function isSketch(v: unknown): v is SketchDef {
  return typeof v === 'object' && v !== null && (v as SketchDef).__occludeSketch === true;
}

/**
 * Define a sketch (declarative form), or reset the legacy recording state
 * when called with only a config (old-style sketches keep working).
 */
export function sketch(config: SketchConfig, fn: (toolkit: Toolkit) => Tree | Promise<Tree>): SketchDef {
  if (typeof fn !== 'function') throw new Error('sketch(config, fn): the second argument is the sketch function (toolkit) => tree');
  return { __occludeSketch: true, config, fn };
}

/** A shape's outlines in sketch units through THE lowerer (rectMode, arc
 * commands, the shape's own transform opts, curves flattened at
 * `tolerance`), each with its own closure. Shared by `material` and
 * `sample`. */
function shapeContours(run: Execution, shape: ShapeValue, tolerance: L | undefined): { pts: [number, number][]; closed: boolean }[] {
  if (!shape || typeof shape !== 'object' || !('geom' in shape) || !('opts' in shape)) {
    throw new Error('expected a shape value (circle, rect, path, polygon, …); for points use the pure material(points)');
  }
  const frame = run.frame;
  const unit = unitMm(frame);
  const tol = tolerance !== undefined ? resolveLen(tolerance, frame.inner) : 0.05;
  const o = shape.opts;
  return lowerToUserContours(
    shape.geom,
    { translate: o.translate, rotate: o.rotate, scale: o.scale, origin: o.origin },
    frame,
    tol,
  ).map((c) => ({ closed: c.closed, pts: c.pts.map(([x, y]) => [x / unit, y / unit] as [number, number]) }));
}

/** The host's automatic form of `inspect`, bound to a run: called for
 * every variable the studio instruments, so it registers materials — and
 * the stations of `along()`, as a material of their own — and ignores
 * everything else without a word. */
export function inspectHook(run: Execution): (label: string, value: unknown) => void {
  return (label, value) => {
    if (value instanceof Material) run.recordInspection(label, value);
    else if (isStations(value)) run.recordInspection(label, stationsMaterial(value));
  };
}

// ---- the toolkit, bound to one execution ----

/** What a field bound (`t.within`) lowers against: the run's frame and its
 * per-shape memo. */
function boundEnv(run: Execution): BoundEnv {
  return { frame: run.frame, cache: run.boundCache };
}

/**
 * The toolkit a sketch function receives: every member that reads the run
 * — its seed, paper, frame, captured assets and fills, the recording —
 * closes over THIS execution. The pure module factories (shapes, fills,
 * modifiers, units, map/ease) are the same functions the package exports.
 */
/** A point for `t.noise`: `{ x, y, z? }` rows or `[x, y, z?]` triples. */
export type NoisePoint = readonly number[] | { readonly x: number; readonly y: number; readonly z?: number };
export interface NoiseOptions {
  /** Distance over which the noise varies once (default 1): inputs divide by it. */
  readonly wavelength?: number;
  /** Output scale (default 1). */
  readonly amount?: number;
}

export function bindToolkit(exec: Execution, scope?: { signal?: AbortSignal; compute3?: SceneCompute3; isOpen?: () => boolean; onProgress?: import('./three/modeling.js').ProgressListener3 }) {
  /** Environment handed to the points module: seeded stream, drawable
   * bounds, and sketch-time length resolution (mm via the paper). */
  function pointsEnv(stream = '__points'): import('./points.js').PointsEnv {
    const b = exec.bounds();
    const st = exec.stream(stream);
    return {
      rnd: () => st.rnd(),
      bounds: { x: 0, y: 0, w: b.w, h: b.h },
      len: (l) => exec.len(l),
    };
  }

  /** Field-modulated Poisson-disk points as point-only material with a
   * `density` column (the field at each point). `t.relax` and `t.settle`
   * refine it; `t.voronoi` reads its cells. */
  function scatter<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3>(mesh:Mesh<P,E,F,C>,options:SurfaceScatterOptions<F>):SurfaceSamples<Omit<F,keyof P>&P,F,C,P>;
  function scatter(field: FieldFn2 | undefined, opts: ScatterOpts): Material;
  function scatter(opts: ScatterOpts): Material;
  function scatter(
    a: FieldFn2 | ScatterOpts | Mesh<any,any,any> | undefined,
    b?: ScatterOpts | SurfaceScatterOptions<any>,
  ): Material | SurfaceSamples<any,any,any,any> {
    if(a instanceof Mesh){const options=b as SurfaceScatterOptions<any>;return scatterSurfacePoints(a,options,{rnd:exec.stream('__surface-scatter:'+ (options?.key??a.key??'default')).rnd,signal:scope?.signal});}
    const field = typeof a === 'function' ? a : undefined;
    const raw = (typeof a === 'function' || a === undefined ? b : a) as ScatterOpts;
    if (!raw?.spacing) throw new Error('scatter: { spacing } is required');
    const opts: ScatterOpts = raw.within === undefined ? raw : { ...raw, within: numericAreaLoops(exec, raw.within, 'scatter') };
    return scatterPoints(pointsEnv(), field, opts);
  }

  /** Independent uniform random points, `count` of them: `t.throw({ count })`
   * over the drawable, `t.throw(area, { count })` inside an area, and
   * `t.throw(field, { count, within? })` kept with the chance the field
   * gives at the point. The random counterpart of `scatter`. */
  function throwTk(field: FieldFn2 | undefined, opts: ThrowOpts): Material;
  function throwTk(area: Boundary | ShapeValue, opts: Omit<ThrowOpts, 'within'>): Material;
  function throwTk(opts: ThrowOpts): Material;
  function throwTk(a: FieldFn2 | Boundary | ShapeValue | ThrowOpts | undefined, b?: ThrowOpts | Omit<ThrowOpts, 'within'>): Material {
    const field = typeof a === 'function' ? a : undefined;
    const area = b !== undefined && typeof a !== 'function' && a !== undefined ? (a as Boundary | ShapeValue) : undefined;
    const raw = (b ?? a) as ThrowOpts;
    if (!raw || typeof raw !== 'object' || raw.count === undefined) throw new Error('throw: { count } is required');
    const within = area ?? raw.within;
    const opts: ThrowOpts = within === undefined ? raw : { ...raw, within: numericAreaLoops(exec, within, 'throw') };
    return throwPoints(pointsEnv('__throw'), field, opts);
  }

  /** Lloyd relaxation: each point to the density-weighted centroid of its
   * cell, `iterations` times; count, edges and columns kept. */
  function relax(m: Material, opts: RelaxOpts = {}): Material {
    const o: RelaxOpts = opts.within === undefined ? opts : { ...opts, within: numericAreaLoops(exec, opts.within, 'relax') };
    return relaxMaterial(pointsEnv(), materialOf(m as never), o);
  }

  /** Weighted Linde-Buzo-Gray settling toward `density` at `spacing`:
   * relaxation plus population control on point-only material; survivors
   * keep their columns, children copy their parent's, `demand` is written.
   * Split directions come from the sketch's seeded stream. */
  function settle(m: Material, opts: SettleOpts): Material {
    const o: SettleOpts = opts.within === undefined ? opts : { ...opts, within: numericAreaLoops(exec, opts.within, 'settle') };
    return settleMaterial(pointsEnv(), materialOf(m as never), o);
  }

  /** Voronoi cells of `sites` as material (see voronoi.ts), clipped to the
   * drawable unless a bounds box or a `within` area is given. A cell is
   * clipped to a BOX, so `within` takes a rectangle; for any other area, trim
   * the cells instead: `within(t.voronoi(sites), area)`. `cells.cellOf(site)`
   * and `cells.siteOf(face)` relate the result to its sites; a material or a
   * point selection of one stays the sites, bare points become one. */
  /** The subdivision of the drawable that puts detail where the points are:
   * a cell holding more than `capacity` points splits into four, down to
   * `depth` splits. Returns the lattice as material — planarize it and its
   * faces are the cells. */
  function quadtreeTk(points: PointsLike, opts: QuadtreeOpts = {}): Material {
    const b = exec.bounds();
    return quadtree(points, opts.bounds ?? { x: 0, y: 0, w: b.w, h: b.h }, opts);
  }

  function voronoiTk(sites: PointsLike, opts: { bounds?: PointBounds; within?: Boundary | ShapeValue } = {}): Material {
    const b = exec.bounds();
    if (opts.within === undefined) return voronoi(sites, opts.bounds ?? { x: 0, y: 0, w: b.w, h: b.h });
    const region = withinRegion(numericAreaLoops(exec, opts.within, 'voronoi'), 'voronoi', opts.bounds);
    if (region.loops) {
      throw new Error('voronoi: within needs a rectangle — a cell is clipped to a box; for any other area, clip the cells afterwards: within(t.voronoi(sites), area)');
    }
    return voronoi(sites, region.bounds);
  }

  /**
   * Contours as one material: each contour a chain (a ring when closed), in
   * the order they came, never joined to each other. Every edge of an
   * isoline carries its requested `level` as a categorical edge column
   * (subdivision copies it).
   */
  function contourMaterial(groups: readonly { contours: readonly IsoContour[]; level?: number }[], withLevel: boolean): Material {
    let n = 0;
    let e = 0;
    for (const g of groups) for (const c of g.contours) {
      n += c.pts.length;
      e += c.closed && c.pts.length > 2 ? c.pts.length : Math.max(0, c.pts.length - 1);
    }
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    const edges = new Uint32Array(2 * e);
    const level = withLevel ? new Float64Array(e) : null;
    let vi = 0;
    let ei = 0;
    for (const g of groups) for (const c of g.contours) {
      const first = vi;
      const m = c.pts.length;
      for (let k = 0; k < m; k++) {
        x[vi] = c.pts[k][0];
        y[vi] = c.pts[k][1];
        vi++;
      }
      const segs = c.closed && m > 2 ? m : Math.max(0, m - 1);
      for (let k = 0; k < segs; k++) {
        edges[2 * ei] = first + k;
        edges[2 * ei + 1] = first + ((k + 1) % m);
        if (level) level[ei] = g.level as number;
        ei++;
      }
    }
    return new Material(x, y, {}, edges, 0, [], level ? { level } : {}, {}, level ? { level: 'copy' } : {});
  }

  /** Contours of `{ field ≥ at }` via marching squares over the drawable, as
   * one material: each contour a chain (a ring when closed), separate
   * contours separate, every edge carrying its `level`. Draw with
   * `strokes(m)`, fill or clip with `polygon(m)`, pick levels with
   * `m.edges.filter((e) => e.attrs.level === 0.4)` or `m.edges.groupBy((e) =>
   * e.attrs.level)`, or step it like any material.
   * Open at the drawable edge by default; `{ close: true }` closes regions
   * along it. An `at` array marches every level over one shared field
   * sampling, in the order given. */
  function isolines(field: FieldFn2, at: number | number[], opts: IsoOpts = {}): Material {
    const b = exec.bounds();
    const env = { bounds: { x: 0, y: 0, w: b.w, h: b.h }, len: (l: L) => exec.len(l) };
    const levels = Array.isArray(at) ? at : [at];
    const perLevel = isolinesOf(env, field, levels, opts);
    return contourMaterial(levels.map((level, k) => ({ contours: perLevel[k], level })), true);
  }

  /** The crest lines of a scalar field over the drawable, as one material:
   * each ridge a chain (a ring when it closes, as a crater rim does),
   * separate ridges separate, every vertex carrying `strength` — how sharply
   * the ground falls away to either side — and `height`, the field's own
   * value there. `t.isolines` says where the field is a given height; this
   * says where it runs along a top. Valleys are the ridges of the negated
   * field, so there is no option for them. Nothing is thresholded: pick with
   * `m.points.filter((p) => p.strength > x).inducedEdges().extract()`.
   * Deterministic, no seed. */
  function ridges(field: FieldFn2, opts: RidgeOpts = {}): Material {
    const b = exec.bounds();
    const env = { bounds: { x: 0, y: 0, w: b.w, h: b.h }, len: (l: L) => exec.len(l) };
    const found = ridgesOf(env, field, opts);
    let n = 0;
    let e = 0;
    for (const c of found) {
      n += c.pts.length;
      e += c.closed && c.pts.length > 2 ? c.pts.length : Math.max(0, c.pts.length - 1);
    }
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    const strength = new Float64Array(n);
    const height = new Float64Array(n);
    const edges = new Uint32Array(2 * e);
    let vi = 0;
    let ei = 0;
    for (const c of found) {
      const first = vi;
      const m = c.pts.length;
      for (let k = 0; k < m; k++) {
        x[vi] = c.pts[k][0];
        y[vi] = c.pts[k][1];
        strength[vi] = c.strength[k];
        height[vi] = c.height[k];
        vi++;
      }
      const segs = c.closed && m > 2 ? m : Math.max(0, m - 1);
      for (let k = 0; k < segs; k++) {
        edges[2 * ei] = first + k;
        edges[2 * ei + 1] = first + ((k + 1) % m);
        ei++;
      }
    }
    return new Material(x, y, { strength, height }, edges, 0, [], {}, { strength: 'interpolate', height: 'interpolate' }, {});
  }

  /** Evenly spaced streamlines of a vector field over the drawable (Jobard &
   * Lefer) as one material of open chains — `strokes(m)` draws them, and
   * `.attribute()`/`.steps()` work on them like any material. `spacing` is a
   * length or a scalar field of lengths: density as tone, direction as flow.
   * Lines stop at the drawable edge, at a `within()` bound, and half a
   * spacing from ink already laid. Deterministic, no seed. */
  function streamlines(field: VectorFieldFn, opts: StreamOpts = {}): Material {
    const b = exec.bounds();
    const env = { bounds: { x: 0, y: 0, w: b.w, h: b.h }, len: (l: L) => exec.len(l) };
    return contourMaterial([{ contours: streamlinesOf(env, field, opts) }], false);
  }

  /**
   * A shape's boundary as material with the boundary's OWN vertices: a
   * rectangle's four corners, a regular polygon's vertices, a path's points,
   * with curved portions flattened at `tolerance` (default 0.05 mm). Each
   * outline is a chain (a ring when closed, without a duplicate seam vertex),
   * separate outlines stay separate, nothing is welded. `sample` is the other
   * conversion: it redistributes points along the boundary by arc length and
   * need not land on a corner. Coordinates are sketch units, before any
   * drawing transform around the shape.
   */
  /**
   * Shapes as material, keeping their own vertices: one or more shapes, each
   * outline a ring or chain of the one returned material, in the order
   * given, welding nothing — `t.material(...circles).planarize()` is the
   * pile whose `faces()` are the pieces the overlaps cut. The options are the
   * trailing plain object. Points go through the pure `material(points)`.
   */
  function materialFromShape(...shapes: ShapeValue[]): Material;
  function materialFromShape(...args: [...ShapeValue[], { tolerance?: L }]): Material;
  function materialFromShape(...args: (ShapeValue | { tolerance?: L })[]): Material {
    const last: unknown = args[args.length - 1];
    // Only a trailing plain object is options; anything else (an array of
    // points included) is judged as a shape, so the error names what it saw.
    const trailingOpts = last !== null && typeof last === 'object' && Object.getPrototypeOf(last) === Object.prototype && !('__occludeShape' in last);
    const opts: { tolerance?: L } = trailingOpts ? (last as { tolerance?: L }) : {};
    const shapes = (trailingOpts ? args.slice(0, -1) : args) as unknown[];
    if (shapes.length === 0) throw new Error('t.material: give at least one shape (circle, rect, path, polygon, …); for points use the pure material(points)');
    const pts: [number, number][] = [];
    const edges: [number, number][] = [];
    for (const shape of shapes) for (const c of shapeContours(exec, shape as ShapeValue, opts.tolerance)) {
      let poly = c.pts;
      // A closed outline comes back with its start repeated at the end: the
      // ring closes with an edge, not a coincident vertex.
      if (c.closed && poly.length > 1) {
        const a = poly[0];
        const z = poly[poly.length - 1];
        if (Math.abs(a[0] - z[0]) <= 1e-9 && Math.abs(a[1] - z[1]) <= 1e-9) poly = poly.slice(0, -1);
      }
      const first = pts.length;
      for (let k = 0; k < poly.length; k++) {
        pts.push(poly[k]);
        if (k > 0) edges.push([first + k - 1, first + k]);
      }
      if (c.closed && poly.length > 2) edges.push([first + poly.length - 1, first]);
    }
    return materialOf(pts, { edges });
  }

  /**
   * A shape as sampled material — the explicit, lossy step from exact
   * geometry to points you can move one by one. Each outline of the shape
   * becomes a chain of the returned material with `count` vertices, or as
   * many as fit at `spacing`, evenly spaced by arc length: a closed outline
   * is a ring (no duplicate seam), an open one a chain from end to end;
   * several outlines are separate chains in one material. Sampling does not
   * keep the shape's own vertices — `t.material(shape)` does. Positions and
   * connectivity only — attributes come from `.attribute()`.
   */
  function sample<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3>(mesh:Mesh<P,E,F,C>,options:SurfaceSamplingOptions<F>):SurfaceSamples<Omit<F,keyof P>&P,F,C,P>;
  function sample<A extends Attributes3>(curves:SurfaceCurves<A>,options?:CurveSamplingOptions):CurveSamples<A,A>;
  function sample(shape:ShapeValue,options:{count?:number;spacing?:L;tolerance?:L}):Material;
  function sample(
    shape: ShapeValue | Mesh<any,any,any> | SurfaceCurves<any>,
    options: { count?: number; spacing?: L; tolerance?: L } | SurfaceSamplingOptions<any> | CurveSamplingOptions = {},
  ): Material | SurfaceSamples<any,any,any,any> | CurveSamples<any,any> {
    if(shape instanceof SurfaceCurves)return sampleSurfaceCurves(shape,options as CurveSamplingOptions);
    if(shape instanceof Mesh){const opts=options as SurfaceSamplingOptions<any>;return sampleSurfacePoints(shape,opts,{rnd:exec.stream('__surface-sample:'+(opts?.key??shape.key??'default')).rnd,signal:scope?.signal});}
    const opts=options as {count?:number;spacing?:L;tolerance?:L};
    checkSampling('sample', { count: opts.count, spacing: opts.spacing === undefined ? undefined : 1 });
    const frame = exec.frame;
    const unit = unitMm(frame);
    const spacingU = opts.spacing !== undefined ? resolveLen(opts.spacing, frame.inner) / unit : undefined;
    if (spacingU !== undefined && !(spacingU > 0)) throw new Error('sample: spacing must be positive');
    const pts: [number, number][] = [];
    const edges: [number, number][] = [];
    // Each outline keeps its OWN closure: a path may hold a ring and a chain.
    for (const { pts: poly, closed } of shapeContours(exec, shape, opts.tolerance)) {
      const samples = alongChain(poly, closed, { count: opts.count, spacing: spacingU });
      const first = pts.length;
      for (let k = 0; k < samples.length; k++) {
        const { seg, t } = samples[k];
        const [x0, y0] = poly[seg];
        const [x1, y1] = poly[(seg + 1) % poly.length];
        pts.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
        if (k > 0) edges.push([first + k - 1, first + k]);
      }
      if (closed && samples.length > 2) edges.push([first + samples.length - 1, first]);
    }
    return materialOf(pts, { edges });
  }

  /**
   * A variable inspector: returns `value` unchanged and records it under
   * `label`, so the studio can show what a number actually ran through —
   * count, min, max, mean, a histogram — after the render. Works anywhere in
   * sketch or fill code (both run in the same runtime), never changes a
   * value, costs nothing to leave in.
   */
  function probe<T>(label: string, value: T): T {
    exec.recordProbe(label, value);
    return value;
  }

  /**
   * Register a material for the studio's debug inspector under `label`. Draws
   * nothing, changes nothing, consumes no randomness, and leaves the plan
   * and exports untouched; with inspection off in the host it is a type check
   * and nothing more. Not history: a label used twice keeps the LAST value
   * (in its first position), so an inspect inside a step callback shows the
   * final state, not every iteration.
   */
  function inspect(label: string, value: Material | readonly Station[]): void {
    if (typeof label !== 'string' || label.length === 0) throw new Error('inspect: the label must be a non-empty string');
    if (value instanceof Material) return exec.recordInspection(label, value);
    if (isStations(value)) return exec.recordInspection(label, stationsMaterial(value));
    throw new Error(`inspect('${label}'): expected a Material (from t.sample, material(), curve(), connect.*, steps, …) or the stations of along()`);
  }

  /** Path optimization for THIS sketch's plan (tour budget, bridging) — in
   * the program, so the same source plans the same way everywhere. */
  function planWith(opts: PlanOptions): void {
    if (typeof opts !== 'object' || opts === null) throw new Error('plan: expected { optimize?, bridge? }');
    for (const k of Object.keys(opts)) if (!['optimize', 'bridge'].includes(k)) throw new Error(`plan: unknown option '${k}' (the sketch sets optimize and bridge; engine identity is the host's)`);
    if (opts.optimize !== undefined && typeof opts.optimize !== 'boolean' && !(typeof opts.optimize === 'number' && Number.isFinite(opts.optimize) && opts.optimize >= 0)) throw new Error('plan: optimize must be a boolean or a non-negative number');
    if (opts.bridge !== undefined && typeof opts.bridge !== 'boolean' && !(typeof opts.bridge === 'number' && Number.isFinite(opts.bridge) && opts.bridge >= 0)) throw new Error('plan: bridge must be a boolean or a non-negative gap in mm');
    exec.planOptions = { ...opts };
  }

  /** Which part of the ordered plan to draw — a prefix or interval by
   * chains, fraction of chains, or minutes, with an optional budget —
   * stated in the program (and tweakable with `ui()`), so preview, exports
   * and the machine all draw exactly this. */
  function draw(req: DrawRequest): DrawRequest {
    const r = checkDrawRequest(req);
    exec.drawRequest = r;
    return r;
  }
  /** The seeded stream: `rnd()`, `rnd(n)`, `rnd(a, b)`. */
  const rnd: Execution['rnd'] = (a?: number, b?: number) => (b !== undefined ? exec.rnd(a as number, b) : a !== undefined ? exec.rnd(a) : exec.rnd());
  /** Seeded 3D noise in [-1, 1]: `noise(x, y?, z?)`, or a point row or
   * triple with `{ wavelength, amount }` so a field reads
   * `p => t.noise(p, { wavelength: 40, amount: 3 })`. */
  function noise(x: number, y?: number, z?: number): number;
  function noise(point: NoisePoint, options?: NoiseOptions): number;
  function noise(a: number | NoisePoint, b?: number | NoiseOptions, c?: number): number {
    if (typeof a === 'number') return exec.noise(a, (b as number | undefined) ?? 0, c ?? 0);
    const row = a as { readonly x: number; readonly y: number; readonly z?: number };
    const [x, y, z] = Array.isArray(a) ? [a[0], a[1], a[2] ?? 0] : [row.x, row.y, row.z ?? 0];
    const options = (b as NoiseOptions | undefined) ?? {};
    const wavelength = options.wavelength ?? 1, amount = options.amount ?? 1;
    if (!(wavelength > 0) || !Number.isFinite(amount)) throw new Error('noise wavelength must be positive and amount finite');
    return amount * exec.noise(x / wavelength, y / wavelength, z / wavelength);
  }
  const b0 = exec.bounds();
  const within = ((x: never, area: Boundary | ShapeValue, opts?: never) => withinAny(exec, x, area, opts)) as Within;
  const synthEnv = (opts: SynthOpts): SynthOpts => ({
    ...opts,
    seed: opts.seed ?? `${exec.seedUsed}:synth:${exec.rng.float()}`,
    bounds: opts.bounds ?? { x: 0, y: 0, w: b0.w, h: b0.h },
  });
  return {
    ...bindModeling3(exec, scope),
    classify3: (scene: LineArtScene3) => {
      if (!scope || scope.isOpen && !scope.isOpen()) throw new Error('classify3 requires an active async compilation');
      return classifyForRun3(exec, scene, scope);
    },
    strokes3: (runs: Parameters<typeof strokesForRun3>[1], options?: Parameters<typeof strokesForRun3>[2]) => {
      for (const run of runs) exec.fixedStrokes3.add(run.source);
      return strokesForRun3(exec, runs, options);
    },
    circle, ellipse, rect, line, ngon, stroke, path, group, clip, mask, decimate, wobble, modify,
    dash, smooth, roughen, deform, label,
    fill, rulings, ui,
    map: mapRange, norm: normRange, invert, invertRange, ease,
    times, range,
    mm, w, h, s, long,
    polygon,
    /** A seeded vector noise field: `deform(t.noiseField(4), …)`. */
    noiseField: (amount: number, wavelength = 25): VectorFieldFn => noiseFieldOf(noise, amount, wavelength),
    rnd,
    pick: <T,>(arr: readonly T[]): T => exec.pick(arr),
    chance: (p: number): boolean => exec.chance(p),
    prob: <T,>(p: number, fn: () => T, elseFn?: () => T): T | undefined => exec.prob(p, fn, elseFn),
    noise,
    stream: (name: string) => exec.stream(name),
    /** Drawable extent in bare units — the same numbers `bounds()` returns. */
    bounds: () => exec.bounds(),
    /** Resolve a length to bare units — for sketch-time math on physical
     * sizes (a bare number comes back unchanged). */
    len: (l: L): number => exec.len(l),
    width: b0.w,
    height: b0.h,
    cx: b0.cx,
    cy: b0.cy,
    /** Cell rectangles covering the whole drawable. */
    grid: (opts: GridOptions): GridCell[] => gridCells(exec.bounds(), opts),
    noisyLine: (x1: L, y1: L, x2: L, y2: L, o?: Parameters<typeof noisyLineValue>[5], shapeOpts?: ShapeOpts): ShapeValue => noisyLineValue(noise, x1, y1, x2, y2, o, shapeOpts),
    svg: svgValue,
    scatter, throw: throwTk, isolines, ridges, streamlines,
    /** A shape's boundary as material with the boundary's OWN vertices,
     * curves flattened. `sample` redistributes instead. */
    material: materialFromShape,
    sample, probe, inspect, plan: planWith, draw, distanceTo, relax, settle, voronoi: voronoiTk, quadtree: quadtreeTk,
    within,
    rotate: rotateField,
    /** Translate a field by lengths of this run (`mm(…)`, `w(…)` resolve). */
    translate: <F extends FieldFn | VectorFieldFn>(field: F, dx: L, dy: L) => translateField(field, dx, dy, (l) => exec.len(l)),
    scale: scaleField,
    vectorField: vectorFieldMark,
    /** A random expression over `vars`, seeded from the sketch's own stream
     * and probed over the drawable unless `seed`/`bounds` are given (see
     * synth.ts). On the toolkit because both defaults are the run's. */
    synth: Object.assign(
      (vars: string[], opts: SynthOpts = {}) => synthPure(vars, synthEnv(opts)),
      { warp: (vars: string[], opts: SynthOpts = {}) => synthPure.warp(vars, synthEnv(opts)) },
    ),
    /** Text of a captured asset (SVGs etc): `t.svg(t.asset('church.svg'), …)`. */
    asset: (name: string): string => assetOf(exec.inputs.assets, name),
    /** A captured image as a sampler placed on the drawable. */
    image: (name: string, place: ImagePlacement = {}) => imageOf(exec.inputs.assets, name, place),
  };
}

interface EmitCtx {
  pen: string | undefined;
  z: number | undefined;
  decimate: DecimateArg | undefined;
  wobble: WobbleArg | undefined;
  bridge: L | undefined;
  /** Inherited modifier stack, deepest ancestors first. */
  modifiers: ModifierValue[];
}

/** The inputs a headless caller gets without naming any: A4 portrait, the
 * package's pens, seed 0. Explicit and fixed — never a session's. */
export const DEFAULT_INPUTS: ExecutionInputs = Object.freeze({ paper: { w: 210, h: 297 } });

/**
 * Compile a sketch into an execution: fix the run's configuration from the
 * sketch's (`Execution.begin`), bind the toolkit, run the sketch function,
 * record the tree. Give it the inputs (paper, captured library, seed,
 * assets, fills) or an `Execution` the host made ahead of time — a worker
 * needs the run's draw hook before the module that defines the sketch has
 * even evaluated. Returns the execution the renderer encodes from.
 */
export function compileSketch(def: SketchDef, inputs: ExecutionInputs | Execution = DEFAULT_INPUTS): Execution {
  if (isSketchAsync(def)) throw new Error('compileSketch: async rendering required; use compileSketchAsync or renderAsync');
  if (!isSketch(def)) throw new Error('compileSketch: expected a sketch definition (sketch(config, fn))');
  const exec = inputs instanceof Execution ? inputs : new Execution(inputs);
  if (compilingAsync.has(exec)) throw new Error('execution already has an asynchronous compile in progress');
  const cfg = def.config;
  exec.begin(cfg);
  const toolkit = bindToolkit(exec);
  const result = def.fn(toolkit);
  if (result && typeof (result as PromiseLike<unknown>).then === 'function') { void Promise.resolve(result).catch(() => {}); throw new Error('compileSketch: the sketch function returned a promise; use compileSketchAsync or renderAsync'); }
  emit(exec, result as Tree, { pen: undefined, z: undefined, decimate: undefined, wobble: undefined, bridge: undefined, modifiers: [] });
  return exec;
}

const compilingAsync = new WeakSet<Execution>();
function containsLineArt3(tree: Tree): boolean {
  if (!tree) return false;
  if (Array.isArray(tree)) return tree.some(containsLineArt3);
  if ((tree as LineArtScene3).__occludeLineArt3 || isDrawing3(tree) || isProjectedStrokes(tree)) return true;
  if ((tree as GroupValue).__occludeGroup || (tree as ClipValue).__occludeClip) return (tree as GroupValue | ClipValue).children.some(containsLineArt3);
  return false;
}

/** Await a sketch before recording its drawing. Cancellation prevents recording;
 * it does not forcibly interrupt user JavaScript. GPU operations should also
 * receive the host's signal so they can stop submitting subsequent batches. */
export async function compileSketchAsync(
  def: SketchDef | AsyncSketchDef,
  inputs: ExecutionInputs | Execution = DEFAULT_INPUTS,
  options: { signal?: AbortSignal; compute3?: SceneCompute3; onStage?: import('./three/resolve.js').StageListener3; onProgress?: import('./three/modeling.js').ProgressListener3 } = {},
): Promise<Execution> {
  if (!isSketch(def) && !isSketchAsync(def)) throw new Error('compileSketchAsync: expected a sketch definition');
  options.signal?.throwIfAborted();
  const exec = inputs instanceof Execution ? inputs : new Execution(inputs);
  if (compilingAsync.has(exec)) throw new Error('execution already has an asynchronous compile in progress');
  compilingAsync.add(exec);
  let open = true;
  const scope = { ...options, isOpen: () => open };
  try {
    exec.begin(def.config);
    const source = await def.fn(bindToolkit(exec, scope));
    if (exec.scenes3.size || containsLineArt3(source)) exec.drawing3 = retainDrawing3(exec, source);
    const tree = containsLineArt3(source)
      ? await resolveTree3(exec, source, scope)
      : source;
    options.signal?.throwIfAborted();
    emit(exec, tree, { pen: undefined, z: undefined, decimate: undefined, wobble: undefined, bridge: undefined, modifiers: [] });
    return exec;
  } finally {
    open = false;
    compilingAsync.delete(exec);
  }
}

/** Commit another view of the captured composition, without invoking the
 * procedural sketch. The returned execution is a new result; the input run
 * and every previously encoded/exported result remain unchanged. */
export async function commitCamera3(
  previous: Execution, scene: LineArtScene3, camera: Camera3,
  options: { signal?: AbortSignal; compute3?: SceneCompute3; onStage?: import('./three/resolve.js').StageListener3 } = {},
): Promise<Execution> {
  options.signal?.throwIfAborted();
  const drawing = cameraDrawing3(previous, scene, camera);
  const next = new Execution(previous.inputs);
  for (const [source, key] of previous.cameraKeys3) next.cameraKeys3.set(source === scene ? drawing.scene : source, key);
  // Reuse unaffected classifications, but never publish into the old run.
  for (const [source, view] of previous.scenes3) if (source !== scene) next.scenes3.set(source, view);
  for (const view of previous.fixedStrokes3) next.fixedStrokes3.add(view);
  next.modeling3.push(...previous.modeling3);
  next.planOptions = previous.planOptions && structuredClone(previous.planOptions);
  next.drawRequest = previous.drawRequest && structuredClone(previous.drawRequest);
  await compileSketchAsync(sketch(drawing.config, () => drawing.tree), next, options);
  // Keep the scene menu and captured configuration in their original order.
  const views = new Map(next.scenes3);
  next.scenes3.clear();
  for (const old of previous.scenes3.keys()) {
    const source = old === scene ? drawing.scene : old;
    const view = views.get(source);
    if (view) { next.scenes3.set(source, view); views.delete(source); }
  }
  for (const [source, view] of views) next.scenes3.set(source, view);
  next.overrides = { ...previous.overrides };
  next.overrideHits = new Set(previous.overrideHits);
  next.drawLog = previous.drawLog.map(entry => ({ ...entry }));
  return next;
}

function emit(exec: Execution, tree: Tree, ctx: EmitCtx): void {
  if (!tree) return;
  if ((tree as LineArtScene3).__occludeLineArt3 || isDrawing3(tree)) throw new Error('lineArt3: async rendering required; use compileSketchAsync or renderAsync');
  if(isProjectedStrokes(tree)){for(const shape of emitProjectedStrokes(exec,tree,ctx.pen??exec.currentPen))emit(exec,shape,ctx);return;}
  if (Array.isArray(tree)) {
    for (const child of tree) emit(exec, child, ctx);
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
    const { translate, rotate, scale, origin } = g.opts;
    if (translate || rotate !== undefined || scale !== undefined) {
      exec.push({ translate, rotate, scale, origin }, () => {
        for (const child of g.children) emit(exec, child, inner);
      });
    } else {
      for (const child of g.children) emit(exec, child, inner);
    }
    return;
  }
  if ((tree as ClipValue).__occludeClip) {
    const c = tree as ClipValue;
    // Capture the region's own transform without applying it to children.
    const { translate, rotate, scale, origin } = c.region.opts;
    let regionShape!: Shape;
    exec.push({ translate, rotate, scale, origin }, () => {
      regionShape = new Shape(c.region.geom, exec);
    });
    exec.clip(
      regionShape,
      () => {
        for (const child of c.children) emit(exec, child, ctx);
      },
      c.invert,
    );
    return;
  }
  if ((tree as unknown as InvertValue).__occludeInvert) {
    throw new Error(
      'invert() is a region annotation, not a drawable — use it as clip(invert(shape), ...)',
    );
  }
  emitShape(exec, tree as ShapeValue, ctx);
}

function emitShape(exec: Execution, sv: ShapeValue, ctx: EmitCtx): void {
  const o = sv.opts;
  if (o.translate || o.rotate !== undefined || o.scale !== undefined) {
    const { translate, rotate, scale, origin } = o;
    exec.push({ translate, rotate, scale, origin }, () =>
      emitShape(exec, { ...sv, opts: { ...o, translate: undefined, rotate: undefined, scale: undefined, origin: undefined } }, ctx),
    );
    return;
  }
  const sh = new Shape(sv.geom, exec);
  const basePen = o.pen ?? ctx.pen ?? exec.currentPen;
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
  sh.preserveStroke = o.preserveStroke ?? false;
  sh.strokeSeed = o.strokeSeed;
  sh.strokeRanges = o.strokeRanges?.map(r => [...r] as [number, number]);
  const bridge = o.bridge ?? ctx.bridge;
  if (bridge !== undefined) sh.bridge = bridge;
}
