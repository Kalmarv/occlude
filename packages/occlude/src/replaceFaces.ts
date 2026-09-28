/**
 * The face form of `replace`: `g.replace(faces, motif)` swaps every
 * selected face for the faces of a motif, read in the face's own frame —
 * the substitution a Penrose tiling or a Sierpinski triangle is made of.
 * The same word as the edge form (tables.ts), told apart by what it takes.
 *
 * THE FRAME. A face whose `source` is a placement — a tiling's cell — takes
 * the motif through that placement, so the motif is drawn as the model
 * face. Any other face, in the plane, takes it through the similarity that
 * puts [0, 0] on its first corner and [1, 0] on its second: the unit face
 * runs counter-clockwise from [0, 0] along +x with a first wall of 1. A
 * curved space has no scale, so there a face without a placement is
 * refused by name.
 *
 * THE OUTLINE. A motif is a material with faces, and its outline is the
 * edge of its leaf faces together: one loop, no hole. A corner is a vertex
 * of a loop where the boundary turns, read in the space of the faces —
 * the motif too, since a curved space draws it about its centre — (`cornersOf`): a
 * curved tiling's wall samples and a point a neighbour's replace put on a
 * wall run straight on, and are not corners. The outline has as many corners as the face or the call is
 * refused by name, and its corners go onto the face's corners, the first
 * onto the first (for a placement, the ones it puts them on). A point on a
 * side of the outline goes onto the matching wall, where the frame puts it
 * projected onto the wall — or, when those places are not in order along
 * it, at its share of the side's length — and every other motif point goes
 * where the frame puts it. So the map is the frame, and what lies on the
 * outline lands on the walls whatever the outline's shape.
 *
 * THE WALLS. A wall stays the wall it was; the outline is not added. Its
 * points split the walls, and one that lands on a point already there — a
 * corner, a wall sample, the point a neighbour's motif put there in this
 * very call — IS that point, so two replaced neighbours share the new
 * points and pieces of their wall once, and a kept neighbour keeps its
 * wall and its statement, run through the new points (`restated`). A piece
 * of a wall keeps the wall's lineage, so every face keeps its key, and the
 * wall's columns, shared as a split's children share them; a column the
 * motif's outline edge has wins on every piece it covers. An edge inside
 * the motif is a new edge with the motif edge's columns, carried whole: a
 * placement of a curved space bends it, and it runs through samples there,
 * as a tiling's wall does.
 *
 * THE ROWS. A replaced face stays a face row with no loop of its own — its
 * area is its children's — and it is their `parent`. Its children follow
 * every face there was, in the motif's face order, face after face in the
 * order of the faces; a child's `source` is its parent. A face column
 * crosses to a child by its transfer policy, and a motif face's column
 * wins. Only a leaf is replaced: a face that holds others has no loop of
 * its own. A face with a hole, and a tiling cell that the drawable cut or
 * a gap shrank (it is not the model face its placement names), are left
 * as they are; when no cell of the call is the model face, the motif is
 * the mistake, and a count of corners that differs is refused.
 */

import { Material, mintIds, type FaceColumn } from './material.js';
import { faceTableOf, restated, type FaceTable, type StatedFaces } from './faces.js';
import { cornerIndex } from './corners.js';
import { whereRows } from './selection.js';
import { isPlacement } from './placement.js';
import { addPointRows, addEdgeRows, swapEdgeRows, cellsBetween, cellsAmong, edgeCells, landsRecord, writeEdgeCells, rebuild, Stored } from './tables.js';
import { derivation, linkRows, record } from './derivation.js';
import { Column, at64, kindOf, kindWords, kinds, type AnyColumn } from './column.js';
import { pairKey, describe } from './views.js';
import type { Space } from './space.js';

const WHO = 'replace';

/** How close, as a fraction of the face's size, a motif point on a wall
 * must land to a point already there to be that point: the edge form's. */
const WELD = 1e-9;

/** How close, as a fraction of its size, a tiling cell's corner must be to
 * where its placement puts the model face's: further, the drawable cut the
 * cell or a gap shrank it, and it is not the model face. */
const MODEL = 1e-6;

/** How far, as a fraction of the face's size, a carried motif edge may
 * leave the straight line between two of its samples, and how many times
 * a piece is halved at most (128 pieces, as a tiling's wall) — an
 * implementation number. A placement of the plane carries a line to a
 * line, so there it adds no sample; one of a curved space bends it. */
const BEND = 1e-4;
const HALVINGS = 7;

/** How far from straight, as the sine of the turn, a loop may bend at a
 * vertex and still run straight on through it: a rounding, never a turn a
 * sketch means. */
const TURN = 1e-7;

/**
 * The corners of a loop, as places in it: the vertices where the boundary
 * TURNS. At each vertex the directions to its two neighbours are read in
 * the material's space (`log` from the vertex): where they are opposite,
 * the loop runs straight on — a sample of a curved wall, or a point a
 * neighbour's replace put on a wall — and anywhere else, or where the loop
 * turns back, it is a corner. One rule for the plane and a curved space,
 * and for a face and a motif's outline, with no column to keep in step.
 */
