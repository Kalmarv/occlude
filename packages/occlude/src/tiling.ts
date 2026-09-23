/**
 * The regular tiling `{p, q}` — `p`-gons meeting `q` at a vertex — in
 * whichever geometry that symbol belongs to.
 *
 * The symbol picks the geometry and there is nothing to set: `(p − 2)(q −
 * 2)` below 4 is the sphere, exactly 4 the plane, above 4 the hyperbolic
 * disk. So `{3, 5}` is the icosahedron, `{4, 4}` is squared paper and
 * `{7, 3}` is the heptagonal tiling of the disk, and one word draws all
 * three. Only `p` or `q` below 3 is a mistake.
 *
 * The answer is GEOMETRY: a `Material` whose vertices and walls are
 * SHARED, so a wall between two cells is one edge and a plotter draws it
 * once, whose faces know their generation, their hand and which placement
 * made them — and which still carries the fundamental polygon (`cell`) and
 * one `Placement` per copy of it (`placements`), the identity first, so a
 * sketch that maps a motif through the isometries reads as it always did.
 * This module is pure and knows nothing of the sheet: `t.tiling` is the
 * door a sketch uses, and it hands in the model door and the map that
 * carries the model chart onto the drawable.
 *
 * The model chart is the one the geometry is written in: the unit Poincaré
 * disk for the hyperbolic case, the unit sphere's stereographic chart for
 * the spherical case — the cell about the pole — and the plane with a cell
 * of circumradius `1/(2·sin(π/p))`, an edge of length 1, about the origin.
 */

import { facesFromCycles, faceKeyOf, type Face, type Faces } from './faces.js';
import { Material, mintIds, type FaceColumn } from './material.js';
import { identity, reflection, type Model, type ModelDoor, type Placement } from './placement.js';
import { chordMiddle, metricGap, modelGap } from './chord.js';
import type { SpaceKind } from './space.js';
import { tileGroup, type TileOps } from './tilegroup.js';
import type { L } from './units.js';
import type { Vec, XY } from './vec.js';

export interface TilingOpts {
  /** Generations of neighbours to reflect out to. Depth 0 is the
   * fundamental polygon alone; depth 1 adds its `p` edge neighbours. */
  depth?: number;
  /**
   * The length of a wall, for a EUCLIDEAN symbol only. Left out, a plane
   * tiling is fitted to the drawable as it always was.
   *
   * A curved symbol has no such option: its side is fixed by the
   * curvature, and asking for another one refuses by name and says what
   * the side is. The toolkit reads this — a length is sketch units, and
   * units are the frame's business — and the kernel is handed the fit it
   * asks for.
   */
  side?: L;
}

/** Which geometry a Schläfli symbol demands — the same three words the
 * sketch's own `space` is named by, so `t.tiling(p, q).space` and
 * `t.space.kind` are comparable. */
export type TilingGeometry = SpaceKind;

/**
 * One regular tiling: a `Material` of shared corners and shared walls, its
 * cell, and where the copies go.
 *
 * It IS a material, so every material word reads it — `strokes(tiles)`
 * draws each wall ONCE, `tiles.faces()` hands back the cells, a point
 * selection picks corners, `t.within` cuts it. A material verb answers a
 * plain `Material`: a warped tiling is no longer a tiling.
 */
export class Tiling extends Material {
  /** The geometry the symbol belongs to, and the chart `cell` is written
   * in. */
  readonly space: TilingGeometry;
  /**
   * The fundamental polygon, `p` vertices in order, one of them on the
   * positive x axis. Its edges are GEODESICS of that geometry; joined up
   * straight they are the chords, which is a different picture. The
   * material's own walls carry the geodesic as samples.
   */
  readonly cell: Vec[];
  /**
   * One ISOMETRY per copy of the cell, the identity first: `p.point(v)`
   * moves a point, `m.transform(p)` a whole material, `group(p, …)` a
   * whole drawing, and `p.orientation` says which hand the copy has.
   *
   * A stereographic chart has no point for the place opposite its pole, so
   * the spherical copy that lands there is UNBOUNDED in the chart: it is
   * the outside of the picture, and the point at its very centre comes
   * back non-finite. That is the truth about a stereographic picture of a
   * sphere, and every drawing word already reads a non-finite point as
   * "no place". A `'gnomonic'` or `'orthographic'` sketch drops that whole
   * copy, as it drops everything on the far side.
   */
  readonly placements: Placement[];
  /** The faces this tiling KNOWS it has, as closed runs of vertex rows.
   * Read once, by `faces()`. */
  private readonly cycles: readonly (readonly number[])[];

