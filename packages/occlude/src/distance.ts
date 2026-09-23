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

import { numericLoops, type AreaInput } from './boundary.js';
import { vx as pointX, vy as pointY, type XY } from './vec.js';
import type { PointsLike } from './material.js';
import { Len } from './units.js';

export type DistanceField = (x: number, y: number) => number;

/** `√(a² + b²)`, spelled out. Not `Math.hypot`: V8's hypot scales by the
 * larger operand and sums with Kahan compensation, which costs about 2.5×
 * this and differs from it only in the last bit. Every distance this
 * module evaluates per sample goes through here, and the fused programs
 * spell the same three operations in the same order, so both walks agree
 * bit for bit. (Deliberate ink change, 2026-09-20: the docs baseline was
 * re-saved with this.) */
const hyp = (a: number, b: number): number => Math.sqrt(a * a + b * b);

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
export function distanceTo(boundary: AreaInput): DistanceField {
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
            const d = hyp(x - (ax + dx * t), y - (ay + dy * t));
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

/** Site coordinates, read from whatever says where its points are: a
 * material answers with its own columns, anything iterable is walked point
 * by point (a point selection yields its vertex views, an array its pairs
 * or records). Non-finite positions are dropped, not drawn to. */
function sitePositions(sites: PointsLike, who: string): { sx: Float64Array; sy: Float64Array } {
  const xs: number[] = [];
  const ys: number[] = [];
  const v = sites as unknown as { x?: ArrayLike<number>; y?: ArrayLike<number>; n?: number };
  if (typeof v?.n === 'number' && v.x !== undefined && v.y !== undefined) {
    for (let i = 0; i < v.n; i++) {
      xs.push(v.x[i]);
      ys.push(v.y[i]);
    }
  } else if (v !== null && v !== undefined && typeof (v as Iterable<XY>)[Symbol.iterator] === 'function') {
    for (const p of sites as Iterable<XY>) {
      xs.push(pointX(p));
      ys.push(pointY(p));
    }
  } else {
    throw new Error(`${who}: expected points — an array of [x, y] or { x, y }, a point selection, or a material`);
  }
  const keep: number[] = [];
  for (let i = 0; i < xs.length; i++) if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) keep.push(i);
  return { sx: Float64Array.from(keep, (i) => xs[i]), sy: Float64Array.from(keep, (i) => ys[i]) };
}

/**
 * Distance to the NEAREST of a cloud of sites, as a field of the same sign
 * convention as `distanceTo`: zero at a site and negative everywhere else,
 * so nowhere is inside. It is −F1 of the Worley family, which is what makes
 * it read as a field: `t.isolines(distanceToPoints(sites), -3)` is the ring
 * three units out from every site, and where two rings would meet they
 * merge into the cracked-mud cell wall between the sites.
 *
 * Pure and deterministic, like `distanceTo`: no seed and no paper. A shape
 * is not points, so there is no lowering to do; `t.scatter(...)`,
 * `m.points` and a plain array of pairs all go straight in. With no usable
 * site the field is −Infinity everywhere, so isolines over it yield no
 * contours rather than throwing.
 *
 * Queries run against a uniform grid built once per call and widened ring
 * by ring, with the exact bound that stops the walk — the same search
 * `distanceTo` makes over its segments.
 */