function cornersOf(m: Material, loop: readonly number[], space: Space | undefined): number[] {
  const out: number[] = [];
  const n = loop.length;
  const X = m.x;
  const Y = m.y;
  const sp = space !== undefined && space.kind !== 'euclidean' ? space : undefined;
  const toward = (from: number, to: number): readonly number[] => (sp ? sp.log([X[from], Y[from]], [X[to], Y[to]]) : [X[to] - X[from], Y[to] - Y[from]]);
  for (let i = 0; i < n; i++) {
    const b = loop[i];
    const u = toward(b, loop[(i + n - 1) % n]);
    const v = toward(b, loop[(i + 1) % n]);
    if (Math.abs(u[0] * v[1] - u[1] * v[0]) > TURN * Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1]) || u[0] * v[0] + u[1] * v[1] >= 0) out.push(i);
  }
  return out;
}

/** A motif, read once: its leaf faces, its outline and where each of its
 * points is on it. */
interface Motif {
  readonly m: Material;
  readonly table: FaceTable;
  /** The leaf faces, in row order. */
  readonly leaves: readonly number[];
  /** The outline's rows, counter-clockwise, from its corner nearest [0, 0]. */
  readonly outline: readonly number[];
  /** The corners, as places in `outline`; the first is 0. */
  readonly corners: readonly number[];
  /** Per motif row, its place in `outline`, or -1 for a point inside. */
  readonly at: Int32Array;
  /** Per motif row, 1 for a corner of one of its faces. */
  readonly corner: Uint8Array;
  /** The motif's edge rows, by their ends. */
  readonly edgeOf: ReadonlyMap<number, number>;
}

/** The motif, read in `space`: the space of the faces it replaces, where
 * a curved one draws it about its centre. */
function readMotif(motif: unknown, space: Space | undefined): Motif {
  if (!(motif instanceof Material)) throw new Error(`${WHO}: a motif for a face is a material with faces — got ${describe(motif)}`);
  if (motif.store.attrs.z instanceof Column) throw new Error(`${WHO}: a motif for a face is drawn in the plane, and this one is in space`);
  const table = faceTableOf(motif.faces);
  const leaves = table.allRows().filter((g) => table.faces[g].leaf && table.runsOf(g).length > 0);
  if (leaves.length === 0) throw new Error(`${WHO}: a motif for a face is a material with faces, and this one has none`);
  const n = Math.max(1, motif.n);
  // The outline: every side a face runs along that no face runs back along.
  const claimed = new Set<number>();
  for (const g of leaves) for (const run of table.runsOf(g)) for (let k = 0; k < run.length; k++) claimed.add(run[k] * n + run[(k + 1) % run.length]);
  const next = new Map<number, number>();
  let pinched = false;
  for (const h of claimed) {
    const a = Math.floor(h / n);
    const b = h % n;
    if (claimed.has(b * n + a)) continue;
    if (next.has(a)) pinched = true;
    next.set(a, b);
  }
  const loops: number[][] = [];
  const walked = new Set<number>();
  for (const from of next.keys()) {
    if (walked.has(from)) continue;
    const loop: number[] = [];
    for (let at: number | undefined = from; at !== undefined && !walked.has(at); at = next.get(at)) {
      walked.add(at);
      loop.push(at);
    }
    loops.push(loop);
  }
  if (pinched || loops.length !== 1) throw new Error(`${WHO}: the faces of a motif make one outline, with no hole and no pinch — this motif's make ${loops.length}${pinched ? ', pinched' : ''}`);
  let outline = loops[0];
  let corners = cornersOf(motif, outline, space);
  if (corners.length < 3) throw new Error(`${WHO}: a motif's outline has ${corners.length} corners — a face has three or more`);
  // The unit face starts at [0, 0]: the corner nearest it is the first.
  const X = motif.x;
  const Y = motif.y;
  let first = 0;
  for (let c = 1; c < corners.length; c++) {
    if (Math.hypot(X[outline[corners[c]]], Y[outline[corners[c]]]) < Math.hypot(X[outline[corners[first]]], Y[outline[corners[first]]])) first = c;
  }
  const shift = corners[first];
  outline = [...outline.slice(shift), ...outline.slice(0, shift)];
  corners = [...corners.slice(first), ...corners.slice(0, first)].map((c) => (c - shift + outline.length) % outline.length);
  const at = new Int32Array(motif.n).fill(-1);
  outline.forEach((r, i) => { at[r] = i; });
  const corner = new Uint8Array(motif.n);
  for (const g of leaves) for (const run of table.runsOf(g)) for (const i of cornersOf(motif, run, space)) corner[run[i]] = 1;
  const edgeOf = new Map<number, number>();
  const list = motif.edgeList;
  for (let e = 0; e < motif.edgeCount; e++) edgeOf.set(pairKey(list[2 * e], list[2 * e + 1]), e);
  return { m: motif, table, leaves, outline, corners, at, corner, edgeOf };
}

