/**
 * thicken: give points and connections thickness, resolve their combined
 * coverage, and return ordinary boundary Material.
 *
 * Every participating vertex carries a radius and every participating edge
 * sweeps the disc at one end into the disc at the other with the radius
 * interpolated linearly along it. Because centre and radius both interpolate
 * linearly, that swept area is exactly the convex hull of the two endpoint
 * discs — two common tangent segments and the two exposed arcs — so the union
 * of every contribution has an analytic boundary of straight intervals and
 * circular arcs, and no circle sampling is needed to decide connectivity.
 * Those boundaries are split at their real events, intervals another
 * contribution covers are dropped, coincident exposed boundaries are merged,
 * and the survivors are stitched into closed walks with the coverage on the
 * left: outer contours positive, holes negative.
 *
 * Pure and deterministic, like `distanceTo`: a module import with no sketch
 * frame, seed, pen, paper or renderer. The result is a fresh Material of
 * closed chains — ready for `polygon`, `strokes`, `along`, `distanceTo`,
 * `t.within` and the material inspection paths. `tolerance` only bounds the
 * deviation of the tessellated arcs; it is not a weld distance, a nib
 * threshold or a simplification strength.
 */

import { Material, material as makeMaterial, type Vertex } from './material.js';
import { EdgeSelection, PointSelection } from './relation.js';
import type { EventCandidate, PlanarEvent } from './faces.js';
import {
  analyticalUnion,
  type Envelope as Shape,
  type BoundaryVertex as OutVert,
  type Candidate as Cand,
} from './thicken-arrangement.js';

/** How `thicken` resolves a source into thickness. */
export interface ThickenOpts {
  /** Required. Radius in the source material's coordinate units: one number
   * for every participating vertex, or a callback read from the vertex view
   * (its real attributes — `p.radius`, not `p.attrs.radius`). */
  radius: number | ((p: Vertex) => number);

  /** Positive boundary-approximation error for the curved parts, in the same
   * units. Default 0.05. Larger means coarser arcs, never a smaller shape. */
  tolerance?: number;

  /** Optional creation of output point attributes: called once per final
   * output vertex with the boundary position and the source generators that
   * meet there. The returned record is the complete output row. */
  point?: (event: PlanarEvent) => Record<string, number>;
}

function candKey(c: Cand): string {
  return c.vertex !== undefined ? `v${c.vertex}` : `e${c.edge}:${c.t}`;
}

function candOrder(a: Cand, b: Cand): number {
  const av = a.vertex ?? Infinity;
  const bv = b.vertex ?? Infinity;
  if (av !== bv) return av - bv;
  const ae = a.edge ?? Infinity;
  const be = b.edge ?? Infinity;
  if (ae !== be) return ae - be;
  return (a.t ?? 0) - (b.t ?? 0);
}

// ---- canonical output ------------------------------------------------------------

function loopArea(loop: readonly OutVert[]): number {
  // Accumulate about the first vertex: world-coordinate cross products
  // silently cancel to zero for a tiny loop far from the origin.
  const ox = loop[0].x;
  const oy = loop[0].y;
  let a = 0;
  for (let k = 0; k < loop.length; k++) {
    const p = loop[k];
    const q = loop[(k + 1) % loop.length];
    a += (p.x - ox) * (q.y - oy) - (q.x - ox) * (p.y - oy);
  }
  return a / 2;
}

function canonicalize(loop: OutVert[]): OutVert[] {
  // Same coordinate twice in a row is one vertex (merge its candidates).
  const compact: OutVert[] = [];
  for (const v of loop) {
    const last = compact[compact.length - 1];
    if (last && last.x === v.x && last.y === v.y) {
      for (const c of v.cands)
        if (!last.cands.some((x) => candKey(x) === candKey(c)))
          last.cands.push(c);
      continue;
    }
    compact.push({ x: v.x, y: v.y, cands: v.cands.slice() });
  }
  if (compact.length > 1) {
    const first = compact[0];
    const last = compact[compact.length - 1];
    if (first.x === last.x && first.y === last.y) {
      for (const c of last.cands)
        if (!first.cands.some((x) => candKey(x) === candKey(c)))
          first.cands.push(c);
      compact.pop();
    }
  }
  if (compact.length < 3) return [];
  // Deterministic start: the lexicographically smallest vertex.
  let start = 0;
  for (let k = 1; k < compact.length; k++) {
    const v = compact[k];
    const s = compact[start];
    if (v.x < s.x || (v.x === s.x && v.y < s.y)) start = k;
  }
  const out = compact.slice(start).concat(compact.slice(0, start));
  for (const v of out) v.cands.sort(candOrder);
  return out;
}

