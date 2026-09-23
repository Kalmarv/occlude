/**
 * interlace: say which strand passes over, and break the one that passes under.
 *
 * Occlusion in this project is *computed* — exact, from geometry, in draw
 * order. A knot diagram is the opposite kind of object: a curve plus a decision
 * at every crossing, authored rather than derived. No amount of exact geometry
 * gives you that, because the two strands are in the same plane and neither is
 * in front; which one is on top is information the drawing carries, not
 * information the drawing contains.
 *
 * So this adds the information. Every proper crossing of two non-adjacent
 * edges is found, `over` is asked which of the two is on top, and the one
 * underneath loses `gap` of its length, centred on the crossing. What comes
 * back is ordinary Material — shorter, in more pieces — which strokes,
 * resamples and plots like anything else. Nothing about occlusion changed, and
 * nothing here consults it.
 *
 * A cut is a SPLIT, as `splitEdges` is. A vertex the cut leaves in place is
 * the vertex it was: its id and its columns. A cut end is a new vertex, its
 * columns read off the edge under it by each column's transfer. Every piece
 * of an edge keeps that edge's lineage root and its columns; a piece that
 * is the whole edge keeps the edge's id too, and a shorter one is minted.
 * So a column the growth carried (`strand`) still picks a pen after the
 * weave, and `sel.in(woven)` still finds what was not cut away.
 *
 * `over` is handed the crossing and returns `true` when strand A is on top.
 * The default alternates: a strand that went under at its last crossing goes
 * over at the next, which is what makes woven work look woven, and what a
 * Celtic knot or a plain three-strand braid is doing. `over: () => true` is a
 * plain painter's order instead, and any rule you can write over the two
 * strands' own columns is available — the point is that the decision is data.
 *
 * Pure: no seed, no paper. `gap` is a length in the material's own
 * coordinates, as `thicken` and `oscillate` take theirs.
 */

import { Material, material as makeMaterial, mintIds } from './material.js';
import { inheritEdge } from './steps.js';
import { pairKey } from './views.js';

/** One place two strands cross, as `over` sees it. */
export interface Crossing {
  readonly x: number;
  readonly y: number;
  /** How many crossings strand A had already met, walking its own chain. */
  readonly nthA: number;
  readonly nthB: number;
  /** Which chain each strand belongs to, in `curves()` order. */
  readonly chainA: number;
  readonly chainB: number;
  /** How far along its chain each strand is, as a length. */
  readonly alongA: number;
  readonly alongB: number;
}

export interface InterlaceOpts {
  /** How much of the under strand is removed, centred on the crossing, in the
   * material's own coordinates. */
  gap: number;
  /** True when strand A passes over strand B. Default alternates along each
   * chain, which is what makes woven work look woven. */
  over?: (c: Crossing) => boolean;
}

interface Hit {
  chain: number;
  at: number;    // arc position along that chain
  other: number; // the other chain
  otherAt: number;
  x: number;
  y: number;
  nth: number;
}

