/**
 * occlude — a drawing library for pen plotters where `fill` means fill.
 *
 * A sketch is a pure function from a toolkit to a tree of shape values:
 *
 *   export default sketch({ aspect: [1, 1], margin: 6 }, (t) => {
 *     const b = t.bounds();
 *     return t.times(24, () =>
 *       circle(t.rnd(b.w), t.rnd(b.h), t.rnd(6, 22), { fill: fill('hatch', { angle: t.rnd(180) }) }));
 *   });
 *
 * Shapes, fills and modifiers are imports; what reads the seed or the paper
 * is on the toolkit `t`.
 *
 * Filled/opaque shapes hide what is beneath them. A host (`occlude/host`)
 * compiles, renders and exports a sketch: `render()` computes the exact
 * visible strokes and `exportGcode()` emits per-pen G-code.
 *
 * The imperative machinery underneath is internal — this module is what a
 * sketch (and a fill file) can use.
 */

// The declarative API.
export {
  sketch,
  circle, ellipse, rect, line, polygon, ngon, stroke, strokes, dots, path, PathValue,
  group, clip, mask, invert, decimate, wobble, dash, smooth, roughen, deform,
  times, range,
} from './api.js';
export type {
  SketchDef, SketchConfig, Toolkit, Tree,
  ShapeValue, ShapeOpts, PolygonOpts, Contour, GroupValue, GroupOpts, ClipValue, InvertValue, WithinKeep, Area,
} from './api.js';
export type { ModifierValue, FieldFn, VectorFieldFn, Origin } from './shapes.js';

// Fills are pure data (module reference + params) or plain functions.
// Built-ins resolve from the package; the registry a host loads custom
// fills into is `occlude/host`.
export { fill, fillAsset, rulings } from './fills.js';
export type { FillAssetDef, FillCtx, FillAnchor, RulingOpts } from './fills.js';
export type { FieldAlign } from './shapes.js';
export { svg } from './svgin.js';
export {
  type ImageSampler, type ImagePlacement, type AssetPixels, type ImageChannel,
  type PaletteEntry, type PaletteSource, type ImageRegion, type RegionOpts,
} from './imageAsset.js';
export type { ColourSpace } from './colour.js';
export { label, labelWidth } from './font.js';
export { strokeFont } from './strokeFont.js';
export type { Font, Glyph, TextOpts } from './strokeFont.js';
export { synth, probe as probeExpression } from './synth.js';
export type { SynthFn, SynthOpts, SynthStats, SynthBounds, WarpFn } from './synth.js';
export type { LabelOpts } from './font.js';
export type { FillSpec, CustomFillFn, CustomPrimitive, FillRegion, FillParams, BuiltinFillName, HatchParams, CrosshatchParams, SolidParams, StippleParams, ContourParams } from './fills.js';

// Material: meshes with columns and connections — hold, connect, write,
// resample, reinterpret (pure; the toolkit's t.sample turns a shape into
// material with its outline's connectivity).
export {
  material, curve, append, connect, Material, extent,
} from './material.js';
export { add, sub, mul, length, distance, unit, perp, dot, cross, fromAngle, angleOf, polar, angleTo, sum, sumBy, turn, lerp, reflect, angleBetween } from './vec.js';
export { force, GraphForce } from './forces.js';
export type { Amount, SeparationOpts } from './forces.js';
// The value you hold is the name: a point or an edge made here names the
// row it becomes in every later state and every write.
export { point, edge } from './tables.js';
export type { PointValue, EdgeValue, PointEnd, EdgeEnd, EdgeRowSpec, PointWhere, EdgeWhere, ColumnValue, Displacement, ReplaceOpts } from './tables.js';
export type { EdgeTransfer } from './material.js';
// Same-world transforms are methods on Material now (`m.thicken(opts)`),
// so only their options types are exported.
export type { ThickenOpts } from './thicken.js';
export type { QuadtreeOpts } from './quadtree.js';
// The fold tables are plain data: read one, edit it, or write your own.
export { hilbertRule, peanoRule, meanderRule } from './spacefill.js';
export type { SpacefillOpts, SpacefillRule, SpacefillTurn } from './spacefill.js';
export type { TrailsOpts } from './trails.js';
export type { WarpOpts, Corner } from './warp.js';
export type { RidgeOpts } from './ridges.js';
export type { InterlaceOpts, Crossing } from './interlace.js';
export type { OscillateOpts, OscillateAmount } from './oscillate.js';
export type { MergeOpts } from './merge.js';
// One selection over every domain: `m.points`, `m.edges`, `m.faces`,
// `l.faces`, and every part of one a sketch picks out.
export type { Selection, Keyed } from './selection.js';
export type { Face, FaceWhere, PlanarizeOpts, PlanarEvent, EventCandidate } from './faces.js';
export type { NearestHit, FirstHit } from './query.js';
export type {
  Vertex, Edge, Transfer, PointTransfer, PointsLike,
} from './material.js';
// The ordered domain: `g.curves`, a selection of curve rows.
export type { Curve } from './curves.js';
export type { NeighbourStats, Sources } from './forces.js';
export type { Vec, XY, XYZ } from './vec.js';

// Units.
export { w, h, s, mm, inch, degrees, radians, Len } from './units.js';
export type { L } from './units.js';

// The seventeen wallpaper groups as placements: `t.symmetry(group, { cell })`
// sized to the drawable.
export type { PlaneGroup } from './symmetry.js';