/** Is the motif edge from `u` to `v` a side of its outline? */
function onOutline(mo: Motif, u: number, v: number): boolean {
  const a = mo.at[u];
  const b = mo.at[v];
  const n = mo.outline.length;
  return a >= 0 && b >= 0 && (b === (a + 1) % n || a === (b + 1) % n);
}

/** A motif edge's own columns, as a sketch would write them: a column of
 * rows names rows of the motif, which name nothing here, and stays behind. */
function edgeColumnsOf(motif: Material, e: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const view = motif.edge(e) as unknown as Record<string, unknown>;
  for (const name of motif.store.edgeAttrNames) {
    if (kindOf(motif.store.edgeAttrs[name]).name === 'reference') continue;
    out[name] = view[name];
  }
  return out;
}

/** One face as it is replaced: the rows the motif's points landed on. */
interface Plan {
  readonly f: number;
  readonly loop: readonly number[];
  /** Per motif row, the row of the result it landed on. */
  readonly rowOf: Int32Array;
  /** 1 when the frame keeps the motif's hand, -1 when it turns it over. */
  readonly dir: 1 | -1;
  /** Per motif edge inside the outline that the frame bends, the rows of
   * its samples, from its stored first end. */
  readonly samples: ReadonlyMap<number, readonly number[]>;
}

/** A face the replace made: its parent's row, the motif face it is, and
 * its runs of rows. */
interface Child {
  readonly f: number;
  readonly g: number;
  readonly runs: readonly (readonly number[])[];
}

/**
 * `g.replace(faces, motif)`: every selected leaf face swapped for the
 * motif's faces, read in the face's frame (see the file header). An empty
 * selection, and a face that is not the model face or does not land on
 * finite places, leave the geometry as it is; an outline with a different
 * number of corners, and a face in a curved space without a placement, are
 * refused by name.
 */
