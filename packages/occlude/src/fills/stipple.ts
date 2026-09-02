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
    const cell = r / Math.SQRT2;
    const cols = Math.ceil(b.w / cell) + 1;
    const rows = Math.ceil(b.h / cell) + 1;
    const grid = new Int32Array(cols * rows).fill(-1);
    const px: number[] = [];
    const py: number[] = [];
    const active: number[] = [];
    const rnd = ctx.rnd;
    const cellOf = (x: number, y: number): [number, number] => [
      Math.min(cols - 1, Math.floor((x - b.x) / cell)),
      Math.min(rows - 1, Math.floor((y - b.y) / cell)),
    ];
    const fits = (x: number, y: number): boolean => {
      if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) return false;
      const [cx, cy] = cellOf(x, y);
      const x0 = Math.max(0, cx - 2);
      const y0 = Math.max(0, cy - 2);
      for (let gy = y0; gy < Math.min(cy + 3, rows); gy++) {
        for (let gx = x0; gx < Math.min(cx + 3, cols); gx++) {
          const idx = grid[gy * cols + gx];
          if (idx >= 0 && Math.hypot(px[idx] - x, py[idx] - y) < r) return false;
        }
      }
      return true;
    };
    const push = (x: number, y: number): void => {
      const idx = px.length;
      px.push(x); py.push(y);
      active.push(idx);
      const [cx, cy] = cellOf(x, y);
      grid[cy * cols + cx] = idx;
    };
    push(b.x + rnd() * b.w, b.y + rnd() * b.h);
    const K = 24;
    while (active.length > 0) {
      const pick = Math.floor(rnd() * active.length) % active.length;
      const bi = active[pick];
      let placed = false;
      for (let t = 0; t < K; t++) {
        const ang = rnd() * 2 * Math.PI;
        const rad = r + rnd() * r;
        const x = px[bi] + Math.cos(ang) * rad;
        const y = py[bi] + Math.sin(ang) * rad;
        if (fits(x, y)) {
          push(x, y);
          placed = true;
          break;
        }
      }
      if (!placed) {
        active[pick] = active[active.length - 1];
        active.pop();
      }
    }
    const out: CustomPrimitive[] = [];
    for (let i = 0; i < px.length; i++) out.push({ type: 'dot', x: px[i], y: py[i] });
    return out;
  },
});
