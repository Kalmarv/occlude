/**
 * The uniform tilings, named by their VERTEX CONFIGURATION: the polygons
 * round one corner, in order — `[3, 6, 3, 6]`, `[4, 8, 8]`,
 * `[3, 3, 4, 3, 4]` — which in a uniform tiling is the same at every
 * corner.
 *
 * ONE MECHANISM. Every tiling here but one is Wythoff's kaleidoscope: the
 * Schwarz triangle with angles `π/p`, `π/q`, `π/2` — corner `P` at the
 * centre of a `{p, q}` cell, `Q` at one of its corners, `R` at the middle
 * of a wall — reflected in its own sides until it covers the space, and a
 * GENERATING POINT `G` in it. The faces are the orbits of `G` round each
 * corner of the triangle: round `P` a face of `p` or `2p` corners, round
 * `Q` one of `q` or `2q`, round `R` one of 2 (a wall, not a face) or 4.
 * Where `G` stands decides the tiling:
 *
 *     G at Q                   {p, q}              p·p·…  (q times)
 *     G at R                   rectified           p.q.p.q
 *     G on QR, off the others  truncated           q.2p.2p
 *     G on PQ, off the others  cantellated         p.4.q.4
 *     G inside                 omnitruncated       4.2p.2q
 *     every other G of the     snub                3.3.p.3.q
 *       inside one, by hand
 *
 * and every wall must come out the same length, which fixes the point:
 * a wall is `G` and its mirror image, twice `G`'s distance from that
 * mirror, so the walls are equal where `G` is equally far from the
 * mirrors it is not on. With each mirror as a unit covector `n` of the
 * model (see `placement.ts`), that distance is read straight off `n·G` —
 * the distance itself on the plane, its sine on the sphere, its sinh in
 * the disk — so "equally far" is LINEAR in the model and the point is one
 * cross product, in all three geometries. The snub keeps only the images
 * of `G` under the turns of the group (the hand of the triangle), its
 * walls are `G` to its turned images about `P`, `Q` and `R`, and the
 * point that makes those three equal is solved for, by Newton's method in
 * the chart, from the omnitruncated one.
 *
 * The flood itself is `tiling.ts`'s, on the `{p, q}` CELL: the `2p`
 * Schwarz triangles round `P` are the cell, so a copy of the cell carries
 * its triangles' faces — the one round `P`, and the ones round its
 * corners and walls, which its neighbours share and the first copy keeps.
 * That is the same reflection group as flooding the triangle, `2p` times
 * cheaper.
 *
 * `3.3.3.4.4`, the elongated triangular tiling, is the one uniform tiling
 * of the plane with no Wythoff construction: its symmetry has a turn that
 * no reflection makes. Its REFLECTIONS still form a group — the one of a
 * rectangle, half a square wide and a square and a triangle high — and
 * that rectangle, flooded by the same code, carries two squares and two
 * triangles: its corners hold two vertices that the turn would have made
 * one.
 *
 * A configuration is read in either direction from any polygon. Its
 * geometry is its angle sum against a full turn. The plane's 11 uniform
 * tilings and the sphere's 13 Archimedean and 5 Platonic solids are a
 * TABLE, so a corner that is not there is refused as no uniform tiling;
 * the disk has infinitely many, and the forms above are the rule there.
 * Prisms and antiprisms are uniform too, and refused by name.
 */

import { modelGap } from './chord.js';
import { modelCell, regularModel, tilingGeometry, type FaceKind, type TilingModel } from './tiling.js';
import type { SpaceKind } from './space.js';
import type { Vec } from './vec.js';

/** Where Wythoff's point stands in the `(p q 2)` triangle. */
export type WythoffForm = 'regular' | 'rectified' | 'truncated' | 'cantellated' | 'omnitruncated' | 'snub';

/** A uniform tiling: the triangle `(p q 2)` and the form, or the one
 * without a Wythoff construction. */
export interface UniformForm {
  readonly form: WythoffForm | 'elongated';
  readonly p: number;
  readonly q: number;
}

// ---- the corner -------------------------------------------------------------

/** The corner in one spelling: of every rotation and reversal of the
 * cycle, the one that reads first in dictionary order. */
export function canonicalCorner(corner: readonly number[]): number[] {
  const n = corner.length;
  let best: number[] | undefined;
  for (const run of [corner, [...corner].reverse()]) {
    for (let s = 0; s < n; s++) {
      const turned = Array.from({ length: n }, (_, i) => run[(s + i) % n]);
      if (!best || less(turned, best)) best = turned;
    }
  }
  return best ?? [];
}

