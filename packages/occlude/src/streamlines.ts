/**
 * Vector field → evenly spaced streamlines: the bridge from vector fields to
 * stampable geometry, the twin of `isolines` for flow. Jobard & Lefer
 * (1997, *Creating Evenly-Spaced Streamlines of Arbitrary Density*):
 * integrate a line from a seed both ways until it leaves the domain or comes
 * within half the local spacing of ink already laid, then queue new seeds
 * one spacing to either side of every point on it. Ideas from the paper
 * only, no code.
 *
 * The field may be ORIENTED (`vectorField`) or an AXIS (`axisField`): an
 * axis has no front, so a line keeps the sign it started in and crosses a
 * place where the formula changes sign without breaking. An oriented field
 * traces exactly as before.
 *
 * Spacing may be a scalar FIELD: where it is small lines crowd, where it is
 * large they thin — density is tone, the direction is the flow. A floor
 * keeps a zero-spacing request from asking for infinite ink.
 *
 * Returns plain `{ pts, closed: false }` contours, exactly what `isolines`
 * returns, so `trace(c)` stamps them and nothing new enters the tree.
 * Non-finite field samples are ABSENT (a `within()` bound or a NaN hole):
 * lines stop there as they do at the paper edge. Deterministic: no
 * randomness, a pure function of the fields and options; seeds are
 * processed in queue order.
 */

import { isAxisField } from './field.js';
import { usableLength } from './guard.js';
import type { IsoContour, IsoEnv } from './isolines.js';
import type { VectorFieldFn } from './shapes.js';
import { mm, type L } from './units.js';

/** A field of lengths: user units, or `mm(...)` per sample. */
export type LengthField = (x: number, y: number) => L;

export interface StreamOpts {
  /** Separation between neighbouring lines: a length, or a field of lengths
   * (`(x, y) => mm(0.5 + 3 * lum)` — density as tone). Default mm(1). */
  spacing?: L | LengthField;
  /** Floor for a spacing field, in user units or a length (default
   * mm(0.3) — the nib: tighter than that is solid ink anyway). */
  minSpacing?: L;
  /** Integration step (default: a quarter of the smallest spacing). */
  step?: L;
  /** Starting seeds in user units. Default: a coarse lattice over the
   * drawable, so a field that is still or absent at any one point (a swirl's
   * centre, a hole) still gets its lines. */
  seeds?: [number, number][];
  /** Longest run each way from the seed, in user units, or a field of
   * lengths read AT THE SEED — one length per line, so a line is long where
   * it starts long. Default: 8× the drawable's long side. A seed
   * whose length is zero, absent, or below a nib width draws nothing: at
   * that size the pen makes a dot, and the field says where the marks
   * shorten into dots. */
  maxLength?: L | LengthField;
}

/** Separation grid: `head[cell]` is the newest point stored in that cell and
 * `before[i]` the one stored before it, -1 terminating — an intrusive linked
 * list over two Int32Arrays, the shape `scatter`'s neighbour grid already
 * uses. A `Map<number, number[]>` made every cell probe a hash lookup and a
 * pointer chase into a separate array, and a separation test probes
 * (2r+1)² cells, nearly all of them empty. */
interface Grid {
  cell: number;
  ox: number;
  oy: number;
  cols: number;
  rows: number;
  head: Int32Array;
  before: Int32Array;
  /** Points stored so far — the index the next one will take. */
  n: number;
  px: Float64Array;
  py: Float64Array;
}

function gridKey(g: Grid, x: number, y: number): number | null {
  const cx = Math.floor((x - g.ox) / g.cell);
  const cy = Math.floor((y - g.oy) / g.cell);
  if (cx < 0 || cy < 0 || cx >= g.cols || cy >= g.rows) return null;
  return cy * g.cols + cx;
}

function gridAdd(g: Grid, x: number, y: number): void {
  const k = gridKey(g, x, y);
  if (k === null) return; // outside the grid: never stored, never numbered
  if (g.n === g.px.length) {
    const cap = g.n * 2;
    const nx = new Float64Array(cap); nx.set(g.px); g.px = nx;
    const ny = new Float64Array(cap); ny.set(g.py); g.py = ny;
    const nb = new Int32Array(cap); nb.set(g.before); g.before = nb;
  }
  const i = g.n++;
  g.px[i] = x;
  g.py[i] = y;
  g.before[i] = g.head[k];
  g.head[k] = i;
}

/** Is any stored point within `d` of (x, y)? `skipFrom` ignores the most
 * recent points (the line being drawn must not collide with itself).
 * A pure any-hit predicate that returns on the first one, so the order the
 * cells and their chains are walked in cannot change the answer. */
