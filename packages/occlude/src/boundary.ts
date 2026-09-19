/**
 * The geometry protocol: what a resolved geometry value can say about
 * itself, and how the area consumers read it.
 *
 * One protocol, three accessors. A value answers the ones it honestly can:
 * `contours()` for areas (closed loops with winding), `curves()` for chains
 * (open or closed, with their points), `points` for positions with identity
 * and columns. Every method is optional; a consumer asks for the one it
 * needs and refuses a value that cannot answer, by name. Nothing is added to
 * a value that it could not already say.
 *
 * Before this there was a `Boundary` union that every area consumer named,
 * overlapping and disagreeing with `strokes`'s union and `distanceTo`'s.
 * The unions are gone: `polygon`, `distanceTo`, `force.boundary` and
 * `t.within` all take `Geometry` plus the plain shapes of loops, and read
 * `contours()`.
 *
 * Structural normalization only: coordinates pass through untouched (a
 * `[L, L]` tuple stays what it was), the consumer keeps its own units and
 * winding semantics, and nothing here welds, planarizes or guesses — a
 * branching material is refused with the way out.
 */

import type { IsoContour } from './isolines.js';
import type { Curve } from './material.js';
import type { PointSelection } from './relation.js';
import { Len, type L } from './units.js';

/** A coordinate: a number, or a length such as `mm(10)` where the consumer
 * draws (polygon); numeric consumers refuse lengths, see `numericLoops`. */
type Coord = L;
export type XYLike = readonly [Coord, Coord] | readonly Coord[] | { x: Coord; y: Coord };
export type Loop = readonly XYLike[];
/** One loop as pairs, in the coordinates the input gave: a length stays a
 * `Len`, so a consumer that computes must go through `numericLoops`. */
export type LoopPoints = [Coord, Coord][];

/**
 * What a resolved geometry value can say about itself.
 *
 * It is a structural interface, not a class and not a marker: a value is
 * geometry because it answers, not because it declares. `Material`,
 * `PointSelection`, `EdgeSelection`, `Faces`, `FaceSelection` and `Face` all
 * satisfy it; a shape does not — a shape needs the paper to become
 * geometry, and enters through `t.material` or `t.sample` (the frame rule).
 */
export interface Geometry {
  /** Areas: closed loops with winding. For a material, its closed chains. */
  contours?(): IsoContour[];
  /** Chains, open or closed, with their points. */
  curves?(): Curve[];
  /** Positions with identity and columns. */
  points?: PointSelection;
}

/** Anything an area consumer takes: a geometry value, or the plain shapes
 * of loops and contour records a sketch can write by hand. */
export type AreaInput = Geometry | IsoContour | readonly IsoContour[] | Loop | readonly Loop[];

const isCoord = (v: unknown): v is Coord => typeof v === 'number' || v instanceof Len;
/** A point as a pair (extra entries ignored). */
const isPointPair = (v: unknown): v is readonly [Coord, Coord] =>
  Array.isArray(v) && v.length >= 2 && isCoord(v[0]) && isCoord(v[1]);
/** A point as an object. */
const isPointObj = (v: unknown): v is { x: Coord; y: Coord } => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return 'x' in v && 'y' in v && isCoord(v.x) && isCoord(v.y);
};
/** A point either way. Either coordinate may be a resolved number or an
 * unresolved length such as `mm(10)`; a numeric consumer refuses the
 * latter — see `numericLoops`. */
const isPoint = (v: unknown): v is XYLike => isPointPair(v) || isPointObj(v);
/** A loop: an array of points, or an empty array. */
const isLoop = (v: unknown): v is Loop => Array.isArray(v) && (v.length === 0 || isPoint(v[0]));
const isContour = (v: unknown): v is IsoContour =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && 'pts' in v && Array.isArray(v.pts);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether a value answers any of the three accessors. */
export function isGeometry(v: unknown): v is Geometry {
  return isObj(v) && (typeof v.contours === 'function' || typeof v.curves === 'function' || v.points !== undefined);
}

/** A value that can say where its areas are. */
const hasContours = (v: unknown): v is { contours(): IsoContour[] } => isObj(v) && typeof v.contours === 'function';
/** A value that can say where its chains are. */
const hasCurves = (v: unknown): v is { curves(): IsoContour[] } => isObj(v) && typeof v.curves === 'function';
/**
 * A face collection: several areas at once, so it must name which it means.
 * It answers `contours()` — the union outline — but `polygon(cells)` is
 * still refused, because "every face" and "their union" are different
 * pictures and the sketch has to say.
 */