// ---- public entry -----------------------------------------------------------------

function candidateAttrs(c: Cand, source: Material): Record<string, number> {
  const out: Record<string, number> = {};
  if (c.vertex !== undefined) {
    for (const name of source.attrNames)
      out[name] = source.attrs[name][c.vertex];
    return out;
  }
  const e = c.edge!;
  const t = c.t!;
  const a = source.edgeList[2 * e];
  const b = source.edgeList[2 * e + 1];
  for (const name of source.attrNames) {
    const va = source.attrs[name][a];
    const vb = source.attrs[name][b];
    out[name] =
      source.transfers[name] === 'nearest'
        ? t <= 0.5
          ? va
          : vb
        : va + (vb - va) * t;
  }
  return out;
}

function checkOpts(opts: ThickenOpts): number {
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
    throw new Error('thicken: options must be an object with a radius');
  }
  for (const key of Object.keys(opts)) {
    if (key !== 'radius' && key !== 'tolerance' && key !== 'point')
      throw new Error(`thicken: unknown option '${key}'`);
  }
  const radius = opts.radius;
  if (radius === undefined) throw new Error('thicken: radius is required');
  if (typeof radius !== 'number' && typeof radius !== 'function') {
    throw new Error(
      'thicken: radius must be a number or a function of a vertex',
    );
  }
  if (typeof radius === 'number' && (!Number.isFinite(radius) || radius < 0)) {
    throw new Error(
      `thicken: radius must be finite and non-negative, got ${radius}`,
    );
  }
  const tol = opts.tolerance ?? 0.05;
  if (typeof tol !== 'number' || !Number.isFinite(tol) || tol <= 0) {
    throw new Error(
      `thicken: tolerance must be finite and greater than zero, got ${String(opts.tolerance)}`,
    );
  }
  if (opts.point !== undefined && typeof opts.point !== 'function') {
    throw new Error('thicken: point must be a function of an event');
  }
  return tol;
}

/**
 * Give `source`'s points and connections thickness: the union of every
 * participating vertex's disc and every participating edge's variable-radius
 * disc envelope, as ordinary boundary Material.
 *
 * Participation: a Material contributes every vertex (isolated ones as bare
 * discs) and every edge; a point selection contributes its selected vertices
 * — including selected vertices with no selected neighbour, which stay bare
 * discs — and the edges whose both endpoints are selected; an edge selection
 * contributes its edges and their endpoints only.
 *
 * `radius` is one number or a callback over the source's own vertex views,
 * evaluated once per participating vertex in source row order. `tolerance`
 * (default 0.05, source units) bounds the arc tessellation only. Without
 * `point` the result is geometry only; with `point` each final boundary
 * vertex gets the callback's record as its complete attribute row.
 */
