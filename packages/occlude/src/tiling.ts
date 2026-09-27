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
 * once, and whose faces are the cells, STATED in the order the flood
 * reached them. A face knows its `generation` and its hand (`mirrored`),
 * and its `source` is the `Placement` that carried the fundamental polygon
 * (`cell`) there, the identity first, so a sketch maps a motif through the
 * isometries with `tiles.faces.map((f) => group(f.source, motif))`.
 *
 * A flat symbol — `{4, 4}`, `{3, 6}`, `{6, 3}` — COVERS THE DRAWABLE: the
 * flood runs until every cell that reaches the drawable is found, every
 * cell is cut to the drawable, and each face carries its lattice
 * coordinates `i` and `j` beside the rest; `gap` parts the cells. A curved
 * symbol has no drawable to cover — the disk is unbounded in its own
 * metric, the sphere is finite — so it floods `depth` generations.
 *
 * This module is pure and knows nothing of the sheet: `t.tiling` is the
 * door a sketch uses, and it hands in the model door and the map that
 * carries the model chart onto the drawable.
 *
 * The model chart is the one the geometry is written in: the unit Poincaré
 * disk for the hyperbolic case, the unit sphere's stereographic chart for
 * the spherical case — the cell about the pole — and the plane with a cell
 * of circumradius `1/(2·sin(π/p))`, an edge of length 1, about the origin.
 */

import type { Origin } from './shapes.js';
import { statedColumns, type StatedFaces } from './faces.js';
import { Material, mintIds, type FaceColumn } from './material.js';
import type { Rect } from './layout.js';
import { act, identity, reflection, type Model, type ModelDoor, type Placement } from './placement.js';
import { chordMiddle, metricGap, modelGap } from './chord.js';
import { signedArea, type Space, type SpaceKind } from './space.js';
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
  /**
   * Where the cell's centre stands (see `Origin`), for a EUCLIDEAN symbol:
   * a point, or `'center'`/`'centroid'` for the middle of the drawable,
   * which is also the default. A curved tiling stands on its chart's
   * centre, and moving it is a placement: `origin` refuses by name there.
   */
  origin?: Origin;
  /** Turn the whole tiling about its centre, in degrees counter-clockwise.
   * A turn about the chart's centre is an isometry of every geometry, so a
   * curved tiling takes it too. */
  rotate?: number;
  /** For a EUCLIDEAN symbol: shrink every cell about its own centre until
   * neighbouring walls stand this far apart. Parted cells touch nothing,
   * so nothing is shared. A curved tiling's cells share their walls, and
   * `gap` refuses by name there. */
  gap?: L;
}

/** Which geometry a Schläfli symbol demands — the same three words the
 * sketch's own `space` is named by, so `t.tiling(p, q).geometry` and
 * `t.space.kind` are comparable. */
export type TilingGeometry = SpaceKind;

/**
 * One regular tiling: a `Material` of shared corners and shared walls,
 * whose faces are the cells, and its fundamental polygon.
 *
 * It IS a material, so every material word reads it — `strokes(tiles)`
 * draws each wall ONCE, `tiles.faces` hands back the cells, a point
 * selection picks corners, `t.within` cuts it. A material verb answers a
 * plain `Material`: a warped tiling is no longer a tiling, though a move
 * or a column write keeps its cells.
 */
export class Tiling extends Material {
  /** The geometry the symbol belongs to, and the chart `cell` is written
   * in: a NAME, where `space` — which every material has — is the space
   * record itself. */
  readonly geometry: TilingGeometry;
  /**
   * The fundamental polygon, `p` vertices in order, one of them on the
   * positive x axis. Its edges are GEODESICS of that geometry; joined up
   * straight they are the chords, which is a different picture. The
   * material's own walls carry the geodesic as samples.
   */
  readonly cell: Vec[];