function less(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** The corner's angle sum against a full turn: `Σ (1 − 2/n)·π` against
 * `2π`, as `tilingGeometry` reads `(p − 2)(q − 2)` against 4. */
export function cornerGeometry(corner: readonly number[]): SpaceKind {
  const excess = corner.reduce((sum, n) => sum + (1 - 2 / n), 0) - 2;
  return Math.abs(excess) < 1e-12 ? 'euclidean' : excess < 0 ? 'spherical' : 'hyperbolic';
}

/** One polygon's corner angle, in degrees, as a refusal writes it. */
function angleOf(n: number): string {
  const a = 180 - 360 / n;
  return Number.isInteger(a) ? `${a}°` : `${a.toFixed(2)}°`;
}

// ---- the tables ---------------------------------------------------------------

const PLANE_LIST: readonly [readonly number[], UniformForm][] = [
  [[3, 3, 3, 3, 3, 3], { form: 'regular', p: 3, q: 6 }],
  [[4, 4, 4, 4], { form: 'regular', p: 4, q: 4 }],
  [[6, 6, 6], { form: 'regular', p: 6, q: 3 }],
  [[3, 6, 3, 6], { form: 'rectified', p: 6, q: 3 }],
  [[3, 12, 12], { form: 'truncated', p: 6, q: 3 }],
  [[4, 8, 8], { form: 'truncated', p: 4, q: 4 }],
  [[3, 4, 6, 4], { form: 'cantellated', p: 6, q: 3 }],
  [[4, 6, 12], { form: 'omnitruncated', p: 6, q: 3 }],
  [[3, 3, 3, 3, 6], { form: 'snub', p: 6, q: 3 }],
  [[3, 3, 4, 3, 4], { form: 'snub', p: 4, q: 4 }],
  [[3, 3, 3, 4, 4], { form: 'elongated', p: 4, q: 4 }],
];

const SPHERE_LIST: readonly [readonly number[], UniformForm][] = [
  // The five Platonic solids.
  [[3, 3, 3], { form: 'regular', p: 3, q: 3 }],
  [[3, 3, 3, 3], { form: 'regular', p: 3, q: 4 }],
  [[4, 4, 4], { form: 'regular', p: 4, q: 3 }],
  [[3, 3, 3, 3, 3], { form: 'regular', p: 3, q: 5 }],
  [[5, 5, 5], { form: 'regular', p: 5, q: 3 }],
  // The thirteen Archimedean solids.
  [[3, 6, 6], { form: 'truncated', p: 3, q: 3 }],
  [[3, 4, 3, 4], { form: 'rectified', p: 4, q: 3 }],
  [[3, 8, 8], { form: 'truncated', p: 4, q: 3 }],
  [[4, 6, 6], { form: 'truncated', p: 3, q: 4 }],
  [[3, 4, 4, 4], { form: 'cantellated', p: 4, q: 3 }],
  [[4, 6, 8], { form: 'omnitruncated', p: 4, q: 3 }],
  [[3, 3, 3, 3, 4], { form: 'snub', p: 4, q: 3 }],
  [[3, 5, 3, 5], { form: 'rectified', p: 5, q: 3 }],
  [[3, 10, 10], { form: 'truncated', p: 5, q: 3 }],
  [[5, 6, 6], { form: 'truncated', p: 3, q: 5 }],
  [[3, 4, 5, 4], { form: 'cantellated', p: 5, q: 3 }],
  [[4, 6, 10], { form: 'omnitruncated', p: 5, q: 3 }],
  [[3, 3, 3, 3, 5], { form: 'snub', p: 5, q: 3 }],
];

const keyOf = (corner: readonly number[]): string => canonicalCorner(corner).join('.');

/** The eleven uniform tilings of the plane, by corner. */
export const PLANE_UNIFORM: ReadonlyMap<string, UniformForm> = new Map(PLANE_LIST.map(([c, f]) => [keyOf(c), f]));
/** The Platonic and Archimedean solids, by corner. */
export const SPHERE_UNIFORM: ReadonlyMap<string, UniformForm> = new Map(SPHERE_LIST.map(([c, f]) => [keyOf(c), f]));

/**
 * The rule the tables are instances of, for a canonical corner: the forms
 * of the `(p q 2)` kaleidoscope, read off the pattern of the polygons. It
 * is how the disk is read, and a test holds it to the tables.
 */
export function wythoffOf(corner: readonly number[]): UniformForm | undefined {
  const c = canonicalCorner(corner);
  const n = c.length;
  const ok = (p: number, q: number): boolean => Number.isInteger(p) && Number.isInteger(q) && p >= 3 && q >= 3;
  const big = (a: number, b: number): [number, number] => (a >= b ? [a, b] : [b, a]);
  // p·p·…, q times.
  if (c.every((v) => v === c[0])) return ok(c[0], n) ? { form: 'regular', p: c[0], q: n } : undefined;
  // Every rotation, so a pattern is matched wherever it starts.
  const turns = Array.from({ length: n }, (_, s) => Array.from({ length: n }, (_, i) => c[(s + i) % n]));
  if (n === 3) {
    for (const [a, b, d] of turns) {
      // q.2p.2p
      if (b === d && b % 2 === 0 && ok(b / 2, a)) return { form: 'truncated', p: b / 2, q: a };
    }
    for (const [a, b, d] of turns) {
      // 4.2p.2q
      if (a === 4 && b % 2 === 0 && d % 2 === 0 && ok(b / 2, d / 2)) {
        const [p, q] = big(b / 2, d / 2);
        return { form: 'omnitruncated', p, q };
      }
    }
  }
  if (n === 4) {
    for (const [a, b, d, e] of turns) {
      // p.q.p.q
      if (a === d && b === e && a !== b && ok(a, b)) {
        const [p, q] = big(a, b);
        return { form: 'rectified', p, q };
      }
    }
    for (const [a, b, d, e] of turns) {
      // p.4.q.4
      if (b === 4 && e === 4 && ok(a, d)) {
        const [p, q] = big(a, d);
        return { form: 'cantellated', p, q };
      }
    }
  }
  if (n === 5) {
    for (const [a, b, d, e, f] of turns) {
      // 3.3.p.3.q
      if (a === 3 && b === 3 && e === 3 && ok(d, f)) {
        const [p, q] = big(d, f);
        return { form: 'snub', p, q };
      }
    }
  }
  return undefined;
}

/**
 * The uniform tiling whose every corner is `corner`, as a model the flood
 * builds — or a refusal that says what is wrong with the corner: its
 * shape, its angles, or that no uniform tiling meets its corners that way.
 */
export function uniformForm(corner: readonly number[]): { geometry: SpaceKind; form: UniformForm } {
  if (corner.length < 3 || !corner.every((n) => Number.isInteger(n) && n >= 3)) {
    throw new Error(`tiling: a vertex configuration is three or more whole numbers of 3 or more, the polygons round one corner — got [${corner.join(', ')}]`);
  }
  const geometry = cornerGeometry(corner);
  const c = canonicalCorner(corner);
  const form = geometry === 'euclidean' ? PLANE_UNIFORM.get(c.join('.'))
    : geometry === 'spherical' ? SPHERE_UNIFORM.get(c.join('.'))
    : wythoffOf(c);
  if (form) return { geometry, form };
  const named = `[${corner.join(', ')}]`;
  const sum = corner.reduce((s, n) => s + 180 - 360 / n, 0);
  const angles = `${corner.map(angleOf).join(' + ')} = ${Number.isInteger(Math.round(sum * 1e9) / 1e9) ? Math.round(sum) : sum.toFixed(2)}°`;
  if (geometry === 'spherical') {
    const fours = c.filter((n) => n === 4).length;
    const threes = c.filter((n) => n === 3).length;
    if (c.length === 3 && fours >= 2) throw new Error(`tiling: ${named} is the prism on a ${c.find((n) => n !== 4) ?? 4}-gon — t.tiling builds the Platonic and Archimedean solids, not prisms`);
    if (c.length === 4 && threes >= 3) throw new Error(`tiling: ${named} is the antiprism on a ${c.find((n) => n !== 3) ?? 3}-gon — t.tiling builds the Platonic and Archimedean solids, not antiprisms`);
    throw new Error(`tiling: no uniform tiling has the corner ${named} — its angles, ${angles}, close a corner of the sphere, and no Platonic or Archimedean solid meets its corners that way`);
  }
  if (geometry === 'euclidean') {
    throw new Error(`tiling: no uniform tiling has the corner ${named} — its angles, ${angles}, fill a full turn, but none of the 11 uniform tilings of the plane meets its corners that way`);
  }
  throw new Error(`tiling: ${named} is not a tiling t.tiling builds — its angles, ${angles}, pass a full turn, so it is hyperbolic, and in the disk t.tiling builds {p, q} and its rectified [p, q, p, q], truncated [q, 2p, 2p], cantellated [p, 4, q, 4], omnitruncated [4, 2p, 2q] and snub [3, 3, p, 3, q] forms`);
}

/** The model of the uniform tiling whose every corner is `corner`. */
export function cornerModel(corner: readonly number[]): TilingModel {
  const { geometry, form } = uniformForm(corner);
  if (form.form === 'regular') return regularModel(form.p, form.q);
  if (form.form === 'elongated') return elongatedModel();
  return wythoffModel(geometry, form.p, form.q, form.form);
}

// ---- the model's own arithmetic ---------------------------------------------------

/** A point of the model: the hyperboloid, the unit sphere, or `[x, y, 1]`. */
type V3 = readonly [number, number, number];

/** The signature of the model's third coordinate. */
const signOf = (g: SpaceKind): -1 | 0 | 1 => (g === 'hyperbolic' ? -1 : g === 'spherical' ? 1 : 0);

/** A chart point into the model: the Poincaré disk, the stereographic
 * chart, or the plane — the one formula `fromChart` writes. */
function lift(s: -1 | 0 | 1, z: Vec): V3 {
  if (s === 0) return [z[0], z[1], 1];
  const r2 = z[0] * z[0] + z[1] * z[1];
  const d = 1 + s * r2;
  return [(2 * z[0]) / d, (2 * z[1]) / d, (1 - s * r2) / d];
}

/** The model back to the chart. */
function drop(s: -1 | 0 | 1, v: V3): Vec {
  if (s === 0) return [v[0] / v[2], v[1] / v[2]];
  return [v[0] / (1 + v[2]), v[1] / (1 + v[2])];
}

/** A vector of the right cone scaled onto the model. */
function onModel(s: -1 | 0 | 1, v: V3): V3 {
  if (s === 0) return [v[0] / v[2], v[1] / v[2], 1];
  const norm = Math.sqrt(Math.abs(v[0] * v[0] + v[1] * v[1] + s * v[2] * v[2]));
  const k = (s < 0 && v[2] < 0 ? -1 : 1) / norm;
  return [v[0] * k, v[1] * k, v[2] * k];
}

const cross = (u: V3, v: V3): V3 => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const dot = (u: V3, v: V3): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const sub = (u: V3, v: V3): V3 => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];