// Pure helpers. Randomness (rnd/noise/stream/…) and layout (bounds/grid)
// come through the toolkit — they belong to a sketch run, not the module.
export type { RandomStream } from './execution.js';
export { mapRange as map } from './random.js';
export { ease } from './ease.js';

// The plan a sketch asks for: `t.plan` and `t.draw` take these options, and
// `shader` is a stroke program the plan runs. Rendering, planning and
// export themselves are host words (`occlude/host`).
export type { PlanOptions, DrawRequest } from './plan.js';
export type { PenDef } from './pens.js';
export { shader } from './shader.js';
export type { ShaderValue, StrokeCtx, StrokeInk, StrokeProgram } from './shader.js';

// Point-distribution duals: pure, so they take arbitrary point arrays.
export type { ScatterOpts, ThrowOpts, RelaxOpts, SettleOpts, SettleParent, Bounds } from './points.js';
// Voronoi cells as material: each cell's `source` is its site.
export { hull, type Sites } from './voronoi.js';
// `faces.measure(field?)` answers the geometry with measurement columns.
export type { MeasureOpts } from './measure.js';
export type { IsoOpts, IsoLevels } from './isolines.js';
// A grid of values you can step: the stateful counterpart of a field. The
// door is `t.lattice` — it reads the drawable and the seeded init.
export type { Lattice, LatticeOpts, LatticeInit, LatticeValues, LatticeFace, LatticeWhere, SpendMarks, SpendOpts } from './lattice.js';
// Ink as a budget: the tone a drawing still owes, a lattice column paid
// down by the marks it makes. The door is `t.residual`.
export type { ResidualOpts } from './residual.js';
// Loops → signed distance field (positive inside): pure, composes with
// isolines (offsetting is a recipe), scatter, decimate, deform.
export { distanceTo, sdf } from './distance.js';
export type { DistanceField, PointSites } from './distance.js';
// Complex arithmetic over the pair spelling, and the escape-time field as
// a field word: the artist's own map in, a smooth count (and its
// potential) out.
export { complex } from './complex.js';
export { escape } from './escape.js';
export type { EscapeOpts, EscapeField, EscapeStep } from './escape.js';
// The sketch's geometry as a frame setting: `space` says what a length is
// worth and `projection` which chart the sheet draws it in. The
// constructors are pure data words — the run resolves them against the
// drawable, and `t.space` is the record every word reads. The isometries
// of the disk and of the Klein ball are what those words are MADE of, and
// stay internal (hyperbolic.ts, hyperbolicSpace.ts).
// ONE isometry value for every door: a walk's frame, a tiling's copies, a
// mirror in a geodesic. `group(placement, …)` places a drawing,
// `m.transform(placement)` a material; `step`, `turn` and `toward` walk it.
// It needs the sketch's space, so it is made on the toolkit: `t.placement`,
// `t.reflection`.
export type { Placement, Model } from './placement.js';
export { space, spaceOf } from './space.js';
export type { Space, SpaceKind, SpaceSpec, CurvatureSpec, SpaceOption, Projection, ProjectionSpec, ProjectionOption } from './space.js';
// `t.tiling(p, q)` is one word for the regular tilings of all three
// geometries: the Schläfli symbol picks the sphere, the plane or the disk,
// and the answer is a material of shared walls whose faces are the cells,
// each with its placement as `source`, the same shape in each.
export { Tiling } from './tiling.js';
export type { TilingGeometry, TilingOpts } from './tiling.js';
// Seeds → arrival times (fast marching): the distance a walk actually
// takes, with walls and a slow ground. `t.travelTime` is the word.
export type { TravelOpts } from './travel.js';
export type { TravelTimeOpts } from './api.js';
// The geometry protocol: what a value can say about itself, and the one
// area contract of polygon, distanceTo, force.boundary and t.within.
export type { AreaInput, Geometry } from './boundary.js';
// Fields as citizens: explicit transforms, domain bounds, vector marking.
export { rotate, translate, scale, vectorField, grad, curl } from './field.js';
// Unoriented direction fields: an axis has no front, and `across` is the
// perpendicular family of either kind.
export { axisField, across } from './field.js';
export type { AxisFieldFn } from './field.js';
export type { Prepared, PointField, DifferenceOptions } from './field.js';

// Tweakable values (identity at runtime; the studio scans + builds sliders).
export { ui } from './ui.js';
export type { UiOpts } from './ui.js';

export type { StreamOpts, LengthField } from './streamlines.js';
export { shaper } from './shaper.js';
export type { Shaper, ShaperOpts, ShaperPoint } from './shaper.js';

// The paper and the pens a sketch declares. `penModel` and `paperModel` are
// what a downloaded sketch calls for the library entries it bundles inline.
export { pen, penModel, paper, paperModel } from './execution.js';
export type { PaperSpec, SketchOptions, TransformOp, Winding } from './execution.js';

// A fill file's `import … from 'occlude'` resolves to this very module: the
// registry hands loaded fills the package's own namespace (self-import is
// ordinary ESM — the namespace is created at link time, bindings are live).
// The root module holds no host words (those are `occlude/host`), so the
// whole namespace is what a fill may see.
import * as occludeNamespace from './index.js';
import { setOccludeModule } from './fills.js';
setOccludeModule(() => occludeNamespace as unknown as Record<string, unknown>);
