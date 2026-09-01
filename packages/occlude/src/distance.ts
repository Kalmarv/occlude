/**
 * Signed distance fields from boundary loops — the bridge back from
 * stampable geometry to scalar fields. `distanceTo(loops)` returns a plain
 * `FieldFn`, so everything that eats a field composes with it: isolines
 * (inset/offset rings ARE `isolines(distanceTo(loops), k)` — there is no
 * offset()), scatter densities, decimate/deform params.
 *
 * Sign: POSITIVE inside, zero on the boundary, negative outside — so inset
 * levels are positive (`isolines(d, 2)` rings 2 units deep) and halos are
 * negative (`isolines(d, -2)` rings 2 units out). Insideness is even-odd
 * over the loops, exactly like `region()`: nesting is holes regardless of
 * loop orientation. Open loops get their closing chord (also like region).
 *
 * Pure and deterministic: a function of the loops alone — no seed, no
 * paper. Coordinates and distances are in the units of the input points.
 * Queries run against a uniform grid built once per call, so sampling the
 * field over a fine isolines grid stays fast for contour-heavy loops.
 */

export type DistanceField = (x: number, y: number) => number;

interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/**
 * Signed distance to the boundary of the area enclosed by `loops`
 * (even-odd): positive inside, negative outside. Strictly loops, like
 * `region()`: wrapper records expose theirs
 * (`distanceTo(blobs.map((c) => c.pts))`). With no usable loops the field
 * is -Infinity everywhere — non-finite samples count as outside, so
 * isolines over an empty field yields no contours rather than throwing.
 */
export function distanceTo(loops: [number, number][][]): DistanceField {
  const segs: Seg[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const loop of loops) {
    if (loop.length < 2) continue;
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = loop[i];
      const [bx, by] = loop[(i + 1) % n];
      if (ax === bx && ay === by) continue;
      segs.push({ ax, ay, bx, by });
      minX = Math.min(minX, ax, bx);
      maxX = Math.max(maxX, ax, bx);
      minY = Math.min(minY, ay, by);
      maxY = Math.max(maxY, ay, by);
    }
  }
  if (segs.length === 0) return () => -Infinity;

  // Uniform grid over segment bboxes (~2 segments per cell), queried by
  // expanding rings with an exact-enough lower bound to stop early.
  const w = Math.max(maxX - minX, 1e-9);
  const h = Math.max(maxY - minY, 1e-9);
  const target = Math.min(256, Math.max(1, Math.ceil(Math.sqrt(segs.length / 2))));
  const cols = target;
  const rows = target;
  const cw = w / cols;
  const ch = h / rows;
  const cells: number[][] = Array.from({ length: cols * rows }, () => []);
  const clampCol = (x: number): number =>
    Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / cw)));
  const clampRow = (y: number): number =>
    Math.min(rows - 1, Math.max(0, Math.floor((y - minY) / ch)));
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const c0 = clampCol(Math.min(s.ax, s.bx));
    const c1 = clampCol(Math.max(s.ax, s.bx));
    const r0 = clampRow(Math.min(s.ay, s.by));
    const r1 = clampRow(Math.max(s.ay, s.by));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) cells[r * cols + c].push(i);
    }
  }

  // Y-bins for the even-odd ray cast: only segments whose y-span covers the
  // query row are candidates.
  const binN = Math.min(4096, Math.max(1, Math.ceil(segs.length / 4)));
  const bh = h / binN;
  const bins: number[][] = Array.from({ length: binN }, () => []);
  const clampBin = (y: number): number =>
    Math.min(binN - 1, Math.max(0, Math.floor((y - minY) / bh)));
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const b0 = clampBin(Math.min(s.ay, s.by));
    const b1 = clampBin(Math.max(s.ay, s.by));
    for (let b = b0; b <= b1; b++) bins[b].push(i);
  }

  const segDist = (s: Seg, x: number, y: number): number => {
    const dx = s.bx - s.ax;
    const dy = s.by - s.ay;
    const len2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / len2));
    return Math.hypot(x - (s.ax + dx * t), y - (s.ay + dy * t));
  };

  // Per-query visited stamps: a segment spanning several cells is measured
  // once. Stamps only skip duplicate work; the min is unaffected.
  const seen = new Uint32Array(segs.length);
  let stamp = 0;

  return (x: number, y: number): number => {
    // Unsigned distance: expanding ring search from the query's cell.
    stamp++;
    const c0 = clampCol(x);
    const r0 = clampRow(y);
    // How far the query sits from its clamped cell (0 when on the grid):
    // ring k's cells are ≥ (k−1)·minCell − offGrid away, a valid stop bound.
    const cellX0 = minX + c0 * cw;
    const cellY0 = minY + r0 * ch;
    const offGrid = Math.hypot(
      Math.max(0, cellX0 - x, x - (cellX0 + cw)),
      Math.max(0, cellY0 - y, y - (cellY0 + ch)),
    );
    const minCell = Math.min(cw, ch);
    const maxRing = Math.max(cols, rows);
    let best = Infinity;
    for (let k = 0; k <= maxRing; k++) {
      if (best <= (k - 1) * minCell - offGrid) break;
      const lo = -k;
      for (let dr = lo; dr <= k; dr++) {
        const r = r0 + dr;
        if (r < 0 || r >= rows) continue;
        const onRim = Math.abs(dr) === k;
        const step = onRim ? 1 : 2 * k;
        for (let dc = lo; dc <= k; dc += step === 0 ? 1 : step) {
          const c = c0 + dc;
          if (c < 0 || c >= cols) continue;
          for (const i of cells[r * cols + c]) {
            if (seen[i] === stamp) continue;
            seen[i] = stamp;
            const d = segDist(segs[i], x, y);
            if (d < best) best = d;
          }
          if (k === 0) break;
        }
      }
    }

    // Even-odd sign via the standard half-open horizontal ray cast.
    let inside = false;
    if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
      let crossings = 0;
      for (const i of bins[clampBin(y)]) {
        const s = segs[i];
        if (s.ay > y !== s.by > y) {
          const xi = s.ax + ((y - s.ay) / (s.by - s.ay)) * (s.bx - s.ax);
          if (xi > x) crossings++;
        }
      }
      inside = crossings % 2 === 1;
    }
    return inside ? best : -best;
  };
}
