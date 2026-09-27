import { identity } from './identity.js';
import { orient2d, orient3d } from 'robust-predicates';
import { kindOf, type AnyColumn } from '../../column.js';
import { cross3, sub3 } from '../math.js';
import type { Provenance3 } from '../geometry/surface.js';
import { faceEdges3, kernelColumn, meshOfMade3, checkMade3, pairKey, type Columns3, type Made3, type Mesh3, type Lineage3 } from '../geometry/mesh3.js';
import type { PointTransfer } from '../../material.js';

export interface SubdivisionOptions {
  readonly maxFaces?: number;
  readonly maxPoints?: number;
}
export type PointTransfers = Readonly<Record<string, PointTransfer>>;

/** A row's kernel columns: the ones a kernel reads (no references or
 * placements, which `made3` carries). */
function kernelColumns(cols: Columns3): [string, AnyColumn][] {
  return Object.entries(cols).filter(([, column]) => kernelColumn(column));
}

/**
 * The columns of rows made between rows. Each made row names its parents
 * (rows of `cols`); `kept` rows come first, as they are. Continuous numeric
 * columns interpolate: the mean of the parents in canonical NAME order,
 * summed as `sum + v / count`. Categorical columns — and a column whose
 * transfer is `'nearest'` — take the first parent in that order.
 */
function interpolated(cols: Columns3, kept: number, names: readonly string[], parents: readonly (readonly number[])[], transfers: PointTransfers): Record<string, AnyColumn> {
  const ordered = parents.map((rows) => [...rows].sort((a, b) => names[a] < names[b] ? -1 : names[a] > names[b] ? 1 : 0));
  const out: Record<string, AnyColumn> = {};
  for (const [name, column] of kernelColumns(cols)) {
    const kind = kindOf(column);
    const count = kept + ordered.length;
    if (transfers[name] !== 'nearest' && (kind.name === 'number' || kind.name === 'vector')) {
      const width = kind.width;
      const from = column.flat() as Float64Array;
      const flat = new Float64Array(count * width);
      flat.set(from.subarray(0, kept * width));
      ordered.forEach((rows, j) => {
        for (let s = 0; s < width; s++) {
          let sum = 0;
          for (const r of rows) sum = sum + from[r * width + s] / rows.length;
          flat[(kept + j) * width + s] = sum;
        }
      });
      out[name] = kind.of(flat);
    } else {
      const rows: number[] = [];
      for (let i = 0; i < kept; i++) rows.push(i);
      for (const r of ordered) rows.push(r[0]);
      out[name] = column.keep(rows);
    }
  }
  return out;
}

/** Each column's rows `rows` of `cols`: -1 is a row nothing reached, which
 * holds the kind's default. */
function picked(cols: Columns3, rows: readonly number[]): Record<string, AnyColumn> {
  const out: Record<string, AnyColumn> = {};
  const whole = rows.every((r) => r >= 0);
  for (const [name, column] of kernelColumns(cols)) {
    const kind = kindOf(column);
    out[name] = whole ? column.keep(rows) : kind.from(rows.map((r) => (r < 0 ? kind.default : column.get(r))));
  }
  return out;
}

/** A center split must not cross a discontinuity in a piecewise-affine corner
 * field. Non-affine chart quads refine their fixed source triangles instead. */
function affineCorners(mesh: Mesh3, f: number, xy: readonly (readonly [number, number])[]): boolean {
  const start = mesh.cornerStart[f];
  for (const [, column] of kernelColumns(mesh.cols.corners)) {
    const kind = kindOf(column);
    if (kind.name !== 'number' && kind.name !== 'vector') continue;
    const width = kind.width, flat = column.flat() as Float64Array;
    for (let s = 0; s < width; s++) {
      const positions = xy.map((p, i) => [p[0], p[1], flat[(start + i) * width + s]] as const);
      if (orient3d(...positions[0], ...positions[1], ...positions[2], ...positions[3]) !== 0) return false;
    }
  }
  return true;
}

/** Only convex, exactly planar quads have a center split. Other polygons use
 * their existing validated triangulation, preserving even folded faces. */
function isQuad(mesh: Mesh3, f: number): boolean {
  const loop = mesh.loops[f];
  if (loop.length !== 4) return false;
  const p = loop.map((v) => mesh.position(v));
  if (orient3d(...p[0], ...p[1], ...p[2], ...p[3]) !== 0) return false;
  const n = cross3(sub3(p[1], p[0]), sub3(p[2], p[0]));
  const axis = n.map(Math.abs).indexOf(Math.max(...n.map(Math.abs)));
  const xy = p.map((v) => v.filter((_, i) => i !== axis) as [number, number]);
  const turns = xy.map((_, i) => Math.sign(orient2d(...xy[i], ...xy[(i + 1) % 4], ...xy[(i + 2) % 4])));
  return turns[0] !== 0 && turns.every((v) => v === turns[0]) && affineCorners(mesh, f, xy);
}

