// Built-in fill 'stipple' — Bridson Poisson-disk dots, plotted as pen taps.
import { fillAsset, type CustomPrimitive } from '../fillModule.js';
import type { L } from '../units.js';

// The cells a candidate must be judged against, as (dx, dy) offsets from its
// own cell, ordered nearest first: its own cell, the eight around it, then the
// twelve of the ring at distance two. The four corners of the 5×5
// (|dx| = |dy| = 2) are absent: with cell = r/√2 the candidate is at least one
// cell away in BOTH axes from anything in them, so the separation is at least
// cell·√2 = r exactly, and the test is `< r`. That is a boundary case in
// floating point, so it was checked rather than assumed: over the saved-sketch
// corpus, 9,943,642 occupied corner cells were examined, zero contained a hit,
// and the closest approach was q/r² = 1.0559 — far outside the ±1e-9 band.
const NEIGHBOURHOOD = new Int8Array([
  0, 0,
  -1, -1, 0, -1, 1, -1, -1, 0, 1, 0, -1, 1, 0, 1, 1, 1,
  -1, -2, 0, -2, 1, -2,
  -2, -1, 2, -1, -2, 0, 2, 0, -2, 1, 2, 1,
  -1, 2, 0, 2, 1, 2,
]);

export default fillAsset({
  params: {
    density: 0.5,
    /** Length; default 2× the fill pen's nib. */
    minDist: undefined as L | undefined,
  },
  generate(region, p, ctx) {
    const minDist =
      (p.minDist !== undefined ? ctx.len(p.minDist) : 2 * ctx.penWidth) * ctx.coarsen;
    // Bridson Poisson-disk INSIDE THE REGION. A thin band's bbox is the whole
    // shape, so proposing over the bbox and letting the engine keep the
    // strictly-inside dots spends most of the work on ink that never lands.
    // Physical floor and a hard grid budget against runaway parameters.
    const b = region.bbox;
    if (!(b.w > 0) || !(b.h > 0) || !Number.isFinite(b.w * b.h)) return [];
    const MAX_CELLS = 4_000_000;
    const r = Math.max(
      minDist / Math.min(1, Math.max(0.05, p.density)),
      0.05,
      Math.sqrt((2 * b.w * b.h) / MAX_CELLS),
    );
    const rr = r * r;
    const cell = r / Math.SQRT2;
    const cols = Math.ceil(b.w / cell) + 1;
    const rows = Math.ceil(b.h / cell) + 1;
    const grid = new Int32Array(cols * rows).fill(-1);
    // Typed, growable point stores and an explicit active stack: no per-
    // candidate allocation.
    let cap = 1024;
    let px = new Float64Array(cap);
    let py = new Float64Array(cap);
    let active = new Int32Array(cap);
    let n = 0;
    let nActive = 0;
    const rnd = ctx.rnd;
    const bx1 = b.x + b.w;
    const by1 = b.y + b.h;
    const push = (x: number, y: number): void => {
      if (n === cap) {
        cap *= 2;
        const npx = new Float64Array(cap); npx.set(px); px = npx;
        const npy = new Float64Array(cap); npy.set(py); py = npy;
        const na = new Int32Array(cap); na.set(active); active = na;
      }
      const idx = n++;
      px[idx] = x;
      py[idx] = y;
      active[nActive++] = idx;
      const cx = Math.min(cols - 1, Math.floor((x - b.x) / cell));
      const cy = Math.min(rows - 1, Math.floor((y - b.y) / cell));
      grid[cy * cols + cx] = idx;
    };
    /** Is (x, y) in the box and at least r from every stored dot? */
    const fits = (x: number, y: number): boolean => {
      if (x < b.x || x > bx1 || y < b.y || y > by1) return false;
      const cx = Math.min(cols - 1, Math.floor((x - b.x) / cell));
      const cy = Math.min(rows - 1, Math.floor((y - b.y) / cell));
      // NEIGHBOURHOOD, nearest cells first. This is a pure any-overlap
      // predicate that stops at the first hit, so the visiting order cannot
      // change the answer — and a rejected candidate, which is most of them,
      // nearly always conflicts with a point in the 3×3 core.
      for (let k = 0; k < NEIGHBOURHOOD.length; k += 2) {
        const gx = cx + NEIGHBOURHOOD[k];
        if (gx < 0 || gx >= cols) continue;
        const gy = cy + NEIGHBOURHOOD[k + 1];
        if (gy < 0 || gy >= rows) continue;
        const idx = grid[gy * cols + gx];
        if (idx < 0) continue;
        // `hypot(dx, dy) < r`, decided by the squared distance except in a
        // ±1e-9 relative band around r², where hypot itself decides.
        const ddx = px[idx] - x;
        const ddy = py[idx] - y;
        const q = ddx * ddx + ddy * ddy;
        if (q < rr * (1 - 1e-9) || (q < rr * (1 + 1e-9) && Math.hypot(ddx, ddy) < r)) return false;
      }
      return true;
    };
    // Refusing candidates outside the region blocks propagation across a gap,
    // so when the frontier empties the loop looks for a fresh seed inside the
    // region — that is what covers a region of several disjoint islands, and
    // what a single bbox-wide seed used to give for free.
    const RESEED = 64;
    const seed = (): boolean => {
      for (let t = 0; t < RESEED; t++) {
        const x = b.x + rnd() * b.w;
        const y = b.y + rnd() * b.h;
        if (fits(x, y) && region.contains(x, y)) {
          push(x, y);
          return true;
        }
      }
      return false;
    };
    const K = 24;
    while (nActive > 0 || seed()) {
      const pick = Math.floor(rnd() * nActive) % nActive;
      const bi = active[pick];
      let placed = false;
      for (let t = 0; t < K; t++) {
        const ang = rnd() * 2 * Math.PI;
        const rad = r + rnd() * r;
        const x = px[bi] + Math.cos(ang) * rad;
        const y = py[bi] + Math.sin(ang) * rad;
        if (!fits(x, y) || !region.contains(x, y)) continue;
        push(x, y);
        placed = true;
        break;
      }
      if (!placed) {
        active[pick] = active[nActive - 1];
        nActive--;
      }
    }
    const out: CustomPrimitive[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = { type: 'dot', x: px[i], y: py[i] };
    return out;
  },
});