export function distanceToPoints(sites: PointsLike): DistanceField {
  const { sx, sy } = sitePositions(sites, 'distanceToPoints');
  const n = sx.length;
  if (n === 0) return () => -Infinity;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (sx[i] < minX) minX = sx[i];
    if (sx[i] > maxX) maxX = sx[i];
    if (sy[i] < minY) minY = sy[i];
    if (sy[i] > maxY) maxY = sy[i];
  }
  const w = Math.max(maxX - minX, 1e-9);
  const h = Math.max(maxY - minY, 1e-9);
  const target = Math.min(256, Math.max(1, Math.ceil(Math.sqrt(n / 2))));
  const cols = target;
  const rows = target;
  const cw = w / cols;
  const ch = h / rows;
  const clampCol = (x: number): number => Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / cw)));
  const clampRow = (y: number): number => Math.min(rows - 1, Math.max(0, Math.floor((y - minY) / ch)));
  // CSR buckets: one cell per site, so no stamping is needed on the walk.
  const start = new Int32Array(cols * rows + 1);
  for (let i = 0; i < n; i++) start[clampRow(sy[i]) * cols + clampCol(sx[i]) + 1]++;
  for (let b = 0; b < cols * rows; b++) start[b + 1] += start[b];
  const fill = start.slice(0, cols * rows);
  const items = new Int32Array(n);
  for (let i = 0; i < n; i++) items[fill[clampRow(sy[i]) * cols + clampCol(sx[i])]++] = i;

  const minCell = Math.min(cw, ch);
  const maxRing = Math.max(cols, rows);
  return (x: number, y: number): number => {
    const c0 = clampCol(x);
    const r0 = clampRow(y);
    const cellX0 = minX + c0 * cw;
    const cellY0 = minY + r0 * ch;
    // How far the query sits outside its clamped cell (0 when on the grid):
    // ring k's cells are ≥ (k−1)·minCell − offGrid away, a valid stop bound.
    const offGrid = Math.hypot(
      Math.max(0, cellX0 - x, x - (cellX0 + cw)),
      Math.max(0, cellY0 - y, y - (cellY0 + ch)),
    );
    let best = Infinity;
    for (let k = 0; k <= maxRing; k++) {
      if (best <= (k - 1) * minCell - offGrid) break;
      for (let dr = -k; dr <= k; dr++) {
        const r = r0 + dr;
        if (r < 0 || r >= rows) continue;
        const onRim = Math.abs(dr) === k;
        const step = onRim || k === 0 ? 1 : 2 * k;
        for (let dc = -k; dc <= k; dc += step) {
          const c = c0 + dc;
          if (c < 0 || c >= cols) continue;
          const cell = r * cols + c;
          for (let m = start[cell], me = start[cell + 1]; m < me; m++) {
            const i = items[m];
            const d = hyp(x - sx[i], y - sy[i]);
            if (d < best) best = d;
          }
          if (k === 0) break;
        }
      }
    }
    // Exactly zero at a site, and never a negative zero.
    return best === 0 ? 0 : -best;
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
 *
 * A field is a function of a point, and the algebra takes that literally:
 * it declines to walk a branch whose own reach proves it cannot change the
 * answer, and it answers a point it was just asked out of the last number
 * it worked out. Both give back the bits the full walk gives back, which
 * is what lets a sketch cut every new shape out of everything already
 * placed without paying for that history twice.
 */

const asField = (f: DistanceField, what: string): DistanceField => {
  if (typeof f !== 'function') throw new Error(`sdf.${what}: expected a distance field, a function of (x, y)`);
  return f;
};

// ---- support: what a field can still be worth, and where ---------------
//
// THE RULE THAT KEEPS LAW 3 AND LAW 5: a skip is allowed only when the
// value returned is bit-identical to the unskipped evaluation. Nothing
// below rounds, blends or approximates anything; it only declines to
// compute a number that provably cannot reach the result.
//
// A leaf knows where it lives. `circle(cx, cy, r)` is `r − |p − c|`, so
// outside a box grown by M its value is at most `r − M`: one subtraction
// says a whole subtree is irrelevant. Every field built by `sdf.*` out of
// such leaves carries that knowledge, hidden in a WeakMap the way
// `field.ts` hides a field's transform and domain bound — never a property
// on the function, which is a plain `(x, y) => number` and stays one.

/**
 * What a bounded field promises. `box` and `peak` are the composable part:
 * in exact arithmetic `f(p) ≤ peak − dist(p, box)` at every finite `p`, so
 * a parent can grow one box around its children and keep a valid ceiling.
 * `hi(x, y)` is the pointwise part: `f(x, y) ≤ hi(x, y)` in FLOATING POINT,
 * which is why `boxBound` widens by more than any rounding of the few
 * operations it makes — a bound may only ever be too loose.
 *
 * Two invariants every producer below maintains, and every skip leans on:
 *  - a bounded field is built ONLY from bounded children, so its whole
 *    subtree is this module's own arithmetic over finite leaves: it is a
 *    pure function of the point and it is FINITE at every finite point;
 *  - `hi` is finite only at a finite point (a box distance is otherwise
 *    infinite or NaN), which is how a skip knows the value it is not
 *    computing is finite.
 */
interface Support {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  peak: number;
  hi: DistanceField;
  /** `hi` IS the field — the same closure, so a caller may keep its answer
   * as the value. True only where the bound is the field's own formula. */
  tight: boolean;
}

const SUPPORT = new WeakMap<DistanceField, Support>();

/** Test-only: walk every branch, bound nothing, memoise nothing — the plain
 * tree of closures this module used to be. A test proves the fast path
 * returns the same bits by rendering both. Not exported from the package. */
let direct = false;
export function __sdfDirect(on: boolean): void {
  direct = on;
}

const supportOf = (f: DistanceField): Support | undefined => (direct ? undefined : SUPPORT.get(f));

const tagged = (f: DistanceField, s: Support): DistanceField => {
  SUPPORT.set(f, s);
  return f;
};

/** `peak − dist(p, box)`, widened. The widening is what makes the bound
 * safe under rounding: `Math.sqrt` and the subtraction are each good to an
 * ulp or so of the magnitudes involved, and this adds about 4500 of them,
 * so the returned number is never smaller than the exact bound. At a
 * non-finite point it is NaN, and NaN fails every skip test below. */
const boxBound = (x0: number, y0: number, x1: number, y1: number, peak: number): DistanceField => {
  const ap = Math.abs(peak);
  return (x, y) => {
    const dx = Math.max(x0 - x, x - x1, 0);
    const dy = Math.max(y0 - y, y - y1, 0);
    const d = Math.sqrt(dx * dx + dy * dy);
    return peak - d + ((ap + d) * 1e-12 + 1e-12);
  };
};

// ---- fusing: a pure subtree, written out as one function ---------------
//
// A field whose WHOLE subtree is this module's own arithmetic — the three
// leaves and the combinators over them, with no sketch lambda anywhere
// below — is a PURE TREE. A sample of it costs a call, a memo test and a
// bound test per node, and none of that is the arithmetic the sample is
// for. So the first time such a field is asked for a point it writes
// itself out as ONE JavaScript function with no calls in it but `Math.*`,
// and answers out of that function ever after.
//
// THE SAME RULE THE BOUNDS KEEP: the generated body performs exactly the
// operations the walk performs, in the same order, on the same operands.
// Every constant is READ from a captured `Float64Array` and never printed
// into the source, so no double makes a round trip through text. Sharing
// is by node identity: a field used twice under one root gets ONE local,
// which keeps the fused body linear in the nodes exactly as the memo keeps
// the walk linear.
//
// A node is reached here only by its own first sample, so an inner node of
// a fused tree is never called and never compiles; a node the sketch
// samples itself writes its own program, which may repeat a sibling's.
// If `new Function` is refused — a page whose policy forbids it — the walk
// of closures stands and nothing else in the module knows the difference.

/** What the compiler needs to write one node out, and whether it has been
 * written. A child is named by its own function: that is how the compiler
 * recognises a node it has already emitted, and how it refuses a subtree
 * that has a sketch lambda in it. */
type SdfNode = { fused: boolean } & (
  | { kind: 'const'; v: number }
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'box'; cx: number; cy: number; hw: number; hh: number }
  | { kind: 'segment'; ax: number; ay: number; dx: number; dy: number; len2: number; r: number }
  | { kind: 'union'; kids: readonly DistanceField[] }
  | { kind: 'intersect'; kids: readonly DistanceField[] }
  | { kind: 'subtract'; base: DistanceField; holes: readonly DistanceField[] }
  | { kind: 'blend'; a: DistanceField; b: DistanceField; rk: number; nk: number }
);