const isFaceCollection = (v: unknown): v is { map(fn: (f: unknown) => unknown): unknown[] } =>
  isObj(v) && typeof v.contours === 'function' && typeof v.curves !== 'function' && typeof v.at === 'function' && 'source' in v;
/**
 * A topology whose highest degree it can report. Not part of the protocol:
 * it is how the area consumers refuse a branching material by name, with
 * the way out, and the refusal has to carry the consumer's own name.
 */
const hasDegree = (v: unknown): v is { maxDegree(): number } => isObj(v) && typeof v.maxDegree === 'function';

const loopOf = (loop: Loop, who: string): LoopPoints =>
  loop.map((p, i) => {
    if (isPointPair(p)) return [p[0], p[1]];
    if (isPointObj(p)) return [p.x, p.y];
    throw new Error(`${who}: loop entry ${i} is not a point ([x, y] or { x, y })`);
  });

/**
 * Resolve an area to loops, in the coordinates given.
 *
 * A value that answers `contours()` is read by it — for a material that is
 * its closed chains, so `polygon(m)` fills what is closed. A value with no
 * closed chain, and one that answers only `curves()`, is read by its
 * chains, where an open one is a loop the consumer closes with a chord, as
 * it always has for open input. Separate components stay separate loops; an
 * isolated point contributes nothing. `who` names the caller in errors.
 */
export function areaLoops(input: AreaInput, who: string): LoopPoints[] {
  if (isFaceCollection(input)) {
    throw new Error(
      `${who}: a face collection is several areas — draw each one, \`cells.map((f) => polygon(f, …))\`, ` +
        'or take their union outline with cells.contours()',
    );
  }
  // A material or a selection that branches has no single inside. The
  // refusal names the consumer, so it belongs here and not in the value.
  if (hasDegree(input)) {
    const degree = input.maxDegree();
    if (degree > 2) {
      throw new Error(
        `${who}: this ${'indices' in input ? 'selection' : 'material'} branches (a vertex has ${degree} edges), so it has no single inside — ` +
          'pick one boundary with edges.filter(…), or derive areas with planarize().faces()',
      );
    }
  }
  if (hasContours(input)) {
    const areas = input.contours();
    // A material's areas are its closed chains. When it has none, its open
    // chains are still read as loops, each closed with a chord — the
    // behaviour every open input has always had here, and the one the docs
    // and the ink baseline pin. `contours()` first means a material that
    // has both is read by what is closed.
    if (areas.length > 0 && hasCurves(input) && input.curves().length !== areas.length) {
      console.error(`PROBE ${who}: contours=${areas.length} curves=${input.curves().length}`);
    }
    if (areas.length > 0 || !hasCurves(input)) return areas.map((c) => c.pts as LoopPoints);
  }
  if (hasCurves(input)) {
    const cs = input.curves();
    if (!hasDegree(input) && isObj(input) && typeof (input as { edges?: unknown }).edges === 'object') {
      const e = (input as unknown as { edges: { maxDegree(): number } }).edges;
      if (typeof e?.maxDegree === 'function' && e.maxDegree() > 2) console.error(`PROBE-DEGREE ${who}: point selection branches`);
    }
    return cs.map((c) => c.pts as LoopPoints);
  }
  if (isContour(input)) return [input.pts as LoopPoints];
  if (!Array.isArray(input)) {
    throw new Error(`${who}: expected a shape, a face, loops of points, contour records or a chain material`);
  }
  if (input.length === 0) return [];
  // What the first entry is decides the shape of the whole: a point means
  // one loop, a loop (possibly empty) or a contour record means a list.
  const first: unknown = input[0];
  if (isContour(first)) return (input as readonly IsoContour[]).map((c) => c.pts as LoopPoints);
  if (isPoint(first)) return [loopOf(input as Loop, who)];
  if (isLoop(first)) return (input as readonly Loop[]).map((l) => loopOf(l, who));
  throw new Error(`${who}: expected loops of points ([x, y] or { x, y }), contour records or a chain material`);
}

/** `areaLoops` for a consumer that computes with the coordinates: a
 * length such as `mm(10)` is a drawing unit the sketch must resolve first. */
export function numericLoops(input: AreaInput, who: string): [number, number][][] {
  const loops = areaLoops(input, who);
  const out: [number, number][][] = [];
  for (const loop of loops) {
    const row: [number, number][] = [];
    for (const [x, y] of loop) {
      if (typeof x !== 'number' || typeof y !== 'number') {
        throw new Error(`${who}: coordinates must be numbers in the material's units; a length such as mm() is a drawing unit — resolve it in the sketch, or draw it with polygon`);
      }
      row.push([x, y]);
    }
    out.push(row);
  }
  return out;
}
