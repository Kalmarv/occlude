/**
 * Field → ridges: the crest lines of a scalar field, as `isolines` gives its
 * level sets.
 *
 * A level set answers "where is the field this high". A ridge answers "where
 * does the field run along a crest" — the spine of a range of hills, the
 * watershed between two basins, the centre line of a light or dark streak in a
 * photograph, the skeleton a `distanceTo` field converges to. The two are
 * complementary and neither derives the other: contours of a long smooth ridge
 * are a nest of ovals with nothing down the middle.
 *
 * A point is on a ridge when the field is at a local maximum ACROSS the ridge:
 * with the Hessian's eigenvalues `λ₁ ≤ λ₂` and unit eigenvectors `e₁, e₂`,
 * where `∇f · e₁ = 0` and `λ₁ < 0`. (`e₁` is the direction the ground falls
 * away fastest, so it points across the crest, and the condition says the crest
 * is a maximum in that direction while saying nothing about the direction you
 * walk along it.) Valleys are the ridges of `-f`, so there is no mode here:
 * `t.ridges((x, y) => -f(x, y))` is the other half.
 *
 * **Why this is an operation and not a recipe.** `∇f · e₁ = 0` looks like a
 * level set of a scalar field, so it looks like `t.isolines(g, 0)` with a
 * hand-written `g`. It is not, and the reason is the reason this file exists:
 * `e₁` is a LINE, not a vector. An eigenvector is defined up to sign, so `g`'s
 * sign flips arbitrarily from sample to sample and marching squares reads
 * every one of those flips as a crossing — noise everywhere and the real ridge
 * lost inside it. There is no global fix either: at an umbilic point, where
 * `λ₁ = λ₂`, the across direction is genuinely undefined, so no consistent
 * sign exists over the whole grid. What does work is to fix the sign inside
 * ONE cell, from that cell's most sharply curved corner, and march there; the
 * crossing position on a shared edge does not depend on the convention, so
 * neighbouring cells still meet.
 *
 * That same local convention is why the segments come out unoriented, and why
 * they are linked here rather than by `chainSegments`, which matches a
 * segment's start against another's end.
 *
 * Every vertex carries two columns: `strength`, which is `-λ₁` — how sharply
 * the ground falls away to either side, in the field's units per square
 * drawable unit — and `height`, the field's own value there. Nothing is
 * thresholded: a weak ridge is a real ridge, and which ones are worth ink is
 * the drawing's decision, made with `m.points.filter(...).inducedEdges()`.
 */

import { positiveLength } from './guard.js';
import type { FieldFn } from './shapes.js';
import { mm, type L } from './units.js';
import type { IsoEnv } from './isolines.js';

export interface RidgeOpts {
  /** Sampling step (default: max of mm(1) and long-side/256). Crossings are
   * edge-interpolated, so positional error is well below the step — but the
   * step also sets the scale of the derivatives, so a coarser grid finds
   * broader ridges and ignores fine ones. That is a real knob, not a quality
   * setting. */
  step?: L;
}

export interface RidgeContour {
  pts: [number, number][];
  closed: boolean;
  /** `-λ₁` at each vertex: how sharply the field falls away across the ridge. */
  strength: number[];
  /** The field's own value at each vertex. */
  height: number[];
}