/** The map IS the purity test. A combinator records its node only when
 * every child already has one, so `NODE.has(f)` answers "this whole
 * subtree is ours" in one lookup, settled when the field is built rather
 * than walked when it is sampled. */
const NODE = new WeakMap<DistanceField, SdfNode>();
const allPure = (fs: readonly DistanceField[]): boolean => fs.every((f) => NODE.has(f));

/** Test-only: has this field compiled itself yet? Not exported from the
 * package — a sketch has no business knowing, and the answer is only ever
 * "the same numbers, sooner". */
export function __sdfFused(f: DistanceField): boolean {
  return NODE.get(f)?.fused === true;
}

/** The pure tree under `root` as one straight-line function of `(x, y)`,
 * or `null` if it cannot be written (no `new Function`). Constants ride in
 * on `C`. */
const compileNode = (root: SdfNode): DistanceField | null => {
  const consts: number[] = [];
  const body: string[] = [];
  const local = new Map<DistanceField, string>();
  let next = 0;
  /** A constant, by the slot it is read from. Template literals evaluate
   * left to right, so the slots line up with the text that names them. */
  const K = (v: number): string => `C[${consts.push(v) - 1}]`;
  const child = (f: DistanceField): string => {
    const had = local.get(f);
    if (had !== undefined) return had;
    const n = NODE.get(f);
    if (n === undefined) throw new Error('sdf: not a pure subtree');
    const name = emit(n);
    local.set(f, name);
    return name;
  };
  function emit(n: SdfNode): string {
    const v = `v${next++}`;
    switch (n.kind) {
      case 'const':
        body.push(`const ${v} = ${K(n.v)};`);
        break;
      case 'circle':
        body.push(`const ${v}a = x - ${K(n.cx)}, ${v}b = y - ${K(n.cy)};`);
        body.push(`const ${v} = ${K(n.r)} - Math.sqrt(${v}a * ${v}a + ${v}b * ${v}b);`);
        break;
      case 'box': {
        const dx = `${v}a`;
        const dy = `${v}b`;
        body.push(`const ${dx} = Math.abs(x - ${K(n.cx)}) - ${K(n.hw)};`);
        body.push(`const ${dy} = Math.abs(y - ${K(n.cy)}) - ${K(n.hh)};`);
        body.push(`const ${v}p = Math.max(${dx}, 0), ${v}q = Math.max(${dy}, 0);`);
        body.push(`const ${v} = -(Math.sqrt(${v}p * ${v}p + ${v}q * ${v}q) + Math.min(Math.max(${dx}, ${dy}), 0));`);
        break;
      }
      case 'segment': {
        const tt = `${v}t`;
        body.push(n.len2 > 0
          ? `const ${tt} = Math.max(0, Math.min(1, ((x - ${K(n.ax)}) * ${K(n.dx)} + (y - ${K(n.ay)}) * ${K(n.dy)}) / ${K(n.len2)}));`
          : `const ${tt} = 0;`);
        body.push(`const ${v}a = x - (${K(n.ax)} + ${K(n.dx)} * ${tt}), ${v}b = y - (${K(n.ay)} + ${K(n.dy)} * ${tt});`);
        body.push(`const ${v} = ${K(n.r)} - Math.sqrt(${v}a * ${v}a + ${v}b * ${v}b);`);
        break;
      }
      case 'union': {
        const ks = n.kids.map(child);
        body.push(`let ${v} = -Infinity;`);
        for (const c of ks) body.push(`${v} = Math.max(${v}, ${c});`);
        break;
      }
      case 'intersect': {
        const ks = n.kids.map(child);
        body.push(`let ${v} = Infinity;`);
        for (const c of ks) body.push(`${v} = Math.min(${v}, ${c});`);
        break;
      }
      case 'subtract': {
        const b = child(n.base);
        const hs = n.holes.map(child);
        body.push(`let ${v} = ${b};`);
        for (const c of hs) body.push(`${v} = Math.min(${v}, -${c});`);
        break;
      }
      case 'blend': {
        const a = child(n.a);
        const b = child(n.b);
        const rk = K(n.rk);
        const nk = K(n.nk);
        body.push(`let ${v};`);
        body.push(`if (!Number.isFinite(${a}) || !Number.isFinite(${b})) ${v} = Math.max(${a}, ${b});`);
        body.push(`else { const ${v}p = Math.max(${rk} + ${a}, 0), ${v}q = Math.max(${rk} + ${b}, 0); ${v} = Math.min(${nk}, Math.max(${a}, ${b})) + Math.sqrt(${v}p * ${v}p + ${v}q * ${v}q); }`);
        break;
      }
    }
    return v;
  }
  try {
    const out = emit(root);
    const make = new Function('C', `"use strict"; return function (x, y) {\n${body.join('\n')}\nreturn ${out};\n};`) as (c: Float64Array) => DistanceField;
    return make(Float64Array.from(consts));
  } catch {
    return null;
  }
};