export function interlace(m: Material, opts: InterlaceOpts): Material {
  const src = makeMaterial(m);
  const asked = opts?.gap;
  if (typeof asked !== 'number') throw new Error(`interlace: { gap } must be a non-negative length in the material's own coordinates (got ${String(asked)})`);
  // A gap below zero, or one that is no number at all, cuts nothing away.
  const gap = asked > 0 ? asked : 0;
  if (opts.over !== undefined && typeof opts.over !== 'function') throw new Error('interlace: { over } must be a function of the crossing');

  const curves = src.curves();
  const chains = curves.map((c) => c.pts.map(([x, y]) => [x, y] as [number, number]));
  // The source row under each chain point, for the columns and the ids.
  const rowsOf = curves.map((c) => [...c.indices]);
  // A closed chain's last segment returns to its first point.
  const closed = curves.map((c) => c.closed);
  for (let k = 0; k < chains.length; k++) {
    if (closed[k] && chains[k].length > 2) {
      chains[k] = [...chains[k], chains[k][0]];
      rowsOf[k] = [...rowsOf[k], rowsOf[k][0]];
    }
  }
  const arcs = chains.map((pts) => {
    const out = [0];
    for (let i = 1; i < pts.length; i++) out.push(out[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    return out;
  });

  // Proper crossings between segments of different chains, or of the same
  // chain but not adjacent along it.
  const hits: Hit[] = [];
  const side = (ax: number, ay: number, bx: number, by: number, px: number, py: number) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  for (let p = 0; p < chains.length; p++) {
    for (let i = 0; i + 1 < chains[p].length; i++) {
      const [ax, ay] = chains[p][i];
      const [bx, by] = chains[p][i + 1];
      for (let q = p; q < chains.length; q++) {
        for (let j = q === p ? i + 2 : 0; j + 1 < chains[q].length; j++) {
          const [cx, cy] = chains[q][j];
          const [dx, dy] = chains[q][j + 1];
          // Two segments that share an endpoint MEET, they do not cross. The
          // orientation test cannot tell the difference on its own — one of
          // its four values is exactly zero at a shared vertex, which reads as
          // a crossing — and a closed chain always has such a pair at its
          // seam, where the last segment comes back to the first. Left in, a
          // lone circle with nothing near it loses half a gap at its seam.
          if ((ax === cx && ay === cy) || (ax === dx && ay === dy) || (bx === cx && by === cy) || (bx === dx && by === dy)) continue;
          const s1 = side(ax, ay, bx, by, cx, cy);
          const s2 = side(ax, ay, bx, by, dx, dy);
          const s3 = side(cx, cy, dx, dy, ax, ay);
          const s4 = side(cx, cy, dx, dy, bx, by);
          if (!(s1 > 0 !== s2 > 0 && s3 > 0 !== s4 > 0)) continue;
          const t = s3 / (s3 - s4);
          const u = s1 / (s1 - s2);
          const x = ax + (bx - ax) * t;
          const y = ay + (by - ay) * t;
          hits.push({ chain: p, at: arcs[p][i] + (arcs[p][i + 1] - arcs[p][i]) * t, other: q, otherAt: arcs[q][j] + (arcs[q][j + 1] - arcs[q][j]) * u, x, y, nth: 0 });
        }
      }
    }
  }
  // Number each crossing along each chain, so "alternate" has something to
  // alternate over.
  const order: number[][] = chains.map(() => []);
  hits.forEach((h, k) => { order[h.chain].push(k); order[h.other].push(k); });
  const nthOn = hits.map(() => [0, 0]);
  for (let c = 0; c < chains.length; c++) {
    const along = order[c].map((k) => [hits[k].chain === c ? hits[k].at : hits[k].otherAt, k] as [number, number]);
    along.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    along.forEach(([, k], i) => { nthOn[k][hits[k].chain === c ? 0 : 1] = i; });
  }

  const rule = opts.over ?? ((c: Crossing) => (c.nthA + c.nthB) % 2 === 0);
  // Where each chain is cut: the arc positions at which it passes under.
  const cuts: number[][] = chains.map(() => []);
  hits.forEach((h, k) => {
    const c: Crossing = { x: h.x, y: h.y, nthA: nthOn[k][0], nthB: nthOn[k][1], chainA: h.chain, chainB: h.other, alongA: h.at, alongB: h.otherAt };
    const aOver = rule(c) !== false;
    if (aOver) cuts[h.other].push(h.otherAt);
    else cuts[h.chain].push(h.at);
  });

  // Rebuild each chain, leaving out a `gap` of arc around every cut.
  const xs: number[] = [];
  const ys: number[] = [];
  const edges: number[] = [];
  // Where each new point came from: a source row it IS, or a place along a
  // source edge it was read off. And each new edge's source edge, and how
  // much of it the piece is.
  const pointFrom: ({ row: number } | { a: number; b: number; f: number })[] = [];
  const edgeFrom: { edge: number; fraction: number; whole: boolean }[] = [];
  const storedRow = new Map<number, number>();
  for (let e = 0; e < src.edgeCount; e++) storedRow.set(pairKey(src.edgeList[2 * e], src.edgeList[2 * e + 1]), e);
  const segmentAt = (c: number, s: number): number => {
    const a = arcs[c];
    let i = 1;
    while (i < a.length - 1 && a[i] < s) i++;
    return i;
  };
  const at = (c: number, s: number): [number, number] => {
    const a = arcs[c];
    const i = segmentAt(c, s);
    const span = a[i] - a[i - 1];
    const f = span > 0 ? (s - a[i - 1]) / span : 0;
    const [x0, y0] = chains[c][i - 1];
    const [x1, y1] = chains[c][i];
    return [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f];
  };
  /** The source a cut end at arc `s` of chain `c` comes from: the vertex
   * it lands on exactly, or the place along the edge under it. */
  const endFrom = (c: number, s: number): { row: number } | { a: number; b: number; f: number } => {
    const a = arcs[c];
    const i = segmentAt(c, s);
    const span = a[i] - a[i - 1];
    const f = span > 0 ? (s - a[i - 1]) / span : 0;
    if (f === 0) return { row: rowsOf[c][i - 1] };
    if (f === 1) return { row: rowsOf[c][i] };
    return { a: rowsOf[c][i - 1], b: rowsOf[c][i], f };
  };
  for (let c = 0; c < chains.length; c++) {
    const total = arcs[c][arcs[c].length - 1];
    // A hole of no width removes nothing, so it must not split anything
    // either: a zero gap has to leave the drawing exactly as it was.
    const holes = cuts[c]
      .map((s) => [Math.max(0, s - gap / 2), Math.min(total, s + gap / 2)] as [number, number])
      .filter(([a, b]) => b > a)
      .sort((p, q) => p[0] - q[0]);
    // Merge holes that touch, so two crossings a hair apart leave one gap.
    const merged: [number, number][] = [];
    for (const h of holes) {
      const last = merged[merged.length - 1];
      if (last && h[0] <= last[1]) last[1] = Math.max(last[1], h[1]);
      else merged.push([h[0], h[1]]);
    }
    const runs: [number, number][] = [];
    let from = 0;
    for (const [a, b] of merged) {
      if (a > from) runs.push([from, a]);
      from = Math.max(from, b);
    }
    if (from < total) runs.push([from, total]);
    for (const [a, b] of runs) {
      if (!(b > a)) continue;
      const base = xs.length;
      // Keep the chain's own vertices inside the run, plus its two cut ends.
      const pts: [number, number][] = [at(c, a)];
      const along: number[] = [a];
      pointFrom.push(endFrom(c, a));
      for (let i = 0; i < arcs[c].length; i++) {
        if (arcs[c][i] > a && arcs[c][i] < b) {
          pts.push(chains[c][i]);
          along.push(arcs[c][i]);
          pointFrom.push({ row: rowsOf[c][i] });
        }
      }
      pts.push(at(c, b));
      along.push(b);
      pointFrom.push(endFrom(c, b));
      for (const [px, py] of pts) {
        xs.push(px);
        ys.push(py);
      }
      for (let i = 1; i < pts.length; i++) {
        edges.push(base + i - 1, base + i);
        // The piece lies on the chain segment under its middle.
        const seg = segmentAt(c, (along[i - 1] + along[i]) / 2);
        const s0 = arcs[c][seg - 1];
        const s1 = arcs[c][seg];
        const edge = storedRow.get(pairKey(rowsOf[c][seg - 1], rowsOf[c][seg]))!;
        edgeFrom.push({ edge, fraction: s1 > s0 ? (along[i] - along[i - 1]) / (s1 - s0) : 1, whole: along[i - 1] === s0 && along[i] === s1 });
      }
    }
  }
  // Columns and identity, carried the way a split carries them.
  const n = xs.length;
  const attrs: Record<string, Float64Array> = {};
  for (const name of src.attrNames) {
    const col = src.attrs[name];
    const nearest = src.transfers[name] === 'nearest';
    attrs[name] = Float64Array.from(pointFrom, (p) => ('row' in p ? col[p.row] : nearest ? (p.f <= 0.5 ? col[p.a] : col[p.b]) : col[p.a] + (col[p.b] - col[p.a]) * p.f));
  }
  // A vertex that comes through keeps its id once. The same vertex again —
  // the seam of a closed chain, a junction met by two chains — is a copy,
  // and a copy is a new point.
  const used = new Set<number>();
  const keeps = pointFrom.map((p) => ('row' in p && !used.has(p.row) ? (used.add(p.row), true) : false));
  const freshPoints = mintIds(keeps.reduce((k, kept) => k + (kept ? 0 : 1), 0));
  const pointIds = new Float64Array(n);
  let nextPoint = 0;
  pointFrom.forEach((p, i) => { pointIds[i] = keeps[i] ? src.pointIds[(p as { row: number }).row] : freshPoints[nextPoint++]; });
  const freshEdges = mintIds(edgeFrom.reduce((k, e) => k + (e.whole ? 0 : 1), 0));
  const edgeIds = new Float64Array(edgeFrom.length);
  const edgeRoots = new Float64Array(edgeFrom.length);
  let nextEdge = 0;
  edgeFrom.forEach((e, i) => {
    edgeIds[i] = e.whole ? src.edgeIds[e.edge] : freshEdges[nextEdge++];
    edgeRoots[i] = src.edgeRoots[e.edge];
  });
  const enames = src.edgeAttrNames;
  const edgeAttrs: Record<string, Float64Array> = {};
  for (const name of enames) edgeAttrs[name] = new Float64Array(edgeFrom.length);
  edgeFrom.forEach((e, i) => {
    const parent: Record<string, number> = {};
    for (const name of enames) parent[name] = src.edgeAttrs[name][e.edge];
    const child = inheritEdge(src, parent, e.fraction);
    for (const name of enames) edgeAttrs[name][i] = child[name];
  });
  return new Material(Float64Array.from(xs), Float64Array.from(ys), attrs, Uint32Array.from(edges), {
    edgeAttrs,
    transfers: { ...src.transfers },
    edgeTransfers: { ...src.edgeTransfers },
    ids: { points: pointIds, edges: edgeIds, edgeRoots },
    faceAttrs: src.faceAttrs,
    space: m.space,
  });
}