  /** @internal Use `t.tiling(p, q)`. */
  constructor(
    x: Float64Array,
    y: Float64Array,
    attrs: Record<string, Float64Array>,
    edgeList: Uint32Array,
    carry: { ids?: { points?: Float64Array; edges?: Float64Array }; faceAttrs?: Record<string, FaceColumn> },
    tiling: { space: TilingGeometry; cell: Vec[]; placements: Placement[]; cycles: readonly (readonly number[])[] },
  ) {
    super(x, y, attrs, edgeList, carry);
    this.space = tiling.space;
    this.cell = Object.freeze(tiling.cell) as Vec[];
    this.placements = Object.freeze(tiling.placements) as Placement[];
    this.cycles = tiling.cycles;
    Object.freeze(this);
  }

  /**
   * The cells, INTRINSIC: the tiling says which corners go round which
   * face, so nothing is read off the picture and nothing is checked for
   * planarity. It is the same memo every material keeps, so one collection
   * answers every call.
   */
  override faces(): Faces {
    return (this.facesBox.faces ??= facesFromCycles(this, this.cycles));
  }

  /** The face of the identity placement: the cell itself, where a motif is
   * written before the placements carry it everywhere else. */
  get seed(): Face {
    return this.faces().faces[0];
  }
}

/** `(p − 2)(q − 2)` against 4 is the whole test, of a symbol that is one:
 * whole numbers of 3 or more. */
export function tilingGeometry(p: number, q: number): TilingGeometry {
  if (!Number.isInteger(p) || !Number.isInteger(q) || p < 3 || q < 3) {
    throw new Error(`tiling: p and q are whole numbers of 3 or more (got ${p}, ${q})`);
  }
  const k = (p - 2) * (q - 2);
  return k < 4 ? 'spherical' : k === 4 ? 'euclidean' : 'hyperbolic';
}

// ---- the isometries -------------------------------------------------------

/**
 * ONE answer to `TileOps` for all three geometries: an isometry is a
 * `Placement` over the tiling's own model door, and a reflection in an edge
 * is the reflection in the geodesic through its two ends. The three private
 * motion types this file used to carry — a Möbius record, a plane motion, a
 * 3×3 turn — were one thing written three times.
 *
 * The seat is the MODEL image of the model origin, which is the third
 * column of the placement's matrix. It names the tile in the geometry's own
 * coordinates rather than in a chart, which is what the sphere needs: the
 * tile opposite the pole has no chart point at all, and in a chart its seat
 * would come back as rounding noise instead of one repeatable place.
 */
export function tileOps(door: ModelDoor): TileOps<Placement> {
  return {
    identity: identity(door),
    compose: (outer, inner) => inner.then(outer),
    apply: (m, p) => m.point(p),
    reflection: (a, b) => reflection(door, a, b),
    seat: (m) => [m.m[2], m.m[5], m.m[8]],
  };
}

// ---- the cells ------------------------------------------------------------

/**
 * The fundamental polygon in each geometry, as the chart radius its
 * vertices sit at.
 *
 * Half the polygon is `2p` right triangles with angles `π/p`, `π/q`,
 * `π/2`, and the one relation `cos R = cot(π/p)·cot(π/q)` — `cosh` in the
 * hyperbolic case — gives the circumradius. Turned into the chart radius
 * that is `tan(R/2)` on the sphere and `tanh(R/2)` in the disk, and both
 * come out as the same square root, `√(∓cos(u + v)/cos(u − v))`, with the
 * sign the geometry itself supplies. The Euclidean case has no such
 * radius — its cells come in every size — so it takes an edge of 1.
 */
export function cellOf(geometry: TilingGeometry, p: number, q: number): Vec[] {
  const u = Math.PI / p;
  const v = Math.PI / q;
  const r = geometry === 'euclidean'
    ? 1 / (2 * Math.sin(u))
    : Math.sqrt(Math.abs(Math.cos(u + v)) / Math.cos(u - v));
  return Array.from({ length: p }, (_, k) => {
    const th = (2 * Math.PI * k) / p;
    return [r * Math.cos(th), r * Math.sin(th)] as Vec;
  });
}