/**
 * One slot of memory in front of a combinator: the same point asked twice
 * in a row answers with the bits it answered the first time. A field IS a
 * function of a point — that is what `DistanceField` means and what this
 * module documents — so the second answer was going to be those bits
 * anyway.
 *
 * It is not a micro-optimisation. A sketch that cuts each new shape out of
 * everything already placed (`taken = union(taken, subtract(next, taken))`)
 * builds a DAG, and walking it as a tree costs 2^n: the same node is asked
 * for the same point once per path that reaches it. The memo makes the walk
 * linear in the nodes again.
 *
 * ±0 is kept apart from +0 on purpose: `1 / x` only runs when `x` is a
 * zero, so the strictness is free.
 *
 * This is the one line here that rests on the CONTRACT rather than on the
 * arithmetic: a "field" that answers the same point with a different number
 * each time — one that draws from the seed per call — would see its first
 * answer twice. Such a thing is not a field, and nothing in the library
 * makes one; every `sdf.*` leaf is arithmetic on the point alone.
 */
const memo1 = (sample: DistanceField, node?: SdfNode): DistanceField => {
  if (direct) return sample;
  // The slot is a Float64Array and not three closure variables on purpose:
  // a double written to a closure variable is boxed on the heap, and this
  // one is written once per sample per node. Measured on a 50-deep blend
  // chain, the boxed spelling costs more than the walk it saves.
  const slot = new Float64Array(3);
  slot[0] = NaN;
  slot[1] = NaN;
  // The walk, until the first sample swaps in the fused program. It is
  // swapped here rather than behind another closure so that a fused field
  // costs one call and one slot test, not two calls.
  let ask = sample;
  let toWrite = node !== undefined;
  return (x, y) => {
    if (x === slot[0] && y === slot[1] && (x !== 0 || 1 / x === 1 / slot[0]) && (y !== 0 || 1 / y === 1 / slot[1])) {
      return slot[2];
    }
    if (toWrite) {
      toWrite = false;
      const prog = compileNode(node as SdfNode);
      if (prog !== null) {
        ask = prog;
        (node as SdfNode).fused = true;
      }
    }
    const v = ask(x, y);
    slot[0] = x;
    slot[1] = y;
    slot[2] = v;
    return v;
  };
};

/** What a combinator hands back: the walk behind one slot of memory, the
 * fused program in its place once the first sample has written it, and —
 * when the whole subtree is ours — the node recorded under the function,
 * which is what lets a PARENT fuse straight through this one. */