/** The mirror through two model points as a unit covector `n`, pointing to
 * the side `inside` is on: `n·v` is then the signed distance from the
 * mirror (the plane), its sine (the sphere) or its sinh (the disk). */
function covector(s: -1 | 0 | 1, a: V3, b: V3, inside: V3): V3 {
  const n = cross(a, b);
  const k = (dot(n, inside) < 0 ? -1 : 1) / Math.sqrt(n[0] * n[0] + n[1] * n[1] + s * n[2] * n[2]);
  return [n[0] * k, n[1] * k, n[2] * k];
}

/** The reflection in a mirror, as the 3×3 Householder in the model's own
 * product — `placement.ts`'s `reflection`, on the unit chart. */
function mirror(s: -1 | 0 | 1, n: V3): number[] {
  const sharp: V3 = [n[0], n[1], s * n[2]];
  const d = dot(n, sharp);
  const m: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m.push((r === c ? 1 : 0) - (2 * sharp[r] * n[c]) / d);
  return m;
}

function mul(a: readonly number[], b: readonly number[]): number[] {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out.push(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]);
  return out;
}

const act = (m: readonly number[], v: V3): V3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

const power = (m: readonly number[], k: number): number[] => {
  let out = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let i = 0; i < k; i++) out = mul(m, out);
  return out;
};