// ---- the mesh -------------------------------------------------------------

/** Pieces a wall is halved into at most, whatever its bow reads — an
 * implementation number: a wall is a geodesic, an edge is straight, and
 * the bow says how closely the second stands in for the first. The
 * worst wall on the docs sheet needs 32 (the `{3, 5}` of the geometry
 * page, and a `{5, 4}` under Klein), and the pieces a bow asks for grow as
 * the square root of the paper's scale: A0, the largest sheet the library
 * ships, is about 4.7 times the docs sheet, so about 2.2 times the pieces,
 * and the next doubling is 128. */
const SAMPLE_CAP = 128;

/** Two corners are ONE vertex when their model points agree this closely,
 * bucketed this coarsely. The model is the honest key in all three
 * geometries: sketch coordinates are single valued through `down`, but a
 * chart can put a corner infinitely far out, and the model never does. */
const BUCKET = 1e-6;
const MERGE_TOL = 1e-9;

/** The 3×3 on a model vector, row-major — `Placement.point` without the
 * round trip back through the chart. A corner is keyed on the model it
 * lands at, and going up from a charted point loses the digits that the
 * farthest copies need. */
function act(m: readonly number[], v: Model): Model {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Where corners are looked up by the model point they land at. */
class Corners {
  private readonly buckets = new Map<string, { at: Model; row: number }[]>();

  private static key(x: number, y: number): string {
    return `${Math.round(x / BUCKET)},${Math.round(y / BUCKET)}`;
  }

  /** The row already standing at this model point, or undefined. */
  find(v: Model): number | undefined {
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const near = this.buckets.get(Corners.key(v[0] + i * BUCKET, v[1] + j * BUCKET));
        if (!near) continue;
        for (const held of near) {
          if (Math.hypot(held.at[0] - v[0], held.at[1] - v[1], held.at[2] - v[2]) < MERGE_TOL) return held.row;
        }
      }
    }
    return undefined;
  }

  add(v: Model, row: number): void {
    const key = Corners.key(v[0], v[1]);
    const held = this.buckets.get(key);
    if (held) held.push({ at: v, row });
    else this.buckets.set(key, [{ at: v, row }]);
  }
}

/**
 * The interior points of the geodesic from `a` to `b`, in the coordinates
 * the tiling lands in.
 *
 * A wall is a geodesic and a material's edge is the flat segment between
 * two coordinates, so a curved wall is carried as SAMPLES. They are taken
 * in the MODEL, where one formula serves all three geometries:
 *
 *     P(t) = (s((1 − t)·g)·A + s(t·g)·B) / s(g),
 *
 * with `g` the model gap (`modelGap`), `s` the model's own sine — `sinh`
 * below zero curvature, `sin` above it — and a plain straight step on the
 * plane, whose geodesics are already straight wherever it is drawn.
 *
 * A piece is judged by its BOW IN THE METRIC: the space's distance
 * (`metricGap`) between the middle of the flat segment the ink will draw —
 * named as the ink names it (`chordMiddle`) — and the geodesic's own
 * middle. That is a distance a placement cannot change, so a wall sampled
 * to `bow` (sketch units, the toolkit's `geodesicBow`, as the ink's `line`
 * and `m.transform` read it) stays within it wherever the tiling is
 * carried. The count doubles until every piece
 * holds, and stops at `SAMPLE_CAP` pieces whatever it reads.
 */
function samplesBetween(door: ModelDoor, a: Vec, b: Vec, bow: number): Vec[] {
  if (door.sign === 0) return [];
  const sign = door.sign;
  const sine = sign < 0 ? Math.sinh : Math.sin;
  const A = door.up(a);
  const B = door.up(b);
  const g = modelGap(sign, A, B);
  const sg = sine(g);
  if (!(Math.abs(sg) > 1e-12)) return [];
  const model = (t: number): Model => {
    const k0 = sine((1 - t) * g) / sg;
    const k1 = sine(t * g) / sg;
    return [A[0] * k0 + B[0] * k1, A[1] * k0 + B[1] * k1, A[2] * k0 + B[2] * k1];
  };
  const at = (t: number): Vec => door.down(model(t));
  const middle = chordMiddle(door);
  const gap = metricGap(door);
  let pieces = 1;
  let nodes: Vec[] = [[a[0], a[1]], [b[0], b[1]]];
  while (pieces < SAMPLE_CAP) {
    let worst = 0;
    for (let k = 0; k < pieces; k++) {
      const off = gap(middle(nodes[k], nodes[k + 1]), at((k + 0.5) / pieces));
      if (off > worst) worst = off;
    }
    if (!(worst > bow)) break;
    pieces *= 2;
    const grown: Vec[] = [[a[0], a[1]]];
    for (let k = 1; k < pieces; k++) grown.push(at(k / pieces));
    grown.push([b[0], b[1]]);
    for (const v of grown) if (!Number.isFinite(v[0]) || !Number.isFinite(v[1])) return [];
    nodes = grown;
  }
  return nodes.slice(1, -1);
}

