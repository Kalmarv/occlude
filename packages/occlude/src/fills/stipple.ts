// Built-in fill 'stipple' — Bridson Poisson-disk dots, plotted as pen taps.
import { fillAsset, type CustomPrimitive } from '../fillModule.js';
import type { L } from '../units.js';

export default fillAsset({
  params: {
    density: 0.5,
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
        const gx0 = Math.max(0, cx - 2);
        const gy0 = Math.max(0, cy - 2);
        const gx1 = Math.min(cx + 3, cols);
        const gy1 = Math.min(cy + 3, rows);
        let ok = true;
        for (let gy = gy0; ok && gy < gy1; gy++) {
          const row = gy * cols;
          for (let gx = gx0; gx < gx1; gx++) {
            const idx = grid[row + gx];
            if (idx < 0) continue;
            // `hypot(dx, dy) < r`, decided by the squared distance except in
            // a ±1e-9 relative band around r², where hypot itself decides —
            // hypot's error is ~1e-16 relative, so the outcome is exactly
            // the original comparison's, at a fraction of the cost.
            const ddx = px[idx] - x;
            const ddy = py[idx] - y;
            const q = ddx * ddx + ddy * ddy;
            const near = q < rr * (1 - 1e-9) || (q < rr * (1 + 1e-9) && Math.hypot(ddx, ddy) < r);
            if (near) {
              ok = false;
              break;
            }
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
