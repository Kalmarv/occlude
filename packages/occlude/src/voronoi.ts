/**
 * Voronoi cells as ordinary material. `voronoiOf(sites, bounds)` builds the
 * diagram of a point set clipped to a rectangle and returns a Material
 * whose vertices are the cell corners and whose edges are the walls:
 * adjacent cells share their vertices and one wall, the clipping boundary
 * is explicit, and `faces()` reads the cells. The topology comes from the
 * Delaunay triangulation (d3-delaunay's Delaunator): every interior wall
 * is the segment between the circumcentres of two neighbouring triangles,
 * every hull wall a ray from a circumcentre away from the hull, both
 * clipped to the rectangle; a corner is shared because it is the same
 * circumcentre, never because two polygons happened to agree. Cocircular
 * sites (a grid, a regular polygon) give one corner per cluster of
 * circumcentres that differ only by rounding: circumcentres closer than
 * 1e-9 of the diagram's scale are one vertex, and the zero-length walls
 * between them are dropped.
 *
 * The result carries a correspondence to its sites: `cells.cellOf(site)`
 * and `cells.siteOf(face)`, both ownership-checked, valid for the frozen
 * result and its selections only. Sites given as a point selection (a
 * material's `points`, or a filtered part of it) keep their source: the
 * correspondence answers for that source's vertices, and rows outside the
 * selection have no cell. Editing or extracting the result makes
 * new material with no correspondence; a moved site set needs a new
 * construction. Nothing here is live.
 *
 * Duplicate sites: the site with the lowest row owns the cell (the
 * triangulation keeps the first of coincident points); the others have no
 * cell. A site whose cell is clipped away entirely has no cell either.
 */

import { Delaunay } from 'd3-delaunay';
import { Material, attachVoronoi, material, type PointsLike } from './material.js';
import { PointSelection } from './relation.js';
import type { Bounds } from './points.js';

/** Sites for a construction: a material (every row) or a point selection
 * of one (the selected rows, correspondence to that source). */
export type Sites = Material | PointSelection<unknown>;

/** The source material and the site rows of a construction. */
function sitesOf(sites: Sites): { source: Material; rows: readonly number[] } {
  if (sites instanceof PointSelection) return { source: sites.source, rows: sites.indices };
  return { source: sites, rows: Array.from({ length: sites.n }, (_, i) => i) };
}

interface RectClip {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Liang–Barsky: the parameter range of p + t·d inside the rect, or null. */
function clipParams(px: number, py: number, dx: number, dy: number, tMin: number, tMax: number, r: RectClip): [number, number] | null {
  let t0 = tMin;
  let t1 = tMax;
  const edges: [number, number][] = [[-dx, px - r.x0], [dx, r.x1 - px], [-dy, py - r.y0], [dy, r.y1 - py]];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return t0 < t1 ? [t0, t1] : null;
}

/** Position of a boundary point along the rectangle's perimeter, clockwise
 * from the top-left corner in screen orientation (top, right, bottom, left). */
function perimeterParam(x: number, y: number, r: RectClip): number {
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  const eps = 1e-9 * Math.max(w, h, 1);
  if (Math.abs(y - r.y0) <= eps && x < r.x1 - eps) return x - r.x0;
  if (Math.abs(x - r.x1) <= eps && y < r.y1 - eps) return w + (y - r.y0);
  if (Math.abs(y - r.y1) <= eps && x > r.x0 + eps) return w + h + (r.x1 - x);
  return 2 * w + h + (r.y1 - y);
}

/** Width and height of a site set's bounding box. */
function extent(sites: { x: ArrayLike<number>; y: ArrayLike<number>; n: number }): [number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < sites.n; i++) {
    if (sites.x[i] < x0) x0 = sites.x[i];
    if (sites.x[i] > x1) x1 = sites.x[i];
    if (sites.y[i] < y0) y0 = sites.y[i];
    if (sites.y[i] > y1) y1 = sites.y[i];
  }
  return sites.n ? [x1 - x0, y1 - y0] : [0, 0];
}

/** Circumcentres within `eps` of one another become one exact coordinate
 * (the lowest triangle's), so cocircular sites meet at a single corner.
 * A sort along x and a sweep make it near-linear; clusters are chained
 * (a is within eps of b, b of c), which is what rounding produces. */
function mergeClose(cc: Float64Array, eps: number): Float64Array {
  const n = cc.length / 2;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => cc[2 * a] - cc[2 * b] || cc[2 * a + 1] - cc[2 * b + 1] || a - b);
  const rep = new Int32Array(n).fill(-1);
  const out = Float64Array.from(cc);
  for (let k = 0; k < n; k++) {
    const i = order[k];
    if (rep[i] !== -1) continue;
    rep[i] = i;
    for (let j = k + 1; j < n && cc[2 * order[j]] - cc[2 * i] <= eps; j++) {
      const o = order[j];
      if (rep[o] === -1 && Math.abs(cc[2 * o + 1] - cc[2 * i + 1]) <= eps) rep[o] = i;
    }
  }
  for (let i = 0; i < n; i++) {
    out[2 * i] = cc[2 * rep[i]];
    out[2 * i + 1] = cc[2 * rep[i] + 1];
  }
  return out;
}