/** One wall: the two corners it joins, and the rows of its samples in the
 * stored direction. */
interface Wall {
  a: number;
  b: number;
  samples: number[];
}

/**
 * The tiling AS GEOMETRY: shared corners, shared walls, and one closed run
 * of vertex rows per copy.
 *
 * The vertex order is settled and repeatable: cell corner `j` of copy `i`
 * first come first served in `i` then `j`, then every wall's samples in
 * the order the walls were found. Corners carry `corner = 1` and samples
 * `corner = 0`.
 *
 * A face runs the seed's own way round for a copy that keeps its hand, and
 * the other way for a MIRRORED one. It has to: a reflection fixes the wall
 * it is taken in, so both copies would otherwise run that shared wall from
 * the same corner to the same corner, and a wall belongs to one face on
 * each side.
 */
function meshOf(door: ModelDoor, bow: number, cell: readonly Vec[], placements: readonly Placement[]): {
  x: Float64Array;
  y: Float64Array;
  corner: Float64Array;
  edgeList: Uint32Array;
  cycles: number[][];
  /** The placement each cycle belongs to, by the same index. */
  kept: number[];
} {
  const p = cell.length;
  const xs: number[] = [];
  const ys: number[] = [];
  const isCorner: number[] = [];
  const index = new Corners();
  const chart = cell.map((v) => door.up(v));
  // Pass one: the corners, so their rows come first and stay put.
  const cornerRow: number[][] = placements.map((place) => chart.map((v) => {
    const at = act(place.m, v);
    const found = index.find(at);
    if (found !== undefined) return found;
    const row = xs.length;
    const q = door.down(at);
    xs.push(q[0]);
    ys.push(q[1]);
    isCorner.push(1);
    index.add(at, row);
    return row;
  }));
  // Pass two: the walls, each one once however many copies share it, with
  // its samples appended after every corner.
  const walls = new Map<string, Wall>();
  const order: Wall[] = [];
  const wallOf = (a: number, b: number): Wall => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    const held = walls.get(key);
    if (held) return held;
    const samples = samplesBetween(door, [xs[a], ys[a]], [xs[b], ys[b]], bow).map((v) => {
      const row = xs.length;
      xs.push(v[0]);
      ys.push(v[1]);
      isCorner.push(0);
      return row;
    });
    const made: Wall = { a, b, samples };
    walls.set(key, made);
    order.push(made);
    return made;
  };
  const cycles: number[][] = [];
  const kept: number[] = [];
  for (let i = 0; i < placements.length; i++) {
    const run: number[] = [];
    for (let j = 0; j < p; j++) {
      const a = cornerRow[i][j];
      const b = cornerRow[i][(j + 1) % p];
      // A cell whose corners collapse onto one another is no cell; the
      // copy is dropped rather than drawn as a crease.
      if (a === b) {
        run.length = 0;
        break;
      }
      const wall = wallOf(a, b);
      run.push(a, ...(wall.a === a ? wall.samples : [...wall.samples].reverse()));
    }
    if (run.length < 3) continue;
    cycles.push(placements[i].orientation < 0 ? [run[0], ...run.slice(1).reverse()] : run);
    kept.push(i);
  }
  const edges: number[] = [];
  for (const wall of order) {
    const through = [wall.a, ...wall.samples, wall.b];
    for (let k = 0; k + 1 < through.length; k++) edges.push(through[k], through[k + 1]);
  }
  return {
    x: Float64Array.from(xs),
    y: Float64Array.from(ys),
    corner: Float64Array.from(isCorner),
    edgeList: Uint32Array.from(edges),
    cycles,
    kept,
  };
}

