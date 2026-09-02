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

  // Flat segment table.
  const n = segs.length;
  const AX = new Float64Array(n), AY = new Float64Array(n);
  const BX = new Float64Array(n), BY = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    AX[i] = segs[i].ax; AY[i] = segs[i].ay; BX[i] = segs[i].bx; BY[i] = segs[i].by;
  }

  // Uniform grid over segment bboxes (~2 segments per cell) in CSR form,
  // queried by expanding rings with an exact lower bound to stop early.
  const w = Math.max(maxX - minX, 1e-9);
  const h = Math.max(maxY - minY, 1e-9);
  const target = Math.min(256, Math.max(1, Math.ceil(Math.sqrt(n / 2))));
  const cols = target;
  const rows = target;
  const cw = w / cols;
  const ch = h / rows;
  const clampCol = (x: number): number =>
    Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / cw)));
  const clampRow = (y: number): number =>
    Math.min(rows - 1, Math.max(0, Math.floor((y - minY) / ch)));
  const csr = (
    nb: number,
    lo: (i: number) => number,
    hi: (i: number) => number,
  ): { start: Int32Array; items: Int32Array } => {
    const start = new Int32Array(nb + 1);
    for (let i = 0; i < n; i++) for (let b = lo(i); b <= hi(i); b++) start[b + 1]++;
    for (let b = 0; b < nb; b++) start[b + 1] += start[b];
    const fill = start.slice(0, nb);
    const items = new Int32Array(start[nb]);
    for (let i = 0; i < n; i++) for (let b = lo(i); b <= hi(i); b++) items[fill[b]++] = i;
    return { start, items };
  };
  // A segment spanning several cells appears in each; the ring walk visits
  // cells in a fixed order and stamps segments so each is measured once.
  const cellIndex = (() => {
    const start = new Int32Array(cols * rows + 1);
    const span = (i: number): [number, number, number, number] => [
      clampCol(Math.min(AX[i], BX[i])), clampCol(Math.max(AX[i], BX[i])),
      clampRow(Math.min(AY[i], BY[i])), clampRow(Math.max(AY[i], BY[i])),
    ];
    for (let i = 0; i < n; i++) {
      const [c0, c1, r0, r1] = span(i);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) start[r * cols + c + 1]++;
    }
    for (let b = 0; b < cols * rows; b++) start[b + 1] += start[b];
    const fill = start.slice(0, cols * rows);
    const items = new Int32Array(start[cols * rows]);
    for (let i = 0; i < n; i++) {
      const [c0, c1, r0, r1] = span(i);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) items[fill[r * cols + c]++] = i;
    }
    return { start, items };
  })();

  // Y-bins for the even-odd ray cast: only segments whose y-span covers the
  // query row are candidates.
  const binN = Math.min(4096, Math.max(1, Math.ceil(n / 4)));
  const bh = h / binN;
  const clampBin = (y: number): number =>
    Math.min(binN - 1, Math.max(0, Math.floor((y - minY) / bh)));
  const bins = csr(binN, (i) => clampBin(Math.min(AY[i], BY[i])), (i) => clampBin(Math.max(AY[i], BY[i])));

  // Per-query visited stamps: a segment spanning several cells is measured
  // once. Stamps only skip duplicate work; the min is unaffected.
  const seen = new Uint32Array(n);
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
          const cell = r * cols + c;
          for (let m = cellIndex.start[cell], me = cellIndex.start[cell + 1]; m < me; m++) {
            const i = cellIndex.items[m];
            if (seen[i] === stamp) continue;
            seen[i] = stamp;
            // Point-to-segment distance, exactly as before (same operations).
            const ax = AX[i], ay = AY[i];
            const dx = BX[i] - ax;
            const dy = BY[i] - ay;
            const len2 = dx * dx + dy * dy;
            const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
            const d = Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
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
      const b = clampBin(y);
      for (let m = bins.start[b], me = bins.start[b + 1]; m < me; m++) {
        const i = bins.items[m];
        const ay = AY[i], by = BY[i];
        if (ay > y !== by > y) {
          const xi = AX[i] + ((y - ay) / (by - ay)) * (BX[i] - AX[i]);
          if (xi > x) crossings++;
        }
      }
      inside = crossings % 2 === 1;
    }
    return inside ? best : -best;
  };
}