const combined = (sample: DistanceField, node: SdfNode | undefined): DistanceField => {
  if (direct || node === undefined) return memo1(sample);
  const out = memo1(sample, node);
  NODE.set(out, node);
  return out;
};

/** The children's supports, or undefined the moment one child has none:
 * a field is bounded only when its WHOLE subtree is (see `Support`). */
const allSupport = (fs: readonly DistanceField[]): Support[] | undefined => {
  const out: Support[] = [];
  for (const f of fs) {
    const s = supportOf(f);
    if (s === undefined) return undefined;
    out.push(s);
  }
  return out;
};

/** The box around every child's box, and the highest ceiling among them. */
const spanOf = (ss: readonly Support[]): { x0: number; y0: number; x1: number; y1: number; peak: number } => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, peak = -Infinity;
  for (const s of ss) {
    if (s.x0 < x0) x0 = s.x0;
    if (s.y0 < y0) y0 = s.y0;
    if (s.x1 > x1) x1 = s.x1;
    if (s.y1 > y1) y1 = s.y1;
    if (s.peak > peak) peak = s.peak;
  }
  return { x0, y0, x1, y1, peak };
};

/** Nothing to combine is not a mistake: it is the identity. `distanceTo`
 * already returns a field that is nowhere inside for an empty boundary,
 * "so isolines over an empty field yields no contours rather than
 * throwing" — a computed list that came out empty must behave the same. */
const many = (fields: readonly unknown[], what: string): DistanceField[] => fields.map((f) => asField(f as DistanceField, what));

/**
 * ONE array of fields, or the fields themselves — never both.
 *
 * A chain of these reads better as the list it is (`union(discs)`) than as
 * a spread or a fold, and the list is the same fold in the same order, so
 * it is the same bits. Two spellings of one meaning is the price. A MIX of
 * them (`union([a, b], c)`) is not a third spelling, it is a mistake, and
 * it is refused here by name rather than quietly read as one of the two.
 */
const oneList = (args: readonly unknown[], what: string): readonly unknown[] => {
  if (!args.some((a) => Array.isArray(a))) return args;
  if (args.length !== 1) throw new Error(`sdf.${what}: pass one array of fields, or the fields themselves — not both`);
  return args[0] as readonly unknown[];
};

/** Nowhere inside — the identity of a union, and an empty drawing. */
const nowhere: DistanceField = () => -Infinity;
/** Everywhere inside — the identity of an intersection. */
const everywhere: DistanceField = () => Infinity;
// Both identities are this module's own arithmetic, so a parent may fuse
// through one. They are private singletons; nothing else can be handed in.
NODE.set(nowhere, { fused: false, kind: 'const', v: -Infinity });
NODE.set(everywhere, { fused: false, kind: 'const', v: Infinity });

/**
 * The `sdf` words take drawable units. A field is a function the sketch
 * calls itself — a shader reads `body(p[0], p[1])` — so it holds no paper to
 * read `mm(4)` against, and a tagged length would read as NaN everywhere.
 * Refuse it by name and say the door: `t.len` lowers a length in the run.
 */
const units = (word: string, ...args: unknown[]): void => {
  for (const v of args) {
    if (v instanceof Len) {
      throw new Error(`sdf.${word}: a length like mm(${v.value}) needs the paper, and a field has none — its arguments are drawable units; give t.len(mm(${v.value}))`);
    }
  }
};

/** A disc of radius `r` about `cx, cy` — spelled like `circle(x, y, r)`.
 * Exact. */
const circleField = (cx: number, cy: number, r: number): DistanceField => {
  units('circle', cx, cy, r);
  const f: DistanceField = (x, y) => r - hyp(x - cx, y - cy);
  NODE.set(f, { fused: false, kind: 'circle', cx, cy, r });
  // The disc's own formula IS `peak − dist(p, box)` for the degenerate box
  // at its centre, so the bound is the value: `tight`. Nothing to bound
  // when a parameter is not a number the arithmetic can hold.
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r)) return f;
  return tagged(f, { x0: cx, y0: cy, x1: cx, y1: cy, peak: r, hi: f, tight: true });
};

/**
 * An axis-aligned box, `w` by `h`, CENTRED on `cx, cy`. Exact inside and
 * out, including the rounded distance past a corner.
 *
 * It is `box` and not `rect` on purpose. `rect(x, y, w, h)` anchors by the
 * sketch's own rect mode, and a pure field function cannot read that, so
 * one name with two anchors would be a trap. A box is centred, always.
 */