export function replaceFaces(m: Material, faces: unknown, motif: Material): Material {
  const mo = readMotif(motif, m.space);
  if (m.store.attrs.z instanceof Column) throw new Error(`${WHO}: faces are replaced in the plane, and this value is in space`);
  const T = faceTableOf(m.faces);
  const picked = whereRows(m.faces, faces, WHO);
  if (picked.length === 0) return m;
  const curved = m.space !== undefined && m.space.kind !== 'euclidean';
  const X = m.x;
  const Y = m.y;
  const MX = motif.x;
  const MY = motif.y;
  const L = m.edgeList;
  const edgeAt = new Map<number, number>();
  for (let e = 0; e < m.edgeCount; e++) edgeAt.set(pairKey(L[2 * e], L[2 * e + 1]), e);
  // A point column `corner` (a curved tiling's) says a point is a corner
  // of a face: a new point is 1 where it is a corner of a new face, and 0
  // where it is a sample of a carried edge.
  const writesCorner = m.store.attrs.corner instanceof Column;
  const sp = curved ? m.space! : undefined;
  const onWall = (u: number, v: number, t: number): readonly number[] => {
    if (!sp) return [X[u] + (X[v] - X[u]) * t, Y[u] + (Y[v] - Y[u]) * t];
    const d = sp.log([X[u], Y[u]], [X[v], Y[v]]);
    return sp.exp([X[u], Y[u]], [d[0] * t, d[1] * t]);
  };
  const km = mo.corners.length;
  // The new points, in the order they are made, and what each came from:
  // a wall (the edge it splits) or the face it lies in.
  const xs: number[] = [];
  const ys: number[] = [];
  const cells: Record<string, unknown>[] = [];
  const fromEdge = new Map<number, number>();
  const fromFace = new Map<number, number>();
  // The points on each wall, by edge row: `t` along it from its stored end.
  const splits = new Map<number, { t: number; row: number }[]>();
  const plans: Plan[] = [];
  // A cell whose corners do not match the motif's: refused when no cell
  // of the call takes the motif, since then the motif is the mistake.
  let mismatch: string | undefined;

  for (const f of picked) {
    const face = T.faces[f];
    if (!face.leaf) continue;
    const runs = T.runsOf(f);
    if (runs.length !== 1) continue;
    const loop = runs[0];
    const n = loop.length;
    const ci = cornersOf(m, loop, m.space);
    const k = ci.length;
    const src = T.sourceAt(f);
    if (!isPlacement(src) && curved) throw new Error(`${WHO}: a face in a curved space takes a motif through its source placement, and this face has none`);
    const counted = `${WHO}: the motif's outline has ${km} corners and this face has ${k}`;
    if (k !== km) {
      // A cell the drawable cut is not the model face, and stays as it is.
      if (!isPlacement(src)) throw new Error(counted);
      mismatch ??= counted;
      continue;
    }
    const size = Math.hypot(face.bounds.w, face.bounds.h);
    if (!(size > 0) || !Number.isFinite(size)) continue;
    // The frame, and which face corner each motif corner goes onto: motif
    // corner j onto face corner s + dir·j.
    let frame: (x: number, y: number) => [number, number];
    let s = 0;
    let dir: 1 | -1 = 1;
    const cornerAt = (i: number): number => loop[ci[((i % k) + k) % k]];
    if (isPlacement(src)) {
      frame = (x, y) => {
        const p = src.point([x, y]);
        return [p[0], p[1]];
      };
      const placed = mo.corners.map((c) => frame(MX[mo.outline[c]], MY[mo.outline[c]]));
      const off = (i: number, j: number): number => Math.hypot(X[cornerAt(i)] - placed[j][0], Y[cornerAt(i)] - placed[j][1]);
      for (let i = 1; i < k; i++) if (off(i, 0) < off(s, 0)) s = i;
      dir = off(s + 1, 1) <= off(s - 1, 1) ? 1 : -1;
      let model = true;
      for (let j = 0; j < k; j++) if (!(off(s + dir * j, j) <= MODEL * size)) model = false;
      if (!model) continue;
    } else {
      const ax = X[cornerAt(0)];
      const ay = Y[cornerAt(0)];
      const dx = X[cornerAt(1)] - ax;
      const dy = Y[cornerAt(1)] - ay;
      frame = (x, y) => [ax + x * dx - y * dy, ay + x * dy + y * dx];
    }
    const tol = WELD * size;
    const rowOf = new Int32Array(motif.n).fill(-1);
    // What this face adds, so a face that does not land takes it back.
    const mark = xs.length;
    const split: number[] = [];
    let lands = true;
    const add = (x: number, y: number, c: Record<string, unknown>, corner: boolean): number => {
      if (writesCorner) c.corner = corner ? 1 : 0;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !landsRecord(c)) {
        lands = false;
        return -1;
      }
      const row = m.n + xs.length;
      xs.push(x);
      ys.push(y);
      cells.push(c);
      return row;
    };
    for (let j = 0; j < k; j++) rowOf[mo.outline[mo.corners[j]]] = cornerAt(s + dir * j);
    for (let j = 0; j < k && lands; j++) {
      // The motif's side from corner j to corner j + 1, and the wall it
      // goes onto, run the same way.
      const a = mo.corners[j];
      const b = j + 1 < k ? mo.corners[j + 1] : mo.outline.length;
      if (b - a < 2) continue;
      const side: number[] = [];
      for (let q = a; q <= b; q++) side.push(mo.outline[q % mo.outline.length]);
      const from = ci[(((s + dir * j) % k) + k) % k];
      const to = ci[(((s + dir * (j + 1)) % k) + k) % k];
      const wall: number[] = [];
      for (let i = from; ; i = (i + dir + n) % n) {
        wall.push(loop[i]);
        if (i === to) break;
      }
      const arc = [0];
      for (let q = 1; q < wall.length; q++) arc.push(arc[q - 1] + Math.hypot(X[wall[q]] - X[wall[q - 1]], Y[wall[q]] - Y[wall[q - 1]]));
      const total = arc[arc.length - 1];
      // Where the frame puts each point of the side, along the wall.
      const inner = side.slice(1, -1);
      const placed = inner.map((r) => frame(MX[r], MY[r]));
      let along = placed.map(([px, py]) => {
        let best = Infinity;
        let got = 0;
        for (let q = 0; q + 1 < wall.length; q++) {
          const ux = X[wall[q + 1]] - X[wall[q]];
          const uy = Y[wall[q + 1]] - Y[wall[q]];
          const len2 = ux * ux + uy * uy;
          const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - X[wall[q]]) * ux + (py - Y[wall[q]]) * uy) / len2)) : 0;
          const d = Math.hypot(X[wall[q]] + t * ux - px, Y[wall[q]] + t * uy - py);
          if (d < best) {
            best = d;
            got = arc[q] + t * (arc[q + 1] - arc[q]);
          }
        }
        return got;
      });
      const ordered = along.every((v, q) => v > 0 && v < total && (q === 0 || v > along[q - 1]));
      if (!ordered) {
        // Not in order along the wall: each at its share of the side.
        const share = [0];
        for (let q = 1; q < side.length; q++) share.push(share[q - 1] + Math.hypot(MX[side[q]] - MX[side[q - 1]], MY[side[q]] - MY[side[q - 1]]));
        along = inner.map((_, q) => (share[q + 1] / share[share.length - 1]) * total);
      }
      inner.forEach((r, q) => {
        if (!lands) return;
        const d = along[q];
        let w = 0;
        while (w < wall.length - 2 && arc[w + 1] < d) w++;
        const u = wall[w];
        const v = wall[w + 1];
        const len = arc[w + 1] - arc[w];
        let tl = len > 0 ? (d - arc[w]) / len : 0;
        // In a curved space the wall is a geodesic: the place along it is
        // read where the frame puts the point, in the space, so a later
        // call that puts a point there finds this one.
        if (sp && ordered) {
          const a = sp.log([X[u], Y[u]], [X[v], Y[v]]);
          const b = sp.log([X[u], Y[u]], placed[q]);
          const a2 = a[0] * a[0] + a[1] * a[1];
          if (a2 > 0) tl = Math.min(1, Math.max(0, (a[0] * b[0] + a[1] * b[1]) / a2));
        }
        if (tl * len <= tol) {
          rowOf[r] = u;
          return;
        }
        if ((1 - tl) * len <= tol) {
          rowOf[r] = v;
          return;
        }
        const e = edgeAt.get(pairKey(u, v))!;
        const t = L[2 * e] === u ? tl : 1 - tl;
        // A point on this wall already — a neighbour's, or this face's own.
        const held = splits.get(e);
        const there = held?.find((p) => Math.abs(p.t - t) * len <= tol);
        if (there !== undefined) {
          rowOf[r] = there.row;
          return;
        }
        // On the wall itself: in a curved space, on the geodesic between the
        // two points it lies between, so it runs straight on for the face
        // that keeps the wall.
        const [px, py] = onWall(u, v, tl);
        const row = add(px, py, cellsBetween(m, L[2 * e], L[2 * e + 1], t), mo.corner[r] === 1);
        if (row < 0) return;
        rowOf[r] = row;
        fromEdge.set(row, e);
        if (held) held.push({ t, row });
        else splits.set(e, [{ t, row }]);
        split.push(e);
      });
    }
    // Every other motif point, where the frame puts it: its columns from
    // the face's corners, the nearer the more.
    const corners = ci.map((i) => loop[i]);
    const among = (x: number, y: number): Record<string, unknown> => {
      const weights = corners.map((c) => Math.hypot(X[c] - x, Y[c] - y) ** 2);
      const exact = weights.indexOf(0);
      const inv = weights.map((d, i) => (exact >= 0 ? (i === exact ? 1 : 0) : 1 / d));
      const sum = inv.reduce((p, q) => p + q, 0);
      return cellsAmong(m, corners, inv.map((w) => w / sum));
    };
    for (let r = 0; r < motif.n && lands; r++) {
      if (mo.at[r] >= 0) continue;
      const [x, y] = frame(MX[r], MY[r]);
      const row = add(x, y, among(x, y), mo.corner[r] === 1);
      if (row < 0) break;
      rowOf[r] = row;
      fromFace.set(row, f);
    }
    // An edge inside the motif is carried whole: where the frame bends it
    // (a placement of a curved space), samples between its ends, as a
    // tiling's wall has them.
    const samples = new Map<number, number[]>();
    const ML = motif.edgeList;
    const bend = BEND * size;
    for (let e = 0; e < motif.edgeCount && lands && isPlacement(src); e++) {
      const u = ML[2 * e];
      const v = ML[2 * e + 1];
      if (onOutline(mo, u, v) || rowOf[u] < 0 || rowOf[v] < 0) continue;
      const on = (t: number) => frame(MX[u] + (MX[v] - MX[u]) * t, MY[u] + (MY[v] - MY[u]) * t);
      const ts: number[] = [];
      const halve = (t0: number, p0: [number, number], t1: number, p1: [number, number], depth: number): void => {
        const tm = (t0 + t1) / 2;
        const pm = on(tm);
        if (depth >= HALVINGS || !(Math.hypot(pm[0] - (p0[0] + p1[0]) / 2, pm[1] - (p0[1] + p1[1]) / 2) > bend)) return;
        halve(t0, p0, tm, pm, depth + 1);
        ts.push(tm);
        halve(tm, pm, t1, p1, depth + 1);
      };
      halve(0, on(0), 1, on(1), 0);
      if (ts.length === 0) continue;
      const rows: number[] = [];
      for (const t of ts) {
        const [x, y] = on(t);
        const row = add(x, y, among(x, y), false);
        if (row < 0) break;
        rows.push(row);
        fromFace.set(row, f);
      }
      samples.set(e, rows);
    }
    if (!lands) {
      // Take back what this face added: it is left as it is.
      for (let row = m.n + mark; row < m.n + xs.length; row++) {
        fromEdge.delete(row);
        fromFace.delete(row);
      }
      xs.length = mark;
      ys.length = mark;
      cells.length = mark;
      for (const e of split) {
        const kept = splits.get(e)!.filter((p) => p.row < m.n + mark);
        if (kept.length > 0) splits.set(e, kept);
        else splits.delete(e);
      }
      continue;
    }
    plans.push({ f, loop, rowOf, dir, samples });
  }
  if (plans.length === 0) {
    if (mismatch !== undefined) throw new Error(mismatch);
    return m;
  }

  // The points on each wall, in order along it.
  for (const list of splits.values()) list.sort((p, q) => p.t - q.t);
  /** The new rows on the wall from row `a` to row `b` of `m`, in order. */
  const between = (a: number, b: number): number[] | undefined => {
    const e = edgeAt.get(pairKey(a, b));
    const list = e === undefined ? undefined : splits.get(e);
    if (e === undefined || list === undefined) return undefined;
    const rows = list.map((p) => p.row);
    return L[2 * e] === a ? rows : rows.reverse();
  };
  const at = (row: number): [number, number] => (row < m.n ? [X[row], Y[row]] : [xs[row - m.n], ys[row - m.n]]);

  const children: Child[] = [];
  const replaced: number[] = [];
  const inner: { pair: [number, number]; cols: Record<string, unknown>; f: number }[] = [];
  const walls = new Map<number, Record<string, unknown>>();
  for (const { f, loop, rowOf, dir, samples } of plans) {
    /** The samples of the motif edge from `u` to `v`, in that order. */
    const bent = (u: number, v: number): readonly number[] => {
      const e = mo.edgeOf.get(pairKey(u, v));
      const rows = e === undefined ? undefined : samples.get(e);
      if (e === undefined || rows === undefined) return [];
      return motif.edgeList[2 * e] === u ? rows : [...rows].reverse();
    };
    // The face's loop through every new point on its walls.
    const ring: number[] = [];
    for (let i = 0; i < loop.length; i++) {
      ring.push(loop[i]);
      const mid = between(loop[i], loop[(i + 1) % loop.length]);
      if (mid) ring.push(...mid);
    }
    const place = new Map<number, number>();
    ring.forEach((r, i) => place.set(r, i));
    /** The rows strictly between `a` and `b`, forward round the ring. */
    const along = (a: number, b: number): number[] | undefined => {
      const i = place.get(a);
      const j = place.get(b);
      if (i === undefined || j === undefined) return undefined;
      const out: number[] = [];
      for (let q = (i + 1) % ring.length; q !== j; q = (q + 1) % ring.length) out.push(ring[q]);
      return out;
    };
    const made: Child[] = [];
    let whole = true;
    for (const g of mo.leaves) {
      const runs: number[][] = [];
      for (const run of mo.table.runsOf(g)) {
        // A frame that turns the motif over turns its faces round: read
        // them backward from the same first point.
        const ms = dir > 0 ? run : [run[0], ...run.slice(1).reverse()];
        const out: number[] = [];
        for (let q = 0; q < ms.length && whole; q++) {
          const u = ms[q];
          const v = ms[(q + 1) % ms.length];
          out.push(rowOf[u]);
          // A side of the outline is the wall under it, every point on it.
          if (onOutline(mo, u, v)) {
            const mid = along(rowOf[u], rowOf[v]);
            if (mid === undefined) whole = false;
            else out.push(...mid);
          } else out.push(...bent(u, v));
        }
        runs.push(out);
      }
      const rows = runs.flat();
      let area = 0;
      const outer = runs[0] ?? [];
      for (let q = 0; q < outer.length; q++) {
        const [ax, ay] = at(outer[q]);
        const [bx, by] = at(outer[(q + 1) % outer.length]);
        area += ax * by - bx * ay;
      }
      if (!whole || rows.some((r) => r < 0) || new Set(rows).size !== rows.length || runs.some((r) => r.length < 3) || !(area > 0)) {
        whole = false;
        break;
      }
      made.push({ f, g, runs });
    }
    // A face whose motif does not close into faces keeps its loop, and
    // gets no edge inside it.
    if (!whole) continue;
    children.push(...made);
    replaced.push(f);
    for (let e = 0; e < motif.edgeCount; e++) {
      const u = motif.edgeList[2 * e];
      const v = motif.edgeList[2 * e + 1];
      if (onOutline(mo, u, v) || rowOf[u] < 0 || rowOf[v] < 0 || rowOf[u] === rowOf[v]) continue;
      const cols = edgeColumnsOf(motif, e);
      const chain = [rowOf[u], ...bent(u, v), rowOf[v]];
      for (let q = 0; q + 1 < chain.length; q++) inner.push({ pair: [chain[q], chain[q + 1]], cols, f });
    }
    // The outline's edge columns, on every piece of the wall they cover.
    for (let q = 0; q < mo.outline.length; q++) {
      const u = mo.outline[q];
      const v = mo.outline[(q + 1) % mo.outline.length];
      const me = mo.edgeOf.get(pairKey(u, v));
      if (me === undefined || motif.store.edgeAttrNames.length === 0) continue;
      const [a, b] = dir > 0 ? [rowOf[u], rowOf[v]] : [rowOf[v], rowOf[u]];
      const path = [a, ...(along(a, b) ?? []), b];
      const cols = edgeColumnsOf(motif, me);
      for (let p = 0; p + 1 < path.length; p++) walls.set(pairKey(path[p], path[p + 1]), cols);
    }
  }
  if (replaced.length === 0) return m;

  // The rows: the new points, the walls swapped for their pieces (each
  // keeps the wall's lineage and shares its columns), the edges inside.
  const withPoints = addPointRows(m, xs, ys, cells, null, WHO);
  const pairs: [number, number][] = [];
  const pieceCols: Record<string, unknown>[] = [];
  const roots: number[] = [];
  const of: number[] = [];
  for (const e of [...splits.keys()].sort((a, b) => a - b)) {
    const list = splits.get(e)!;
    const ends = [L[2 * e], ...list.map((p) => p.row), L[2 * e + 1]];
    const ts = [0, ...list.map((p) => p.t), 1];
    for (let q = 0; q + 1 < ends.length; q++) {
      pairs.push([ends[q], ends[q + 1]]);
      pieceCols.push(edgeCells(m, e, ts[q + 1] - ts[q]));
      roots.push(at64(m.store.edgeRoots, e));
      of.push(e);
    }
  }
  const swapped = pairs.length > 0 ? swapEdgeRows(withPoints, pairs, pieceCols, roots, of, WHO, m.n) : { out: withPoints, from: [] as number[] };
  // An edge inside takes the motif edge's columns, and a column the motif
  // does not hold its kind's default.
  const held = swapped.out.store;
  const innerCols = inner.map(({ cols }) => {
    const full: Record<string, unknown> = { ...cols };
    for (const name of held.edgeAttrNames) if (!(name in full)) full[name] = new Stored(kindOf(held.edgeAttrs[name]).default);
    return full;
  });
  const withInner = addEdgeRows(swapped.out, inner.map((i) => i.pair), innerCols, null, WHO);
  // The rows of the edges by their ends, for the walls and the links.
  const list = withInner.edgeList;
  const edgeRow = new Map<number, number>();
  for (let e = 0; e < withInner.edgeCount; e++) edgeRow.set(pairKey(list[2 * e], list[2 * e + 1]), e);
  const wallRows: number[] = [];
  const wallCols: Record<string, unknown>[] = [];
  for (const [key, cols] of walls) {
    const e = edgeRow.get(key);
    if (e === undefined) continue;
    wallRows.push(e);
    wallCols.push(cols);
  }
  const out = writeEdgeCells(withInner, wallRows, wallCols, WHO);

  // The statement: every face there was, run through the new points on its
  // walls; each replaced face a parent with no loop; its children after.
  const base: StatedFaces = m.stated ?? {
    cycles: T.allRows().map((f) => T.runsOf(f)),
    ...(T.parentOf !== null ? { parent: T.parentOf } : {}),
    edgeList: m.store.edgeList,
    edgeIds: m.store.edgeIds,
  };
  const s = out.store;
  const kept = restated(base, { from: m, n: out.n, pointIds: s.pointIds, edgeList: s.edgeList, edgeIds: s.edgeIds, x: s.x, y: s.y }, between);
  // Every face keeps its walls, so none is lost; one that were would leave
  // the rows unnamed, and the faces are read off the picture instead.
  if (kept === undefined || kept.cycles.length !== base.cycles.length) return finish(m, motif, out, fromEdge, fromFace, swapped.from, inner, edgeRow);
  const stated = withChildren(kept, replaced, children);
  // A motif's edge column comes with its policy.
  const edgeTransfers = { ...out.edgeTransfers };
  for (const name of motif.store.edgeAttrNames) if (!(name in m.edgeTransfers) && name in motif.edgeTransfers) edgeTransfers[name] = motif.edgeTransfers[name];
  let result = rebuild(out, {}, { faces: stated, edgeTransfers });
  result = withFaceColumns(m, T, mo, result, base.cycles.length, children);
  return finish(m, motif, result, fromEdge, fromFace, swapped.from, inner, edgeRow);
}

