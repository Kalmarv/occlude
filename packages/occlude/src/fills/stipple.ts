// Built-in fill 'stipple' — Bridson Poisson-disk dots, plotted as pen taps.
import { fillAsset, type CustomPrimitive, type FillRegion } from '../fillModule.js';
import type { L } from '../units.js';
import type { FieldFn } from '../shapes.js';

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
    /** 0…1, or a field of it read at every dot: 1 packs the dots `minDist`
     * apart, lower spreads them (to 20× `minDist` at 0.05 and below). */
    density: 0.5 as number | FieldFn,
    /** Length; default 2× the fill pen's nib. */
    minDist: undefined as L | undefined,
  },
  generate(region, p, ctx) {
    const minDist =
      (p.minDist !== undefined ? ctx.len(p.minDist) : 2 * ctx.penWidth) * ctx.coarsen;
    // Bridson Poisson-disk over the bbox; the engine keeps only strictly-
    // inside dots, so no containment test is needed here. Physical floor
    // and a hard grid budget against runaway parameters.
    const b = region.bbox;
    if (!(b.w > 0) || !(b.h > 0) || !Number.isFinite(b.w * b.h)) return [];
    const MAX_CELLS = 4_000_000;
    const density = p.density;
    if (typeof density === 'function') return variable(region, density, minDist, Math.max(0.05, Math.sqrt((2 * b.w * b.h) / MAX_CELLS)), ctx.rnd);
    // A radius that is not a finite length has no disc: the loop below would
    // never place a second dot and never stop.
    if (typeof density !== 'number' || !Number.isFinite(density)) {
      throw new Error(`stipple: density must be a finite number from 0 to 1 or a field (x, y) => number, got ${String(density)}`);
    }
    const r = Math.max(
      minDist / Math.min(1, Math.max(0.05, density)),
      0.05,
      Math.sqrt((2 * b.w * b.h) / MAX_CELLS),
    );
    if (!Number.isFinite(r)) throw new Error(`stipple: the dot spacing is not a finite length (minDist ${minDist} mm)`);
    const rr = r * r;
    const cell = r / Math.SQRT2;
    const cols = Math.ceil(b.w / cell) + 1;
    const rows = Math.ceil(b.h / cell) + 1;
    const grid = new Int32Array(cols * rows).fill(-1);
    // Typed, growable point stores and an explicit active stack: no per-
    // candidate allocation. The arithmetic, the comparisons, and the order
    // of rnd() draws are exactly the original Bridson loop's — this fill's
    // ink is immutable and the golden fixture pins it.
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
    push(b.x + rnd() * b.w, b.y + rnd() * b.h);
    const K = 24;
    while (nActive > 0) {
      const pick = Math.floor(rnd() * nActive) % nActive;
      const bi = active[pick];
      let placed = false;
      for (let t = 0; t < K; t++) {
        const ang = rnd() * 2 * Math.PI;
        const rad = r + rnd() * r;
        const x = px[bi] + Math.cos(ang) * rad;
        const y = py[bi] + Math.sin(ang) * rad;
        // fits(x, y), inlined.
        if (x < b.x || x > bx1 || y < b.y || y > by1) continue;
        const cx = Math.min(cols - 1, Math.floor((x - b.x) / cell));
        const cy = Math.min(rows - 1, Math.floor((y - b.y) / cell));
        // NEIGHBOURHOOD, nearest cells first. `ok` is a pure any-overlap
        // predicate that stops at the first hit, so the visiting order
        // cannot change the answer — and a rejected candidate, which is most
        // of them, nearly always conflicts with a point in the 3×3 core.
        let ok = true;
        for (let k = 0; k < NEIGHBOURHOOD.length; k += 2) {
          const gx = cx + NEIGHBOURHOOD[k];
          if (gx < 0 || gx >= cols) continue;
          const gy = cy + NEIGHBOURHOOD[k + 1];
          if (gy < 0 || gy >= rows) continue;
          const idx = grid[gy * cols + gx];
          if (idx < 0) continue;
          // `hypot(dx, dy) < r`, decided by the squared distance except in
          // a ±1e-9 relative band around r², where hypot itself decides —
          // hypot's error is ~1e-16 relative, so the outcome is exactly
          // the original comparison's, at a fraction of the cost.
          const ddx = px[idx] - x;
          const ddy = py[idx] - y;
          const q = ddx * ddx + ddy * ddy;
          if (q < rr * (1 - 1e-9) || (q < rr * (1 + 1e-9) && Math.hypot(ddx, ddy) < r)) {
            ok = false;
            break;
          }
        }
        if (ok) {
          push(x, y);
          placed = true;
          break;
        }
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

/**
 * The same Bridson growth with a radius per disc: the density field is read
 * at each candidate, and the candidate keeps its own radius from every dot
 * already placed. The grid is cut for the smallest radius (density 1), so a
 * cell still holds one dot, and a candidate searches as far as its own
 * radius reaches. A field that answers no place (a non-finite value) places
 * no dot there.
 */
function variable(region: FillRegion, density: FieldFn, minDist: number, floor: number, rnd: () => number): CustomPrimitive[] {
  const b = region.bbox;
  const rmin = Math.max(minDist, floor);
  if (!Number.isFinite(rmin)) throw new Error(`stipple: the dot spacing is not a finite length (minDist ${minDist} mm)`);
  const radiusAt = (x: number, y: number): number => {
    const d = density(x, y);
    if (typeof d !== 'number' || Number.isNaN(d)) return NaN;
    return Math.max(minDist / Math.min(1, Math.max(0.05, d)), floor);
  };
  const cell = rmin / Math.SQRT2;
  const cols = Math.ceil(b.w / cell) + 1;
  const rows = Math.ceil(b.h / cell) + 1;
  const grid = new Int32Array(cols * rows).fill(-1);
  const px: number[] = [];
  const py: number[] = [];
  const pr: number[] = [];
  const active: number[] = [];
  const bx1 = b.x + b.w;
  const by1 = b.y + b.h;
  const cellOf = (x: number, y: number): [number, number] =>
    [Math.min(cols - 1, Math.floor((x - b.x) / cell)), Math.min(rows - 1, Math.floor((y - b.y) / cell))];
  const fits = (x: number, y: number, r: number): boolean => {
    const [cx, cy] = cellOf(x, y);
    const reach = Math.ceil(r / cell);
    const rr = r * r;
    for (let gy = Math.max(0, cy - reach); gy <= Math.min(rows - 1, cy + reach); gy++) {
      for (let gx = Math.max(0, cx - reach); gx <= Math.min(cols - 1, cx + reach); gx++) {
        const idx = grid[gy * cols + gx];
        if (idx < 0) continue;
        const dx = px[idx] - x;
        const dy = py[idx] - y;
        if (dx * dx + dy * dy < rr) return false;
      }
    }
    return true;
  };
  const push = (x: number, y: number, r: number): void => {
    const idx = px.length;
    px.push(x); py.push(y); pr.push(r);
    active.push(idx);
    const [cx, cy] = cellOf(x, y);
    grid[cy * cols + cx] = idx;
  };
  // The first dot: the first draw the field answers for. A field that
  // answers nowhere in 64 draws places none.
  for (let tries = 0; tries < 64 && px.length === 0; tries++) {
    const x = b.x + rnd() * b.w;
    const y = b.y + rnd() * b.h;
    const r = radiusAt(x, y);
    if (Number.isFinite(r)) push(x, y, r);
  }
  const K = 24;
  while (active.length > 0) {
    const pick = Math.floor(rnd() * active.length) % active.length;
    const bi = active[pick];
    let placed = false;
    for (let t = 0; t < K; t++) {
      const ang = rnd() * 2 * Math.PI;
      const rad = pr[bi] + rnd() * pr[bi];
      const x = px[bi] + Math.cos(ang) * rad;
      const y = py[bi] + Math.sin(ang) * rad;
      if (x < b.x || x > bx1 || y < b.y || y > by1) continue;
      const r = radiusAt(x, y);
      if (!Number.isFinite(r) || !fits(x, y, r)) continue;
      push(x, y, r);
      placed = true;
      break;
    }
    if (!placed) {
      active[pick] = active[active.length - 1];
      active.pop();
    }
  }
  return px.map((x, i) => ({ type: 'dot', x, y: py[i] }));
}