const boxField = (cx: number, cy: number, w: number, h: number): DistanceField => {
  units('box', cx, cy, w, h);
  const hw = Math.abs(w) / 2;
  const hh = Math.abs(h) / 2;
  const f: DistanceField = (x, y) => {
    const dx = Math.abs(x - cx) - hw;
    const dy = Math.abs(y - cy) - hh;
    // Outside: distance to the nearest corner or edge. Inside: the nearest
    // edge, which is the larger (least negative) of the two.
    const outside = hyp(Math.max(dx, 0), Math.max(dy, 0));
    return -(outside + Math.min(Math.max(dx, dy), 0));
  };
  NODE.set(f, { fused: false, kind: 'box', cx, cy, hw, hh });
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(hw) || !Number.isFinite(hh)) return f;
  // Deepest inside the box is half its short side; outside it is exactly
  // minus the distance to the box, so `peak − dist` holds on both sides.
  const x0 = cx - hw, y0 = cy - hh, x1 = cx + hw, y1 = cy + hh;
  const peak = Math.min(hw, hh);
  return tagged(f, { x0, y0, x1, y1, peak, hi: boxBound(x0, y0, x1, y1, peak), tight: false });
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
  units('segment', x0, y0, x1, y1, r);
  const ax = x0;
  const ay = y0;
  const dx = x1 - ax;
  const dy = y1 - ay;
  const len2 = dx * dx + dy * dy;
  const f: DistanceField = (x, y) => {
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    return r - hyp(x - (ax + dx * t), y - (ay + dy * t));
  };
  NODE.set(f, { fused: false, kind: 'segment', ax, ay, dx, dy, len2, r });
  if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(r)) return f;
  // A point is at least as far from the segment as from its bounding box,
  // so `r − dist(p, box)` is a ceiling on `r − dist(p, segment)`.
  const bx0 = Math.min(x0, x1), by0 = Math.min(y0, y1);
  const bx1 = Math.max(x0, x1), by1 = Math.max(y0, y1);
  return tagged(f, { x0: bx0, y0: by0, x1: bx1, y1: by1, peak: r, hi: boxBound(bx0, by0, bx1, by1, r), tight: false });
};

/**
 * Inside wherever any of them is inside — a maximum. Takes one array of
 * fields as well as the fields themselves: `union(discs)` is `union(...discs)`,
 * the same fold over the same list, so it is the same bits.
 *
 * SKIP: child `i` is left unevaluated when `hi_i(p) < best`, the largest
 * value a sibling has already returned. Its value is at most `hi_i`, so
 * `Math.max(best, value)` is `best` — the same bits, not a near-enough
 * number. The comparison is strict, so a child that could TIE the running
 * best is still evaluated, which is what keeps a `-0` answer a `-0`.
 * Children keep their written order, and `best` starts at -Infinity, so the
 * first child is never skipped and a NaN from any child still poisons the
 * maximum exactly as `Math.max` does.
 */
function unionField(fields: readonly DistanceField[]): DistanceField;
function unionField(...fields: DistanceField[]): DistanceField;
function unionField(...args: Array<DistanceField | readonly DistanceField[]>): DistanceField {
  const fs = many(oneList(args, 'union'), 'union');
  if (fs.length === 0) return nowhere;
  if (fs.length === 1) return fs[0];
  const n = fs.length;
  const sup = direct ? [] : fs.map((f) => SUPPORT.get(f));
  const plain = sup.every((s) => s === undefined);
  const out = combined(plain
    ? (x, y) => {
      let best = -Infinity;
      for (const f of fs) best = Math.max(best, f(x, y));
      return best;
    }
    : (x, y) => {
      let best = -Infinity;
      for (let i = 0; i < n; i++) {
        const s = sup[i];
        if (s === undefined) {
          best = Math.max(best, fs[i](x, y));
          continue;
        }
        const hi = s.hi(x, y);
        if (hi < best) continue;
        best = Math.max(best, s.tight ? hi : fs[i](x, y));
      }
      return best;
    }, allPure(fs) ? { fused: false, kind: 'union', kids: fs } : undefined);
  const ss = allSupport(fs);
  if (ss === undefined) return out;
  // Every child is under one box, and none of them reaches higher than the
  // highest ceiling: `max_i (peak_i − dist(p, box_i)) ≤ peak − dist(p, box)`
  // because the joint box is the closest of them all.
  const { x0, y0, x1, y1, peak } = spanOf(ss);
  return tagged(out, { x0, y0, x1, y1, peak, hi: boxBound(x0, y0, x1, y1, peak), tight: false });
}

/**
 * Inside only where all of them are inside — a minimum. One array of
 * fields or the fields themselves, like `union`.
 *
 * NO SKIP. A support bound is a CEILING, and a minimum is decided from
 * below: knowing a child cannot exceed some value never proves it is not
 * the smallest. Skipping here would need a floor, which a field that may
 * dive arbitrarily deep inside a shape does not have. It still carries a
 * bound upward for its parents — the intersection is at most any one of
 * its children.
 */