/**
 * The kept statement with the replaced faces as parents — no loop, no
 * corners, no fixed triangles — and the children after every face, each a
 * new face whose source is its parent. A corner column reads its kind's
 * default on a child's corners.
 */
function withChildren(kept: StatedFaces, replaced: readonly number[], children: readonly Child[]): StatedFaces {
  const F = kept.cycles.length;
  const gone = new Set(replaced);
  const cycles = [...kept.cycles.map((runs, f) => (gone.has(f) ? Object.freeze([]) : runs)), ...children.map((c) => Object.freeze(c.runs.map((r) => Object.freeze([...r]))))];
  const parent = new Int32Array(F + children.length).fill(-1);
  if (kept.parent !== undefined) parent.set(kept.parent);
  children.forEach((c, i) => { parent[F + i] = c.f; });
  const fromParent = new Uint8Array(F + children.length);
  if (kept.fromParent !== undefined) fromParent.set(kept.fromParent);
  fromParent.fill(1, F);
  // The corners kept: every face's but a replaced one's; a child's are new.
  const index = cornerIndex(kept.cycles);
  const rows: number[] = [];
  for (let f = 0; f < F; f++) if (!gone.has(f)) for (let c = index.start[f]; c < index.start[f + 1]; c++) rows.push(c);
  const added = children.reduce((sum, c) => sum + c.runs.reduce((n, r) => n + r.length, 0), 0);
  let corners: Record<string, AnyColumn> | undefined;
  if (kept.corners !== undefined) {
    corners = {};
    for (const [name, col] of Object.entries(kept.corners)) {
      const kind = kindOf(col);
      corners[name] = (kind as { from(v: readonly unknown[]): AnyColumn }).from([...rows.map((r) => col.get(r)), ...new Array<unknown>(added).fill(kind.default)]);
    }
  }
  const cornerIds = kept.cornerIds === undefined ? undefined : Float64Array.from([...rows.map((r) => kept.cornerIds![r]), ...mintIds(added)]);
  return {
    ...kept,
    cycles: Object.freeze(cycles),
    parent,
    fromParent,
    ...(corners !== undefined ? { corners: Object.freeze(corners) } : {}),
    ...(cornerIds !== undefined ? { cornerIds } : {}),
    ...(kept.faceIds !== undefined ? { faceIds: Float64Array.from([...kept.faceIds, ...mintIds(children.length)]) } : {}),
    ...(kept.faceKeys !== undefined ? { faceKeys: Object.freeze([...kept.faceKeys, ...children.map(() => '')]) } : {}),
    ...(kept.cornerKeys !== undefined ? { cornerKeys: Object.freeze([...rows.map((r) => kept.cornerKeys![r]), ...new Array<string>(added).fill('')]) } : {}),
    ...(kept.triangles !== undefined ? { triangles: Object.freeze([...kept.triangles.map((t, f) => (gone.has(f) ? undefined : t)), ...children.map(() => undefined)]) } : {}),
  };
}