export function ridgesOf(env: IsoEnv, field: FieldFn, opts: RidgeOpts = {}): RidgeContour[] {
  const b = env.bounds;
  positiveLength('ridges', opts.step);
  const stepU =
    opts.step !== undefined ? env.len(opts.step) : Math.max(env.len(mm(1)), Math.max(b.w, b.h) / 256);
  const gw = Math.max(3, Math.ceil(b.w / stepU) + 1);
  const gh = Math.max(3, Math.ceil(b.h / stepU) + 1);
  const cells = gw * gh;
  if (!Number.isFinite(cells)) throw new Error(`ridges: grid is ${cells} — check for a zero step`);
  if (cells > 16_777_216) {
    throw new Error(`ridges: ${Math.floor(cells)} grid cells (step too fine) — capped at 16.7M (~128MB of samples)`);
  }

  const sx = b.w / (gw - 1);
  const sy = b.h / (gh - 1);
  // One real ring of samples outside the drawable, so a central difference is
  // available at every node inside it — the ring carries field values, not
  // sentinels, because a derivative made from a sentinel is not a derivative.
  const pw = gw + 2;
  const ph = gh + 2;
  const f = new Float64Array(pw * ph);
  for (let j = -1; j <= gh; j++) {
    for (let i = -1; i <= gw; i++) {
      f[(j + 1) * pw + (i + 1)] = field(b.x + i * sx, b.y + j * sy);
    }
  }
  const at = (i: number, j: number): number => f[(j + 1) * pw + (i + 1)];

  // Per node: the across direction, the curvature across it, and how far the
  // field still climbs that way.
  const n = gw * gh;
  const ex = new Float64Array(n);
  const ey = new Float64Array(n);
  const lam = new Float64Array(n);
  const slope = new Float64Array(n);
  const val = new Float64Array(n);
  const absent = new Uint8Array(n);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      const c = at(i, j);
      const l = at(i - 1, j);
      const r = at(i + 1, j);
      const d = at(i, j - 1);
      const u = at(i, j + 1);
      const dl = at(i - 1, j - 1);
      const dr = at(i + 1, j - 1);
      const ul = at(i - 1, j + 1);
      const ur = at(i + 1, j + 1);
      // A within() bound or a NaN hole anywhere in the stencil means this node
      // has no second derivative, so it has no opinion about ridges.
      if (![c, l, r, d, u, dl, dr, ul, ur].every(Number.isFinite)) {
        absent[k] = 1;
        continue;
      }
      val[k] = c;
      const fx = (r - l) / (2 * sx);
      const fy = (u - d) / (2 * sy);
      const fxx = (r - 2 * c + l) / (sx * sx);
      const fyy = (u - 2 * c + d) / (sy * sy);
      const fxy = (ur - ul - dr + dl) / (4 * sx * sy);
      const half = (fxx + fyy) / 2;
      const gap = Math.hypot((fxx - fyy) / 2, fxy);
      const l1 = half - gap; // the more negative eigenvalue
      // Eigenvector of l1: both rows of (H - l1 I) are multiples of its
      // normal; take the longer one so an axis-aligned Hessian is exact.
      let vx = fxy;
      let vy = l1 - fxx;
      if (Math.hypot(vx, vy) < Math.hypot(l1 - fyy, fxy)) {
        vx = l1 - fyy;
        vy = fxy;
      }
      const len = Math.hypot(vx, vy);
      if (len === 0) {
        // Isotropic curvature: every direction is e₁ and none of them is. An
        // umbilic is not a ridge point; it is where the question stops making
        // sense, so the node abstains rather than guessing a direction.
        absent[k] = 1;
        continue;
      }
      ex[k] = vx / len;
      ey[k] = vy / len;
      lam[k] = l1;
      slope[k] = fx * ex[k] + fy * ey[k];
    }
  }

  // Marching the zero set of the across-slope, one cell at a time, each with
  // its own sign convention.
  const segs: number[] = [];
  const sv = [0, 0, 0, 0];
  const lv = [0, 0, 0, 0];
  const px = [0, 0, 0, 0];
  const py = [0, 0, 0, 0];
  for (let j = 0; j < gh - 1; j++) {
    for (let i = 0; i < gw - 1; i++) {
      const c00 = j * gw + i;
      const c10 = c00 + 1;
      const c11 = c00 + gw + 1;
      const c01 = c00 + gw;
      if (absent[c00] || absent[c10] || absent[c11] || absent[c01]) continue;
      const corner = [c00, c10, c11, c01];
      // The sharpest corner decides which way "across" points in this cell;
      // it is the one whose eigenvector is least ambiguous.
      let ref = corner[0];
      for (const k of corner) if (Math.abs(lam[k]) > Math.abs(lam[ref])) ref = k;
      for (let q = 0; q < 4; q++) {
        const k = corner[q];
        const agree = ex[k] * ex[ref] + ey[k] * ey[ref] >= 0 ? 1 : -1;
        sv[q] = slope[k] * agree;
        lv[q] = lam[k];
        px[q] = b.x + (i + (q === 1 || q === 2 ? 1 : 0)) * sx;
        py[q] = b.y + (j + (q === 2 || q === 3 ? 1 : 0)) * sy;
      }
      // Crossings on the four cell edges, in edge order 0→1, 1→2, 2→3, 3→0.
      const cutX: number[] = [];
      const cutY: number[] = [];
      const cutL: number[] = [];
      const cutE: number[] = [];
      for (let e = 0; e < 4; e++) {
        const a = e;
        const z = (e + 1) % 4;
        if (sv[a] === 0 && sv[z] === 0) continue;
        if (sv[a] < 0 === sv[z] < 0) continue;
        const t = sv[a] / (sv[a] - sv[z]);
        cutX.push(px[a] + (px[z] - px[a]) * t);
        cutY.push(py[a] + (py[z] - py[a]) * t);
        cutL.push(lv[a] + (lv[z] - lv[a]) * t);
        cutE.push(e);
      }
      const join = (p: number, q: number): void => {
        // A crest is a maximum across itself. Where the interpolated curvature
        // is not negative this is a trough or a flat, and the crossing belongs
        // to the ridges of -f instead.
        if (cutL[p] >= 0 || cutL[q] >= 0) return;
        segs.push(cutX[p], cutY[p], cutX[q], cutY[q]);
      };
      if (cutX.length === 2) join(0, 1);
      else if (cutX.length === 4) {
        // A saddle in the across-slope: the bilinear middle says which pair
        // belongs together, exactly as marching squares resolves its own.
        const mid = (sv[0] + sv[1] + sv[2] + sv[3]) / 4;
        if (mid < 0 === sv[0] < 0) {
          join(0, 3);
          join(1, 2);
        } else {
          join(0, 1);
          join(2, 3);
        }
      }
    }
  }

  const contours = linkSegments(segs);
  // Columns are read back off the grid at the linked vertices rather than
  // carried through the linking: one bilinear read each, and the chaining
  // stays a function of positions.
  const read = (arr: Float64Array, x: number, y: number): number => {
    const u = Math.min(gw - 1.0001, Math.max(0, (x - b.x) / sx));
    const v = Math.min(gh - 1.0001, Math.max(0, (y - b.y) / sy));
    const i = Math.floor(u);
    const j = Math.floor(v);
    const tx = u - i;
    const ty = v - j;
    const k = j * gw + i;
    return (
      arr[k] * (1 - tx) * (1 - ty) +
      arr[k + 1] * tx * (1 - ty) +
      arr[k + gw] * (1 - tx) * ty +
      arr[k + gw + 1] * tx * ty
    );
  };
  return contours.map((c) => ({
    ...c,
    strength: c.pts.map(([x, y]) => Math.max(0, -read(lam, x, y))),
    height: c.pts.map(([x, y]) => read(val, x, y)),
  }));
}