/**
 * Every face split round its middle, `levels` times: a convex planar quad
 * into four round its center, any other face's fixed triangles each into
 * four. Point and corner columns refine by their transfer (`interpolated`);
 * face columns pass to the children, and edge columns to the two halves of
 * their edge. Undefined when nothing changes (no levels, no faces).
 */
export function subdivideMesh3(mesh: Mesh3, levels = 1, options: SubdivisionOptions = {}, transfers: PointTransfers = {}, cornerTransfers: PointTransfers = {}): Made3 | undefined {
  const maxFaces = options.maxFaces ?? Infinity, maxPoints = options.maxPoints ?? Infinity;
  if (!Number.isSafeInteger(levels) || levels < 0) throw new Error('subdivide levels must be a nonnegative integer');
  if (![maxFaces, maxPoints].every((n) => (n === Infinity || Number.isSafeInteger(n)) && n > 0)) throw new Error('subdivide budgets must be positive integers or Infinity');
  if (!levels || !mesh.faceCount) return undefined;
  const quads = mesh.loops.map((_, f) => isQuad(mesh, f));
  const start = mesh.faceTriangleStart;
  // Preflight every requested level before allocating the first output. The
  // point bound includes every polygon/triangulation edge and quad center.
  let faces = 0, points = mesh.n + mesh.edgeCount;
  for (let f = 0; f < mesh.faceCount; f++) {
    faces += quads[f] ? 4 : 4 * (start[f + 1] - start[f]);
    points += quads[f] ? 1 : Math.max(0, mesh.loops[f].length - 3);
  }
  for (let level = 0; level < levels; level++) {
    if (faces > maxFaces || points > maxPoints) throw new Error(`subdivide exceeds budget (${maxFaces} faces, ${maxPoints} points); reduce levels or raise explicit limits`);
    // Each next face has at most four sides; edges <= 4F, centers <= F.
    points += 5 * faces; faces *= 4;
  }
  let current = mesh, made: Made3 | undefined;
  for (let level = 0; level < levels; level++) {
    const next = refine(current, made?.lineage?.points, transfers, cornerTransfers, maxPoints, maxFaces);
    made = made === undefined ? next : throughLevel(made, next);
    current = meshOfMade3(made);
  }
  return made;
}

/** Several levels are one derivation: a row of the last level names its
 * lineage in the input, not in a level the sketch never held. Each row's
 * parents are read through the level before. */
function throughLevel(previous: Made3, next: Made3): Made3 {
  const up = new Map<string, readonly string[]>();
  for (const d of ['points', 'edges', 'faces', 'corners'] as const) {
    const lineage = previous.lineage?.[d];
    previous.names[d].forEach((name, i) => up.set(name, lineage?.[i]?.parents ?? [name]));
  }
  const lift = (rows: readonly (Provenance3 | undefined)[] | undefined) => rows?.map((r) => r && {operation: r.operation, parents: [...new Set(r.parents.flatMap((p) => up.get(p) ?? [p]))]});
  const l = next.lineage ?? {};
  return {...next, lineage: {points: lift(l.points), edges: lift(l.edges), faces: lift(l.faces), corners: lift(l.corners)}};
}

/** One level: `mesh`'s points kept (with `kept`, their lineage when a level
 * before made them), a point at the middle of every split edge and quad,
 * and the child faces in parent order. */
