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
import { checkDrawRequest, checkPlanOptions, clonePlanOptions, type DrawRequest, type PlanOptions } from './plan.js';
import { lowerToUserContours, paperToUser } from './record.js';
import ClipperLib from 'clipper-lib';
import { INK_TOL, modelChart, spaceAreaField, type Space, type SpaceContour } from './space.js';
import { cellOf, tiling as tilingKernel, tilingGeometry, type Tiling, type TilingOpts } from './tiling.js';
import { isPlacement, type Placement } from './placement.js';
import { vx, vy, type Vec, type XY } from './vec.js';
import { checkFillOpaque, customFill, fill, rulings, type CustomFillFn, type FillSpec } from './fills.js';
import { ease } from './ease.js';
import { finiteCount } from './guard.js';
import { svg as svgValue } from './svgin.js';
import { label } from './font.js';
import { grid as gridCells, hexes as hexCells, triangles as triangleCells, type GridCell, type GridOptions, type HexOptions, type TriangleOptions } from './layout.js';
import { placements as symmetryPlacements, cellStep as symmetryCellStep, type PlaneGroup } from './symmetry.js';
import { type FieldAlign, Shape, geomClosed, type FieldFn, type LengthFn, type ModifierValue, type Origin, type PathCmd, type ShapeGeom, type VectorFieldFn } from './shapes.js';
import { Execution, type ExecutionInputs, type PaperSpec, type Pickable, type SketchOptions, type TransformOp, type Winding } from './execution.js';
import type { PenDef } from './pens.js';
import { invertRange, mapRange, normRange } from './random.js';
import {
  scatterPoints, throwPoints, relaxMaterial, settleMaterial, withinRegion,
  type RelaxOpts, type SettleOpts, type Bounds as PointBounds, type FieldFn2, type ScatterOpts, type ThrowOpts,
} from './points.js';
import { levelContours, levelMaterial, type IsoContour, type IsoDomain, type IsoLevels, type IsoOpts } from './isolines.js';
import { ridgesOf, type RidgeOpts } from './ridges.js';
import { streamlinesOf, type StreamOpts } from './streamlines.js';
import { travelTimeOf, type TravelFrom, type TravelOpts } from './travel.js';

/** `t.travelTime` options: the kernel's, with a shape allowed as the
 * ground, because the toolkit has the frame to lower one. */
export interface TravelTimeOpts extends Omit<TravelOpts, 'within'> {
  /** The ground the front may cross (default: the whole drawable).
   * Everything outside it is wall. */
  within?: Area;
  /** Seeds, one per entry, whatever the spelling: a pair IS a seed here,
   * because the key says so. Give this or `fromArea`, not both. */
  fromPoints?: PointSelection | readonly XY[];
  /** One area to start from — its whole interior and boundary — read
   * through the ordinary area door. Give this or `fromPoints`, not both. */
  fromArea?: Area;
}
import { latticeOf, type Lattice, type LatticeInit, type LatticeOpts } from './lattice.js';
import { residualOf, type Residual, type ResidualOpts } from './residual.js';
import { geodesicBow, unitMm, userPointMm } from './record.js';
import { areaLoops, isGeometry, numericLoops, type AreaInput, type Geometry, type Loop } from './boundary.js';
import {
  Material, material as materialOf, alongChain, checkSampling, inSpace, isStations, stationAt, stationsMaterial,
  withinMaterial, areaCentroid, append, type PointsLike, type Station, type Transfer,
} from './material.js';
import { PointSelection, EdgeSelection } from './relation.js';
import { Faces, FaceSelection, type Face } from './faces.js';
import { voronoiOf } from './voronoi.js';
import { quadtree, type QuadtreeOpts } from './quadtree.js';
import { spacefill, type SpacefillOpts } from './spacefill.js';
import { textOf, type TextOpts } from './strokeFont.js';
import { hersheySimplex } from './fonts/hersheySimplex.js';
import { distanceTo, distanceToPoints, type DistanceField } from './distance.js';
import { attractIn, boundaryIn, force, separationIn, sourcePoints, vortexIn, type Sources } from './forces.js';
import {
  rotate as rotateField, scale as scaleField, translate as translateField,
  vectorField as vectorFieldMark, within as withinField, fieldMeta, type BoundEnv, type Prepared,
} from './field.js';
import { apply as applyMat, invert as invertMat } from './matrix.js';
import { areaFill, interiorPoint } from './area.js';
import { orient2d } from 'robust-predicates';
import { ui } from './ui.js';
import { asset as assetOf, image as imageOf, type ImagePlacement } from './imageAsset.js';
import { h, long, mm, s, w, radians, resolveLen, Len, type L } from './units.js';
import { synth as synthPure, type SynthOpts } from './synth.js';
import { isShader } from './shader.js';

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
   * separately (e.g. { fill: 0.5 } erodes the texture, keeps the outline);
   * `step` is the pitch the engine samples a field amount on. */
  decimate?: DecimateArg;
  /** Hand-tremor: displace final strokes with seeded smooth noise, AFTER
   * occlusion (line quality only). A length (bare units or mm()), or
   * { amount, wavelength } to also set the noise wavelength (default
   * mm(25)); `step` is the pitch the engine samples a field amount on. */
  wobble?: WobbleArg;
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
  /** Pivot for `rotate` and `scale` (see `Origin`): a point in user
   * coordinates, `'center'` for the middle of this shape's own bounds or
   * `'centroid'` for its area centroid. The user origin when unset. */
  origin?: Origin<L>;
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
  decimate?: DecimateArg;
  /** Wobble default for children that don't set their own. */
  wobble?: WobbleArg;
  /** Bridge default for children that don't set their own (opt-in join). */
  bridge?: L;
  /** Modifier stack for the subtree; nesting concatenates in
   * function-application order — inner stacks run before outer ones. */
  modifiers?: ModifierValue[];
  translate?: readonly [L, L];
  /** Degrees; pivots around `origin`. */
  rotate?: number;
  scale?: number | readonly [number, number];
  /** Pivot for `rotate` and `scale` (see `Origin`): a point in user
   * coordinates, `'center'` for the middle of the children's own bounds
   * or `'centroid'` for the area centroid of their union. */
  origin?: Origin<L>;
  /**
   * An ISOMETRY of the sketch's geometry — a station's own frame, one of a
   * tiling's placements, a `reflection` — instead of a deformation of the
   * sheet. `group(placement, …children)` is the short spelling.
   *
   * It cannot share a group with `translate`, `rotate`, `scale` or
   * `origin`: those name the sheet and this names the space. Nest two
   * groups instead, the inner one deforming in source coordinates and the
   * outer one placing.
   */
  placement?: Placement;
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
  /** A shape, or a group the toolkit lowers to its union when the clip is
   * drawn. Any other area was made a shape by `clip` itself. */
  readonly region: ShapeValue | GroupValue;
  /** Complement: children keep the OUTSIDE of the region. */
  readonly invert: boolean;
  readonly children: Tree[];
}

/** The outside of an area, made by `invert()`. It is an area wherever an
 * area is taken: `clip` keeps the ink outside it, and every toolkit word
 * reads it as the drawable with the area taken out. It is not a drawable. */
export interface InvertValue {
  readonly __occludeInvert: true;
  readonly area: Area;
}

/**
 * Anything an area consumer takes: the plain area inputs (a face, contour
 * records, loops, a closed material or a selection), a shape, a group — the
 * union of its children through its own transform, as an svg import or a
 * placed shape is — and the outside of any of these, `invert(area)`. A
 * shape and a group are lowered by the toolkit, which has the frame.
 */
export type Area = AreaInput | ShapeValue | GroupValue | InvertValue;

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
  checkOrigin('shape', opts?.origin);
  return { __occludeShape: true, geom, opts };
}

/** A pivot as a value says it: a point, or one of the two words. Anything
 * else is refused here, by name, before the lowerer could turn it into a
 * NaN. */
function checkOrigin(who: string, origin: unknown): void {
  if (origin === undefined || origin === 'center' || origin === 'centroid') return;
  if (Array.isArray(origin) && origin.length >= 2 && isLen(origin[0]) && isLen(origin[1])) return;
  if (typeof origin === 'object' && origin !== null && !Array.isArray(origin)) {
    const o = origin as { x?: unknown; y?: unknown };
    if (isLen(o.x) && isLen(o.y)) return;
  }
  throw new Error(`${who}: origin is a point ([x, y] or { x, y }), 'center' or 'centroid' — got ${describeValue(origin)}`);
}

/** How a refusal names a value it was handed. */
function describeValue(v: unknown): string {
  if (typeof v === 'string') return `'${v}'`;
  if (v === null || typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return `[${v.map((e) => (typeof e === 'object' && e !== null ? '…' : String(e))).join(', ')}]`;
  return JSON.stringify(v) ?? 'a value';
}

/** The kind of a value an area consumer refuses, as its refusal says it. */
function kindOf(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'function') return 'function';
  if (typeof v !== 'object') return typeof v;
  if ((v as ClipValue).__occludeClip) return 'clip';
  if ((v as { __occludeModifier?: true }).__occludeModifier) return 'modifier';
  const name = Object.getPrototypeOf(v)?.constructor?.name;
  return name && name !== 'Object' ? name : 'record';
}

const isOpts = (v: unknown): v is ShapeOpts =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Len);

/** A shape value, as opposed to any other area input. */
const isShapeValue = (v: unknown): v is ShapeValue =>
  typeof v === 'object' && v !== null && '__occludeShape' in v;
const isGroupValue = (v: unknown): v is GroupValue =>
  typeof v === 'object' && v !== null && (v as GroupValue).__occludeGroup === true;
const isInvertValue = (v: unknown): v is InvertValue =>
  typeof v === 'object' && v !== null && (v as InvertValue).__occludeInvert === true;

// ---- pure shape constructors ----
//
// A shape that names points takes them either way. The FIRST argument
// decides the form — `isPointArg` below — never the count of arguments,
// so a station goes straight in and nothing is guessed.

export function circle(x: L, y: L, r: L, opts?: ShapeOpts): ShapeValue;
/** The same circle about a point: a pair or an `{ x, y }` record, so
 * `circle(station, 3)` works. The radius is a length as everywhere. */
export function circle(center: XY, r: L, opts?: ShapeOpts): ShapeValue;
export function circle(a: L | XY, b: L, c?: L | ShapeOpts, d?: ShapeOpts): ShapeValue {
  if (isPointArg(a)) return circle(vx(a), vy(a), b, c as ShapeOpts | undefined);
  return shape({ kind: 'circle', x: a, y: b, r: c as L }, d);
}

export function ellipse(x: L, y: L, rx: L, ry: L, rotation?: number | ShapeOpts, opts?: ShapeOpts): ShapeValue;
/** The same ellipse about a point: a pair or an `{ x, y }` record. */
export function ellipse(center: XY, rx: L, ry: L, rotation?: number | ShapeOpts, opts?: ShapeOpts): ShapeValue;
export function ellipse(
  a: L | XY, b: L, c: L, d?: L | number | ShapeOpts,
  e?: number | ShapeOpts,
  f?: ShapeOpts,
): ShapeValue {
  if (isPointArg(a)) return ellipse(vx(a), vy(a), b, c, d as number | ShapeOpts | undefined, e as ShapeOpts | undefined);
  const g = { kind: 'ellipse' as const, x: a, y: b, rx: c, ry: d as L };
  if (isOpts(e)) return shape({ ...g, rotation: 0 }, e);
  return shape({ ...g, rotation: e ?? 0 }, f);
}

export function rect(x: L, y: L, w: L, h: L, radius?: L | ShapeOpts, opts?: ShapeOpts): ShapeValue;
/** The same rect from a point: a pair or an `{ x, y }` record. The point is
 * the corner, or the centre under `mode: 'center'`, as (x, y) is. */
export function rect(at: XY, w: L, h: L, radius?: L | ShapeOpts, opts?: ShapeOpts): ShapeValue;
export function rect(
  a: L | XY, b: L, c: L, d?: L | ShapeOpts,
  e?: L | ShapeOpts,
  f?: ShapeOpts,
): ShapeValue {
  if (isPointArg(a)) return rect(vx(a), vy(a), b, c, d, e as ShapeOpts | undefined);
  const o = isOpts(e) ? e : f;
  const r = isOpts(e) ? 0 : (e ?? 0);
  return shape({ kind: 'rect', x: a, y: b, w: c, h: d as L, radius: r, anchor: o?.mode }, o);
}