/**
 * What every cell of a tiling knows about itself, as face columns:
 * `generation` (the flood generation the copy was first reached in),
 * `mirrored` (1 when the placement turns the plane over, read off the
 * placement and never off a signed area) and `placementIndex`.
 *
 * A face column is keyed by the WALLS of its face, so the keys are built
 * here from the edge ids the material is about to be given — the same key
 * `Faces.keys()` reads back.
 */
function columnsOf(
  cycles: readonly (readonly number[])[],
  vertexCount: number,
  edgeList: Uint32Array,
  edgeIds: Float64Array,
  placements: readonly Placement[],
  generation: readonly number[],
  kept: readonly number[],
): Record<string, FaceColumn> {
  const n = Math.max(1, vertexCount);
  const edgeAt = new Map<number, number>();
  for (let e = 0; e < edgeList.length / 2; e++) {
    edgeAt.set(edgeList[2 * e] * n + edgeList[2 * e + 1], e);
    edgeAt.set(edgeList[2 * e + 1] * n + edgeList[2 * e], e);
  }
  const keys = cycles.map((run) => faceKeyOf(run.map((v, k) => edgeIds[edgeAt.get(v * n + run[(k + 1) % run.length])!])));
  const seen = new Set(keys);
  const column = (value: (f: number) => number): FaceColumn => ({
    values: new Map(keys.map((key, f) => [key, value(f)])),
    transfer: 'nearest',
    seen,
  });
  return {
    generation: column((f) => generation[kept[f]]),
    mirrored: column((f) => (placements[kept[f]].orientation < 0 ? 1 : 0)),
    placementIndex: column((f) => kept[f]),
  };
}

// ---- the word -------------------------------------------------------------

/** How far a finite tiling is allowed to flood before it is a mistake: the
 * biggest of them, `{5, 3}`, closes in three generations. */
const CLOSURE = 16;

/**
 * The `{p, q}` tiling, placed through one model door.
 *
 * The symbol picks the geometry and builds the fundamental polygon in that
 * geometry's MODEL CHART; `place.up` carries a chart point into the
 * sketch's own coordinates, and `place.door` is the model door of the
 * sketch's space, which is this very geometry. The flood then runs in
 * those coordinates, so every placement that comes back is an isometry a
 * sketch can hand straight to `group`, `m.transform` or a station.
 * `place.bow` is the bow a wall's stored chords may keep, in the space's
 * metric and in sketch units: the toolkit reads it off the frame, where
 * the chart is widest.
 *
 * `depth` is generations of reflection across the cell's edges, 3 by
 * default: depth 1 is the cell and its `p` edge neighbours. A spherical
 * tiling is FINITE — there are only ever 4, 6, 8, 12 or 20 cells — so it
 * is returned whole and `depth` is ignored rather than refused.
 *
 * The `Tiling` is built HERE and not in the toolkit: once it has the door
 * it needs no frame, and a material is the answer rather than a step on
 * the way to one. `side` is resolved before this — it is a length, and a
 * length is the frame's business.
 */
export function tiling(
  p: number,
  q: number,
  opts: TilingOpts,
  place: { door: ModelDoor; up: (z: XY) => Vec; bow: number },
): Tiling {
  const space = tilingGeometry(p, q);
  const cell = cellOf(space, p, q).map(place.up);
  const depth = space === 'spherical'
    ? CLOSURE
    : opts.depth === undefined ? 3 : Math.floor(opts.depth);
  const flood = !Number.isFinite(depth) || depth < 0
    ? { tiles: [], generation: [] }
    : tileGroup('tiling', tileOps(place.door), cell, depth);
  const mesh = meshOf(place.door, place.bow, cell, flood.tiles);
  // The ids are minted here, in the order the constructor would mint them,
  // because the face columns are keyed by the walls of each face and a
  // wall is named by its edge's id.
  const points = mintIds(mesh.x.length);
  const edges = mintIds(mesh.edgeList.length / 2);
  return new Tiling(
    mesh.x,
    mesh.y,
    { corner: mesh.corner },
    mesh.edgeList,
    {
      ids: { points, edges },
      faceAttrs: columnsOf(mesh.cycles, mesh.x.length, mesh.edgeList, edges, flood.tiles, flood.generation, mesh.kept),
    },
    { space, cell, placements: flood.tiles, cycles: mesh.cycles },
  );
}