function gridNear(g: Grid, x: number, y: number, d: number, skipFrom: number): boolean {
  const r = Math.ceil(d / g.cell);
  const cx = Math.floor((x - g.ox) / g.cell);
  const cy = Math.floor((y - g.oy) / g.cell);
  const d2 = d * d;
  const j0 = Math.max(0, cy - r);
  const j1 = Math.min(g.rows - 1, cy + r);
  const i0 = Math.max(0, cx - r);
  const i1 = Math.min(g.cols - 1, cx + r);
  const { head, before, px, py, cols } = g;
  for (let j = j0; j <= j1; j++) {
    const row = j * cols;
    for (let i = i0; i <= i1; i++) {
      for (let p = head[row + i]; p >= 0; p = before[p]) {
        if (p >= skipFrom) continue;
        const dx = px[p] - x;
        const dy = py[p] - y;
        if (dx * dx + dy * dy < d2) return true;
      }
    }
  }
  return false;
}

export function streamlinesOf(env: IsoEnv, field: VectorFieldFn, opts: StreamOpts = {}): IsoContour[] {
  const b = env.bounds;
  // A step, a minimum spacing or a fixed spacing that is not a positive
  // length leaves nothing to trace.
  if (!usableLength(opts.step) || !usableLength(opts.minSpacing)) return [];
  if (typeof opts.spacing !== 'function' && !usableLength(opts.spacing)) return [];
  const floorU = env.len(opts.minSpacing ?? mm(0.3));
  const spacingAt: (x: number, y: number) => number = (() => {
    const s = opts.spacing;
    if (typeof s === 'function') return (x, y) => {
      const raw = s(x, y);
      const v = typeof raw === 'number' ? raw : Number.isFinite(raw?.value) ? env.len(raw) : NaN;
      return Number.isFinite(v) ? Math.max(floorU, v) : NaN;
    };
    const fixed = Math.max(floorU, env.len(s ?? mm(1)));
    return () => fixed;
  })();
  // The grid's cell is the smallest spacing that can occur, so a separation
  // test never has to look further than ceil(spacing / cell) cells.
  const cellU = typeof opts.spacing === 'function' ? floorU : spacingAt(0, 0);
  const stepU = opts.step !== undefined ? env.len(opts.step) : cellU / 4;
  // The longest line is read AT THE SEED, so one seed grows one length. A
  // nib width is the floor: a line shorter than the pen's own mark is the
  // dot the pen would leave, and the seed is dropped instead.
  const nibU = env.len(mm(0.3));
  const maxLenAt: (x: number, y: number) => number = (() => {
    const l = opts.maxLength;
    if (typeof l === 'function') return (x, y) => {
      const raw = l(x, y);
      const v = typeof raw === 'number' ? raw : Number.isFinite(raw?.value) ? env.len(raw) : NaN;
      return Number.isFinite(v) ? v : 0;
    };
    const fixed = l !== undefined ? env.len(l) : 8 * Math.max(b.w, b.h);
    return () => fixed;
  })();
  const cols = Math.max(1, Math.ceil(b.w / cellU) + 1);
  const rows = Math.max(1, Math.ceil(b.h / cellU) + 1);
  // A separation grid of no finite size has no cells to seed; one too fine
  // to hold is a resource guard and still names itself.
  if (!Number.isFinite(cols * rows)) return [];
  if (cols * rows > 1 << 24) {
    throw new Error(`streamlines: separation grid is ${cols}×${rows} — spacing too small for this drawable`);
  }
  const grid: Grid = {
    cell: cellU, ox: b.x, oy: b.y, cols, rows,
    head: new Int32Array(cols * rows).fill(-1),
    before: new Int32Array(1024).fill(-1),
    n: 0,
    px: new Float64Array(1024),
    py: new Float64Array(1024),
  };

  const inside = (x: number, y: number): boolean =>
    x >= b.x && y >= b.y && x <= b.x + b.w && y <= b.y + b.h;
  // An axis field's sign says nothing (`axisField`), so the tracer picks the
  // one that agrees with the step before it. An oriented field never flips:
  // it traces exactly as it always has.
  const axis = isAxisField(field);
  /** Unit direction of the field, or null where it is absent or still. For
   * an axis field, turned to agree with `prev` (the direction the line
   * arrived in) — the sign it is walked in belongs to the line, not to the
   * field. A seed has no `prev`: the field's raw sign goes forward, and the
   * backward half-line is its opposite. */
  const dir = (x: number, y: number, prev: [number, number] | null = null): [number, number] | null => {
    const v = field(x, y);
    if (!v) return null;
    const [dx, dy] = v;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    const m = Math.hypot(dx, dy);
    if (m < 1e-12) return null;
    const ux = dx / m;
    const uy = dy / m;
    if (axis && prev && ux * prev[0] + uy * prev[1] < 0) return [-ux, -uy];
    return [ux, uy];
  };
  /** One RK4 step of length `h` along the unit field (sign = direction),
   * with the direction it left in — what the next step agrees with. */
  const rk4 = (
    x: number, y: number, h: number, prev: [number, number] | null,
  ): { to: [number, number]; dir: [number, number] } | null => {
    const k1 = dir(x, y, prev);
    if (!k1) return null;
    const k2 = dir(x + (h / 2) * k1[0], y + (h / 2) * k1[1]);
    if (!k2) return null;
    const k3 = dir(x + (h / 2) * k2[0], y + (h / 2) * k2[1]);
    if (!k3) return null;
    const k4 = dir(x + h * k3[0], y + h * k3[1]);
    if (!k4) return null;
    // Keep the two half-lines consistent in orientation: flip any sample
    // whose direction opposes k1 (fields from gradients of images flip sign
    // across ridges; a line should not reverse mid-step).
    const al = (k: [number, number]): [number, number] =>
      k[0] * k1[0] + k[1] * k1[1] < 0 ? [-k[0], -k[1]] : k;
    const a2 = al(k2);
    const a3 = al(k3);
    const a4 = al(k4);
    return {
      to: [
        x + (h / 6) * (k1[0] + 2 * a2[0] + 2 * a3[0] + a4[0]),
        y + (h / 6) * (k1[1] + 2 * a2[1] + 2 * a3[1] + a4[1]),
      ],
      dir: k1,
    };
  };

  /** Trace one half-line from (x0, y0), returning its points (excluding the
   * seed). Stops at the domain edge, at absence, at a standstill, when it
   * comes within half the local spacing of other ink, or at maxSteps. */
  const half = (x0: number, y0: number, sign: number, skipFrom: number, maxSteps: number): [number, number][] => {
    const out: [number, number][] = [];
    let x = x0;
    let y = y0;
    let prev: [number, number] | null = null;
    for (let i = 0; i < maxSteps; i++) {
      const next = rk4(x, y, sign * stepU, prev);
      if (!next) break;
      const [nx, ny] = next.to;
      if (!inside(nx, ny)) break;
      const sp = spacingAt(nx, ny);
      if (!Number.isFinite(sp)) break;
      // Self-collision. The own line's recent points are never a collision
      // (a line may curve gently), and for the first K steps of a half-line
      // the WHOLE own line is ignored — the other half's first points sit
      // right beside the seed. Past K steps only the last K own points are
      // skipped, so a line closing on itself stops like any other.
      const K = Math.ceil((sp / stepU) * 1.5);
      const ownSkip = i < K ? skipFrom : Math.max(skipFrom, grid.n - K);
      if (gridNear(grid, nx, ny, sp * 0.5, ownSkip)) break;
      out.push([nx, ny]);
      gridAdd(grid, nx, ny);
      x = nx;
      y = ny;
      prev = next.dir;
    }
    return out;
  };

  const lines: IsoContour[] = [];
  // Seeds are processed in order; each finished line queues its own, so a
  // single good seed floods a connected domain. The lattice only has to
  // reach every disconnected piece and avoid a still point.
  const lattice = (): [number, number][] => {
    const n = 5;
    const out: [number, number][] = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        out.push([b.x + ((i + 0.5) * b.w) / n, b.y + ((j + 0.5) * b.h) / n]);
      }
    }
    return out;
  };
  const queue: [number, number][] = opts.seeds ? [...opts.seeds] : lattice();
  let head = 0;
  while (head < queue.length) {
    const [sx, sy] = queue[head++];
    if (!inside(sx, sy)) continue;
    const sp0 = spacingAt(sx, sy);
    if (!Number.isFinite(sp0) || !dir(sx, sy)) continue;
    // Nothing to grow: this seed is where the field asks for no line at all.
    const maxLenU = maxLenAt(sx, sy);
    if (!(maxLenU >= nibU)) continue;
    const maxSteps = Math.max(2, Math.ceil(maxLenU / stepU));
    // A seed too close to existing ink (within the full spacing) is dropped:
    // seeds are spawned AT one spacing, so anything nearer is a duplicate.
    if (gridNear(grid, sx, sy, sp0 * 0.9, Infinity)) continue;
    const mark = grid.n;
    gridAdd(grid, sx, sy);
    const fwd = half(sx, sy, 1, mark, maxSteps);
    const back = half(sx, sy, -1, mark, maxSteps);
    const pts: [number, number][] = [...back.reverse(), [sx, sy], ...fwd];
    if (pts.length < 2) continue;
    lines.push({ pts, closed: false });
    // New seeds: one local spacing to either side, at roughly every half
    // spacing along the line (denser candidates than the paper's one per
    // point would only add rejected duplicates).
    let since = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = pts[i];
      if (i > 0) since += Math.hypot(x - pts[i - 1][0], y - pts[i - 1][1]);
      const sp = spacingAt(x, y);
      if (!Number.isFinite(sp)) continue;
      if (since < sp * 0.5) continue;
      since = 0;
      const d = dir(x, y);
      if (!d) continue;
      queue.push([x - d[1] * sp, y + d[0] * sp], [x + d[1] * sp, y - d[0] * sp]);
    }
  }
  return lines;
}