/**
 * The face columns on the children: a motif face's own column wins; a
 * column the motif does not hold crosses from the parent by its transfer
 * policy — `'nearest'` takes the parent's value, `'drop'` stops — and a
 * child that gets no value reads the column's fallback, never a
 * neighbour's. A column only the motif holds comes with its policy and
 * fallback. Every face that was keeps its key, so its value.
 */
function withFaceColumns(m: Material, T: FaceTable, mo: Motif, result: Material, first: number, children: readonly Child[]): Material {
  const own = m.faceAttrs;
  const theirs = mo.m.faceAttrs;
  const names = [...new Set([...Object.keys(own), ...Object.keys(theirs)])].filter((name) => theirs[name]?.kind?.name !== 'reference' || own[name] !== undefined);
  if (names.length === 0 || children.length === 0) return result;
  const ids = faceTableOf(result.faces).ids();
  const next: Record<string, FaceColumn> = { ...result.faceAttrs };
  for (const name of names) {
    const mine = own[name];
    const motif = theirs[name]?.kind?.name === 'reference' ? undefined : theirs[name];
    if (mine !== undefined && motif !== undefined) {
      const a = mine.kind ?? kinds.number;
      const b = motif.kind ?? kinds.number;
      if (a.name !== b.name || a.width !== b.width) throw new Error(`${WHO}: the face column '${name}' holds ${kindWords(a)} a face, and the motif's holds ${kindWords(b)} a face`);
    }
    const values = new Map<string, unknown>(mine?.values ?? []);
    const seen = new Set<string>(mine?.seen ?? ids);
    const carried = T.carried.get(name);
    const motifCarried = mo.table.carried.get(name);
    children.forEach((c, i) => {
      const id = ids[first + i];
      seen.add(id);
      const v = motif !== undefined
        ? motifCarried?.[c.g] ?? motif.fallback ?? (motif.kind ?? kinds.number).default
        : mine!.transfer === 'nearest' ? carried?.[c.f] : undefined;
      if (v !== undefined) values.set(id, v);
    });
    next[name] = mine !== undefined
      ? { ...mine, values, seen }
      : { values, transfer: motif!.transfer, ...(motif!.fallback !== undefined ? { fallback: motif!.fallback } : {}), seen, ...(motif!.kind !== undefined ? { kind: motif!.kind } : {}) };
  }
  return rebuild(result, {}, { faceAttrs: next });
}