export function line(x1: L, y1: L, x2: L, y2: L, opts?: ShapeOpts): ShapeValue;
/** The same line from two points: pairs or `{ x, y }` records, so
 * `line(start, tip)` works with two stations. */
export function line(a: XY, b: XY, opts?: ShapeOpts): ShapeValue;
export function line(a: L | XY, b: L | XY, c?: L | ShapeOpts, d?: L, e?: ShapeOpts): ShapeValue {
  if (isPointArg(a)) {
    return line(vx(a), vy(a), vx(b as XY), vy(b as XY), c as ShapeOpts | undefined);
  }
  return shape({ kind: 'line', x1: a, y1: b as L, x2: c as L, y2: d as L }, e);
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
export function strokes(source:Geometry|readonly IsoContour[],opts?:ShapeOpts):ShapeValue[];
export function strokes(
  source: Geometry | readonly IsoContour[] | ProjectedCurves,
  opts?: ShapeOpts | ProjectedStrokeOptions,
): ShapeValue[] | ProjectedStrokes {
  if(source instanceof ProjectedCurves)return projectedStrokes(source,opts);
  if (Array.isArray(source)) return (source as readonly IsoContour[]).map((c) => stroke(c, opts));
  // A chain consumer reads `curves()`: a face collection answers with its
  // edges, each wall once. A value that has no chains to draw — one face
  // is an area — is refused by name.
  const chains = (source as Geometry).curves;
  if (typeof chains !== 'function') {
    throw new Error('strokes: this value has no chains to draw — one face is an area; draw it with polygon(face), or its walls with strokes(face.edges)');
  }
  return chains.call(source).map((c) => stroke(c, opts));
}

export interface PolygonOpts extends ShapeOpts {
  /** Fill rule where boundaries nest or cross. `'evenodd'` (default): every
   * enclosed boundary is a hole, whatever its orientation — a ring is an
   * annulus, a pentagram has an empty pentagon. `'nonzero'`: the pentagram
   * is solid; orientation decides holes. */
  winding?: Winding;
}

/**
 * What `polygon` says, as a type, to a face collection: it is several
 * areas, and the sketch names which. The refusal at run time says the same.
 */
type FacesAreSeveralAreas = 'polygon: a face collection is several areas — polygon(cells.contours()) for their union, or cells.map((f) => polygon(f)) for each';

/**
 * Refuse, by name, a value no area consumer can read: not a shape, a group,
 * an inverted area, loops, a contour record, nor a value that answers
 * `contours()` or `curves()`. A pure word (`clip`, `mask`, `invert`) names
 * itself; a toolkit word is named with its `t.`.
 */
function refuseNonArea(who: string, v: unknown, pure = false): void {
  const name = pure ? who : `t.${who}`;
  if ((v as ClipValue | null)?.__occludeClip) {
    throw new Error(`${name}: a clip is ink, not an area — cut a material with t.within(t.material(shape), region) instead`);
  }
  if (isShapeValue(v) || isGroupValue(v) || isInvertValue(v) || Array.isArray(v)) return;
  if (typeof v === 'object' && v !== null) {
    const o = v as { contours?: unknown; curves?: unknown; pts?: unknown };
    if (typeof o.contours === 'function' || typeof o.curves === 'function' || Array.isArray(o.pts)) return;
  }
  throw new Error(`${name}: a ${kindOf(v)} is not an area — give a face, contours, a closed material or a shape`);
}

/** One outline of a lowered area in sketch coordinates, with its own
 * closure (a path may hold a ring and a chain). */
interface Outline {
  pts: [number, number][];
  closed: boolean;
  curve?: (seg: number, t: number) => [number, number];
  geodesic?: boolean[];
}

/** An area as loops in sketch coordinates and the fill rule they read. */
interface Region {
  loops: [number, number][][];
  rule: Winding;
}

/** The fill rule a shape brings: a path's own, even-odd for the rest. */
const windingOf = (sv: ShapeValue): Winding =>
  sv.geom.kind === 'path' || sv.geom.kind === 'area' ? sv.geom.winding : 'evenodd';

/**
 * THE toolkit area lowering: every area word reads an area through this.
 * A shape is lowered through the one lowerer with its own fill rule; a group
 * is the union of its shapes through its transform (one shape stays that
 * shape, loop for loop); `invert(area)` is the drawable with the area taken
 * out; anything else is read through the boundary contract, which refuses a
 * face collection by name.
 */
function areaRegion(run: Execution, area: Area, who: string): Region {
  if (isInvertValue(area)) {
    return { loops: [drawableLoop(run), ...cleanLoops(areaRegion(run, area.area, who))], rule: 'evenodd' };
  }
  if (isGroupValue(area)) {
    const leaves = treeLeaves(run, area, [], who, undefined, 'all');
    if (leaves.length === 0) return { loops: [], rule: 'evenodd' };
    const regions = leaves.map((l) => ({ loops: l.outlines.map((o) => o.pts), rule: windingOf(l.shape) }));
    if (regions.length === 1) return regions[0];
    return { loops: unionLoops(regions), rule: 'evenodd' };
  }
  if (isShapeValue(area)) return { loops: shapeContours(run, area, undefined).map((c) => c.pts), rule: windingOf(area) };
  refuseNonArea(who, area);
  return { loops: numericLoops(areaLoops(area, who), who), rule: 'evenodd' };
}

/** `areaRegion`'s loops, which is what a consumer that reads even-odd
 * loops (and has always read a shape's loops that way) takes. */
function numericAreaLoops(run: Execution, input: Area, who: string): [number, number][][] {
  return areaRegion(run, input, who).loops;
}

/** Any area as ONE shape: a shape keeps its own geometry (its pivot words
 * resolved), anything else becomes the path of its lowered loops. What a
 * field bound and a clip region hold. */
function areaAsShape(run: Execution, area: Area, who: string): ShapeValue {
  if (isShapeValue(area)) return pinShape(run, area);
  const r = areaRegion(run, area, who);
  return loopsPath(r.loops, r.rule);
}

/** The drawable as one loop in sketch coordinates, whatever the frame's
 * origin and y direction: the outside an `invert` is bounded by. */
function drawableLoop(run: Execution): [number, number][] {
  const f = run.frame;
  const back = paperToUser(f);
  const { innerW, innerH } = f.inner;
  const x0 = f.offsetX;
  const y0 = f.offsetY;
  return [back(x0, y0), back(x0 + innerW, y0), back(x0 + innerW, y0 + innerH), back(x0, y0 + innerH)];
}

/** Polygon arithmetic resolution for a union: sketch units to integers. */
const UNION_SCALE = 2 ** 20;
type ClipperPath = { X: number; Y: number }[];
const toClipper = (loop: readonly (readonly [number, number])[]): ClipperPath =>
  loop.map(([x, y]) => ({ X: Math.round(x * UNION_SCALE), Y: Math.round(y * UNION_SCALE) }));
function clipperUnion(paths: ClipperPath[], rule: Winding): ClipperPath[] {
  const c = new ClipperLib.Clipper();
  c.StrictlySimple = true;
  c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const ft = rule === 'nonzero' ? ClipperLib.PolyFillType.pftNonZero : ClipperLib.PolyFillType.pftEvenOdd;
  const out: ClipperPath[] = [];
  if (!c.Execute(ClipperLib.ClipType.ctUnion, out, ft, ft)) throw new Error('area union failed');
  return out;
}

/** Several regions, each under its own rule, as the loops of their union:
 * simple, holes inside outers, read the same under either rule. */
function unionLoops(regions: readonly Region[]): [number, number][][] {
  const each = regions.flatMap((r) => clipperUnion(r.loops.map(toClipper), r.rule));
  return clipperUnion(each, 'nonzero').map((p) => p.map((q) => [q.X / UNION_SCALE, q.Y / UNION_SCALE] as [number, number]));
}

/** A region's loops as even-odd reads them: already so for an even-odd
 * region or a single loop, otherwise the union under its own rule. */
function cleanLoops(r: Region): [number, number][][] {
  if (r.rule === 'evenodd' || r.loops.length <= 1) return r.loops;
  return unionLoops([r]);
}

/** A pivot resolved to a point in the value's own coordinates: a pair
 * stays the pair it was, a record becomes one, and `'center'`/`'centroid'`
 * are read off the outlines `own` lowers. */
function pinOrigin(who: string, origin: Origin<L> | undefined, own: () => readonly Outline[]): readonly [L, L] | undefined {
  if (origin === undefined) return undefined;
  checkOrigin(who, origin);
  if (origin === 'center' || origin === 'centroid') return pivotOf(own(), origin);
  if (Array.isArray(origin)) return origin.length === 2 ? (origin as unknown as readonly [L, L]) : [origin[0], origin[1]];
  const o = origin as { x: L; y: L };
  return [o.x, o.y];
}

/** `'center'`: the middle of the outlines' bounds. `'centroid'`: the area
 * centroid of the closed ones as `polygon` fills them, else the mean of
 * every point. Nothing at all pivots on the user origin. */
function pivotOf(outlines: readonly Outline[], which: 'center' | 'centroid'): [number, number] {
  let n = 0, mx = 0, my = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of outlines) for (const [x, y] of o.pts) {
    n++; mx += x; my += y;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  if (n === 0) return [0, 0];
  if (which === 'center') return [(x0 + x1) / 2, (y0 + y1) / 2];
  const c = areaCentroid(outlines.filter((o) => o.closed && o.pts.length >= 3).map((o) => ({ pts: o.pts, closed: true }) as IsoContour));
  return c ? [c[0], c[1]] : [mx / n, my / n];
}

/** A shape with its pivot words resolved to a point of its own geometry —
 * before its transform, which is what the pivot turns — so nothing past the
 * toolkit meets a word. A `polygon(shape)`'s inner shape is resolved too. */
function pinShape(run: Execution, sv: ShapeValue): ShapeValue {
  let geom = sv.geom;
  if (geom.kind === 'area') {
    const inner = pinShape(run, shape(geom.of.geom, geom.of.opts as ShapeOpts));
    if (inner.geom !== geom.of.geom || inner.opts.origin !== geom.of.opts.origin) {
      geom = { ...geom, of: { geom: inner.geom, opts: { ...geom.of.opts, origin: inner.opts.origin } } };
    }
  }
  const g = geom;
  const origin = pinOrigin('shape', sv.opts.origin, () => {
    const unit = unitMm(run.frame);
    return lowerToUserContours(g, {}, run.frame).map((c) => ({ pts: c.pts.map(([x, y]) => [x / unit, y / unit] as [number, number]), closed: c.closed }));
  });
  if (geom === sv.geom && origin === sv.opts.origin) return sv;
  return { ...sv, geom, opts: { ...sv.opts, origin } };
}

/** A group with its pivot word resolved against its children's own
 * outlines (their transforms applied, the group's not). */
function pinGroup(run: Execution, g: GroupValue): GroupValue {
  const origin = pinOrigin('group', g.opts.origin, () => treeLeaves(run, g.children, [], 'group', undefined, 'all').flatMap((l) => l.outlines));
  return origin === g.opts.origin ? g : { ...g, opts: { ...g.opts, origin } };
}

/** The op a (pinned) group pushes onto the chain, or none. */
function groupOp(g: GroupValue): TransformOp | null {
  const { translate, rotate, scale, origin, placement } = g.opts;
  if (placement !== undefined) return { placement };
  if (translate || rotate !== undefined || scale !== undefined) return { translate, rotate, scale, origin: origin as readonly [L, L] | undefined };
  return null;
}

/** Every shape in a tree with its outlines, lowered through `chain` (the
 * enclosing groups' ops, outermost first) and its own transform. A group
 * is an area through the shapes it holds; anything else in it is refused
 * by name. */
function treeLeaves(
  run: Execution, tree: Tree, chain: readonly TransformOp[], who: string,
  tolerance: L | undefined, refine: 'all' | 'curves',
): { shape: ShapeValue; outlines: Outline[] }[] {
  if (!tree) return [];
  if (Array.isArray(tree)) return tree.flatMap((c) => treeLeaves(run, c, chain, who, tolerance, refine));
  if (isGroupValue(tree)) {
    const g = pinGroup(run, tree);
    const op = groupOp(g);
    return treeLeaves(run, g.children, op ? [...chain, op] : chain, who, tolerance, refine);
  }
  if (isShapeValue(tree)) return [{ shape: tree, outlines: shapeContours(run, tree, tolerance, refine, chain) }];
  throw new Error(`${who}: a ${kindOf(tree)} in a group is not an area — a group is an area through the shapes it holds`);
}

/** A face: one area of a face collection, which knows its own walls. */
const isFace = (v: unknown): v is Face =>
  typeof v === 'object' && v !== null && typeof (v as Face).index === 'number'
  && typeof (v as Face).contours === 'function' && typeof (v as Face).extract === 'function'
  && (v as { boundaryEdges?: unknown }).boundaryEdges instanceof EdgeSelection;

/** Every outline of an area with its own closure, for the words that walk a
 * boundary (`t.material`, `t.sample`): a shape's and a group's shapes' own,
 * a contour record's own, every other contour (holes too) a ring. */
function areaOutlines(run: Execution, area: Area, who: string, tolerance: L | undefined, refine: 'all' | 'curves'): Outline[] {
  if (isShapeValue(area)) return shapeContours(run, area, tolerance, refine);
  if (isGroupValue(area)) return treeLeaves(run, area, [], who, tolerance, refine).flatMap((l) => l.outlines);
  if (isInvertValue(area)) return areaRegion(run, area, who).loops.map((pts) => ({ pts, closed: true }));
  refuseNonArea(who, area);
  const records = (Array.isArray(area) && area.length > 0 && isContourRecord(area[0])) ? area as readonly IsoContour[]
    : isContourRecord(area) ? [area] : null;
  if (records) return records.map((c) => ({ pts: numericLoops([c.pts as Loop], who)[0], closed: c.closed !== false }));
  return numericLoops(areaLoops(area, who), who).map((pts) => ({ pts, closed: true }));
}
const isContourRecord = (v: unknown): v is IsoContour =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Array.isArray((v as IsoContour).pts)
  && typeof (v as { contours?: unknown }).contours !== 'function';

/**
 * A shape as geometry: its outlines as contour records, in the sketch's own
 * units, with each outline's own closure.
 *
 * This is the one door the frame rule names. A shape is a description in
 * sketch coordinates; it needs the paper, the units and its own transform
 * before it is geometry, so the toolkit lowers it and every `t.` word takes
 * a shape because of this function. A pure kernel never calls it.
 *
 * `polygon` is the deliberate exception and must stay one: it defers the
 * shape into the drawing tree, where it is lowered inside the full transform
 * chain — the paper offset, the user origin, and any enclosing `group`.
 * Lowering it here instead would quietly drop the group's transform.
 */
/**
 * Is this the `t.travelTime` options record, and not a source handed in
 * where the record goes? A shape, a value that answers the geometry
 * protocol, a contour record and an array are all sources, so none of
 * them is the record.
 */
const isTravelOpts = (v: unknown): v is TravelTimeOpts => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return !(isShapeValue(v) || isGeometry(v) || 'pts' in v);
};

