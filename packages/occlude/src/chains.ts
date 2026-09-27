/**
 * The one chain walk: a set of edges over source vertex rows becomes
 * chains. Used by a material (all its edges) and by an edge selection (its
 * selected edges) alike, so a selection's chains follow the selected
 * topology without extracting a temporary material. The chains are the
 * rows of the `curves` domain (curves.ts).
 *
 * Chains start at endpoints and junctions (degree ≠ 2 within the given
 * edges), pass through degree-2 vertices, and end at the next endpoint or
 * junction; edges left over belong to pure cycles, which come back closed.
 * A cycle starts at the stored start of its first edge row (in the order
 * given) and runs that edge's way. Every edge
 * is covered once; a junction vertex appears in each chain that meets it.
 * Chains come in row order of their first vertex (stable), so a material
 * built from contours keeps contour order.
 */

/**
 * @internal One chain: the kernel record every chain consumer reads. The
 * public view of it is a `curves` row (curves.ts).
 */
export interface Chain {
  /** The vertex rows it walks, in walk order; a ring lists each once. */
  indices: number[];
  /** The edge rows it walks, in walk order: edge `k` joins vertex `k` to
   * vertex `k + 1` (a ring's closing edge last). A view of one buffer the
   * whole walk shares — every edge is walked once. */
  readonly edges: Uint32Array;
  closed: boolean;
  /** The positions of `indices`. */
  pts: [number, number][];
  /** Segment by segment: is it a geodesic of the space? Absent when none is. */
  geodesic?: boolean[];
}

export interface ChainInput {
  /** Rows of the vertex table (source rows). */
  vertexCount: number;
  /** Edge rows to walk, in the order that decides pure-cycle order. */
  edgeRows: ArrayLike<number>;
  /** Endpoints of an edge row, stored order. */
  endpoints: (e: number) => [number, number];
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  /** Is this edge row a geodesic of the space? Given, a chain that walks
   * one carries `geodesic`, segment by segment (see `IsoContour`). */
  geodesic?: (e: number) => boolean;
}

/** A chain as the walk makes it: its edges a run of the walk's one buffer,
 * viewed when asked for. */
class WalkedChain implements Chain {
  declare geodesic?: boolean[];
  constructor(
    public indices: number[],
    public closed: boolean,
    public pts: [number, number][],
    geodesic: boolean[] | undefined,
    private readonly walked: Uint32Array,
    private readonly from: number,
    private readonly to: number,
  ) {
    if (geodesic) this.geodesic = geodesic;
  }
  get edges(): Uint32Array {
    return this.walked.subarray(this.from, this.to);
  }
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

export function walkChains(input: ChainInput): Chain[] {
  const { vertexCount: n, edgeRows, endpoints, x, y, geodesic } = input;
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
  // Every edge is walked exactly once, so the walk's edges, chain after
  // chain, fill one buffer; each chain keeps a view of its run.
  const walked = new Uint32Array(m);
  let cursor = 0;
  const other = (k: number, v: number): number => (A[k] === v ? B[k] : A[k]);
  const nextUnused = (v: number): number => {
    for (let s = start[v]; s < start[v + 1]; s++) if (!used[incident[s]]) return incident[s];
    return -1;
  };
  const out: Chain[] = [];
  const walk = (from: number, firstEdge: number, stopAtDegree: boolean): Chain => {
    const indices = [from];
    const first = cursor;
    let c = cursor;
    const flags: boolean[] = [];
    let v = from;
    let k = firstEdge;
    for (;;) {
      used[k] = 1;
      walked[c++] = edgeRows[k];
      if (geodesic) flags.push(geodesic(edgeRows[k]));
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
    cursor = c;
    const pts = indices.map((i) => [x[i], y[i]] as [number, number]);
    // A closed chain's last edge is its closing segment, as the flags say.
    return new WalkedChain(indices, closed, pts, flags.some((g) => g) ? flags : undefined, walked, first, c);
  };
  for (let v = 0; v < n; v++) {
    if (degree[v] === 2 || degree[v] === 0) continue;
    for (let s = start[v]; s < start[v + 1]; s++) {
      const k = incident[s];
      if (!used[k]) out.push(walk(v, k, true));
    }
  }
  // What is left is pure cycles. A ring starts at the stored start of its
  // first edge row and runs that edge's way: the direction of its edges
  // and the order of their rows decide it.
  for (let k = 0; k < m; k++) {
    if (!used[k]) out.push(walk(A[k], k, false));
  }
  return out.sort((p, q) => p.indices[0] - q.indices[0]);
}