function intersectField(fields: readonly DistanceField[]): DistanceField;
function intersectField(...fields: DistanceField[]): DistanceField;
function intersectField(...args: Array<DistanceField | readonly DistanceField[]>): DistanceField {
  const fs = many(oneList(args, 'intersect'), 'intersect');
  if (fs.length === 0) return everywhere;
  if (fs.length === 1) return fs[0];
  const out = combined((x, y) => {
    let best = Infinity;
    for (const f of fs) best = Math.min(best, f(x, y));
    return best;
  }, allPure(fs) ? { fused: false, kind: 'intersect', kids: fs } : undefined);
  const ss = allSupport(fs);
  if (ss === undefined) return out;
  const s = ss[0];
  return tagged(out, { x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, peak: s.peak, hi: s.hi, tight: false });
}

/**
 * `a` with every later field cut out of it. The holes are one array or a
 * list of arguments, like `union`.
 *
 * SKIP: hole `i` is left unevaluated when `hi_i(p) < -best`, where `best`
 * is the value the base and the earlier holes have already settled on. The
 * hole contributes `-f_i`, and `f_i ≤ hi_i < -best` gives `-f_i > best`, so
 * `Math.min(best, -f_i)` is `best` — the same bits. Strict again: a hole
 * that could tie is evaluated, and a NaN anywhere still wins the minimum.
 */
function subtractField(a: DistanceField, holes: readonly DistanceField[]): DistanceField;
function subtractField(a: DistanceField, ...holes: DistanceField[]): DistanceField;
function subtractField(a: DistanceField, ...args: Array<DistanceField | readonly DistanceField[]>): DistanceField {
  const base = asField(a, 'subtract');
  const fs = many(oneList(args, 'subtract'), 'subtract');
  if (fs.length === 0) return base;
  const n = fs.length;
  const sup = direct ? [] : fs.map((f) => SUPPORT.get(f));
  const plain = sup.every((s) => s === undefined);
  const out = combined(plain
    ? (x, y) => {
      let best = base(x, y);
      for (const f of fs) best = Math.min(best, -f(x, y));
      return best;
    }
    : (x, y) => {
      let best = base(x, y);
      for (let i = 0; i < n; i++) {
        const s = sup[i];
        if (s === undefined) {
          best = Math.min(best, -fs[i](x, y));
          continue;
        }
        const hi = s.hi(x, y);
        if (hi < -best) continue;
        best = Math.min(best, -(s.tight ? hi : fs[i](x, y)));
      }
      return best;
    }, NODE.has(base) && allPure(fs) ? { fused: false, kind: 'subtract', base, holes: fs } : undefined);
  const sb = supportOf(base);
  if (sb === undefined || allSupport(fs) === undefined) return out;
  // Cutting only removes material: the result is at most the base.
  return tagged(out, { x0: sb.x0, y0: sb.y0, x1: sb.x1, y1: sb.y1, peak: sb.peak, hi: sb.hi, tight: false });
}

/**
 * A union with a fillet of `radius` where the two meet. Away from the
 * joint it is exactly the union. Within `radius` of it the corner becomes
 * an arc, so the blended shape is a little larger there than the union —
 * a fillet adds material, and this one adds it only where it belongs.
 *
 * A whole list of fields blends at one radius: `blend(discs, r)` is the
 * left fold of the pair form over the list, which is what a sketch used to
 * spell with `reduce`. It is the same fold in the same order, so it is the
 * same bits. An empty list is nowhere — the union's identity — and one
 * field is itself. The radius stays last, so the list form is NOT variadic:
 * `blend(a, b, c, r)` would read as a mode chosen by counting arguments.
 */
