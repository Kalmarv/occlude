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
 * over the loops, exactly like `polygon()`: nesting is holes regardless of
 * loop orientation. Open loops get their closing chord (also like polygon).
 *
 * Pure and deterministic: a function of the loops alone — no seed, no
 * paper. Coordinates and distances are in the units of the input points.
 * Queries run against a uniform grid built once per call, so sampling the
 * field over a fine isolines grid stays fast for contour-heavy loops.
 */

import { numericLoops, type Boundary } from './boundary.js';

export type DistanceField = (x: number, y: number) => number;

interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/**
 * Signed distance to the boundary of the area enclosed by `boundary`
 * (even-odd): positive inside, negative outside. The boundary is plain
 * loops, contour records (an isoline, a face's contours) or a chain
 * material (`t.material(rect(…))`, `t.isolines(…)`), all resolved the way
 * `polygon()` resolves them; a branching material is refused. With no
 * usable loops the field is -Infinity everywhere — non-finite samples count
 * as outside, so isolines over an empty field yields no contours rather
 * than throwing.
 */
export function distanceTo(boundary: Boundary): DistanceField {
  const loops = numericLoops(boundary, 'distanceTo');
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

// ---- the algebra -------------------------------------------------------

/**
 * Distance fields as shapes you can combine. A shape here is a function of
 * a point, POSITIVE INSIDE and negative outside, exactly like `distanceTo`.
 * The sign is why union is a maximum and not a minimum: the union is
 * inside wherever EITHER field is inside, and inside is the larger value.
 *
 * Everything else is already vocabulary. The boundary of a field is
 * `t.isolines(f, 0)`, and a ring is the same call at another level — there
 * is no `contour()` and no `offset()`. A field is a function, so a shape
 * grown by four is `(x, y) => f(x, y) + 4`, written where it is needed.
 *
 * `circle`, `rect` and `segment` are exact. `union` is exact outside the
 * shape and understates depth inside it, because the nearest boundary may
 * belong to the other field; `intersect` is the reverse, and `subtract` is
 * approximate near the cut. Contour any of them at zero and the boundary
 * is exact. `blend` is exact wherever the joint is further than its radius
 * away, and rounds the corner within that distance.
 */

const asField = (f: DistanceField, what: string): DistanceField => {
  if (typeof f !== 'function') throw new Error(`sdf.${what}: expected a distance field, a function of (x, y)`);
  return f;
};

/** Nothing to combine is not a mistake: it is the identity. `distanceTo`
 * already returns a field that is nowhere inside for an empty boundary,
 * "so isolines over an empty field yields no contours rather than
 * throwing" — a computed list that came out empty must behave the same. */
const many = (fields: readonly DistanceField[], what: string): DistanceField[] => fields.map((f) => asField(f, what));

/** Nowhere inside — the identity of a union, and an empty drawing. */
const nowhere: DistanceField = () => -Infinity;
/** Everywhere inside — the identity of an intersection. */
const everywhere: DistanceField = () => Infinity;

/** A disc of radius `r` about `cx, cy` — spelled like `circle(x, y, r)`.
 * Exact. */
const circleField = (cx: number, cy: number, r: number): DistanceField =>
  (x, y) => r - Math.hypot(x - cx, y - cy);

/**
 * An axis-aligned box, `w` by `h`, CENTRED on `cx, cy`. Exact inside and
 * out, including the rounded distance past a corner.
 *
 * It is `box` and not `rect` on purpose. `rect(x, y, w, h)` anchors by the
 * sketch's own rect mode, and a pure field function cannot read that, so
 * one name with two anchors would be a trap. A box is centred, always.
 */
const boxField = (cx: number, cy: number, w: number, h: number): DistanceField => {
  const hw = Math.abs(w) / 2;
  const hh = Math.abs(h) / 2;
  return (x, y) => {
    const dx = Math.abs(x - cx) - hw;
    const dy = Math.abs(y - cy) - hh;
    // Outside: distance to the nearest corner or edge. Inside: the nearest
    // edge, which is the larger (least negative) of the two.
    const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
    return -(outside + Math.min(Math.max(dx, dy), 0));
  };
};

/**
 * A capsule: every point within `r` of the segment, spelled like
 * `line(x0, y0, x1, y1)`. Exact.
 *
 * `r` is required, and for a reason: a capsule of no radius is never
 * positive, so its zero contour is empty and the sketch draws nothing at
 * all. A field is an area, and an area needs a width.
 */
const segmentField = (x0: number, y0: number, x1: number, y1: number, r: number): DistanceField => {
  const ax = x0;
  const ay = y0;
  const dx = x1 - ax;
  const dy = y1 - ay;
  const len2 = dx * dx + dy * dy;
  return (x, y) => {
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    return r - Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
  };
};

/** Inside wherever any of them is inside. */
const unionField = (...fields: DistanceField[]): DistanceField => {
  const fs = many(fields, 'union');
  if (fs.length === 0) return nowhere;
  if (fs.length === 1) return fs[0];
  return (x, y) => {
    let best = -Infinity;
    for (const f of fs) best = Math.max(best, f(x, y));
    return best;
  };
};

/** Inside only where all of them are inside. */
const intersectField = (...fields: DistanceField[]): DistanceField => {
  const fs = many(fields, 'intersect');
  if (fs.length === 0) return everywhere;
  if (fs.length === 1) return fs[0];
  return (x, y) => {
    let best = Infinity;
    for (const f of fs) best = Math.min(best, f(x, y));
    return best;
  };
};

/** `a` with every later field cut out of it. */
const subtractField = (a: DistanceField, ...holes: DistanceField[]): DistanceField => {
  const base = asField(a, 'subtract');
  const fs = many(holes, 'subtract');
  if (fs.length === 0) return base;
  return (x, y) => {
    let best = base(x, y);
    for (const f of fs) best = Math.min(best, -f(x, y));
    return best;
  };
};

/**
 * A union with a fillet of `radius` where the two meet. Away from the
 * joint it is exactly the union. Within `radius` of it the corner becomes
 * an arc, so the blended shape is a little larger there than the union —
 * a fillet adds material, and this one adds it only where it belongs.
 */
const blendField = (a: DistanceField, b: DistanceField, radius: number): DistanceField => {
  const fa = asField(a, 'blend');
  const fb = asField(b, 'blend');
  const k = Math.abs(radius);
  if (!(k > 0) || !Number.isFinite(k)) return unionField(fa, fb);
  return (x, y) => {
    const u = fa(x, y);
    const v = fb(x, y);
    // An empty field is -Infinity by design. Blending with one gives the
    // other, rather than NaN everywhere.
    if (!Number.isFinite(u) || !Number.isFinite(v)) return Math.max(u, v);
    // A ROUNDED union: a quarter circle of radius k across the joint. The
    // obvious polynomial smooth maximum is wrong for this job — its bump
    // is added wherever the two fields are within k of EACH OTHER, which
    // on the locus equidistant from both is true out to infinity, so the
    // whole shape grows by k/4 and never stops. This form is exactly the
    // union wherever the joint is further than k away.
    return Math.min(-k, Math.max(u, v)) + Math.hypot(Math.max(k + u, 0), Math.max(k + v, 0));
  };
};

/**
 * Shapes as distance fields, and the algebra over them. Pure: no seed and
 * no paper, so it is a module import. `distanceTo(shape)` brings ordinary
 * geometry into the same algebra.
 *
 * The name says what the algebra takes. A signed distance field is what
 * every word here reads and returns, and `union` of two NOISE fields would
 * be a maximum of noise — meaningless. `distance` was not available
 * anyway: `distance(a, b)` is already the distance between two points.
 */
export const sdf = {
  circle: circleField,
  box: boxField,
  segment: segmentField,
  union: unionField,
  intersect: intersectField,
  subtract: subtractField,
  blend: blendField,
};