/** @internal The walls of the clipped diagram before they become material:
 * vertex coordinates, edge pairs, and each edge's origin (for diagnosis). */
export interface VoronoiWalls {
  vx: number[];
  vy: number[];
  edges: number[];
  kinds: ('wall' | 'ray' | 'bisector' | 'boundary')[];
  del: Delaunay<[number, number]> | null;
}

/** The material of a rectangle-clipped Voronoi diagram of `sites`. */
export function voronoiOf(sites: Sites, bounds: Bounds): Material {
  const { source, rows } = sitesOf(sites);
  const { vx, vy, edges, del } = voronoiWalls(sites, bounds);
  const m = new Material(Float64Array.from(vx), Float64Array.from(vy), {}, Uint32Array.from(edges));
  // Faces ↔ sites: a cell is convex, so its area centroid lies inside it and
  // names the site by nearest-site search. Site numbers are rows of the
  // source; rows outside a selection have no cell.
  const cells = m.faces(); // cached on the material: every later faces() is this collection
  const siteOfFace = new Int32Array(cells.length).fill(-1);
  const faceOfSite = new Int32Array(source.n).fill(-1);
  if (del) {
    for (const f of cells) {
      const outer = f.contours[0].pts;
      let cx = 0;
      let cy = 0;
      let a2 = 0;
      for (let k = 0; k < outer.length; k++) {
        const [x0, y0] = outer[k];
        const [x1, y1] = outer[(k + 1) % outer.length];
        const cross = x0 * y1 - x1 * y0;
        a2 += cross;
        cx += (x0 + x1) * cross;
        cy += (y0 + y1) * cross;
      }
      if (a2 === 0) continue;
      cx /= 3 * a2;
      cy /= 3 * a2;
      const k = del.find(cx, cy);
      if (k < 0) continue;
      const s = rows[k];
      if (faceOfSite[s] !== -1) continue;
      siteOfFace[f.index] = s;
      faceOfSite[s] = f.index;
    }
  }
  attachVoronoi(m, { sites: source, siteOfFace, faceOfSite, cells });
  return m;
}