function blendField(fields: readonly DistanceField[], radius: number): DistanceField;
function blendField(a: DistanceField, b: DistanceField, radius: number): DistanceField;
function blendField(a: DistanceField | readonly DistanceField[], b: DistanceField | number, radius?: number): DistanceField {
  units('blend', b, radius);
  if (Array.isArray(a)) {
    if (radius !== undefined) throw new Error('sdf.blend: pass one array of fields and the radius, or two fields and the radius — not both');
    const fs = many(a as readonly DistanceField[], 'blend');
    const r = b as number;
    if (fs.length === 0) return nowhere;
    let acc = fs[0];
    for (let i = 1; i < fs.length; i++) acc = blendField(acc, fs[i], r);
    return acc;
  }
  const fa = asField(a as DistanceField, 'blend');
  const fb = asField(b as DistanceField, 'blend');
  const k = Math.abs(radius as number);
  if (!(k > 0) || !Number.isFinite(k)) return unionField(fa, fb);
  const nk = -k;
  const join = (u: number, v: number): number => {
    // An empty field is -Infinity by design. Blending with one gives the
    // other, rather than NaN everywhere.
    if (!Number.isFinite(u) || !Number.isFinite(v)) return Math.max(u, v);
    // A ROUNDED union: a quarter circle of radius k across the joint. The
    // obvious polynomial smooth maximum is wrong for this job — its bump
    // is added wherever the two fields are within k of EACH OTHER, which
    // on the locus equidistant from both is true out to infinity, so the
    // whole shape grows by k/4 and never stops. This form is exactly the
    // union wherever the joint is further than k away.
    return Math.min(nk, Math.max(u, v)) + hyp(Math.max(k + u, 0), Math.max(k + v, 0));
  };
  const sa = supportOf(fa);
  const sb = supportOf(fb);
  // SKIP: one side may be dropped only where the formula has ALREADY
  // collapsed onto the other. Both `Math.max(·, 0)` terms above clamp to
  // exactly +0 once a value is at or below -k, so a side proved to be
  // there contributes nothing but a zero the other side's expression can
  // be written with directly. The skip below therefore does not return
  // "the other value": it evaluates the SAME expression with the same
  // arguments, one of them the +0 the clamp would have produced — the
  // same bits, `hyp` and all.
  //
  // Two conditions, both needed. A side is under the fillet when the
  // sample is at least `peak + k` from its box, since `f ≤ peak − dist`;
  // that is a comparison of SQUARED distances against a limit worked out
  // once here, so the test costs no square root and no call. The limit is
  // widened by far more than the rounding of the four operations that
  // reach it, and a wider limit can only refuse a skip. The kept side must
  // then be at or above -k, or the dropped side could be the larger of the
  // two and `Math.max` would answer with it. A non-finite sample makes the
  // squared distance infinite or NaN, and both fail the test, which is how
  // a skip knows the value it is not computing is finite.
  const loosen = (v: number): number => v * (1 + 1e-12) + 1e-12;
  const limit2 = (s: Support | undefined): number => {
    if (s === undefined) return NaN;
    const lim = loosen(s.peak + k);
    return lim > 0 ? lim * lim : 0;
  };
  const ax0 = sa?.x0 ?? 0, ay0 = sa?.y0 ?? 0, ax1 = sa?.x1 ?? 0, ay1 = sa?.y1 ?? 0;
  const bx0 = sb?.x0 ?? 0, by0 = sb?.y0 ?? 0, bx1 = sb?.x1 ?? 0, by1 = sb?.y1 ?? 0;
  const aPeak = sa?.peak ?? 0, bPeak = sb?.peak ?? 0;
  const aLim2 = limit2(sa);
  const bLim2 = limit2(sb);
  /** `peak − √d2`, widened the way `boxBound` widens it — from a squared
   * distance the test has already worked out. */
  const above = (peak: number, d2: number): number => {
    const d = Math.sqrt(d2);
    return peak - d + ((Math.abs(peak) + d) * 1e-12 + 1e-12);
  };
  const out = combined((x, y) => {
    if (sa !== undefined) {
      const dx = x < ax0 ? ax0 - x : x > ax1 ? x - ax1 : 0;
      const dy = y < ay0 ? ay0 - y : y > ay1 ? y - ay1 : 0;
      const d2 = dx * dx + dy * dy;
      if (d2 >= aLim2 && d2 !== Infinity) {
        const v = fb(x, y);
        // The kept side is the larger when it is at or above -k. Further
        // out than that BOTH sides are under the fillet, and which of them
        // `Math.max` would have answered with is the one question the box
        // test cannot settle: there the bound's own value decides it, at
        // the price of the square root the fast test avoided.
        if (Number.isFinite(v) && (v >= nk || v >= above(aPeak, d2))) {
          return Math.min(nk, v) + hyp(0, Math.max(k + v, 0));
        }
        return join(fa(x, y), v);
      }
    }
    const u = fa(x, y);
    if (sb !== undefined && Number.isFinite(u)) {
      const dx = x < bx0 ? bx0 - x : x > bx1 ? x - bx1 : 0;
      const dy = y < by0 ? by0 - y : y > by1 ? y - by1 : 0;
      const d2 = dx * dx + dy * dy;
      if (d2 >= bLim2 && d2 !== Infinity && (u >= nk || u >= above(bPeak, d2))) {
        return Math.min(nk, u) + hyp(Math.max(k + u, 0), 0);
      }
    }
    return join(u, fb(x, y));
  }, NODE.has(fa) && NODE.has(fb) ? { fused: false, kind: 'blend', a: fa, b: fb, rk: k, nk } : undefined);
  if (sa === undefined || sb === undefined) return out;
  // A fillet adds material, so the union's ceiling is not enough. Where
  // the formula is the union it is `max(u, v) ≤ P − d`; where it is not,
  // both clamps are under `k + m` with `m = max(u, v) ≥ -k`, so the whole
  // is at most `-k + √2·(k + m)`, and `1.5·max(P, 0) + k` covers that for
  // every `d ≥ 0` with room to spare.
  const { x0, y0, x1, y1, peak: P } = spanOf([sa, sb]);
  const peak = Math.max(P, 1.5 * Math.max(P, 0) + k);
  return tagged(out, { x0, y0, x1, y1, peak, hi: boxBound(x0, y0, x1, y1, peak), tight: false });
}

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
