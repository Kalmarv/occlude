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

export type XYLike = readonly [number, number] | readonly number[] | { x: number; y: number };
export type Loop = readonly XYLike[];

/** The shape of a Material this module needs, without importing the class
 * (the class imports the consumers that import this). */
export interface ChainSource {
  n: number;
  edgeList: Uint32Array;
  curves(): IsoContour[];
}

/** Anything the area consumers take as a boundary. */
export type Boundary = Loop | readonly Loop[] | IsoContour | readonly IsoContour[] | ChainSource;

/** A point: a numeric pair (extra entries ignored) or an object with numeric x and y. */
const isPoint = (v: unknown): v is XYLike =>
  (Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number') ||
  (typeof v === 'object' && v !== null && !Array.isArray(v) &&
    typeof (v as { x?: unknown }).x === 'number' && typeof (v as { y?: unknown }).y === 'number');
/** A loop: an array of points, or an empty array. */
const isLoop = (v: unknown): v is Loop => Array.isArray(v) && (v.length === 0 || isPoint(v[0]));
const isContour = (v: unknown): v is IsoContour =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Array.isArray((v as { pts?: unknown }).pts);
const isChainSource = (v: unknown): v is ChainSource =>
  typeof v === 'object' && v !== null && !Array.isArray(v) &&
  typeof (v as { curves?: unknown }).curves === 'function' && (v as { edgeList?: unknown }).edgeList instanceof Uint32Array;

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
  if (isChainSource(input)) {
    const degree = new Uint32Array(input.n);
    const e = input.edgeList;
    for (let k = 0; k < e.length; k++) degree[e[k]]++;
    for (let i = 0; i < input.n; i++) {
      if (degree[i] > 2) {
        throw new Error(
          `${who}: this material branches (vertex ${i} has ${degree[i]} edges), so it has no single inside — ` +
            'choose boundaries with selectEdges(…).extract(), or derive areas with planarize().faces()',
        );
      }
    }
    return input.curves().map((c) => c.pts);
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
