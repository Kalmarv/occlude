/**
 * The geometry protocol: what a resolved geometry value can say about
 * itself, and how the area consumers read it.
 *
 * One protocol, three accessors. A value answers the ones it honestly can:
 * `contours()` for areas (closed loops with winding), `curves` for chains
 * (open or closed, each a row with its `points` in order and `closed`),
 * `points` for positions with identity and columns. Every accessor is optional; a consumer asks for the one it
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
 * branching material with no closed chain is read by the faces it already
 * has, and a branching selection is refused with the way out.
 */

import type { IsoContour } from './isolines.js';
import { areaView } from './material.js';
import { chainRecordsOf } from './curves.js';
import { Selection } from './selection.js';
import type { Vertex } from './material.js';
import { Len, type L } from './units.js';

/** A coordinate: a number, or a length such as `mm(10)` where the consumer
 * draws (polygon); numeric consumers refuse lengths, see `numericLoops`. */
type Coord = L;
export type XYLike = readonly [Coord, Coord] | readonly Coord[] | { x: Coord; y: Coord };
export type Loop = readonly XYLike[];
/** One loop as pairs, in the coordinates the input gave: a length stays a
 * `Len`, so a consumer that computes must go through `numericLoops`. */
export type LoopPoints = [Coord, Coord][];

/** A chain as the protocol reads it: its points in order, and whether it
 * closes. A curve row is one. */
export interface CurveLike {
  readonly points: Iterable<XYLike>;
  readonly closed: boolean;
}

/**
 * What a resolved geometry value can say about itself.
 *
 * It is a structural interface, not a class and not a marker: a value is
 * geometry because it answers, not because it declares. `Material`,
 * a `Selection` of points, edges or faces, and `Face` all
 * satisfy it; a shape does not — a shape needs the paper to become
 * geometry, and enters through `t.material` or `t.sample` (the frame rule).
 */
export interface Geometry {
  /** Areas: closed loops with winding. For a material, its closed chains. */
  contours?(): IsoContour[];
  /** Chains, open or closed: rows with their points in order. A property,
   * read on first ask. */
  readonly curves?: Iterable<CurveLike>;
  /** Positions with identity and columns. */
  points?: Selection<Vertex>;
}