function refine(mesh: Mesh3, kept: readonly (Provenance3 | undefined)[] | undefined, transfers: PointTransfers, cornerTransfers: PointTransfers, maxPoints: number, maxFaces: number): Made3 {
  const names = mesh.names;
  const x: number[] = Array.from(mesh.x), y: number[] = Array.from(mesh.y), z: number[] = Array.from(mesh.z);
  const pointNames: string[] = [...names.points];
  const pointLineage: (Provenance3 | undefined)[] = kept === undefined ? new Array(mesh.n).fill(undefined) : [...kept];
  // The rows each made point sits between, and each made corner.
  const pointParents: (readonly number[])[] = [], cornerParents: (readonly number[])[] = [];
  const loops: number[][] = [], triangles: number[][] = [], faceNames: string[] = [], faceParent: number[] = [];
  const faceLineage: Provenance3[] = [], cornerNames: string[] = [], cornerLineage: Provenance3[] = [];
  const contributors = new Map<number, readonly number[]>();
  const midpoints = new Map<number, number>(), children = new Map<number, number>();
  const originals = new Map<number, number>();
  for (let e = 0; e < mesh.edgeCount; e++) originals.set(pairKey(mesh.edges[2 * e], mesh.edges[2 * e + 1]), e);
  const center = (vertices: readonly number[], name: string): number => {
    if (x.length >= maxPoints) throw new Error(`subdivide exceeds point budget (${maxPoints})`);
    // The mean of the vertices, summed as `sum + v / count` in their order.
    const mean = (axis: Float64Array) => vertices.reduce((sum, v) => sum + axis[v] / vertices.length, 0);
    const index = x.length;
    contributors.set(index, vertices);
    x.push(mean(mesh.x)); y.push(mean(mesh.y)); z.push(mean(mesh.z));
    pointNames.push(name);
    pointLineage.push({operation: 'subdivide', parents: vertices.map((v) => names.points[v])});
    pointParents.push(vertices);
    return index;
  };
  const midpoint = (a: number, b: number): number => {
    const key = pairKey(a, b), found = midpoints.get(key);
    if (found !== undefined) return found;
    const original = originals.get(key);
    const index = center([a, b], identity('edge', ...[names.points[a], names.points[b]].sort()));
    midpoints.set(key, index);
    if (original !== undefined) {
      children.set(pairKey(a, index), original);
      children.set(pairKey(index, b), original);
    }
    return index;
  };
  const add = (parent: number, vertices: number[], part: number) => {
    if (loops.length >= maxFaces) throw new Error(`subdivide exceeds face budget (${maxFaces})`);
    const faceName = identity('face', names.faces[parent], part), loop = mesh.loops[parent], first = mesh.cornerStart[parent];
    for (const v of vertices) {
      const source = (contributors.get(v) ?? [v]).map((point) => {
        const local = loop.indexOf(point);
        if (local < 0) throw new Error('subdivision corner source is outside its parent polygon');
        return first + local;
      });
      cornerNames.push(identity('corner', faceName, pointNames[v]));
      cornerLineage.push({operation: 'subdivide', parents: source.map((c) => names.corners[c])});
      cornerParents.push(source);
    }
    loops.push(vertices);
    triangles.push(vertices.length === 4 ? [0, 1, 2, 0, 2, 3] : [0, 1, 2]);
    faceNames.push(faceName);
    faceParent.push(parent);
    faceLineage.push({operation: 'subdivide', parents: [names.faces[parent]]});
  };
  const start = mesh.faceTriangleStart;
  for (let f = 0; f < mesh.faceCount; f++) {
    const loop = mesh.loops[f];
    if (isQuad(mesh, f)) {
      const c = center(loop, identity('center', names.faces[f]));
      loop.forEach((v, j) => add(f, [v, midpoint(v, loop[(j + 1) % 4]), c, midpoint(loop[(j + 3) % 4], v)], j));
    } else {
      let part = 0;
      for (let t = start[f]; t < start[f + 1]; t++) {
        const [a, b, c] = mesh.triangle(t);
        const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
        for (const vertices of [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]]) add(f, vertices, part++);
      }
    }
  }
  // The edges as assembly derives them; the two halves of a split edge
  // are its children, named for it and its ends, and hold its columns.
  const derived = faceEdges3(loops, pointNames);
  const edgeCount = derived.edges.length / 2, edgeNames = [...derived.names], edgeParent: number[] = [];
  const edgeLineage: (Provenance3 | undefined)[] = [];
  for (let e = 0; e < edgeCount; e++) {
    const a = derived.edges[2 * e], b = derived.edges[2 * e + 1], parent = children.get(pairKey(a, b));
    edgeParent.push(parent ?? -1);
    if (parent === undefined) { edgeLineage.push(undefined); continue; }
    const parentName = names.edges[parent];
    edgeNames[e] = identity('child-edge', parentName, ...[pointNames[a], pointNames[b]].sort());
    edgeLineage.push({operation: 'subdivide', parents: [parentName]});
  }
  const lineage: Lineage3 = {points: pointLineage, edges: edgeLineage, faces: faceLineage, corners: cornerLineage};
  const made: Made3 = {
    x, y, z,
    names: {points: pointNames, edges: edgeNames, faces: faceNames, corners: cornerNames},
    loops, triangles, edges: derived.edges,
    cols: {
      points: interpolated(mesh.cols.points, mesh.n, names.points, pointParents, transfers),
      edges: picked(mesh.cols.edges, edgeParent),
      faces: picked(mesh.cols.faces, faceParent),
      corners: interpolated(mesh.cols.corners, 0, names.corners, cornerParents, cornerTransfers),
    },
    lineage,
  };
  checkMade3(made);
  return made;
}
