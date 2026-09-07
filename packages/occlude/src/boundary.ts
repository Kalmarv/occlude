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

const isXY = (v: unknown): v is XYLike =>
  (Array.isArray(v) && (v.length === 0 || typeof v[0] === 'number' || typeof v[0] === 'object')) ||
  (typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { x?: unknown }).x === 'number');
const isTuple = (v: unknown): v is readonly number[] => Array.isArray(v);
const isContour = (v: unknown): v is IsoContour =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Array.isArray((v as { pts?: unknown }).pts);
const isChainSource = (v: unknown): v is ChainSource =>
  typeof v === 'object' && v !== null && !Array.isArray(v) &&
  typeof (v as { curves?: unknown }).curves === 'function' && (v as { edgeList?: unknown }).edgeList instanceof Uint32Array;

const loopOf = (loop: Loop): [number, number][] =>
  loop.map((p) => (isTuple(p) ? (p as unknown as [number, number]) : [p.x, p.y]));

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
  const first: unknown = input[0];
  if (isContour(first)) return (input as readonly IsoContour[]).map((c) => c.pts);
  if (isXY(first) && !(Array.isArray(first) && first.length > 0 && Array.isArray(first[0]))) {
    // One loop of points: `[[x, y], …]` or `[{ x, y }, …]`.
    return [loopOf(input as Loop)];
  }
  return (input as readonly Loop[]).map(loopOf);
}