  /** @internal Use `t.tiling(p, q)`. */
  constructor(
    x: Float64Array,
    y: Float64Array,
    attrs: Record<string, Float64Array>,
    edgeList: Uint32Array,
    carry: { ids?: { points?: Float64Array; edges?: Float64Array }; faceAttrs?: Record<string, FaceColumn>; space?: Space; faces?: StatedFaces },
    tiling: { geometry: TilingGeometry; cell: Vec[] },
  ) {
    super(x, y, attrs, edgeList, carry);
    this.geometry = tiling.geometry;
    this.cell = Object.freeze(tiling.cell) as Vec[];
    Object.freeze(this);
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
 * The seat is the MODEL image of the cell's own centre, `centre` as a
 * model point. It names the tile in the geometry's own coordinates rather
 * than in a chart, which is what the sphere needs: the tile opposite the
 * pole has no chart point at all, and in a chart its seat would come back
 * as rounding noise instead of one repeatable place. It is the CELL's
 * centre and not the model origin because only the centre is where every
 * placement of one tile agrees: a flat cell stands where the drawable puts
 * it, and two placements that land it in one place with different turns
 * send the origin to two places. With `q` odd a flood reaches a tile both
 * ways round, so the flat `{6, 3}` would otherwise keep both.
 */
export function tileOps(door: ModelDoor, centre: Model): TileOps<Placement> {
  return {
    identity: identity(door),
    compose: (outer, inner) => inner.then(outer),
    apply: (m, p) => m.point(p),
    reflection: (a, b) => reflection(door, a, b),
    seat: (m) => act(m.m, centre),
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
export function modelCell(geometry: TilingGeometry, p: number, q: number): Vec[] {
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
 * sketch can hand straight to `group`, `m.transform` or a walk.
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
  place: { door: ModelDoor; up: (z: XY) => Vec; bow: number; space?: Space },
): Tiling {
  const geometry = tilingGeometry(p, q);
  const cell = modelCell(geometry, p, q).map(place.up);
  const depth = geometry === 'spherical'
    ? CLOSURE
    : opts.depth === undefined ? 3 : Math.floor(opts.depth);
  const flood = !Number.isFinite(depth) || depth < 0
    ? { tiles: [], generation: [] }
    : tileGroup('tiling', tileOps(place.door, place.door.up(place.up([0, 0]))), cell, depth);
  const mesh = meshOf(place.door, place.bow, cell, flood.tiles);
  // The ids are minted here, in the order the constructor would mint them,
  // because the face columns are keyed by the walls of each face and a
  // wall is named by its edge's id.
  const points = mintIds(mesh.x.length);
  const edges = mintIds(mesh.edgeList.length / 2);
  const cycles = mesh.cycles.map((run) => [run]);
  const placed = mesh.kept.map((k) => flood.tiles[k]);
  return new Tiling(
    mesh.x,
    mesh.y,
    { corner: mesh.corner },
    mesh.edgeList,
    {
      ids: { points, edges },
      faceAttrs: statedColumns(cycles, mesh.x.length, mesh.edgeList, edges, {
        generation: (f) => flood.generation[mesh.kept[f]],
        mirrored: (f) => (placed[f].orientation < 0 ? 1 : 0),
      }),
      space: place.space,
      faces: { cycles, source: (f) => placed[f], edgeList: mesh.edgeList, edgeIds: edges },
    },
    { geometry, cell },
  );
}

/**
 * The flat `{p, q}` tiling COVERING a drawable, through one model door.
 *
 * The flood is the curved one's, with no depth: it goes on while a copy
 * reaches the box that holds the drawable and the fundamental cell, which
 * is every cell between them, so the cover is whole whatever the origin.
 * Each copy is then shrunk by `gap` (a length in the sketch's units), cut
 * to the drawable and welded to its neighbours, so a wall two cells share
 * is one edge. A flat wall is straight, so there are no samples, and no
 * `corner` column: every point is a corner or where the drawable cuts. The faces come in flood order and carry `generation`,
 * `mirrored`, and the lattice coordinates `i` and `j`: for `{6, 3}` the
 * axial pair, for `{4, 4}` the two edge directions, and for `{3, 6}` the
 * row `j` and the place `i` along it, an even `i` the fundamental cell's
 * way round and an odd one turned. `down` carries a sketch point back to
 * the model chart, where the lattice is read.
 */
export function coverTiling(
  p: number,
  q: number,
  gap: number,
  place: { door: ModelDoor; up: (z: XY) => Vec; down: (v: Vec) => Vec; side: number; space?: Space; bounds: Rect },
): Tiling {
  const geometry = tilingGeometry(p, q);
  if (geometry !== 'euclidean') throw new Error(`tiling: {${p}, ${q}} is not a flat tiling`);
  const model = modelCell(geometry, p, q);
  const cell = model.map(place.up);
  const r = place.bounds;
  const bx0 = r.x ?? 0;
  const by0 = r.y ?? 0;
  const bx1 = bx0 + r.w;
  const by1 = by0 + r.h;
  // The cells shrink about their centres until neighbouring walls stand
  // `gap` apart: each gives up half of it from its inradius.
  const inradius = place.side / (2 * Math.tan(Math.PI / p));
  const k = 1 - gap / 2 / inradius;
  // A mid-edit zero, a non-finite place, or a gap that eats the cell:
  // nothing to lay out.
  const finite = Number.isFinite(place.side) && cell.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (!finite || !(k > 0) || !(r.w > 0) || !(r.h > 0)) return new Tiling(new Float64Array(0), new Float64Array(0), {}, new Uint32Array(0), { space: place.space }, { geometry, cell });
  // The box a copy must reach to be kept: the drawable's, grown to take in
  // the fundamental cell wherever the origin put it.
  let hx0 = bx0;
  let hy0 = by0;
  let hx1 = bx1;
  let hy1 = by1;
  for (const [x, y] of cell) {
    hx0 = Math.min(hx0, x);
    hy0 = Math.min(hy0, y);
    hx1 = Math.max(hx1, x);
    hy1 = Math.max(hy1, y);
  }
  const reaches = (m: Placement): boolean => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const v of cell) {
      const [x, y] = m.point(v);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    return x1 > hx0 && x0 < hx1 && y1 > hy0 && y0 < hy1;
  };
  const centre = place.up([0, 0]);
  const flood = tileGroup('tiling', tileOps(place.door, place.door.up(centre)), cell, Infinity, reaches);
  // Each copy as a loop of sketch points, shrunk, cut and turned to run
  // counter-clockwise in a y-up reading, as every stated face does.
  const xs: number[] = [];
  const ys: number[] = [];
  const buckets = new Map<string, number[]>();
  const vertexAt = (x: number, y: number): number => {
    const bi = Math.floor(x / WELD);
    const bj = Math.floor(y / WELD);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const list = buckets.get(`${bi + di},${bj + dj}`);
        if (!list) continue;
        for (const row of list) {
          if (Math.abs(xs[row] - x) <= WELD && Math.abs(ys[row] - y) <= WELD) return row;
        }
      }
    }
    const row = xs.length;
    xs.push(x);
    ys.push(y);
    const key = `${bi},${bj}`;
    const list = buckets.get(key);
    if (list) list.push(row);
    else buckets.set(key, [row]);
    return row;
  };
  const edges: number[] = [];
  const edgeSeen = new Set<string>();
  const cycles: number[][][] = [];
  const faces: { m: Placement; generation: number; i: number; j: number }[] = [];
  for (let t = 0; t < flood.tiles.length; t++) {
    const m = flood.tiles[t];
    const c = m.point(centre);
    const own = cell.map((v) => {
      const [x, y] = m.point(v);
      return [c[0] + (x - c[0]) * k, c[1] + (y - c[1]) * k] as [number, number];
    });
    const cut = clipToRect(own, bx0, by0, bx1, by1);
    // Nothing of the cell reached the drawable, or the cut left a sliver
    // with no area: judged BEFORE any vertex is minted, so a discarded cell
    // leaves no loose vertex behind.
    if (!cut || Math.abs(area2(cut)) < WELD) continue;
    const loop = area2(cut) < 0 ? cut.reverse() : cut;
    const rows: number[] = [];
    for (const v of loop) {
      const row = vertexAt(v[0], v[1]);
      if (rows.length === 0 || rows[rows.length - 1] !== row) rows.push(row);
    }
    while (rows.length > 1 && rows[0] === rows[rows.length - 1]) rows.pop();
    if (rows.length < 3) continue;
    if (Math.abs(area2(rows.map((row) => [xs[row], ys[row]] as [number, number]))) < WELD) continue;
    for (let e = 0; e < rows.length; e++) {
      const a = rows[e];
      const b = rows[(e + 1) % rows.length];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (edgeSeen.has(key)) continue;
      edgeSeen.add(key);
      edges.push(a, b);
    }
    cycles.push([rows]);
    faces.push({ m, generation: flood.generation[t], ...latticeCoords(p, place.down(c)) });
  }
  const edgeList = Uint32Array.from(edges);
  const points = mintIds(xs.length);
  const edgeIds = mintIds(edgeList.length / 2);
  return new Tiling(
    Float64Array.from(xs),
    Float64Array.from(ys),
    {},
    edgeList,
    {
      ids: { points, edges: edgeIds },
      faceAttrs: statedColumns(cycles, xs.length, edgeList, edgeIds, {
        generation: (f) => faces[f].generation,
        mirrored: (f) => (faces[f].m.orientation < 0 ? 1 : 0),
        i: (f) => faces[f].i,
        j: (f) => faces[f].j,
      }),
      space: place.space,
      faces: { cycles, source: (f) => faces[f].m, edgeList, edgeIds },
    },
    { geometry, cell },
  );
}

/** Vertices a hair apart are the same vertex: the wall two cells share is
 * computed from two different placements, so the two answers differ in
 * the last bits. A bucket per WELD square, and the eight neighbours
 * searched too, so a pair that straddles a bucket edge still meets. */
const WELD = 1e-6;

/**
 * The lattice coordinates of a flat cell whose centre is `z`, a point of
 * the model chart (an edge of 1, the fundamental cell about the origin).
 * The centres of the cells the fundamental one's way round are a lattice;
 * for `{3, 6}` the turned ones are that lattice shifted by the
 * neighbour's centre, and `i` says which with its parity.
 */
function latticeCoords(p: number, z: Vec): { i: number; j: number } {
  const [x, y] = z;
  if (p === 4) {
    // Neighbours across the walls, at 45° and 135°.
    const s = Math.SQRT1_2;
    return { i: Math.round(s * (x + y)), j: Math.round(s * (y - x)) };
  }
  if (p === 6) {
    // Axial: a = (3/2, √3/2), b = (0, √3).
    const i = Math.round(x / 1.5);
    return { i, j: Math.round((y - (i * Math.sqrt(3)) / 2) / Math.sqrt(3)) };
  }
  // {3, 6}: translations a = (0, 1) along the row, b = (√3/2, 1/2) across.
  const solve = (px: number, py: number) => {
    const v = px / (Math.sqrt(3) / 2);
    const u = py - v / 2;
    return { u, v, off: Math.abs(u - Math.round(u)) + Math.abs(v - Math.round(v)) };
  };
  const own = solve(x, y);
  const turned = solve(x + 1 / Math.sqrt(3), y);
  const pick = own.off <= turned.off ? { ...own, parity: 0 } : { ...turned, parity: 1 };
  return { i: 2 * Math.round(pick.u) + pick.parity, j: Math.round(pick.v) };
}

/** Twice the signed area of a loop. */
const area2 = (pts: readonly (readonly [number, number])[]): number => 2 * signedArea(pts);

/** Sutherland–Hodgman against one half-plane. */
function clipHalf(pts: readonly (readonly [number, number])[], inside: (p: readonly [number, number]) => boolean, cut: (a: readonly [number, number], b: readonly [number, number]) => [number, number]): (readonly [number, number])[] {
  const out: (readonly [number, number])[] = [];
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k];
    const b = pts[(k + 1) % pts.length];
    const ain = inside(a);
    const bin = inside(b);
    if (ain) out.push(a);
    if (ain !== bin) out.push(cut(a, b));
  }
  return out;
}

/** A cell cut to a rectangle, or null when nothing of it is left. */
function clipToRect(pts: readonly (readonly [number, number])[], x0: number, y0: number, x1: number, y1: number): (readonly [number, number])[] | null {
  const lerp = (a: readonly [number, number], b: readonly [number, number], t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  let p = clipHalf(pts, (v) => v[0] >= x0, (a, b) => lerp(a, b, (x0 - a[0]) / (b[0] - a[0])));
  if (p.length < 3) return null;
  p = clipHalf(p, (v) => v[0] <= x1, (a, b) => lerp(a, b, (x1 - a[0]) / (b[0] - a[0])));
  if (p.length < 3) return null;
  p = clipHalf(p, (v) => v[1] >= y0, (a, b) => lerp(a, b, (y0 - a[1]) / (b[1] - a[1])));
  if (p.length < 3) return null;
  p = clipHalf(p, (v) => v[1] <= y1, (a, b) => lerp(a, b, (y1 - a[1]) / (b[1] - a[1])));
  if (p.length < 3) return null;
  return p;
}