/** @internal */
export function voronoiWalls(sitesIn: Sites, bounds: Bounds): VoronoiWalls {
  if (!(bounds.w > 0) || !(bounds.h > 0)) throw new Error('voronoi: bounds must have positive width and height');
  const rect: RectClip = { x0: bounds.x, y0: bounds.y, x1: bounds.x + bounds.w, y1: bounds.y + bounds.h };
  const { source, rows } = sitesOf(sitesIn);
  const n = rows.length;
  const sites = { x: rows.map((r) => source.x[r]), y: rows.map((r) => source.y[r]), n };
  const vx: number[] = [];
  const vy: number[] = [];
  const vertexAt = new Map<string, number>();
  const vertex = (x: number, y: number): number => {
    const key = `${x},${y}`;
    let id = vertexAt.get(key);
    if (id === undefined) {
      id = vx.length;
      vertexAt.set(key, id);
      vx.push(x);
      vy.push(y);
    }
    return id;
  };
  const edges: number[] = [];
  const kinds: VoronoiWalls['kinds'] = [];
  const edgeKeys = new Set<number>();
  const edge = (a: number, b: number, kind: VoronoiWalls['kinds'][number]): void => {
    if (a === b) return;
    const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(a, b);
    kinds.push(kind);
  };
  /** Boundary vertices with their perimeter position. */
  const boundary: { id: number; s: number }[] = [];
  const onBoundary = (id: number): void => {
    if (!boundary.some((b) => b.id === id)) boundary.push({ id, s: perimeterParam(vx[id], vy[id], rect) });
  };
  const inside = (x: number, y: number): boolean => x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1;
  const onRect = (x: number, y: number): boolean => x === rect.x0 || x === rect.x1 || y === rect.y0 || y === rect.y1;
  /** Add a wall from p along d for t in [tMin, tMax], clipped. An original
   * endpoint (t at tMin, or at tMax with `end` given) keeps its exact
   * coordinates, so a circumcentre is one vertex however many walls meet
   * there; a recomputed p + t·d would differ by an ulp. */
  const wall = (px: number, py: number, dx: number, dy: number, tMin: number, tMax: number, kind: VoronoiWalls['kinds'][number], end?: [number, number]): void => {
    const range = clipParams(px, py, dx, dy, tMin, tMax, rect);
    if (!range) return;
    const [t0, t1] = range;
    const endpoint = (t: number, original: number): number => {
      const exact = t === tMin ? [px, py] : t === tMax && end ? end : null;
      const x = exact ? exact[0] : px + t * dx;
      const y = exact ? exact[1] : py + t * dy;
      const id = vertex(x, y);
      // A clipped endpoint lies on the rectangle; so may an unclipped corner
      // that happens to fall exactly on it. Either way the boundary must
      // pass through it as a vertex, never touch it mid-edge.
      if (t !== original || !inside(x, y) || onRect(x, y)) onBoundary(id);
      return id;
    };
    const a = endpoint(t0, tMin);
    const b = endpoint(t1, tMax);
    edge(a, b, kind);
  };

  let del: Delaunay<[number, number]> | null = null;
  if (n > 0) {
    const coords = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      coords[2 * i] = sites.x[i];
      coords[2 * i + 1] = sites.y[i];
    }
    del = new Delaunay(coords) as unknown as Delaunay<[number, number]>;
    const hull = del.hull;
    const collinear = (del as unknown as { collinear?: Int32Array }).collinear;
    if (collinear) {
      // All sites on one line: the walls are the bisectors between consecutive
      // distinct sites along it (the triangulation is a jittered stand-in).
      let prev = -1;
      for (const i of collinear) {
        if (prev >= 0 && (sites.x[i] !== sites.x[prev] || sites.y[i] !== sites.y[prev])) {
          const mx = (sites.x[prev] + sites.x[i]) / 2;
          const my = (sites.y[prev] + sites.y[i]) / 2;
          wall(mx, my, -(sites.y[i] - sites.y[prev]), sites.x[i] - sites.x[prev], -Infinity, Infinity, 'bisector');
        }
        if (prev < 0 || sites.x[i] !== sites.x[prev] || sites.y[i] !== sites.y[prev]) prev = i;
      }
    } else if (hull.length === 2) {
      // Two distinct sites: one bisector wall across the rectangle.
      const a = hull[0];
      const b = hull[1];
      const mx = (sites.x[a] + sites.x[b]) / 2;
      const my = (sites.y[a] + sites.y[b]) / 2;
      const dx = -(sites.y[b] - sites.y[a]);
      const dy = sites.x[b] - sites.x[a];
      wall(mx, my, dx, dy, -Infinity, Infinity, 'bisector');
    } else if (hull.length > 2) {
      const tri = del.triangles;
      const half = del.halfedges;
      const cc = mergeClose(del.voronoi([rect.x0, rect.y0, rect.x1, rect.y1]).circumcenters, 1e-9 * Math.max(rect.x1 - rect.x0, rect.y1 - rect.y0, ...extent(sites)));
      const next = (e: number): number => (e % 3 === 2 ? e - 2 : e + 1);
      const prev = (e: number): number => (e % 3 === 0 ? e + 2 : e - 1);
      for (let e = 0; e < tri.length; e++) {
        const t = Math.floor(e / 3);
        const h = half[e];
        const x0 = cc[2 * t];
        const y0 = cc[2 * t + 1];
        if (h >= 0) {
          if (h < e) continue; // its twin already added this wall
          const u = Math.floor(h / 3);
          if (cc[2 * u] === x0 && cc[2 * u + 1] === y0) continue; // merged circumcentres: no wall between them
          wall(x0, y0, cc[2 * u] - x0, cc[2 * u + 1] - y0, 0, 1, 'wall', [cc[2 * u], cc[2 * u + 1]]);
        } else {
          // Hull edge a → b: the wall is a ray from the circumcentre,
          // perpendicular to the edge, away from the triangle's third vertex.
          const a = tri[e];
          const b = tri[next(e)];
          const c = tri[prev(e)];
          const ex = sites.x[b] - sites.x[a];
          const ey = sites.y[b] - sites.y[a];
          let dx = -ey;
          let dy = ex;
          const mx = (sites.x[a] + sites.x[b]) / 2;
          const my = (sites.y[a] + sites.y[b]) / 2;
          if (dx * (sites.x[c] - mx) + dy * (sites.y[c] - my) > 0) {
            dx = -dx;
            dy = -dy;
          }
          wall(x0, y0, dx, dy, 0, Infinity, 'ray');
        }
      }
    }
  }
  // The rectangle itself: corners, then boundary edges between consecutive
  // boundary vertices around the perimeter. No sites at all: nothing.
  if (n > 0) {
    for (const [x, y] of [[rect.x0, rect.y0], [rect.x1, rect.y0], [rect.x1, rect.y1], [rect.x0, rect.y1]]) onBoundary(vertex(x, y));
    boundary.sort((p, q) => p.s - q.s);
    for (let k = 0; k < boundary.length; k++) edge(boundary[k].id, boundary[(k + 1) % boundary.length].id, 'boundary');
  }
  return { vx, vy, edges, kinds, del };
}

/** Voronoi cells of any point set clipped to `bounds`, as material with
 * the site correspondence. A material or a point selection of one keeps
 * its identity as the sites (`cellOf` answers for that source's vertices);
 * bare points become a new material that is the sites. */
export function voronoi(points: PointsLike, bounds: Bounds): Material {
  return voronoiOf(points instanceof PointSelection ? points : material(points), bounds);
}