/** Link unoriented segments end to end. `chainSegments` cannot serve here: it
 * matches one segment's start against another's end, and these have no
 * consistent direction to match on. */
function linkSegments(segs: number[]): { pts: [number, number][]; closed: boolean }[] {
  const count = segs.length / 4;
  if (count === 0) return [];
  const Q = 1e-6;
  const key = (x: number, y: number): string => `${Math.round(x / Q)},${Math.round(y / Q)}`;
  const ends = new Map<string, number[]>();
  const push = (k: string, half: number): void => {
    const cur = ends.get(k);
    if (cur) cur.push(half);
    else ends.set(k, [half]);
  };
  for (let s = 0; s < count; s++) {
    push(key(segs[4 * s], segs[4 * s + 1]), 2 * s);
    push(key(segs[4 * s + 2], segs[4 * s + 3]), 2 * s + 1);
  }
  const used = new Uint8Array(count);
  const ptOf = (half: number): [number, number] => [segs[2 * half], segs[2 * half + 1]];
  // The far end of the segment this half belongs to.
  const other = (half: number): number => half ^ 1;
  const step = (half: number): number => {
    // From the vertex at `half`, the one unused segment continuing through it.
    const here = ends.get(key(...ptOf(half)));
    if (!here) return -1;
    for (const h of here) {
      const s = h >> 1;
      if (!used[s]) return h;
    }
    return -1;
  };

  const out: { pts: [number, number][]; closed: boolean }[] = [];
  for (let s = 0; s < count; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const pts: [number, number][] = [ptOf(2 * s), ptOf(2 * s + 1)];
    // Forward from the second end, then backward from the first.
    let tip = 2 * s + 1;
    for (;;) {
      const h = step(tip);
      if (h < 0) break;
      used[h >> 1] = 1;
      tip = other(h);
      pts.push(ptOf(tip));
    }
    let closed = false;
    if (key(...pts[0]) === key(...pts[pts.length - 1]) && pts.length > 3) {
      pts.pop();
      closed = true;
    }
    if (!closed) {
      let tail = 2 * s;
      for (;;) {
        const h = step(tail);
        if (h < 0) break;
        used[h >> 1] = 1;
        tail = other(h);
        pts.unshift(ptOf(tail));
      }
    }
    if (pts.length >= (closed ? 3 : 2)) out.push({ pts, closed });
  }
  return out;
}
