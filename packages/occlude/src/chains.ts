/**
 * The one chain walk: a set of edges over source vertex rows becomes
 * chains for drawing. Used by a material (all its edges) and by an edge
 * selection (its selected edges) alike, so a selection's chains follow the
 * selected topology without extracting a temporary material.
 *
 * Chains start at endpoints and junctions (degree ≠ 2 within the given
 * edges), pass through degree-2 vertices, and end at the next endpoint or
 * junction; edges left over belong to pure cycles, which come back closed.
 * Every edge is covered once; a junction vertex appears in each chain that
 * meets it. Chains come in row order of their first vertex (stable), so a
 * material built from contours keeps contour order.
 */

import type { Curve } from './material.js';

export interface ChainInput {
  /** Rows of the vertex table (source rows). */
  vertexCount: number;
  /** Edge rows to walk, in the order that decides pure-cycle order. */
  edgeRows: ArrayLike<number>;
  /** Endpoints of an edge row, stored order. */
  endpoints: (e: number) => [number, number];
  x: ArrayLike<number>;
  y: ArrayLike<number>;
}

/** Vertex degree within the given edges, as a dense count per source row. */
export function degreesWithin(vertexCount: number, edgeRows: ArrayLike<number>, endpoints: (e: number) => [number, number]): Uint32Array {
  const degree = new Uint32Array(vertexCount);
  for (let k = 0; k < edgeRows.length; k++) {
    const [a, b] = endpoints(edgeRows[k]);
    degree[a]++;
    degree[b]++;
  }
  return degree;
}

export function walkChains(input: ChainInput): Curve[] {
  const { vertexCount: n, edgeRows, endpoints, x, y } = input;
  const m = edgeRows.length;
  if (m === 0) return [];
  // CSR of local edge indices by vertex, in edge order.
  const degree = degreesWithin(n, edgeRows, endpoints);
  const start = new Uint32Array(n + 1);
  for (let v = 0; v < n; v++) start[v + 1] = start[v] + degree[v];
  const fill = start.slice(0, n);
  const incident = new Uint32Array(start[n]);
  const A = new Uint32Array(m);
  const B = new Uint32Array(m);
  for (let k = 0; k < m; k++) {
    const [a, b] = endpoints(edgeRows[k]);
    A[k] = a;
    B[k] = b;
    incident[fill[a]++] = k;
    incident[fill[b]++] = k;
  }
  const used = new Uint8Array(m);
  const other = (k: number, v: number): number => (A[k] === v ? B[k] : A[k]);
  const nextUnused = (v: number): number => {
    for (let s = start[v]; s < start[v + 1]; s++) if (!used[incident[s]]) return incident[s];
    return -1;
  };
  const out: Curve[] = [];
  const walk = (from: number, firstEdge: number, stopAtDegree: boolean): Curve => {
    const indices = [from];
    let v = from;
    let k = firstEdge;
    for (;;) {
      used[k] = 1;
      v = other(k, v);
      indices.push(v);
      if (stopAtDegree && degree[v] !== 2) break;
      if (v === from) break;
      const nk = nextUnused(v);
      if (nk < 0) break;
      k = nk;
    }
    const closed = indices.length > 1 && indices[0] === indices[indices.length - 1];
    if (closed) indices.pop();
    return { indices, closed, pts: indices.map((i) => [x[i], y[i]] as [number, number]) };
  };
  for (let v = 0; v < n; v++) {
    if (degree[v] === 2 || degree[v] === 0) continue;
    for (let s = start[v]; s < start[v + 1]; s++) {
      const k = incident[s];
      if (!used[k]) out.push(walk(v, k, true));
    }
  }
  for (let k = 0; k < m; k++) {
    if (!used[k]) out.push(walk(A[k], k, false));
  }
  return out.sort((p, q) => p.indices[0] - q.indices[0]);
}