/** A rectangle as a record: its corner and its size. */
export interface RectRecord {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Anything an area consumer takes: a geometry value, a rect record, or
 * the plain shapes of loops and contour records a sketch can write by hand. */
export type AreaInput = Geometry | IsoContour | readonly IsoContour[] | Loop | readonly Loop[] | RectRecord;

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
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @internal A contour record: `{ pts, closed? }` written by hand or
 * answered by a word, and not a value that answers `contours()` itself. */
export const isContourRecord = (v: unknown): v is IsoContour =>
  isObj(v) && Array.isArray(v.pts) && typeof v.contours !== 'function';

/** What a value that is not geometry yet is called in a refusal: a shape,
 * a group of shapes, or an inverted area. Null for anything else. */
function unloweredKind(v: unknown): string | null {
  if (!isObj(v)) return null;
  if ('__occludeShape' in v) return 'a shape';
  if (v.__occludeGroup === true) return 'a group';
  if (v.__occludeInvert === true) return 'an inverted area';
  return null;
}

/**
 * @internal Refuse, by name, a shape (or a group, or an inverted area)
 * handed to a word that reads geometry. A shape needs the paper, the units
 * and its own transform before it has points, so it is geometry only after
 * a toolkit door lowers it: `t.material(shape)` keeps the boundary's own
 * vertices, `t.sample(shape, { count })` spaces points along it. `twin`
 * names a toolkit word that takes the shape as it is (`t.distanceTo`).
 */
export function refuseShape(v: unknown, who: string, twin?: string): void {
  const kind = unloweredKind(v);
  if (kind === null) return;
  const doors = 't.material(shape) for its own vertices, or t.sample(shape, { count }) for points spaced along it';
  throw new Error(
    twin === undefined
      ? `${who}: ${kind} is not geometry until the toolkit lowers it — give ${doors}`
      : `${who}: ${kind} is not geometry until the toolkit lowers it — use ${twin}(…), which lowers it, or give ${doors}`,
  );
}

/** @internal Whether a value answers any of the three accessors. */
export function isGeometry(v: unknown): v is Geometry {
  return isObj(v) && (typeof v.contours === 'function' || 'curves' in v || v.points !== undefined);
}

/** A rect record: four finite numbers `x, y, w, h`, and nothing that
 * answers the protocol (a grid cell answers `contours()` itself). */
export const isRectRecord = (v: unknown): v is RectRecord =>
  isObj(v) && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.w === 'number' && typeof v.h === 'number' && !('pts' in v);

/** A value that can say where its areas are. */
const hasContours = (v: unknown): v is { contours(): IsoContour[] } => isObj(v) && typeof v.contours === 'function';
/** A value that can say where its chains are: it answers `curves`. Asked
 * without reading it, because reading it walks the chains. */
const hasCurves = (v: unknown): v is { readonly curves: Iterable<CurveLike> } => isObj(v) && 'curves' in v;
/** A value that can find the regions its edges enclose. Asked without
 * reading it, because reading it walks the faces. */
const hasFaces = (v: unknown): v is { readonly faces: { contours(): IsoContour[] } } => isObj(v) && 'faces' in v;
/**
 * A face collection: several areas at once, so it must name which it means.
 * It answers `contours()` — the union outline — but `polygon(cells)` is
 * still refused, because "every face" and "their union" are different
 * pictures and the sketch has to say. Known by its kind: a selection of
 * faces, of a material or of a lattice.
 */
const isFaceCollection = (v: unknown): boolean => v instanceof Selection && v.domain.kind.name === 'face';
/**
 * The highest vertex degree inside a value's own edges, or null for a
 * value that has none. Not part of the protocol: it is how the area
 * consumers refuse a branching material by name, with the way out, and
 * the refusal has to carry the consumer's own name. An edge selection
 * answers for itself; anything with an `edges` collection — a material, a
 * point selection — answers through it.
 */
const branchingDegree = (v: unknown): number | null => {
  if (isObj(v) && typeof v.maxDegree === 'function') return (v as { maxDegree(): number }).maxDegree();
  // A face states its own area exactly, and its `edges` are the edges it
  // OWNS — walls plus anything inside it. A spur in a cell is not a
  // branching boundary, so a face never answers this question.
  if (isObj(v) && typeof v.area === 'number' && typeof v.index === 'number') return null;
  const edges = isObj(v) ? (v as { edges?: unknown }).edges : undefined;
  if (isObj(edges) && typeof edges.maxDegree === 'function') return (edges as { maxDegree(): number }).maxDegree();
  return null;
};

const loopOf = (loop: Loop, who: string): LoopPoints =>
  loop.map((p, i) => {
    if (isPointPair(p)) return [p[0], p[1]];
    if (isPointObj(p)) return [p.x, p.y];
    throw new Error(`${who}: loop entry ${i} is not a point ([x, y] or { x, y })`);
  });

/**
 * @internal
 * Resolve an area to loops, in the coordinates given.
 *
 * A value that answers `contours()` is read by it — for a material that is
 * its closed chains, so `polygon(m)` fills what is closed. A value with no
 * closed chain, and one that answers only `curves`, is read by its
 * chains, where an open one is a loop the consumer closes with a chord, as
 * it always has for open input. A material with no closed chain whose
 * chains branch is read by its faces: its area is their union. Separate
 * components stay separate loops; an isolated point contributes nothing. `who` names the caller in errors.
 */
export function areaLoops(given: AreaInput, who: string): LoopPoints[] {
  // A level set's area is worked out when it is first read, here.
  const input = areaView(given) as AreaInput;
  refuseShape(input, who);
  if (isFaceCollection(input)) {
    throw new Error(
      `${who}: a face collection is several areas — draw each one, \`cells.map((f) => polygon(f, …))\`, ` +
        'or take their union outline with cells.contours()',
    );
  }
  // A material or a selection that branches has no single inside of its
  // chains. A material with a closed chain is still read by what is closed
  // (the refusal below keeps it); one with none is read by its faces — a
  // tiling, a hex field, a planarized web — and its area is their union, the
  // outer rim and any holes, the loops `m.faces.contours()` answers. A
  // branching material that encloses nothing, such as a tree, has no area
  // and gives no loops. A selection has no faces of its own, so the refusal
  // names the consumer, which is why it belongs here and not in the value.
  {
    const degree = branchingDegree(input);
    if (degree !== null && degree > 2 && hasFaces(input) && hasCurves(input) && !(hasContours(input) && input.contours().length > 0)) {
      // A crossing without a vertex is the faces' own refusal, which names
      // the way out; it carries the consumer's name as every refusal here.
      let regions: IsoContour[];
      try {
        regions = input.faces.contours();
      } catch (err) {
        throw new Error(`${who}: ${(err as Error).message}`);
      }
      return regions.map((c) => c.pts as LoopPoints);
    }
    if (degree !== null && degree > 2) {
      throw new Error(
        `${who}: this ${isObj(input) && 'indices' in input ? 'selection' : 'material'} branches (a vertex has ${degree} edges), so it has no single inside — ` +
          'pick one boundary with edges.filter(…), or derive areas with planarize().faces',
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
    if (areas.length > 0 || !hasCurves(input)) return areas.map((c) => c.pts as LoopPoints);
  }
  if (hasCurves(input)) return (chainRecordsOf(input) ?? []).map((c) => c.pts as LoopPoints);
  if (isContourRecord(input)) return [input.pts as LoopPoints];
  // A rect record — `{ x, y, w, h }`, as `t.bounds()` and a grid cell
  // spell a rectangle — is the rectangle's one loop.
  if (isRectRecord(input)) {
    const { x, y, w, h } = input;
    return [[[x, y], [x + w, y], [x + w, y + h], [x, y + h]]];
  }
  if (!Array.isArray(input)) {
    throw new Error(`${who}: expected geometry — a material, a selection, a face, contour records or loops of points`);
  }
  if (input.length === 0) return [];
  // What the first entry is decides the shape of the whole: a point means
  // one loop, a loop (possibly empty) or a contour record means a list.
  const first: unknown = input[0];
  if (isContourRecord(first)) return (input as readonly IsoContour[]).map((c) => c.pts as LoopPoints);
  if (isPoint(first)) return [loopOf(input as Loop, who)];
  if (isLoop(first)) return (input as readonly Loop[]).map((l) => loopOf(l, who));
  throw new Error(`${who}: expected loops of points ([x, y] or { x, y }), contour records or a chain material`);
}

/** @internal `areaLoops` for a consumer that computes with the coordinates: a
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
