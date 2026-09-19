/**
 * trails: the same drawing, re-wired so the pen lifts as few times as it can.
 *
 * `strokes` breaks a chain at every junction, because a vertex where three or
 * four edges meet has no single way onward — so a grid comes off the plotter
 * as one stroke per edge pair even though a pen could run straight through it.
 * A *trail* is a walk that uses no edge twice, and the fewest trails that cover
 * a connected network is `max(1, odd / 2)`, where `odd` counts its odd-degree
 * vertices: every trail has two ends, and only an odd vertex can be one.
 *
 * So the answer is not a drawing mode, it is a re-wiring. Splitting a junction
 * into one degree-2 vertex per passing pair leaves the ink exactly where it
 * was and lets the ordinary chain walk sail through, which is why this returns
 * plain Material and nothing about `strokes` had to change. A network with no
 * odd vertex at all comes back as one closed loop.
 *
 * No edge is ever drawn twice: this reaches the minimum without retracing,
 * which the project's routing default forbids. Pairing odd vertices along
 * shortest paths and duplicating those edges — the postman's answer — would
 * buy a single closed circuit at the cost of ink, and belongs behind an
 * explicit request rather than here.
 *
 * The split vertices sit on top of one another, which is exactly what they
 * are: one place the pen passes through twice. That makes the result a
 * DRAWING, not a structure — `faces()` refuses coincident distinct vertices,
 * and rightly. Keep the original for asking questions of, and trail the copy
 * for plotting it.
 */

import { Material, material as makeMaterial } from './material.js';

export interface TrailsOpts {
  /** Edge attributes for the rewired edges (the source edge's own columns are
   * carried across; these are added on top). */
  edgeAttributes?: Record<string, number>;
}

/** One pen-down run: the source rows it passes through, in order, and whether
 * it closes. */
interface Trail {
  rows: number[];
  edges: number[];
  closed: boolean;
}