/** `fromPoints` as one seed per entry: the key says every entry is a point,
 * so a pair and a record mean the same thing here. */
function seedRecords(from: PointSelection | readonly XY[]): { x: number; y: number }[] {
  if (from === null || typeof from !== 'object' || typeof (from as Iterable<XY>)[Symbol.iterator] !== 'function') {
    throw new Error('travelTime: fromPoints expects points — a point selection, or a list of [x, y] pairs or { x, y } records');
  }
  const out: { x: number; y: number }[] = [];
  let i = 0;
  for (const p of from as Iterable<XY>) {
    const x = vx(p as XY);
    const y = vy(p as XY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`travelTime: fromPoints entry ${i} is not a point ([x, y] or { x, y })`);
    }
    out.push({ x, y });
    i++;
  }
  return out;
}

/** An area for a word that reads it as geometry: a shape lowered with each
 * outline's own closure, a group or an inverted area as its loops, and any
 * other area as it is (refused by name when it is none). */
function lowerShape(run: Execution, input: Area, who: string): AreaInput {
  if (isShapeValue(input)) return shapeContours(run, input, undefined).map((c) => ({ pts: c.pts, closed: c.closed }));
  if (isGroupValue(input) || isInvertValue(input)) return areaRegion(run, input, who).loops.map((pts) => ({ pts, closed: true }));
  refuseNonArea(who, input);
  return input;
}

/**
 * Points a word may draw a neighbourhood from — and a shape is NOT one.
 *
 * Lowering a shape here would make the answer depend on a flattening
 * tolerance nobody chose: how strongly a circle pushes its neighbours away
 * would be set by how finely it happened to be flattened, and
 * `excludeConnected` would change meaning, because a lowered outline has
 * edges where a list of points has none. So the refusal names the door:
 * `t.material(shape)` keeps the boundary's own vertices and
 * `t.sample(shape, { count })` places the number you ask for. Either choice
 * is the sketch's to make, in the open.
 */