/** The result linked to what it came from — a point on a wall and a piece
 * of one to that edge of `m`, a point and an edge inside to the face they
 * are in — and recorded as a replace of `m` by `motif`. */
function finish(
  m: Material,
  motif: Material,
  out: Material,
  fromEdge: ReadonlyMap<number, number>,
  fromFace: ReadonlyMap<number, number>,
  pieces: number[],
  inner: readonly { pair: [number, number]; f: number }[],
  edgeRow: ReadonlyMap<number, number>,
): Material {
  // Sparse, as `linkMade` keeps them: only the rows the replace made.
  const pointEdge: number[] = [];
  const pointFace: number[] = [];
  for (const [row, e] of fromEdge) pointEdge[row] = e;
  for (const [row, f] of fromFace) pointFace[row] = f;
  const edgeFace: number[] = [];
  for (const { pair, f } of inner) {
    const e = edgeRow.get(pairKey(pair[0], pair[1]));
    if (e !== undefined && pieces[e] === undefined) edgeFace[e] = f;
  }
  linkRows(out, {
    points: { source: { of: m, domain: 'edges', rows: pointEdge } },
    edges: { source: { of: m, domain: 'edges', rows: pieces } },
  });
  linkRows(out, {
    points: { source: { of: m, domain: 'faces', rows: pointFace } },
    edges: { source: { of: m, domain: 'faces', rows: edgeFace } },
  });
  return record(out, derivation('replace', [m, motif]));
}
