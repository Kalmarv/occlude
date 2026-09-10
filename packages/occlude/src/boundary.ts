/**
 * One boundary-input contract for the area consumers — `polygon`,
 * `distanceTo`, `force.boundary`: plain loops, contour records (an
 * isoline, a face's contours) and chain materials all resolve to the same
 * list of loops. Structural normalization only: coordinates pass through
 * untouched (a `[L, L]` tuple stays what it was), the consumer keeps its
 * own units and winding semantics, and nothing here welds, planarizes or
 * guesses — a branching material is refused with the way out.
 */

import type { IsoContour } from './isolines.js';
import { Len, type L } from './units.js';

/** A coordinate: a number, or a length such as `mm(10)` where the consumer
 * draws (polygon); numeric consumers refuse lengths, see `numericLoops`. */
type Coord = L;
export type XYLike = readonly [Coord, Coord] | readonly Coord[] | { x: Coord; y: Coord };
export type Loop = readonly XYLike[];
/** One loop as pairs, in the coordinates the input gave: a length stays a
 * `Len`, so a consumer that computes must go through `numericLoops`. */
export type LoopPoints = [Coord, Coord][];

/** What a material or an edge selection offers this module, without
 * importing the classes (they import the consumers that import this):
 * chains over its own topology, and that topology's highest degree. */
export interface ChainSource {
  curves(): IsoContour[];
  maxDegree(): number;
}

/** A point selection: its existing connections decide the boundary. */
interface PointSource {
  inducedEdges(): ChainSource;
}

/** A face collection or selection: several areas, so the union boundary is
 * the only single boundary it has. */
interface FaceSource {
  boundaries(): IsoContour[];
  map(fn: (f: { contours: IsoContour[] }) => unknown): unknown[];
}

/** One face: an area already (its `contours` are the outer boundary and the
 * holes), so it goes straight to a consumer that wants an area. */
interface FaceLike {
  area: number;
  contours: IsoContour[];
}

/** Anything the area consumers take as a boundary. */
export type Boundary =
  | Loop
  | readonly Loop[]
  | IsoContour
  | readonly IsoContour[]
  | FaceLike
  | ChainSource
  | PointSource;

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
const isChainSource = (v: unknown): v is ChainSource =>
  isObj(v) && typeof v.curves === 'function' && typeof v.maxDegree === 'function';
const isPointSource = (v: unknown): v is PointSource => isObj(v) && typeof v.inducedEdges === 'function';
const isFaceSource = (v: unknown): v is FaceSource => isObj(v) && typeof v.boundaries === 'function' && typeof v.curves !== 'function';
/** One face: already an area, with its holes as further contours. */
const isFace = (v: unknown): v is FaceLike =>
  isObj(v) && Array.isArray(v.contours) && typeof v.area === 'number';

const loopOf = (loop: Loop, who: string): LoopPoints =>
  loop.map((p, i) => {
    if (isPointPair(p)) return [p[0], p[1]];
    if (isPointObj(p)) return [p.x, p.y];
    throw new Error(`${who}: loop entry ${i} is not a point ([x, y] or { x, y })`);
  });

/**
 * Resolve a boundary to loops, in the coordinates given. A closed chain is a
 * loop; an open chain is a loop the consumer closes with a chord (as it
 * always has for open input); separate components stay separate loops; an
 * isolated point contributes nothing; a face is its contours (outer boundary
 * and holes). `who` names the caller in errors.
 */
export function boundaryLoops(input: Boundary, who: string): LoopPoints[] {
  if (isFace(input)) return input.contours.map((c) => c.pts as LoopPoints);
  if (isFaceSource(input)) {
    throw new Error(
      `${who}: a face collection is several areas — draw each one, \`cells.map((f) => polygon(f, …))\`, ` +
        'or take their union outline with cells.boundaries()',
    );
  }
  // A point selection has no connectivity of its own: its existing edges decide.
  const chains = isPointSource(input) ? input.inducedEdges() : input;
  if (isChainSource(chains)) {
    const degree = chains.maxDegree();
    if (degree > 2) {
      throw new Error(
        `${who}: this ${'indices' in input ? 'selection' : 'material'} branches (a vertex has ${degree} edges), so it has no single inside — ` +
          'pick one boundary with edges.filter(…), or derive areas with planarize().faces()',
      );
    }
    return chains.curves().map((c) => c.pts as LoopPoints);
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

/** `boundaryLoops` for a consumer that computes with the coordinates: a
 * length such as `mm(10)` is a drawing unit the sketch must resolve first. */
export function numericLoops(input: Boundary, who: string): [number, number][][] {
  const loops = boundaryLoops(input, who);
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