/** The distance of the geometry between two model points. */
function gap(s: -1 | 0 | 1, u: V3, v: V3): number {
  return s === 0 ? Math.hypot(u[0] - v[0], u[1] - v[1]) : modelGap(s, u, v);
}

/** Two model points closer than this are one corner. */
const SAME = 1e-9;

/**
 * The corners of the face round a corner of the triangle: `G`'s images
 * in the triangles round it, walked in order — the triangle itself, then
 * across `a`, across `b`, across `a` … — with a repeat where `G` stands on
 * the mirror crossed. `n` is the corner's order, so `2n` triangles.
 */
function walk(s: -1 | 0 | 1, g: V3, a: readonly number[], b: readonly number[], n: number): V3[] {
  const out: V3[] = [];
  let w = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let i = 0; i < 2 * n; i++) {
    const v = act(w, g);
    if (out.length === 0 || gap(s, out[out.length - 1], v) > SAME) out.push(v);
    w = mul(w, i % 2 === 0 ? a : b);
  }
  while (out.length > 1 && gap(s, out[0], out[out.length - 1]) <= SAME) out.pop();
  return out;
}

/** A kind of face from model points: its chart loop run counter-clockwise
 * from its first corner, and its centre. */
function kindOf(s: -1 | 0 | 1, loop: readonly V3[], centre: V3, own: boolean): FaceKind {
  const chart = loop.map((v) => drop(s, v));
  let area = 0;
  for (let i = 0; i < chart.length; i++) {
    const [x0, y0] = chart[i];
    const [x1, y1] = chart[(i + 1) % chart.length];
    area += x0 * y1 - x1 * y0;
  }
  return { loop: area < 0 ? [chart[0], ...chart.slice(1).reverse()] : chart, centre: drop(s, centre), own };
}