export function trails(m: Material, opts: TrailsOpts = {}): Material {
  const src = makeMaterial(m);
  const E = src.edgeCount;
  const ends = (e: number): [number, number] => [src.edgeList[2 * e], src.edgeList[2 * e + 1]];
  if (E === 0) return src.withEdges([], opts.edgeAttributes);

  // Adjacency over real edges, in row order so the result is deterministic.
  const adj: number[][] = Array.from({ length: src.n }, () => []);
  for (let e = 0; e < E; e++) {
    const [a, b] = ends(e);
    adj[a].push(e);
    adj[b].push(e);
  }
  // Components over the edges.
  const comp = new Int32Array(src.n).fill(-1);
  const members: number[][] = [];
  for (let v = 0; v < src.n; v++) {
    if (comp[v] !== -1 || adj[v].length === 0) continue;
    const c = members.length;
    const group: number[] = [v];
    comp[v] = c;
    for (let k = 0; k < group.length; k++) {
      for (const e of adj[group[k]]) {
        const [a, b] = ends(e);
        const w = a === group[k] ? b : a;
        if (comp[w] === -1) {
          comp[w] = c;
          group.push(w);
        }
      }
    }
    members.push(group);
  }

  // Pairing the odd vertices with virtual edges makes every degree even, so
  // one Euler circuit exists; cutting that circuit at the virtual edges gives
  // back exactly `odd / 2` trails, which is the minimum. The virtual edges are
  // never drawn — they only say where the pen is allowed to lift.
  const virt: [number, number][] = [];
  const adjAll = adj.map((list) => list.slice());
  for (const group of members) {
    const odd = group.filter((v) => adj[v].length % 2 === 1).sort((a, b) => a - b);
    for (let k = 0; k + 1 < odd.length; k += 2) {
      const id = E + virt.length;
      virt.push([odd[k], odd[k + 1]]);
      adjAll[odd[k]].push(id);
      adjAll[odd[k + 1]].push(id);
    }
  }
  const endsAll = (e: number): [number, number] => (e < E ? ends(e) : virt[e - E]);

  const used = new Uint8Array(E + virt.length);
  const cursor = new Int32Array(src.n);
  const out: Trail[] = [];
  for (const group of members) {
    // Start where an odd vertex was, so a cut falls at the start of the walk
    // rather than mid-trail; with no odd vertex anywhere, start at the lowest
    // row and the circuit closes on itself.
    const odd = group.filter((v) => adj[v].length % 2 === 1);
    const start = odd.length ? Math.min(...odd) : Math.min(...group);
    for (;;) {
      // Hierholzer from any vertex of the component that still has an edge.
      let from = -1;
      if (adjAll[start].some((e) => !used[e])) from = start;
      else for (const v of group) if (adjAll[v].some((e) => !used[e])) { from = v; break; }
      if (from === -1) break;
      const stackV: number[] = [from];
      const stackE: number[] = [-1];
      const walkV: number[] = [];
      const walkE: number[] = [];
      while (stackV.length) {
        const v = stackV[stackV.length - 1];
        while (cursor[v] < adjAll[v].length && used[adjAll[v][cursor[v]]]) cursor[v]++;
        if (cursor[v] === adjAll[v].length) {
          walkV.push(v);
          walkE.push(stackE.pop()!);
          stackV.pop();
        } else {
          const e = adjAll[v][cursor[v]];
          used[e] = 1;
          const [a, b] = endsAll(e);
          stackV.push(a === v ? b : a);
          stackE.push(e);
        }
      }
      walkV.reverse();
      walkE.reverse();
      // walkE[0] is the -1 sentinel; walkE[k] is the edge from walkV[k-1].
      let run: Trail = { rows: [walkV[0]], edges: [], closed: false };
      for (let k = 1; k < walkV.length; k++) {
        const e = walkE[k];
        if (e >= E) {
          // A virtual edge: the pen lifts here.
          if (run.edges.length) out.push(run);
          run = { rows: [walkV[k]], edges: [], closed: false };
          continue;
        }
        run.rows.push(walkV[k]);
        run.edges.push(e);
      }
      if (run.edges.length) {
        // A walk that returns to where it began and lifted nowhere is a loop.
        if (out.length === 0 || true) run.closed = run.rows.length > 2 && run.rows[0] === run.rows[run.rows.length - 1];
        out.push(run);
      }
    }
  }

  // Emit: one fresh row per step of each trail, so every vertex the pen passes
  // through twice becomes two rows and the chain walk runs straight through.
  const names = Object.keys(src.attrs);
  const edgeNames = Object.keys(src.edgeAttrs);
  const xs: number[] = [];
  const ys: number[] = [];
  const cols: Record<string, number[]> = Object.fromEntries(names.map((k) => [k, []]));
  const edgeCols: Record<string, number[]> = Object.fromEntries(edgeNames.map((k) => [k, []]));
  const edges: number[] = [];
  for (const run of out) {
    const rows = run.closed ? run.rows.slice(0, -1) : run.rows;
    const base = xs.length;
    for (const v of rows) {
      xs.push(src.x[v]);
      ys.push(src.y[v]);
      for (const k of names) cols[k].push(src.attrs[k][v]);
    }
    for (let i = 0; i < run.edges.length; i++) {
      const a = base + i;
      const b = run.closed && i === run.edges.length - 1 ? base : base + i + 1;
      edges.push(a, b);
      for (const k of edgeNames) edgeCols[k].push(src.edgeAttrs[k][run.edges[i]]);
    }
  }
  const extra = opts.edgeAttributes ?? {};
  for (const k of Object.keys(extra)) if (!edgeNames.includes(k)) edgeCols[k] = new Array(edges.length / 2).fill(extra[k]);
  return new Material(Float64Array.from(xs), Float64Array.from(ys), Object.fromEntries(names.map((k) => [k, Float64Array.from(cols[k])])), Uint32Array.from(edges), { iteration: 0, history: [], edgeAttrs: Object.fromEntries(Object.keys(edgeCols).map((k) => [k, Float64Array.from(edgeCols[k])])), transfers: { ...src.transfers }, edgeTransfers: { ...src.edgeTransfers } });
}