export function thicken(
  source: Material | PointSelection<unknown> | EdgeSelection<unknown>,
  opts: ThickenOpts,
): Material {
  const tol = checkOpts(opts);

  let src: Material;
  let vRows: readonly number[];
  let eRows: readonly number[];
  if (source instanceof Material) {
    src = source;
    const v: number[] = [];
    for (let i = 0; i < source.n; i++) v.push(i);
    const e: number[] = [];
    for (let i = 0; i < source.edgeCount; i++) e.push(i);
    vRows = v;
    eRows = e;
  } else if (source instanceof PointSelection) {
    src = source.source;
    vRows = source.indices;
    eRows = source.inducedEdges().indices;
  } else if (source instanceof EdgeSelection) {
    src = source.source;
    vRows = source.endpointRows;
    eRows = source.indices;
  } else {
    throw new Error(
      'thicken: source must be a Material, a point selection or an edge selection',
    );
  }

  if (vRows.length === 0) return makeMaterial([]);

  const radii = new Float64Array(src.n);
  radii.fill(NaN);
  for (const row of vRows) {
    const x = src.x[row];
    const y = src.y[row];
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new Error(`thicken: vertex ${row} is not finite`);
    let r: number;
    if (typeof opts.radius === 'number') r = opts.radius;
    else r = opts.radius(src.vertex(row));
    if (typeof r !== 'number' || !Number.isFinite(r) || r < 0) {
      throw new Error(
        `thicken: radius for vertex ${row} must be finite and non-negative, got ${String(r)}`,
      );
    }
    radii[row] = r;
  }

  // ---- coverage shapes: edges first, then isolated participating vertices ----
  const onEdge = new Set<number>();
  const shapes: Shape[] = [];
  for (const e of eRows) {
    const a = src.edgeList[2 * e];
    const b = src.edgeList[2 * e + 1];
    onEdge.add(a);
    onEdge.add(b);
    const ra = radii[a];
    const rb = radii[b];
    if (!(ra > 0) && !(rb > 0)) continue;
    shapes.push({
      ax: src.x[a],
      ay: src.y[a],
      bx: src.x[b],
      by: src.y[b],
      ra,
      rb,
      va: a,
      vb: b,
      edge: e,
      minX: Math.min(src.x[a] - ra, src.x[b] - rb),
      minY: Math.min(src.y[a] - ra, src.y[b] - rb),
      maxX: Math.max(src.x[a] + ra, src.x[b] + rb),
      maxY: Math.max(src.y[a] + ra, src.y[b] + rb),
    });
  }
  for (const row of vRows) {
    if (onEdge.has(row) || !(radii[row] > 0)) continue;
    const r = radii[row];
    shapes.push({
      ax: src.x[row],
      ay: src.y[row],
      bx: src.x[row],
      by: src.y[row],
      ra: r,
      rb: r,
      va: row,
      vb: row,
      edge: -1,
      minX: src.x[row] - r,
      minY: src.y[row] - r,
      maxX: src.x[row] + r,
      maxY: src.y[row] + r,
    });
  }
  if (shapes.length === 0) return makeMaterial([]);

  const loops = analyticalUnion(shapes, tol, !!opts.point).map(canonicalize);
  for (const loop of loops) {
    if (loop.length < 3 || loopArea(loop) === 0)
      throw new Error(
        'thicken: exact boundary cannot be represented by this binary64 polygon',
      );
  }

  loops.sort((a, b) => {
    const aa = loopArea(a);
    const ab = loopArea(b);
    if (aa !== ab) return ab - aa;
    if (a[0].x !== b[0].x) return a[0].x - b[0].x;
    return a[0].y - b[0].y;
  });

  // ---- output material: fresh arrays, no inherited columns ----
  let total = 0;
  for (const loop of loops) total += loop.length;
  const x = new Float64Array(total);
  const y = new Float64Array(total);
  const edges = new Uint32Array(total * 2);
  let at = 0;
  let et = 0;
  for (const loop of loops) {
    const base = at;
    for (let k = 0; k < loop.length; k++) {
      x[at] = loop[k].x;
      y[at] = loop[k].y;
      at++;
    }
    for (let k = 0; k < loop.length; k++) {
      edges[et++] = base + k;
      edges[et++] = base + ((k + 1) % loop.length);
    }
  }

  let attrs: Record<string, Float64Array> = {};
  if (opts.point) {
    const point = opts.point;
    let schema: string[] | null = null;
    const cols: Record<string, Float64Array> = {};
    let index = 0;
    for (const loop of loops) {
      for (const v of loop) {
        const event: PlanarEvent = {
          position: [v.x, v.y],
          candidates: v.cands.map((c): EventCandidate => {
            const base: EventCandidate = { attrs: candidateAttrs(c, src) };
            if (c.vertex !== undefined) base.vertex = c.vertex;
            else {
              base.edge = c.edge;
              base.t = c.t;
            }
            return base;
          }),
        };
        let record: Record<string, number>;
        try {
          record = point(event);
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          throw new Error(
            `thicken: point callback threw at output vertex ${index} (${v.x}, ${v.y}): ${why}`,
          );
        }
        if (typeof record !== 'object' || record === null) {
          throw new Error(
            `thicken: point callback must return a record for output vertex ${index}`,
          );
        }
        const keys = Object.keys(record);
        for (const key of keys) {
          if (key === 'x' || key === 'y' || key === 'index')
            throw new Error(
              `thicken: point callback used reserved name '${key}' at output vertex ${index}`,
            );
          if (!Number.isFinite(record[key]))
            throw new Error(
              `thicken: point callback returned a non-finite '${key}' at output vertex ${index}`,
            );
        }
        if (schema === null) {
          schema = keys;
          for (const key of keys) cols[key] = new Float64Array(total);
        } else if (
          keys.length !== schema.length ||
          schema.some((k) => !keys.includes(k))
        ) {
          throw new Error(
            `thicken: point callback changed its columns at output vertex ${index} (expected ${schema.join(', ') || 'none'}; got ${keys.join(', ') || 'none'})`,
          );
        }
        for (const key of schema) cols[key][index] = record[key];
        index++;
      }
    }
    attrs = cols;
  }

  return new Material(x, y, attrs, edges, 0, [], {}, {}, {});
}