// ---- Wythoff's kaleidoscope -----------------------------------------------------------

/**
 * The tiling of one Wythoff form of the `(p q 2)` triangle, on the
 * `{p, q}` cell: the triangle's corners `P` (the cell's centre), `Q` (its
 * first corner) and `R` (the middle of its first wall), its three mirrors,
 * the generating point that makes every wall equal, and the faces a copy
 * of the cell carries.
 */
export function wythoffModel(geometry: SpaceKind, p: number, q: number, form: Exclude<WythoffForm, 'regular'>): TilingModel {
  if (tilingGeometry(p, q) !== geometry) throw new Error(`tiling: the (${p} ${q} 2) triangle is not ${geometry}`);
  const s = signOf(geometry);
  const cell = modelCell(geometry, p, q);
  const P = lift(s, [0, 0]);
  const Q = lift(s, cell[0]);
  const Q1 = lift(s, cell[1]);
  const R = onModel(s, [Q[0] + Q1[0], Q[1] + Q1[1], Q[2] + Q1[2]]);
  // Each mirror named for the corner it does not pass through.
  const nP = covector(s, Q, R, P);
  const nQ = covector(s, P, R, Q);
  const nR = covector(s, P, Q, R);
  const mP = mirror(s, nP);
  const mQ = mirror(s, nQ);
  const mR = mirror(s, nR);
  const inside = (v: V3): V3 => {
    const g = onModel(s, v);
    // The sphere's two antipodes both solve the equations; the one in
    // the triangle is on the inner side of all three mirrors.
    return s > 0 && dot(nP, g) + dot(nQ, g) + dot(nR, g) < 0 ? [-g[0], -g[1], -g[2]] : g;
  };
  const omni = inside(cross(sub(nP, nQ), sub(nQ, nR)));
  const G = form === 'rectified' ? R
    : form === 'truncated' ? inside(cross(nP, sub(nQ, nR)))
    : form === 'cantellated' ? inside(cross(nR, sub(nP, nQ)))
    : form === 'omnitruncated' ? omni
    : snubPoint(s, omni, mul(mQ, mR), mul(mR, mP), mul(mP, mQ));
  // The turn about P that carries the cell's first corner to the next.
  const turn = mul(mQ, mR);
  const kinds: FaceKind[] = [];
  const push = (loop: V3[], centre: V3, own: boolean): void => {
    if (loop.length >= 3) kinds.push(kindOf(s, loop, centre, own));
  };
  if (form === 'snub') {
    // Every other image of G: those of the turns. Round P, round each
    // corner, and one triangle for each triangle of the other hand —
    // `G` seen from its three neighbours, `mR·mP·G`, `mR·mQ·G` and `G`.
    const aboutP = mul(mQ, mR);
    const aboutQ = mul(mR, mP);
    push(Array.from({ length: p }, (_, k) => act(power(aboutP, k), G)), P, true);
    const atQ = Array.from({ length: q }, (_, k) => act(power(aboutQ, k), G));
    const snub = [G, act(mul(mR, mP), G), act(mul(mR, mQ), G)];
    const middle = onModel(s, [snub[0][0] + snub[1][0] + snub[2][0], snub[0][1] + snub[1][1] + snub[2][1], snub[0][2] + snub[1][2] + snub[2][2]]);
    for (let j = 0; j < p; j++) {
      const t = power(turn, j);
      push(atQ.map((v) => act(t, v)), act(t, Q), false);
      push(snub.map((v) => act(t, v)), act(t, middle), true);
    }
  } else {
    push(walk(s, G, mQ, mR, p), P, true);
    const atQ = walk(s, G, mP, mR, q);
    const atR = walk(s, G, mP, mQ, 2);
    for (let j = 0; j < p; j++) {
      const t = power(turn, j);
      push(atQ.map((v) => act(t, v)), act(t, Q), false);
      push(atR.map((v) => act(t, v)), act(t, R), false);
    }
  }
  const [a, b] = kinds[0].loop;
  return {
    geometry,
    cell,
    centre: [0, 0],
    kinds,
    wall: Math.hypot(b[0] - a[0], b[1] - a[1]),
    // A snub has a hand: its mirror is the triangle's side PQ.
    chiral: form === 'snub' ? [[0, 0], cell[0]] : undefined,
  };
}