function pointSources(sources: Sources | ShapeValue, who: string): Sources {
  if (!isShapeValue(sources)) return sources as Sources;
  throw new Error(
    `${who}: a shape is not a set of points — how many it has would be decided by a flattening ` +
      `tolerance, not by you. Use t.material(shape) for the boundary's own vertices, or ` +
      `t.sample(shape, { count }) for a number you choose.`,
  );
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
export function polygon<A extends AreaInput | Contour | Contour[] | ShapeValue>(area: A extends FaceSelection<unknown> ? FacesAreSeveralAreas : A, opts: PolygonOpts = {}): ShapeValue {
  const contours = area as AreaInput | Contour | Contour[] | ShapeValue;
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
  return areaPath(contours as AreaInput, 'polygon', winding, rest);
}

/** An area input as a path shape, pure: its loops in the coordinates they
 * were given, geodesic walls kept. What `polygon` draws, and what `clip`
 * and `mask` make of an area that is not a shape. */
function areaPath(input: AreaInput, who: string, winding: Winding, opts: ShapeOpts = {}): ShapeValue {
  refuseNonArea(who, input, true);
  return loopsPath(areaLoops(input, who), winding, opts, geodesicSegments(input));
}

/** Loops as one path shape, each loop a closed subpath. */
function loopsPath(
  loops: readonly (readonly (readonly [L, L])[])[], winding: Winding, opts: ShapeOpts = {},
  geodesic?: (a: readonly [unknown, unknown], b: readonly [unknown, unknown]) => boolean,
): ShapeValue {
  const cmds: PathCmd[] = [];
  for (const loop of loops) {
    if (loop.length < 2) continue;
    cmds.push({ op: 'move', x: loop[0][0], y: loop[0][1] });
    for (let k = 1; k < loop.length; k++) {
      cmds.push(geodesic?.(loop[k - 1], loop[k]) ? { op: 'line', x: loop[k][0], y: loop[k][1], geodesic: true } : { op: 'line', x: loop[k][0], y: loop[k][1] });
    }
    cmds.push(geodesic?.(loop[loop.length - 1], loop[0]) ? { op: 'close', geodesic: true } : { op: 'close' });
  }
  return shape({ kind: 'path', cmds, winding }, opts);
}

/**
 * The geodesic segments of an area source, as a test on a segment's two
 * ends: the chains the source answers (`curves()`), each segment its
 * `geodesic` flag says is one, keyed by its ends either way round. A
 * loop `areaLoops` reads — a closed chain, a face's rim — is made of those
 * very edges, with the very coordinates. Undefined when nothing is a
 * geodesic, which is every flat source.
 */
function geodesicSegments(source: unknown): ((a: readonly [unknown, unknown], b: readonly [unknown, unknown]) => boolean) | undefined {
  if (typeof source !== 'object' || source === null || typeof (source as { curves?: unknown }).curves !== 'function') return undefined;
  const keys = new Set<string>();
  for (const c of (source as { curves(): IsoContour[] }).curves()) {
    const g = c.geodesic;
    if (!g) continue;
    const n = c.pts.length;
    for (let k = 0; k < g.length; k++) {
      if (!g[k]) continue;
      const a = c.pts[k];
      const b = c.pts[(k + 1) % n];
      keys.add(`${a[0]},${a[1]},${b[0]},${b[1]}`);
      keys.add(`${b[0]},${b[1]},${a[0]},${a[1]}`);
    }
  }
  if (keys.size === 0) return undefined;
  return (a, b) => keys.has(`${a[0]},${a[1]},${b[0]},${b[1]}`);
}

/**
 * The region word, one spelling. `within(field, area)` bounds a field's
 * domain (the field is ABSENT outside — see field.ts). Everything else keeps
 * only what lies INSIDE the area:
 *
 * - a material: its edges cut where they cross the boundary, the outside
 *   dropped, so a chord built long enough to be sure of crossing a frame
 *   ends ON the frame (columns keep their declared transfer policy);
 * - a point, edge or face selection: the members that belong to the area,
 *   whole, as a selection of the same source, so it still chains and still
 *   works as `{ where }` in a step rule.
 *
 * `area` is any `Area`, read through the one toolkit lowering: a shape, a
 * group, a face, loops, contour records, a closed material, a selection, or
 * `invert(area)` for the outside. A selection takes `{ keep }` (see
 * WithinKeep).
 */
/** How `within` decides that a member of a selection belongs to an area:
 * one vocabulary for points, edges and faces. The boundary is judged with
 * the one ink tolerance (`INK_TOL`, on the sheet): a vertex that close to
 * the boundary is ON it, and a wall that runs along the boundary does not
 * cross it.
 *
 * `'contained'` (the default) keeps a member with no point outside the area
 * and no crossing of its boundary, so the boundary belongs to the area: a
 * point on it is in, and a cell whose wall runs along it is in. A face must
 * also not hold a hole or an island of the area inside it. `'centroid'`
 * keeps a member whose centroid is in or on the area — an edge's centroid is
 * its middle, a point's is the point — so a cell the boundary cuts is kept
 * whole, and its ink may reach past the edge by up to that cell.
 * `'touching'` keeps a member that shares any point with the area: a vertex
 * in or on it, a wall meeting its boundary, or the area lying inside a
 * face. To cut at the boundary instead, hand `within` the MATERIAL: a
 * material is cut, a selection is filtered. */
export interface WithinKeep {
  keep?: 'contained' | 'centroid' | 'touching';
}

export interface Within {
  <F extends FieldFn | VectorFieldFn | LengthFn>(field: F, area: Area): Prepared<F>;
  (material: Material, area: Area, opts?: { transfer?: Record<string, Transfer> }): Material;
  (points: PointSelection, area: Area, opts?: WithinKeep): PointSelection;
  (edges: EdgeSelection, area: Area, opts?: WithinKeep): EdgeSelection;
  (faces: Faces | FaceSelection, area: Area, opts?: WithinKeep): FaceSelection;
}

export function withinAny<F extends FieldFn | VectorFieldFn | LengthFn>(run: Execution, field: F, area: Area): Prepared<F>;
export function withinAny(run: Execution, material: Material, area: Area, opts?: { transfer?: Record<string, Transfer> }): Material;
export function withinAny(run: Execution, points: PointSelection, area: Area, opts?: WithinKeep): PointSelection;
export function withinAny(run: Execution, edges: EdgeSelection, area: Area, opts?: WithinKeep): EdgeSelection;
export function withinAny(run: Execution, faces: Faces | FaceSelection, area: Area, opts?: WithinKeep): FaceSelection;

export function withinAny(
  run: Execution,
  x: FieldFn | VectorFieldFn | LengthFn | Material | PointSelection | EdgeSelection | Faces | FaceSelection,
  area: Area,
  opts: { transfer?: Record<string, Transfer> } & WithinKeep = {},
): FieldFn | VectorFieldFn | LengthFn | Material | PointSelection | EdgeSelection | FaceSelection {
  // The one area door: a field is bounded by the area as one shape, which
  // the engine receives as exact geometry.
  if (typeof x === 'function') return withinField(x, areaAsShape(run, area, 'within'), boundEnv(run));
  const old = opts as { faces?: unknown; edges?: unknown };
  for (const key of ['faces', 'edges'] as const) {
    if (old[key] !== undefined) {
      throw new Error(`within: the '${key}' option is spelled keep — { keep: 'contained' | 'centroid' | 'touching' }, the same on points, edges and faces`);
    }
  }
  const keep = opts.keep ?? 'contained';
  if (keep !== 'contained' && keep !== 'centroid' && keep !== 'touching') {
    throw new Error(`within: keep must be 'contained', 'centroid' or 'touching', got ${describeValue(opts.keep)}`);
  }
  const region = areaRegion(run, area, 'within');
  const loops = region.loops;
  // The FILLED REGION, not the contours: under a nonzero rule an interior
  // contour has fill on both sides and is not a boundary at all, so points on
  // it are inside, material along it is not cut, and a face may cross or
  // enclose it. A shape area brings its own rule; loops and faces carry none
  // and read even-odd, exactly as `distanceTo` documents.
  const fill = areaFill(loops, region.rule);
  const inside = fill.at;
  if (x instanceof Material) {
    if (opts.keep !== undefined) throw new Error("within: 'keep' is for a selection — a material is cut at the boundary");
    return withinMaterial(x, loops, { ...opts, inside, crossings: fill.crossings });
  }
  if (opts.transfer !== undefined) throw new Error("within: 'transfer' is for a material — a selection's member is kept whole or not at all");
  const side = boundarySide(fill, INK_TOL / unitMm(run.frame));
  // A point is its own centroid, and touches the area exactly when it is
  // in or on it: the three questions have one answer.
  if (x instanceof PointSelection) return x.filter((p) => side(p.x, p.y) >= 0);
  // A wall belongs when no piece of it lies outside: its ends in or on the
  // area, and between any two crossings of the real boundary the middle in
  // or on it too — so a wall that runs along the boundary, crossing it back
  // and forth by a rounding error, belongs.
  const wallIn = (ax: number, ay: number, bx: number, by: number): boolean => {
    if (!(side(ax, ay) >= 0) || !(side(bx, by) >= 0)) return false;
    let t0 = 0;
    for (const t1 of [...fill.crossings(ax, ay, bx, by).map((h) => h.t), 1]) {
      const tm = (t0 + t1) / 2;
      if (!(side(ax + (bx - ax) * tm, ay + (by - ay) * tm) >= 0)) return false;
      t0 = t1;
    }
    return true;
  };
  const touches = (ax: number, ay: number, bx: number, by: number): boolean =>
    side(ax, ay) >= 0 || side(bx, by) >= 0 || meetsBoundary(fill.boundary, ax, ay, bx, by);
  if (x instanceof EdgeSelection) {
    if (keep === 'centroid') return x.filter((e) => side(e.center[0], e.center[1]) >= 0);
    if (keep === 'touching') return x.filter((e) => touches(e.a.x, e.a.y, e.b.x, e.b.y));
    return x.filter((e) => wallIn(e.a.x, e.a.y, e.b.x, e.b.y));
  }
  const faces: Faces | FaceSelection = x;
  const tol = INK_TOL / unitMm(run.frame);
  if (keep === 'centroid') {
    // Geometric centres: no field is measured, so no raster is built.
    const measured = faces.measure();
    return faces.filter((f) => {
      const [cx, cy] = measured.forFace(f).centroid;
      return side(cx, cy) >= 0;
    });
  }
  if (keep === 'touching') {
    // Any shared point: a vertex in or ON the boundary, a wall meeting a real
    // boundary, or else the area lying wholly inside the face, which a point
    // of the boundary inside or on the face says.
    return faces.filter((f) => {
      const areas = f.contours();
      if (areas.length === 0) return false;
      for (const c of areas) {
        for (let k = 0; k < c.pts.length; k++) {
          const p = c.pts[k];
          const q = c.pts[(k + 1) % c.pts.length];
          if (touches(p[0], p[1], q[0], q[1])) return true;
        }
      }
      if (fill.boundary.length === 0) return false;
      const [ax, ay] = fill.boundary[0];
      return distanceTo(areas)(ax, ay) >= -tol;
    });
  }
  // A face is kept whole or not kept at all: nothing of it is clipped. It
  // belongs to the area when every wall does — so a cell whose wall RUNS
  // ALONG the boundary is in (the artist means the cells that belong to the
  // frame, and the frame's own cells share its edges), while a face merely
  // touching it from outside is not.
  const keepFace = (f: Face): boolean => {
    const areas = f.contours();
    if (areas.length === 0) return false;
    for (const c of areas) {
      for (let k = 0; k < c.pts.length; k++) {
        const p = c.pts[k];
        const q = c.pts[(k + 1) % c.pts.length];
        // Only a REAL boundary stops a face: an interior contour may be crossed
        // freely, since the fill is on both of its sides.
        if (!wallIn(p[0], p[1], q[0], q[1])) return false;
      }
    }
    // A face must also have somewhere of its own inside the fill: a wall it
    // shares with the boundary says nothing by itself, and the same walls bound
    // the annulus and the hole it encloses.
    const probe = interiorPoint(areas.map((c) => c.pts));
    if (probe && !(side(probe[0], probe[1]) >= 0)) return false;
    // Every wall in still leaves the reverse case: a real boundary — a hole,
    // or an island — lying inside the face, whose excluded space the face
    // would cover. Each real segment is tested at its ends and its middle,
    // deeper than the tolerance; a wall the face shares with the boundary is
    // ON it, not in it, and passes.
    const faceInside = distanceTo(areas);
    for (const s of fill.boundary) {
      const [ax, ay, bx, by] = s;
      if (faceInside(ax, ay) > tol || faceInside(bx, by) > tol || faceInside((ax + bx) / 2, (ay + by) / 2) > tol) return false;
    }
    return true;
  };
  return x instanceof Faces ? x.filter(keepFace) : x.filter(keepFace);
}

/**
 * Which side of a filled region a point is on, the boundary judged with a
 * tolerance: 0 within `tol` of a real boundary segment (ON it), otherwise
 * the fill's own sign — positive in, negative out. The distance to the
 * boundary is built on the first point that needs it.
 */
function boundarySide(fill: ReturnType<typeof areaFill>, tol: number): (x: number, y: number) => number {
  let near: DistanceField | null = null;
  return (x, y) => {
    const v = fill.at(x, y);
    if (!(v > 0) && !(v < 0)) return v;
    near ??= fill.boundary.length === 0 ? () => Infinity : distanceTo(fill.boundary.map(([ax, ay, bx, by]) => [[ax, ay], [bx, by]] as [number, number][]));
    return Math.abs(near(x, y)) <= tol ? 0 : v;
  };
}

/** Do segment (ax, ay)–(bx, by) and any of these boundary segments share a
 * point? Closed segments, exact signs: an end on the other segment, a
 * collinear overlap and a proper crossing all count. */
function meetsBoundary(
  boundary: readonly (readonly [number, number, number, number])[],
  ax: number, ay: number, bx: number, by: number,
): boolean {
  const lox = Math.min(ax, bx);
  const hix = Math.max(ax, bx);
  const loy = Math.min(ay, by);
  const hiy = Math.max(ay, by);
  for (const [cx, cy, dx, dy] of boundary) {
    if (Math.max(cx, dx) < lox || Math.min(cx, dx) > hix || Math.max(cy, dy) < loy || Math.min(cy, dy) > hiy) continue;
    const o1 = Math.sign(orient2d(ax, ay, bx, by, cx, cy));
    const o2 = Math.sign(orient2d(ax, ay, bx, by, dx, dy));
    const o3 = Math.sign(orient2d(cx, cy, dx, dy, ax, ay));
    const o4 = Math.sign(orient2d(cx, cy, dx, dy, bx, by));
    // Collinear: the boxes, which overlap, are the spans.
    if (o1 === 0 && o2 === 0) return true;
    // Each segment's ends on both sides of the other's line, or on it: the
    // one point the lines share lies on both. A zero sign is an end ON the
    // other line, and the other pair's differing signs put it within.
    if (o1 !== o2 && o3 !== o4) return true;
  }
  return false;
}

/** Regular n-gon: `sides` vertices on a circle of radius `r`, the first at
 * `rotation` degrees. */
export function ngon(x: L, y: L, sides: number, r: L, rotation?: number | ShapeOpts, opts?: ShapeOpts): ShapeValue;
/** The same n-gon about a point: a pair or an `{ x, y }` record. */
export function ngon(center: XY, sides: number, r: L, rotation?: number | ShapeOpts, opts?: ShapeOpts): ShapeValue;
export function ngon(
  a: L | XY, b: L, c: number | L, d?: L | number | ShapeOpts, e?: number | ShapeOpts, f?: ShapeOpts,
): ShapeValue {
  if (isPointArg(a)) return ngon(vx(a), vy(a), b as number, c, d as number | ShapeOpts | undefined, e as ShapeOpts | undefined);
  const g = { kind: 'ngon' as const, x: a, y: b, sides: c as number, r: d as L };
  if (isOpts(e)) return shape({ ...g, rotation: 0 }, e);
  return shape({ ...g, rotation: e ?? 0 }, f);
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
  // A segment the contour names a geodesic is drawn as one (a material
  // edge with `geodesic = 1`); every other is the image of its coordinate
  // segment, as always.
  const geodesic = Array.isArray(contour) ? undefined : contour.geodesic;
  const cmds: PathCmd[] = [];
  if (pts.length > 0) {
    cmds.push({ op: 'move', x: pts[0][0], y: pts[0][1] });
    for (let i = 1; i < pts.length; i++) {
      cmds.push(geodesic?.[i - 1] ? { op: 'line', x: pts[i][0], y: pts[i][1], geodesic: true } : { op: 'line', x: pts[i][0], y: pts[i][1] });
    }
    if (closed) cmds.push(geodesic?.[pts.length - 1] ? { op: 'close', geodesic: true } : { op: 'close' });
  }
  return shape({ kind: 'path', cmds, winding: 'nonzero' }, opts);
}

/**
 * A tap of the pen at every point: pen down, the pen's delay, pen up.
 *
 * `dots` is the third way to spell ink, beside `stroke`/`strokes` (along a
 * contour) and `polygon` (an area). It takes any geometry that has points
 * — a material, a selection, a face collection, a plain list of pairs —
 * and marks each one. A dot is occluded as a point: a shape drawn over it
 * hides it whole, and nothing hides half of it. The preview shows it at
 * nib width, the plan keeps it through the zero-length cleanup, and the
 * machine gets one pen-down with the pen's settle.
 *
 * No points, no ink.
 */
export function dots(points: Sources, opts: { pen?: string } = {}): ShapeValue[] {
  const list = materialOf(sourcePoints(points));
  const out: ShapeValue[] = [];
  // A dot is an engine stipple mark, and a stipple mark belongs to a
  // region: the marks are supplied for a shape and judged strictly inside
  // it. A shape with a fill HIDES what is beneath it, so one box around a
  // whole cloud would erase everything drawn before it. Instead every dot
  // carries its own box, a hundredth of a millimetre across — four cells
  // of the engine's 0.005 mm input grid, so the tap is strictly inside it,
  // and two hundredths of a nib, so what it hides is nothing a pen could
  // draw. The box is in PAPER mm and the dot's place is the translate, so
  // the box is the same hair whatever the paper and whatever the sketch's
  // own coordinates mean.
  const r = mm(0.01);
  const g = mm(-0.01);
  const box: [L, L][] = [[g, g], [r, g], [r, r], [g, r]];
  for (let i = 0; i < list.n; i++) {
    const x = list.x[i];
    const y = list.y[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    // The box is centred on the origin and the shape is moved to the dot,
    // so the tap IS the anchor's origin: it rides every transform the
    // shape rode without any arithmetic of ours.
    const mark: CustomFillFn = (_region, ctx) => [{ type: 'dot', x: ctx.anchor.e, y: ctx.anchor.f }];
    out.push(polygon(box, { ...opts, translate: [x, y], stroke: false, fill: customFill(mark) }));
  }
  return out;
}

/** Mutable builder; `build()` snapshots, so the builder stays extendable. */
export class PathValue {
  private cmds: PathCmd[] = [];
  constructor(private winding: Winding = 'nonzero') {}

  // Every point these take is a pair of numbers or one point — a pair or an
  // `{ x, y }` record — and the first argument decides, as in the factories.
  moveTo(x: L, y: L): this;
  moveTo(to: XY): this;
  moveTo(a: L | XY, b?: L): this {
    if (isPointArg(a)) return this.moveTo(vx(a), vy(a));
    this.cmds.push({ op: 'move', x: a, y: b as L });
    return this;
  }
  lineTo(x: L, y: L): this;
  lineTo(to: XY): this;
  lineTo(a: L | XY, b?: L): this {
    if (isPointArg(a)) return this.lineTo(vx(a), vy(a));
    this.cmds.push({ op: 'line', x: a, y: b as L });
    return this;
  }
  bezierTo(c0x: L, c0y: L, c1x: L, c1y: L, x: L, y: L): this;
  bezierTo(c0: XY, c1: XY, to: XY): this;
  bezierTo(a: L | XY, b: L | XY, c: L | XY, d?: L, e?: L, f?: L): this {
    if (isPointArg(a)) {
      const [c1, to] = [b as XY, c as XY];
      return this.bezierTo(vx(a), vy(a), vx(c1), vy(c1), vx(to), vy(to));
    }
    this.cmds.push({ op: 'bezier', c0x: a, c0y: b as L, c1x: c as L, c1y: d as L, x: e as L, y: f as L });
    return this;
  }
  quadTo(cx: L, cy: L, x: L, y: L): this;
  quadTo(c: XY, to: XY): this;
  quadTo(a: L | XY, b: L | XY, c?: L, d?: L): this {
    if (isPointArg(a)) return this.quadTo(vx(a), vy(a), vx(b as XY), vy(b as XY));
    this.cmds.push({ op: 'quad', cx: a, cy: b as L, x: c as L, y: d as L });
    return this;
  }
  /**
   * Arc to (x, y) of radius `r`. The sign of `r` picks the side of the
   * chord the centre sits on, which is what chooses the direction of the
   * turn; `large` picks WHICH OF THE TWO arcs about that centre is drawn —
   * the minor one by default, the long way round with `{ large: true }`.
   * Under a radius of half the chord there is no such circle, and the arc
   * is the semicircle on that chord.
   */
  arcTo(x: L, y: L, r: L, opts?: { large?: boolean }): this;
  arcTo(to: XY, r: L, opts?: { large?: boolean }): this;
  arcTo(a: L | XY, b: L, c?: L | { large?: boolean }, d: { large?: boolean } = {}): this {
    if (isPointArg(a)) return this.arcTo(vx(a), vy(a), b, c as { large?: boolean } | undefined);
    this.cmds.push({ op: 'arc', x: a, y: b, r: c as L, large: d.large });
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

/**
 * A subtree with shared options. `group(placement, ...children)` is the
 * short spelling of `group({ placement }, ...children)` — told apart by
 * `isPlacement`, never by duck-typing a function, because a placement is
 * not one.
 */
export function group(opts: GroupOpts | Placement, ...children: Tree[]): GroupValue {
  if (isPlacement(opts)) return { __occludeGroup: true, opts: { placement: opts }, children };
  const o = opts as GroupOpts;
  checkOrigin('group', o?.origin);
  if (o && o.placement !== undefined
    && (o.translate !== undefined || o.rotate !== undefined || o.scale !== undefined || o.origin !== undefined)) {
    throw new Error(
      'group: a placement and translate/rotate/scale/origin name two different frames — nest groups instead, '
      + 'the inner one deforming in source coordinates and the outer one placing',
    );
  }
  return { __occludeGroup: true, opts: o, children };
}

/**
 * The children's ink restricted to an area: any `Area` — a shape, a group,
 * a face, loops, contour records, a closed material — and `invert(area)`
 * keeps the ink outside it instead. The area is not drawn.
 */
export function clip(region: Area, ...children: Tree[]): ClipValue {
  let inv = false;
  let r: Area = region;
  while (isInvertValue(r)) {
    inv = !inv;
    r = r.area;
  }
  return {
    __occludeClip: true,
    // A group is lowered when the clip is drawn, with the run in hand; any
    // other area is its path now, so a refusal comes from here.
    region: isShapeValue(r) || isGroupValue(r) ? r : areaPath(r, 'clip', 'evenodd'),
    invert: inv,
    children,
  };
}

/**
 * The outside of an area: an area wherever an area is taken.
 * `clip(invert(area), ...children)` keeps the ink outside it,
 * `mask(invert(area))` hides everything but it, and a toolkit word reads it
 * as the drawable with the area taken out. Not a drawable — returning it
 * in the tree fails loudly.
 */
export function invert(area: Area): InvertValue {
  refuseNonArea('invert', area, true);
  return { __occludeInvert: true, area };
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

type DecimateArg =
  | number
  | FieldFn
  | { stroke?: number | FieldFn; fill?: number | FieldFn; align?: FieldAlign; step?: L };
type WobbleArg = L | FieldFn | { amount: L | LengthFn; wavelength?: L; align?: FieldAlign; step?: L };

function decimateValue(p: DecimateArg): ModifierValue {
  const [stroke, fill, align, step] =
    typeof p === 'number' || typeof p === 'function'
      ? [p, p, undefined, undefined]
      : [p.stroke ?? 0, p.fill ?? 0, p.align, p.step];
  const c = (v: number | FieldFn): number | FieldFn => (typeof v === 'number' ? clamp01(v) : v);
  return { __occludeModifier: true, kind: 'decimate', stroke: c(stroke), fill: c(fill), align, step };
}

function wobbleValue(a: WobbleArg): ModifierValue {
  if (typeof a === 'object' && !(a instanceof Len) && 'amount' in a) {
    return {
      __occludeModifier: true, kind: 'wobble',
      amount: a.amount, wavelength: a.wavelength, align: a.align, step: a.step,
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
 * In the record form, `step` is the pitch the engine samples a field
 * amount on.
 */
type RoughenArg = L | FieldFn | { amount: L | FieldFn; detail?: L; align?: FieldAlign; step?: L };

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
    step: cfg.step,
  };
  if (children.length === 0) return value;
  return { __occludeGroup: true, opts: { modifiers: [value] }, children };
}

/**
 * Displace shape geometry by a vector field, BEFORE occlusion — the
 * deformed silhouette is what hides things (occluded shapes peek through).
 * The conscious-choice stage: wrapped shapes' curves shatter into
 * polylines entering the solve, and only they pay for it. Pass
 * `{ field, detail }` to set the resampling spacing (default mm(2)), and
 * `step` to set the pitch the engine samples the field on.
 */
export function deform(
  field: VectorFieldFn | { field: VectorFieldFn; detail?: L; align?: FieldAlign; step?: L },
): ModifierValue;
export function deform(
  field: VectorFieldFn | { field: VectorFieldFn; detail?: L; align?: FieldAlign; step?: L },
  ...children: [Tree, ...Tree[]]
): GroupValue;
export function deform(
  field: VectorFieldFn | { field: VectorFieldFn; detail?: L; align?: FieldAlign; step?: L },
  ...children: Tree[]
): GroupValue | ModifierValue {
  const cfg = typeof field === 'function' ? { field } : field;
  const value: ModifierValue = {
    __occludeModifier: true, kind: 'deform',
    field: cfg.field, detail: cfg.detail, align: cfg.align, step: cfg.step,
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

/** An area that occludes everything beneath it and draws nothing at all.
 * A shape or any other area input answers a shape, a group a group of
 * masks (their union hides), and `invert(area)` a clip that hides the
 * whole drawable outside the area. */
export function mask(area: ShapeValue | AreaInput): ShapeValue;
export function mask(area: GroupValue): GroupValue;
export function mask(area: InvertValue): ClipValue;
export function mask(area: Area): ShapeValue | GroupValue | ClipValue;
export function mask(area: Area): ShapeValue | GroupValue | ClipValue {
  if (isInvertValue(area)) {
    // Everything but the area: an opaque sheet past the drawable on every
    // side, anchored at its corner whatever the sketch's rectMode.
    return clip(area, mask(rect(w(-100), h(-100), w(300), h(300), { mode: 'corner' })));
  }
  if (isGroupValue(area)) return { ...area, children: area.children.map(maskTree) };
  const sv = isShapeValue(area) ? area : areaPath(area, 'mask', 'evenodd');
  return { ...sv, opts: { ...sv.opts, opaque: true, stroke: false, fill: undefined } };
}

/** A group's children as masks, shape by shape. */
function maskTree(tree: Tree): Tree {
  if (!tree) return tree;
  if (Array.isArray(tree)) return tree.map(maskTree);
  if (isShapeValue(tree) || isGroupValue(tree)) return mask(tree);
  throw new Error(`mask: a ${kindOf(tree)} in a group is not an area — a group is an area through the shapes it holds`);
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

/** A geometry by the words a refusal says it in, and the `space` value
 * that draws in it. */
const GEOMETRY_NAME: Record<Space['kind'], string> = {
  euclidean: 'the flat plane',
  hyperbolic: 'hyperbolic space',
  spherical: 'spherical space',
};
const GEOMETRY_SPACE: Record<Space['kind'], string> = {
  euclidean: 'space.euclidean()',
  hyperbolic: 'space.hyperbolic({ radius })',
  spherical: 'space.spherical({ radius })',
};

/** Is this argument a POINT — a pair or an `{x, y}` record — rather than a
 * length? A `Len` is neither an array nor a record of two numbers, so the
 * two spellings of `t.station` never have to guess. */
function isPointArg(v: unknown): v is XY {
  if (Array.isArray(v)) return true;
  if (typeof v !== 'object' || v === null) return false;
  const p = v as { x?: unknown; y?: unknown };
  return typeof p.x === 'number' && typeof p.y === 'number';
}

/** A shape's outlines in sketch units through THE lowerer (rectMode, arc
 * commands, the shape's own transform opts, curves flattened at
 * `tolerance`), each with its own closure. Shared by `material` and
 * `sample`. `'curves'` keeps every straight edge whole, so the outline's
 * vertices are the shape's own in every space; a circle's or an ellipse's
 * outline in a curved space also carries `curve`, the point of the curve
 * itself between two of its vertices. */
function shapeContours(
  run: Execution, source: ShapeValue, tolerance: L | undefined, refine: 'all' | 'curves' = 'all',
  /** Enclosing groups' ops, outermost first: a shape in a group. */
  chain: readonly TransformOp[] = [],
): Outline[] {
  if (!source || typeof source !== 'object' || !('geom' in source) || !('opts' in source)) {
    throw new Error('expected a shape value (circle, rect, path, polygon, …); for points use the pure material(points)');
  }
  const frame = run.frame;
  const unit = unitMm(frame);
  const tol = tolerance !== undefined ? resolveLen(tolerance, frame.inner) : 0.05;
  const pinned = pinShape(run, source);
  const o = pinned.opts;
  const own: TransformOp = { translate: o.translate, rotate: o.rotate, scale: o.scale, origin: o.origin as readonly [L, L] | undefined };
  return lowerToUserContours(
    pinned.geom,
    chain.length === 0 ? own : [...chain, own],
    frame,
    tol,
    refine,
  ).map(({ closed, pts, curve, geodesic }) => {
    const sketch = pts.map(([x, y]) => [x / unit, y / unit] as [number, number]);
    if (!curve) return geodesic ? { closed, pts: sketch, geodesic } : { closed, pts: sketch };
    return {
      closed,
      pts: sketch,
      ...(geodesic ? { geodesic } : {}),
      curve: (seg: number, t: number): [number, number] => {
        const [x, y] = curve(seg, t);
        return [x / unit, y / unit];
      },
    };
  });
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
  /** A material this toolkit hands back, in the run's space: its
   * coordinates are sketch coordinates, so it carries `exec.space` — the
   * flat one too, since a flat material from the toolkit KNOWS it is flat.
   * Every word below that answers a material answers through this. */
  function spaced(m: Material): Material {
    return inSpace(m, exec.space);
  }

  /** Environment handed to the points module: seeded stream, drawable
   * bounds, and sketch-time length resolution (mm via the paper). */
  function pointsEnv(stream = '__points'): import('./points.js').PointsEnv {
    const b = exec.bounds();
    const st = exec.stream(stream);
    return {
      rnd: () => st.rnd(),
      bounds: { x: 0, y: 0, w: b.w, h: b.h },
      len: (l) => exec.len(l),
      space: exec.space,
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
    if (raw?.spacing === undefined) throw new Error('scatter: { spacing } is required');
    const opts: ScatterOpts = raw.within === undefined ? raw : { ...raw, within: numericAreaLoops(exec, raw.within, 'scatter') };
    return spaced(scatterPoints(pointsEnv(), field, opts));
  }

  /** Independent uniform random points, `count` of them: `t.throw({ count })`
   * over the drawable, `t.throw(area, { count })` inside an area, and
   * `t.throw(field, { count, within? })` kept with the chance the field
   * gives at the point. The random counterpart of `scatter`. */
  function throwTk(field: FieldFn2 | undefined, opts: ThrowOpts): Material;
  function throwTk(area: Area, opts: Omit<ThrowOpts, 'within'>): Material;
  function throwTk(opts: ThrowOpts): Material;
  function throwTk(a: FieldFn2 | Area | ThrowOpts | undefined, b?: ThrowOpts | Omit<ThrowOpts, 'within'>): Material {
    const field = typeof a === 'function' ? a : undefined;
    const area = b !== undefined && typeof a !== 'function' && a !== undefined ? (a as Area) : undefined;
    const raw = (b ?? a) as ThrowOpts;
    if (!raw || typeof raw !== 'object' || raw.count === undefined) throw new Error('throw: { count } is required');
    const within = area ?? raw.within;
    const opts: ThrowOpts = within === undefined ? raw : { ...raw, within: numericAreaLoops(exec, within, 'throw') };
    return spaced(throwPoints(pointsEnv('__throw'), field, opts));
  }

  /** Lloyd relaxation: each point to the density-weighted centroid of its
   * cell, `iterations` times; count, edges and columns kept. */
  function relax(m: Material, opts: RelaxOpts = {}): Material {
    const o: RelaxOpts = opts.within === undefined ? opts : { ...opts, within: numericAreaLoops(exec, opts.within, 'relax') };
    return spaced(relaxMaterial(pointsEnv(), materialOf(m as never), o));
  }

  /** Weighted Linde-Buzo-Gray settling toward `density` at `spacing`:
   * relaxation plus population control on point-only material; survivors
   * keep their columns, children copy their parent's, `demand` is written.
   * Split directions come from the sketch's seeded stream. */
  function settle(m: Material, opts: SettleOpts): Material {
    const o: SettleOpts = opts.within === undefined ? opts : { ...opts, within: numericAreaLoops(exec, opts.within, 'settle') };
    return spaced(settleMaterial(pointsEnv(), materialOf(m as never), o));
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
    return spaced(quadtree(points, opts.bounds ?? { x: 0, y: 0, w: b.w, h: b.h }, opts));
  }

  /** One line that folds until it fills an area, as material: a chain of
   * cell centres, one vertex per cell, each carrying the `level` it stopped
   * at, with an elbow at every level change so no step runs diagonally.
   * `spacing` is the finest cell. A `field` of tone, 0 to 1, makes the
   * folds crowd where the picture is dark and open out where it is light,
   * and lifts the pen where it reads 0. `maxSpacing` caps how far they open
   * out. `rule` is the recursion table — `hilbertRule` by default,
   * `peanoRule` and `meanderRule` beside it, and a table of your own if you
   * want another fold. Draw it with `strokes`. */
  function spacefillTk(area: Area, opts: SpacefillOpts): Material {
    return spaced(spacefill({ len: (l: L) => exec.len(l) }, numericAreaLoops(exec, area, 'spacefill'), opts));
  }

  /**
   * The regular `{p, q}` tiling on the drawable: its cell and one
   * `Placement` per copy of it, the identity first.
   *
   * The symbol picks the geometry — `(p − 2)(q − 2)` below 4 is the
   * sphere, exactly 4 the plane, above 4 the hyperbolic disk — and the
   * sketch has to draw in it. This is why the word is on the toolkit: a
   * tiling is written in its geometry's own model chart, and that chart
   * is the sketch's own — the disk of the space's radius, or the sphere it
   * pictures — so every placement is an isometry of the space the sketch
   * draws in, and the cell is one cell of it. A symbol of another geometry
   * is refused by name, with the `space` that draws it.
   *
   * The flat plane fixes no unit of length, so a Euclidean symbol takes
   * one: `side`, or by default half the short side of the drawable, about
   * its middle. That is a size, and every placement is still an isometry
   * of the sheet.
   */
  function tilingTk(p: number, q: number, opts: TilingOpts = {}): Tiling {
    const geometry = tilingGeometry(p, q);
    const sp = exec.space;
    if (sp.kind !== geometry) {
      throw new Error(`tiling: {${p}, ${q}} is a tiling of ${GEOMETRY_NAME[geometry]} and this sketch draws in ${GEOMETRY_NAME[sp.kind]} — set space: ${GEOMETRY_SPACE[geometry]} on the sketch`);
    }
    const side = opts.side === undefined ? undefined : exec.len(opts.side);
    if (opts.rotate !== undefined && !Number.isFinite(opts.rotate)) throw new Error(`tiling: rotate is an angle in degrees, got ${describeValue(opts.rotate)}`);
    // The turn about the cell's centre: the identity when there is none, so
    // an unturned tiling is the one it always was.
    // A quarter turn is exact, so a wall that should stand upright does.
    const deg = opts.rotate ?? 0;
    const quarter = deg % 90 === 0 ? (((deg / 90) % 4) + 4) % 4 : -1;
    const cos = quarter >= 0 ? [1, 0, -1, 0][quarter] : Math.cos(radians(deg));
    const sin = quarter >= 0 ? [0, 1, 0, -1][quarter] : Math.sin(radians(deg));
    const turn = deg === 0
      ? (z: XY): Vec => [vx(z), vy(z)]
      : (z: XY): Vec => [cos * vx(z) - sin * vy(z), sin * vx(z) + cos * vy(z)];
    const chart = modelChart(sp);
    if (!chart) {
      const b = exec.bounds();
      const k = side ?? Math.min(b.w, b.h) / 2;
      checkOrigin('tiling', opts.origin);
      const [ox, oy] = opts.origin === undefined || opts.origin === 'center' || opts.origin === 'centroid'
        ? [b.cx, b.cy] : [vx(opts.origin as XY), vy(opts.origin as XY)];
      return tilingKernel(p, q, opts, { door: sp.model, up: (z: XY): Vec => { const t = turn(z); return [ox + k * t[0], oy + k * t[1]]; }, bow: 0, space: sp });
    }
    if (opts.origin !== undefined) {
      throw new Error(`tiling: a ${GEOMETRY_NAME[geometry]} tiling stands on its chart's centre — move it with a placement, group(placement, …), not origin`);
    }
    // A curved symbol takes its unit from its curvature: the model chart
    // is the sketch's own chart, so the model point goes through it and
    // out the other side, into the coordinates everything else speaks.
    const [cx, cy] = chart.center;
    const k = chart.scale;
    const up = (z: XY): Vec => { const t = turn(z); return sp.fromChart([cx + k * t[0], cy + k * t[1]]); };
    if (side !== undefined) {
      const model = cellOf(geometry, p, q);
      const fixed = sp.distance(up(model[0]), up(model[1]));
      throw new Error(`tiling: {${p}, ${q}} has the side its curvature fixes, ${fixed.toFixed(2)} here — leave side out`);
    }
    // A wall's stored chords are judged in the metric, where no placement
    // can change them, to the bow the widest part of the chart allows.
    return tilingKernel(p, q, opts, { door: sp.model, up, bow: geodesicBow(sp, exec.frame), space: sp });
  }

  /**
   * The distance field of an area IN THE SKETCH'S SPACE: the metric the
   * frame names, not the sheet's.
   *
   * The area is lowered the one way every area is lowered — the boundary
   * the ink door draws, in sketch coordinates — and read as a polygon
   * whose edges are GEODESICS: the value at a point is its distance to the
   * nearest of them, positive inside. That is exact for a convex cell of
   * geodesics, and as close as the boundary's own sampling for anything
   * else, so a circle and a tiling cell need no word of their own.
   */
  /**
   * `t.distanceTo(points)` in a curved space: zero at a point and minus the
   * space's distance to the nearest point everywhere else — the sign
   * `distanceToPoints` has, measured along geodesics. The pure word reads
   * the chart; this one reads the space, so a ring about every site has
   * one radius of the space wherever the site is.
   *
   * In the disk a space length is never shorter than its coordinate
   * length, so a site further off in coordinates than the best found so
   * far cannot win and is skipped unmeasured.
   */
  function spaceDistanceToPoints(space: Space, points: PointSelection<unknown> | Material): DistanceField {
    const m = points instanceof Material ? points : points.extract();
    const sx: number[] = [];
    const sy: number[] = [];
    for (let i = 0; i < m.n; i++) {
      if (!Number.isFinite(m.x[i]) || !Number.isFinite(m.y[i])) continue;
      sx.push(m.x[i]);
      sy.push(m.y[i]);
    }
    if (sx.length === 0) return () => -Infinity;
    const bounded = space.kind === 'hyperbolic';
    return (x, y) => {
      let best = Infinity;
      for (let i = 0; i < sx.length; i++) {
        if (bounded && Math.hypot(sx[i] - x, sy[i] - y) >= best) continue;
        const d = space.distance([x, y], [sx[i], sy[i]]);
        if (d < best) best = d;
      }
      return -best;
    };
  }

  function spaceDistanceTo(space: Space, area: Area): DistanceField {
    // A shape says whether each of its outlines closes; anything else is
    // an area, and an area's boundaries are loops.
    const contours: SpaceContour[] = isShapeValue(area)
      ? shapeContours(exec, area as ShapeValue, undefined).map((c) => ({ pts: c.pts, closed: c.closed }))
      : numericAreaLoops(exec, area, 'distanceTo').map((pts) => ({ pts, closed: true }));
    return spaceAreaField(space, contours);
  }

  /**
   * A string as material: every glyph of the face drawn as the chains it
   * is made of, all in one material, ready for `strokes(...)`. `size` is
   * the CAP HEIGHT — the letter height a plotter artist measures — and
   * `at` puts the start of the first baseline somewhere; the sketch can
   * also move the result with the ordinary words. `\n` breaks lines at
   * `leading`, `tracking` letterspaces, `align` anchors, and `along` sets
   * the line on a chain instead of a straight baseline. `font` defaults to
   * the built-in Hershey roman simplex; `occlude/fonts` holds the other
   * faces, and `strokeFont(t.asset('my-face.svg'))` reads your own. Every
   * point carries a `glyph` column: the index into `str` of the character
   * it belongs to. A material never draws itself.
   */
  function text(str: string, opts: TextOpts): Material {
    return spaced(textOf({ len: (l: L) => exec.len(l), font: hersheySimplex }, str, opts));
  }

  function voronoiTk(sites: PointsLike, opts: { bounds?: PointBounds; within?: Area } = {}): Material {
    const b = exec.bounds();
    // The sites as the pure `voronoi` reads them: a selection stays the
    // sites, anything else becomes a material. The cells are made in the
    // run's space, and their site correspondence lives on that material.
    const siteSet = sites instanceof PointSelection ? sites : materialOf(sites);
    if (opts.within === undefined) return voronoiOf(siteSet, opts.bounds ?? { x: 0, y: 0, w: b.w, h: b.h }, exec.space);
    const region = withinRegion(numericAreaLoops(exec, opts.within, 'voronoi'), 'voronoi', opts.bounds);
    if (region.loops) {
      throw new Error('voronoi: within needs a rectangle — a cell is clipped to a box; for any other area, clip the cells afterwards: within(t.voronoi(sites), area)');
    }
    return voronoiOf(siteSet, region.bounds, exec.space);
  }

  /**
   * Contours as one material: each contour a chain (a ring when closed), in
   * the order they came, never joined to each other. (`t.isolines` builds
   * its own, with the `level` and `cut` edge columns: `levelMaterial`.)
   */
  function contourMaterial(contours: readonly IsoContour[]): Material {
    let n = 0;
    let e = 0;
    for (const c of contours) {
      n += c.pts.length;
      e += c.closed && c.pts.length > 2 ? c.pts.length : Math.max(0, c.pts.length - 1);
    }
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    const edges = new Uint32Array(2 * e);
    let vi = 0;
    let ei = 0;
    for (const c of contours) {
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
        ei++;
      }
    }
    return new Material(x, y, {}, edges, { iteration: 0, history: [], edgeAttrs: {}, transfers: {}, edgeTransfers: {} });
  }

  /**
   * A grid of named channels over an area, and a rule you step it with:
   * the substrate for reaction-diffusion, trails, erosion — anything whose
   * next state is a local rule over its current one. `spacing` is the cell
   * size, `area` defaults to the drawable, `channels` defaults to `['a']`,
   * and `init` fills each cell from its centre. `lat.field(channel)` hands
   * it back as an ordinary field, absent outside the area, so `isolines`,
   * `scatter` and the fills read it like any other. `lat.steps(n, rule)`
   * and `lat.add(points, amount)` return a NEW lattice.
   */
  function lattice(opts: LatticeOpts, init?: LatticeInit): Lattice {
    const b = exec.bounds();
    const env = { bounds: { x: 0, y: 0, w: b.w, h: b.h }, len: (l: L) => exec.len(l) };
    const o: LatticeOpts = opts?.area === undefined ? opts : { ...opts, area: numericAreaLoops(exec, opts.area, 'lattice') };
    return latticeOf(env, o, init);
  }

  /**
   * Ink as a budget: `field` is the tone the drawing owes, 0 to 1, and the
   * residual holds what is still owed on a grid of cells. `spacing` is the
   * cell size (default the grid step `t.isolines` uses), and `area` bounds
   * what owes anything — outside it nothing is owed.
   *
   * A residual IS a field: `r(x, y)` is the remaining tone there, so
   * `t.scatter(r)`, `t.isolines(r, …)` and a decimate amount read it like
   * any other. `r.spend(marks, { width })` subtracts the nib footprint of
   * what was drawn and answers with the darkness taken, in cell areas;
   * `r.total()` is the debt that is left, for the loop's stopping test.
   *
   * `spend` mutates, and it is the one value in the library that does: a
   * ledger has to remember what the last stroke paid, and copying a raster
   * per stroke would make a long loop quadratic. `r.snapshot()` is the
   * frozen copy. The seed still decides everything: the ledger is a pure
   * function of the sequence of spends.
   */
  function residual(field: FieldFn2, opts: ResidualOpts = {}): Residual {
    const b = exec.bounds();
    const env = { bounds: { x: 0, y: 0, w: b.w, h: b.h }, len: (l: L) => exec.len(l) };
    const o: ResidualOpts = opts?.area === undefined ? opts : { ...opts, area: numericAreaLoops(exec, opts.area, 'residual') };
    return residualOf(env, field, o);
  }

  /** The level sets of `{ field ≥ at }` via marching squares over the
   * drawable, as one material: each region's boundary a ring, separate
   * regions separate, every edge carrying its `level`. A region the drawable
   * (or the field's `t.within` bound) cuts closes along that edge, through
   * every corner it passes; those closing edges carry `cut` = 1 and the level
   * line itself `cut` = 0. `polygon(m)` fills the regions, `strokes(m)` draws
   * their whole boundary, and `strokes(m.edges.filter((e) => !e.attrs.cut))`
   * draws the level line alone. Pick levels with `m.edges.filter((e) =>
   * e.attrs.level === 0.4)` or `m.edges.groupBy((e) => e.attrs.level)`, or
   * step it like any material. An `at` array marches every level over one
   * shared field sampling, in the order given; `{ count }` spreads that many
   * levels evenly inside the field's own sampled range, and `{ spacing }`
   * takes every multiple of it (shifted by `offset`) inside that range. A
   * bound field is sampled over its bound's box, not the whole drawable. */
  function isolines(field: FieldFn2, at: IsoLevels, opts: IsoOpts = {}): Material {
    const b = exec.bounds();
    const env = { bounds: { x: 0, y: 0, w: b.w, h: b.h }, len: (l: L) => exec.len(l) };
    return spaced(levelMaterial(levelContours(env, field, at, opts, boundDomain(field, env.bounds))));
  }

  /** Where a bound field can exist: the box its `within` bounds share with
   * the drawable, and the bounds' own loops, in the field's coordinates. A
   * field with no bound is the whole drawable, and has no walls. */
  function boundDomain(field: FieldFn2, drawable: { x: number; y: number; w: number; h: number }): IsoDomain | undefined {
    const bounds = fieldMeta(field).bounds;
    if (bounds.length === 0) return undefined;
    let x0 = drawable.x;
    let y0 = drawable.y;
    let x1 = drawable.x + drawable.w;
    let y1 = drawable.y + drawable.h;
    const walls: [number, number][][] = [];
    for (const bound of bounds) {
      // The bound's coordinates are where the field reads it; the field's
      // own are those back through every verb applied since.
      const back = invertMat(bound.toBound());
      const loops = numericAreaLoops(exec, bound.shape, 'isolines').map((loop) => loop.map(([x, y]) => applyMat(back, x, y)));
      let bx0 = Infinity;
      let by0 = Infinity;
      let bx1 = -Infinity;
      let by1 = -Infinity;
      for (const loop of loops) for (const [x, y] of loop) {
        bx0 = Math.min(bx0, x); by0 = Math.min(by0, y);
        bx1 = Math.max(bx1, x); by1 = Math.max(by1, y);
      }
      x0 = Math.max(x0, bx0); y0 = Math.max(y0, by0);
      x1 = Math.min(x1, bx1); y1 = Math.min(y1, by1);
      walls.push(...loops);
    }
    return { box: { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }, walls };
  }

  /** The crest lines of a scalar field over the drawable, as one material:
   * each ridge a chain (a ring when it closes, as a crater rim does),
   * separate ridges separate, every vertex carrying `strength` — how sharply
   * the ground falls away to either side — and `height`, the field's own
   * value there. `t.isolines` says where the field is a given height; this
   * says where it runs along a top. Valleys are the ridges of the negated
   * field, so there is no option for them. Nothing is thresholded: pick with
   * `m.points.filter((p) => p.strength > x).edges.extract()`.
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
    return new Material(x, y, { strength, height }, edges, { iteration: 0, history: [], edgeAttrs: {}, transfers: { strength: 'interpolate', height: 'interpolate' }, edgeTransfers: {}, space: exec.space });
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
    return spaced(contourMaterial(streamlinesOf(env, field, opts)));
  }

  /** How long the front takes to reach each point of the drawable, as a
   * plain field. The source is NAMED, never inferred: `{ fromPoints }`
   * reads every entry as a separate seed whatever its spelling, and
   * `{ fromArea }` reads its input — an area or a shape — as one area.
   * Exactly one of the two.
   * `distanceTo` measures the straight line and walks through walls; this
   * measures the walk. `speed` is a number or a field (default 1), and a
   * speed of zero or less is a WALL the front goes around; `within` is the
   * ground it may cross, the drawable by default. Arrival rings are
   * `t.isolines(T, …)`; unreachable ground is `+Infinity`, so contours stop
   * at a barrier instead of crossing it. With speed 1 and nothing in the
   * way it is unsigned distance. Deterministic, no seed. */
  function travelTime(opts: TravelTimeOpts): FieldFn {
    if (!isTravelOpts(opts) || arguments.length > 1) {
      throw new Error('travelTime: the source goes in the options record — t.travelTime({ fromPoints }) or t.travelTime({ fromArea })');
    }
    const bounds = exec.bounds();
    // The march measures in the run's space: an arrival time is a length
    // of the space over the speed.
    const env = { bounds: { x: 0, y: 0, w: bounds.w, h: bounds.h }, len: (l: L) => exec.len(l), space: exec.space };
    const within = opts.within === undefined
      ? undefined
      : (lowerShape(exec, opts.within, 'travelTime') as AreaInput);
    const points = opts.fromPoints !== undefined;
    const area = opts.fromArea !== undefined;
    if (points === area) throw new Error('travelTime: give fromPoints or fromArea, not both');
    // Each key says what its input IS, so neither reading is inferred: a
    // pair under `fromPoints` is one seed, and points under `fromArea`
    // are one loop, through the ordinary area door.
    const seeds: TravelFrom = points
      ? seedRecords(opts.fromPoints!)
      : (numericAreaLoops(exec, opts.fromArea!, 'travelTime') as unknown as TravelFrom);
    return travelTimeOf(env, seeds, { ...opts, within });
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
   *
   * Any `Area` enters here, through the one lowering: a group's shapes
   * through its transform (an svg import, a placed shape), a face as its
   * walls with their ids, loops and contour records one ring or chain each,
   * `invert(area)` as the drawable with the area taken out, and a material
   * as the material it already is.
   */
  function materialFromShape(...areas: Area[]): Material;
  function materialFromShape(...args: [...Area[], { tolerance?: L }]): Material;
  function materialFromShape(...args: (Area | { tolerance?: L })[]): Material {
    const last: unknown = args[args.length - 1];
    // Only a trailing plain object that is no area is options; anything else
    // (a contour record, loops, a face) is judged as an area, so the error
    // names what it saw.
    const trailingOpts = last !== null && typeof last === 'object' && Object.getPrototypeOf(last) === Object.prototype
      && !('__occludeShape' in last) && !('__occludeGroup' in last) && !('__occludeInvert' in last) && !('pts' in last);
    const opts: { tolerance?: L } = trailingOpts ? (last as { tolerance?: L }) : {};
    const areas = (trailingOpts ? args.slice(0, -1) : args) as Area[];
    // No areas (a spread of an empty list) is the empty material.
    if (areas.length === 0) return spaced(materialOf([]));
    // A material is already material, and a face's walls are material with
    // their ids: both come back as they are. Every other area is its
    // outlines, and a run of those is one material, built at once.
    const pieces: Material[] = [];
    let run: Outline[] = [];
    const flush = (): void => {
      if (run.length > 0) pieces.push(outlineMaterial(run));
      run = [];
    };
    for (const area of areas) {
      if (area instanceof Material) {
        flush();
        pieces.push(area);
      } else if (isFace(area)) {
        flush();
        pieces.push(area.boundaryEdges.extract());
      } else {
        run.push(...areaOutlines(exec, area, 'material', opts.tolerance, 'curves'));
      }
    }
    flush();
    return pieces.length === 1 ? pieces[0] : spaced(append(...pieces));
  }

  /** Outlines as one material, each a ring or a chain, welding nothing. */
  function outlineMaterial(outlines: readonly Outline[]): Material {
    const pts: [number, number][] = [];
    const edges: [number, number][] = [];
    // In a curved space every edge says what it is: a geodesic of the
    // space (the edges of a line, a circle, an ellipse, an ngon), or the
    // image of its coordinate segment (a rect's, a path's, a polygon's).
    // The flat plane has no difference to say, and writes nothing.
    const curved = exec.space.kind !== 'euclidean';
    const geodesic: number[] = [];
    // The shape's own vertices in every space: a straight edge is kept
    // whole, and the ink door samples it when the material is drawn.
    for (const c of outlines) {
      const flag = (k: number): number => (c.geodesic?.[k] ? 1 : 0);
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
        if (k > 0) {
          edges.push([first + k - 1, first + k]);
          geodesic.push(flag(k - 1));
        }
      }
      // The closing edge is the outline's last segment: back onto the seam
      // the ring dropped, or the implicit one when there was none.
      if (c.closed && poly.length > 2) {
        edges.push([first + poly.length - 1, first]);
        geodesic.push(flag(poly.length - 1));
      }
    }
    const m = materialOf(pts, { edges });
    return spaced(curved ? m.edgeAttribute('geodesic', (e) => geodesic[e.index]) : m);
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
  function sample(area:Area,options:{count?:number;spacing?:L;tolerance?:L}):Material;
  function sample(shape:Material,options:{count?:number;spacing?:L}):Material;
  function sample(
    shape: Area | Material | Mesh<any,any,any> | SurfaceCurves<any>,
    options: { count?: number; spacing?: L; tolerance?: L } | SurfaceSamplingOptions<any> | CurveSamplingOptions = {},
  ): Material | SurfaceSamples<any,any,any,any> | CurveSamples<any,any> {
    if(shape instanceof SurfaceCurves)return sampleSurfaceCurves(shape,options as CurveSamplingOptions);
    // A material is already geometry: redistributing along its chains by arc
    // length is `resample`, the same door in the material's own world. The
    // toolkit form exists so one word means one thing whatever it is given.
    if(shape instanceof Material){
      // A length is a drawing unit; the material's own coordinates are what
      // `resample` counts in, so it is resolved through the frame exactly as
      // a shape's spacing is.
      const opts=options as {count?:number;spacing?:L};
      const spacing=opts.spacing===undefined?undefined:resolveLen(opts.spacing,exec.frame.inner)/unitMm(exec.frame);
      // The space is frame data and a material has no frame, so the toolkit
      // hands the run's own in with the spacing.
      return spaced(shape.resample(spacing===undefined?{count:opts.count,space:exec.space}:{spacing,space:exec.space}));
    }
    if(shape instanceof Mesh){const opts=options as SurfaceSamplingOptions<any>;return sampleSurfacePoints(shape,opts,{rnd:exec.stream('__surface-sample:'+(opts?.key??shape.key??'default')).rnd,signal:scope?.signal});}
    const opts=options as {count?:number;spacing?:L;tolerance?:L};
    const frame = exec.frame;
    const unit = unitMm(frame);
    const spacingU = opts.spacing !== undefined ? resolveLen(opts.spacing, frame.inner) / unit : undefined;
    // A spacing that resolves to nothing, or a count with fewer than two
    // samples in it, samples nothing: an empty material, not a failed sketch.
    if (!checkSampling('sample', { count: opts.count, spacing: spacingU })) return spaced(materialOf([]));
    const pts: [number, number][] = [];
    const edges: [number, number][] = [];
    // Each outline keeps its OWN closure: a path may hold a ring and a chain.
    // A bare `spacing` is a length in the space, so the arc length between
    // two samples is the space's own and a sample between two vertices sits
    // on the geodesic. Euclidean: the literal `Math.hypot` sum of
    // `chainLengths` and the literal lerp below.
    const curved = exec.space.kind !== 'euclidean' ? exec.space : null;
    for (const { pts: poly, closed, curve } of areaOutlines(exec, shape, 'sample', opts.tolerance, 'all')) {
      const samples = alongChain(poly, closed, { count: opts.count, spacing: spacingU, space: exec.space });
      const first = pts.length;
      for (let k = 0; k < samples.length; k++) {
        const { seg, t } = samples[k];
        const [x0, y0] = poly[seg];
        const [x1, y1] = poly[(seg + 1) % poly.length];
        // A circle or an ellipse in a curved space: the sample is ON the
        // curve, a step from its centre, and not on a chord of it.
        if (curve) {
          pts.push(curve(seg, t));
        } else if (curved) {
          const g = curved.geodesic([x0, y0], [x1, y1], t);
          pts.push([g[0], g[1]]);
        } else {
          pts.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
        }
        if (k > 0) edges.push([first + k - 1, first + k]);
      }
      if (closed && samples.length > 2) edges.push([first + samples.length - 1, first]);
    }
    return spaced(materialOf(pts, { edges }));
  }

  /**
   * A station at a point of the sketch, facing `heading` DEGREES (as
   * `turn` and `rotate`, positive counter-clockwise), 0 by default: where
   * a walk starts. The space is the sketch's own, so `station.step` and
   * `station.turn` walk in the geometry the sketch draws in.
   */
  function station(x: L, y: L, opts?: { heading?: number }): Station;
  /** The same station at a point — a pair or an `{x, y}` record, so a
   * station or a centroid goes straight in. The two spellings are told
   * apart by the first argument being a point, never by guessing. */
  function station(point: XY, opts?: { heading?: number }): Station;
  function station(a: L | XY, b?: L | { heading?: number }, c?: { heading?: number }): Station {
    const point = isPointArg(a);
    const opts = (point ? b : c) as unknown;
    if (opts !== undefined && (typeof opts !== 'object' || opts === null)) {
      throw new Error('t.station: the heading goes in the options record, in degrees — t.station(x, y, { heading: 90 })');
    }
    const heading = radians((opts as { heading?: number } | undefined)?.heading ?? 0);
    if (point) return stationAt(vx(a), vy(a), heading, exec.space);
    return stationAt(exec.len(a), exec.len(b as L), heading, exec.space);
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
    exec.planOptions = checkPlanOptions(opts);
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
  /** Seeded simplex noise in [-1, 1]: `noise(x, y?, z?)`, or a point row or
   * triple with `{ wavelength, amount }` so a field reads
   * `p => t.noise(p, { wavelength: 40, amount: 3 })`. Two coordinates read
   * a plane, three read a solid that changes at one rate in every axis; a
   * 2D row reads the plane and a 3D row the solid. */
  function noise(x: number, y?: number, z?: number): number;
  function noise(point: NoisePoint, options?: NoiseOptions): number;
  function noise(a: number | NoisePoint, b?: number | NoiseOptions, c?: number): number {
    if (typeof a === 'number') return exec.noise(a, (b as number | undefined) ?? 0, c);
    const row = a as { readonly x: number; readonly y: number; readonly z?: number };
    const [x, y, z] = Array.isArray(a) ? [a[0], a[1], a[2]] : [row.x, row.y, row.z];
    const options = (b as NoiseOptions | undefined) ?? {};
    const wavelength = options.wavelength ?? 1, amount = options.amount ?? 1;
    // No wavelength to walk, or no amount to give: no noise here. The field
    // stays flat where it cannot be read.
    if (!(wavelength > 0) || !Number.isFinite(amount)) return 0;
    return amount * exec.noise(x / wavelength, y / wavelength, z === undefined ? undefined : z / wavelength);
  }
  const b0 = exec.bounds();
  const within = ((x: never, area: Area, opts?: never) => withinAny(exec, x, area, opts)) as Within;
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
    /** A whole number from the seeded stream, one draw: `rndInt(n)` is
     * 0 … n−1, `rndInt(a, b)` is a … b with both ends in. */
    rndInt: ((a: number, b?: number): number => (b === undefined ? exec.rndInt(a) : exec.rndInt(a, b))) as Execution['rndInt'],
    /** A normal draw from the seeded stream: most within one `sd` of
     * `mean`, a few far out, and no bound at all — the jitter that has a
     * typical size rather than a range. `t.rnd(a, b)` is the flat one. */
    gaussian: (mean = 0, sd = 1): number => exec.gaussian(mean, sd),
    pick: <T,>(items: Pickable<T>): T => exec.pick(items),
    chance: (p: number): boolean => exec.chance(p),
    prob: <T,>(p: number, fn: () => T, elseFn?: () => T): T | undefined => exec.prob(p, fn, elseFn),
    noise,
    stream: (name: string) => exec.stream(name),
    /** The seed this run resolved: the config's own, or the host's when
     * the config says `'url'` or names none. Read-only: the run holds it. */
    get seed(): number | string {
      return exec.seedUsed;
    },
    /** Drawable extent in bare units — the same numbers `bounds()` returns. */
    bounds: () => exec.bounds(),
    /** Resolve a length to bare units — for sketch-time math on physical
     * sizes (a bare number comes back unchanged). */
    len: (l: L): number => exec.len(l),
    width: b0.w,
    height: b0.h,
    cx: b0.cx,
    cy: b0.cy,
    /**
     * The geometry this run draws in, as data: its `kind`, its
     * `projection`, its `curvature` and `radius`, and the metric itself —
     * `distance`, `geodesic`, `circle`, `density`, `exp`, `log`,
     * `project`. Euclidean unless the sketch's config names a `space`.
     * Read-only: the space is a frame setting, fixed for the run.
     */
    get space(): Space {
      return exec.space;
    },
    /** Cell rectangles covering the whole drawable. */
    grid: (opts: GridOptions): GridCell[] => gridCells(exec.bounds(), opts),
    /** Hexagonal cells covering the drawable as one material: `m.faces()`
     * are the cells, a shared wall is ONE edge, and each face carries its
     * axial `i` and `j`. `gap` shrinks each cell about its centre, and a
     * gapped cell shares nothing. */
    hexes: (opts: HexOptions): Material => spaced(hexCells({ bounds: exec.bounds(), len: (l: L) => exec.len(l) }, opts)),
    /** Triangular cells covering the drawable as one material, read exactly
     * as `hexes`: each face carries its row `j` and its index `i` along that
     * row, where an even `i` points up. */
    triangles: (opts: TriangleOptions): Material => spaced(triangleCells({ bounds: exec.bounds(), len: (l: L) => exec.len(l) }, opts)),
    /** The placements of one of the seventeen wallpaper groups, enough of
     * them to cover the drawable: hand each to `group(placement, motif)`
     * and the motif repeats under the group. `cell` is `[w, h]` for a
     * rectangular lattice and one length for a hexagonal one. */
    symmetry: (group: PlaneGroup, opts: { cell: number | readonly [number, number] }): TransformOp[] => {
      const b = exec.bounds();
      const [ax, by] = symmetryCellStep(group, opts.cell);
      if (!(ax > 0) || !(by > 0)) return [];
      // One ring past the drawable on every side: a mirrored or turned copy
      // of the first cell lands in the one before it.
      return symmetryPlacements(group, opts.cell, -1, Math.ceil(b.w / ax) + 2, -1, Math.ceil(b.h / by) + 2);
    },
    tiling: tilingTk,
    noisyLine: (x1: L, y1: L, x2: L, y2: L, o?: Parameters<typeof noisyLineValue>[5], shapeOpts?: ShapeOpts): ShapeValue => noisyLineValue(noise, x1, y1, x2, y2, o, shapeOpts),
    svg: svgValue,
    scatter, throw: throwTk, isolines, ridges, streamlines, travelTime,
    lattice,
    residual,
    /** An area's boundary as material with the boundary's OWN vertices,
     * curves flattened. `sample` redistributes instead. */
    material: materialFromShape,
    sample, station, probe, inspect, plan: planWith, draw, relax, settle, voronoi: voronoiTk, quadtree: quadtreeTk, spacefill: spacefillTk,
    text,
    /**
     * The distance field of an area, taking a shape as well as resolved
     * geometry: inside the sketch the frame is in hand, so the toolkit
     * lowers the shape and the pure `distanceTo` never has to.
     */
    distanceTo: (area: Area): DistanceField => {
      // Points have no inside: a point selection, or a material that is
      // points alone, is measured to its nearest point.
      if (area instanceof PointSelection || (area instanceof Material && area.edgeCount === 0)) {
        return exec.space.kind === 'euclidean' ? distanceToPoints(area) : spaceDistanceToPoints(exec.space, area);
      }
      return exec.space.kind === 'euclidean'
        ? distanceTo(lowerShape(exec, area, 'distanceTo') as AreaInput)
        : spaceDistanceTo(exec.space, area);
    },
    /**
     * The forces, each taking a shape where it takes an area or points. The
     * pure `force.*` is the same kernel with the frame left out.
     */
    force: {
      ...force,
      /**
       * A boundary force from an area, taking a shape: an area's resolution
       * is what a flattening tolerance is for, so lowering one here means
       * what it means everywhere else.
       */
      boundary: (area: Area, opts: { radius: number; strength?: number }) =>
        boundaryIn(lowerShape(exec, area, 'force.boundary') as AreaInput, opts, exec.space),
      separation: (sources: Sources | ShapeValue, opts: { radius: number; excludeConnected?: boolean }) =>
        separationIn(pointSources(sources, 'force.separation'), opts, exec.space),
      attract: (sources: Sources | ShapeValue, opts: { radius: number; strength?: number; excludeConnected?: boolean }) =>
        attractIn(pointSources(sources, 'force.attract'), opts, exec.space),
      /** A turn about a centre: a centre is a bare point, so the toolkit
       * hands it the sketch's space. */
      vortex: (centre: XY, opts: { strength: number; falloff?: number }) => vortexIn(centre, opts, exec.space),
    },
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
  next.planOptions = previous.planOptions && clonePlanOptions(previous.planOptions);
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
    const g = pinGroup(exec, tree as GroupValue);
    const inner: EmitCtx = {
      pen: g.opts.pen ?? ctx.pen,
      z: g.opts.z ?? ctx.z,
      decimate: g.opts.decimate ?? ctx.decimate,
      wobble: g.opts.wobble ?? ctx.wobble,
      bridge: g.opts.bridge ?? ctx.bridge,
      // Function-application order: deeper stacks run before shallower.
      modifiers: g.opts.modifiers ? [...g.opts.modifiers, ...ctx.modifiers] : ctx.modifiers,
    };
    // A placement never shares a group with the affine keys (`group`
    // refuses the two together), so it pushes an op of its own.
    const op = groupOp(g);
    if (op) {
      exec.push(op, () => {
        for (const child of g.children) emit(exec, child, inner);
      });
    } else {
      for (const child of g.children) emit(exec, child, inner);
    }
    return;
  }
  if ((tree as ClipValue).__occludeClip) {
    const c = tree as ClipValue;
    const region = areaAsShape(exec, c.region, 'clip');
    // Capture the region's own transform without applying it to children.
    const { translate, rotate, scale, origin } = region.opts;
    let regionShape!: Shape;
    exec.push({ translate, rotate, scale, origin: origin as readonly [L, L] | undefined }, () => {
      regionShape = new Shape(region.geom, exec);
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
      'invert() is an area, not a drawable — use it as clip(invert(area), ...) or mask(invert(area))',
    );
  }
  emitShape(exec, tree as ShapeValue, ctx);
}

function emitShape(exec: Execution, given: ShapeValue, ctx: EmitCtx): void {
  const sv = pinShape(exec, given);
  const o = sv.opts;
  checkFillOpaque(o);
  if (o.translate || o.rotate !== undefined || o.scale !== undefined) {
    const { translate, rotate, scale, origin } = o;
    exec.push({ translate, rotate, scale, origin: origin as readonly [L, L] | undefined }, () =>
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
