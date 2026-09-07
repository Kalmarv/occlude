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
import { Len } from './units.js';

/** A coordinate: a number, or a length such as `mm(10)` where the consumer
 * draws (polygon); numeric consumers refuse lengths, see `numericLoops`. */
type Coord = number | Len;
export type XYLike = readonly [Coord, Coord] | readonly Coord[] | { x: number; y: number };
export type Loop = readonly XYLike[];

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

/** A face collection or selection: explicit per-face areas only. */
interface FaceSource {
  boundaries(): IsoContour[];
  map(fn: (f: { contours: IsoContour[] }) => unknown): unknown[];
}

/** Anything the area consumers take as a boundary. */
export type Boundary = Loop | readonly Loop[] | IsoContour | readonly IsoContour[] | ChainSource | PointSource;

const isCoord = (v: unknown): v is Coord => typeof v === 'number' || v instanceof Len;
/** A point: a coordinate pair (extra entries ignored) or an object with numeric x and y. */
const isPoint = (v: unknown): v is XYLike =>
  (Array.isArray(v) && v.length >= 2 && isCoord(v[0]) && isCoord(v[1])) ||
  (typeof v === 'object' && v !== null && !Array.isArray(v) &&
    typeof (v as { x?: unknown }).x === 'number' && typeof (v as { y?: unknown }).y === 'number');
/** A loop: an array of points, or an empty array. */
const isLoop = (v: unknown): v is Loop => Array.isArray(v) && (v.length === 0 || isPoint(v[0]));
const isContour = (v: unknown): v is IsoContour =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Array.isArray((v as { pts?: unknown }).pts);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isChainSource = (v: unknown): v is ChainSource =>
  isObj(v) && typeof v.curves === 'function' && typeof v.maxDegree === 'function';
const isPointSource = (v: unknown): v is PointSource => isObj(v) && typeof v.inducedEdges === 'function';
const isFaceSource = (v: unknown): v is FaceSource => isObj(v) && typeof v.boundaries === 'function' && typeof v.curves !== 'function';

const loopOf = (loop: Loop, who: string): [number, number][] =>
  loop.map((p, i) => {
    if (!isPoint(p)) throw new Error(`${who}: loop entry ${i} is not a point ([x, y] or { x, y })`);
    if (Array.isArray(p)) return p as unknown as [number, number];
    const q = p as { x: number; y: number };
    return [q.x, q.y];
  });

/**
 * Resolve a boundary to loops. A closed chain is a loop; an open chain is a
 * loop the consumer closes with a chord (as it always has for open input);
 * separate components stay separate loops; an isolated point contributes
 * nothing. `who` names the caller in errors.
 */
export function boundaryLoops(input: Boundary, who: string): [number, number][][] {
  if (isFaceSource(input)) {
    throw new Error(
      `${who}: faces are areas already — draw each one, \`cells.map((f) => polygon(f.contours, …))\`, ` +
        'or outline their union with cells.boundaries()',
    );
  }
  // A point selection has no connectivity of its own: its existing edges decide.
  const chains = isPointSource(input) ? input.inducedEdges() : input;
  if (isChainSource(chains)) {
    const degree = chains.maxDegree();
    if (degree > 2) {
      throw new Error(
        `${who}: this ${'indices' in (input as object) ? 'selection' : 'material'} branches (a vertex has ${degree} edges), so it has no single inside — ` +
          'pick one boundary with edges.filter(…), or derive areas with planarize().faces()',
      );
    }
    return chains.curves().map((c) => c.pts);
  }
  if (isContour(input)) return [input.pts];
  if (!Array.isArray(input)) throw new Error(`${who}: expected loops, contour records or a chain material`);
  if (input.length === 0) return [];
  // What the first entry is decides the shape of the whole: a point means
  // one loop, a loop (possibly empty) or a contour record means a list.
  const first: unknown = input[0];
  if (isContour(first)) return (input as readonly IsoContour[]).map((c) => c.pts);
  if (isPoint(first)) return [loopOf(input as Loop, who)];
  if (isLoop(first)) return (input as readonly Loop[]).map((l) => loopOf(l, who));
  throw new Error(`${who}: expected loops of points ([x, y] or { x, y }), contour records or a chain material`);
}

/** `boundaryLoops` for a consumer that computes with the coordinates: a
 * length such as `mm(10)` is a drawing unit the sketch must resolve first. */
export function numericLoops(input: Boundary, who: string): [number, number][][] {
  const loops = boundaryLoops(input, who);
  for (const loop of loops) {
    for (const p of loop) {
      if (typeof p[0] !== 'number' || typeof p[1] !== 'number') {
        throw new Error(`${who}: coordinates must be numbers in the material's units; a length such as mm() is a drawing unit — resolve it in the sketch, or draw it with polygon`);
      }
    }
  }
  return loops;
}