/**
 * The snub's point: the one whose turned images about `P`, `Q` and `R`
 * all stand one wall away. Two equations in the chart's two coordinates,
 * solved by Newton's method from the omnitruncated point, which is inside
 * the same triangle and near.
 */
function snubPoint(s: -1 | 0 | 1, start: V3, aboutP: readonly number[], aboutQ: readonly number[], aboutR: readonly number[]): V3 {
  const f = (z: Vec): [number, number] => {
    const g = lift(s, z);
    const r = gap(s, g, act(aboutR, g));
    return [gap(s, g, act(aboutP, g)) - r, gap(s, g, act(aboutQ, g)) - r];
  };
  let z = drop(s, start);
  const h = 1e-7 * Math.max(1e-3, Math.hypot(z[0], z[1]));
  for (let i = 0; i < 50; i++) {
    const [e0, e1] = f(z);
    if (Math.hypot(e0, e1) < 1e-15) break;
    const [a0, a1] = f([z[0] + h, z[1]]);
    const [b0, b1] = f([z[0], z[1] + h]);
    const j00 = (a0 - e0) / h;
    const j10 = (a1 - e1) / h;
    const j01 = (b0 - e0) / h;
    const j11 = (b1 - e1) / h;
    const det = j00 * j11 - j01 * j10;
    if (!(Math.abs(det) > 0)) break;
    z = [z[0] - (j11 * e0 - j01 * e1) / det, z[1] - (j00 * e1 - j10 * e0) / det];
  }
  return lift(s, z);
}

// ---- the one without a Wythoff symbol ----------------------------------------------------

/**
 * `3.3.3.4.4`: rows of squares between rows of triangles, each row of
 * squares half a square along from the last.
 *
 * Every line across the rows through a corner or the middle of a square
 * is a mirror, and so is the line along the middle of each row of
 * squares; the rectangle between two neighbours of each, half a square
 * wide and a square and a triangle high, is the flood's cell. Its
 * corners stand at the centres of two squares, and its long sides through
 * the centres of two triangles: those four faces, each shared with the
 * copies round its centre, are all it carries. The square at the model's
 * origin is the first face.
 */
function elongatedModel(): TilingModel {
  const h = Math.sqrt(3) / 2;
  const top = 1 + h;
  const square = (cx: number, cy: number): FaceKind => ({
    loop: [[cx + 0.5, cy - 0.5], [cx + 0.5, cy + 0.5], [cx - 0.5, cy + 0.5], [cx - 0.5, cy - 0.5]],
    centre: [cx, cy],
    own: false,
  });
  return {
    geometry: 'euclidean',
    cell: [[0, 0], [0.5, 0], [0.5, top], [0, top]],
    centre: [0.25, top / 2],
    kinds: [
      square(0, 0),
      square(0.5, top),
      { loop: [[0.5, 0.5], [0, 0.5 + h], [-0.5, 0.5]], centre: [0, 0.5 + h / 3], own: false },
      { loop: [[0.5, 0.5], [1, 0.5 + h], [0, 0.5 + h]], centre: [0.5, 0.5 + (2 * h) / 3], own: false },
    ],
    wall: 1,
  };
}
