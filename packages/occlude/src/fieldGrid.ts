/**
 * Engine field grids: one raster per (unbounded field, kind), shared by
 * every use of that field, at the pitch the tightest use needs. This is
 * the planning — bounds from the uses' pulled-back footprints, pitch,
 * lattice origin, the read window a paper-aligned grid is clipped to —
 * and the evaluation, sampling the sketch's own field function on that
 * lattice. The per-use transform and domain refs stay outside the grid
 * (render.ts registers uses; this module only reads them and assigns
 * each its grid index). Moved out of `encodeScene` unchanged: the same
 * expressions, in the same order, produce the same doubles.
 *
 * Callable JavaScript fields are the only field representation; a grid is
 * how the ENGINE reads one. A future GPU descriptor for built-in fields
 * would be an alternative evaluator over the same plan, never a
 * replacement for the callable.
 */

import type { FieldFn, LengthFn, VectorFieldFn } from './shapes.js';
import { apply, invert, minScale, type Mat } from './matrix.js';
import { resolveLen } from './units.js';

export type FieldKind = 'p01' | 'len' | 'vx' | 'vy';
export interface FieldUse {
  fn: LengthFn | FieldFn | VectorFieldFn; // the UNBOUNDED field the grid samples (a length kind resolves each sample)
  kind: FieldKind;
  /**
   * paper mm → field units, an affine. On the flat plane it IS the
   * reading. In a curved space it is the chart's affine and no longer the
   * reading: the grid's lattice is laid out in it (`planGrid`'s bounds,
   * pitch through `minScale` and read window) and the engine looks the
   * grid up through it, while `toField` says where each lattice point is
   * read.
   */
  m: Mat;
  /**
   * A paper point → the point the field is read at, when that is not `m`:
   * the sketch point under the paper sample in a curved space (see
   * `encodeScene`). A non-finite answer is a place the chart cannot show,
   * and the sample fails open to 0. Absent on the flat plane, where the
   * lattice point is the field point.
   */
  toField?: (px: number, py: number) => [number, number];
  domains: number[];
  footprint: { x0: number; y0: number; x1: number; y1: number }; // paper mm
  /** Union of the paper bboxes of every shape referencing this use — where
   * the raster is actually read, as opposed to the sheet it spans. */
  shapeFp: { x0: number; y0: number; x1: number; y1: number };
  aligned: boolean;
  grid?: number;
}


/** The lattice one grid is sampled on: `gw × gh` cells of `cell` from the
 * full grid's origin `(x0, y0)` offset by `(ci0, cj0)` whole cells — the
 * declared origin `(ox, oy)` IS the first sample's coordinate, by the same
 * expression the sampler uses, so the engine reconstructs the lattice. */
export interface GridPlan {
  gw: number;
  gh: number;
  cell: number;
  x0: number;
  y0: number;
  ci0: number;
  cj0: number;
  ox: number;
  oy: number;
}

/** Plan the grid of one use group (uses of one field and kind): bounds
 * from the union of the uses' pulled-back footprints, pitch from the
 * paper step scaled by the tightest use, the sample budget, one cell of
 * margin, and — for paper-aligned grids — the window of the full grid the
 * shapes actually read. Pure arithmetic over the uses' transforms. */
export function planGrid(group: readonly FieldUse[], vector: boolean, paperW: number, paperH: number, unit: number): GridPlan {
  // Deform geometry follows its raster directly and vortex-like fields
  // turn fast near their cores: finer than the scalar pitch.
  const paperStep = vector
    ? Math.max(0.25, Math.min(1, Math.max(paperW, paperH) / 256))
    : Math.max(0.5, Math.min(2, Math.max(paperW, paperH) / 128));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let cell = Infinity;
  for (const u of group) {
    const f = u.footprint;
    for (const [px, py] of [[f.x0, f.y0], [f.x1, f.y0], [f.x0, f.y1], [f.x1, f.y1]]) {
      const [fx, fy] = apply(u.m, px, py);
      x0 = Math.min(x0, fx); y0 = Math.min(y0, fy);
      x1 = Math.max(x1, fx); y1 = Math.max(y1, fy);
    }
    cell = Math.min(cell, paperStep * minScale(u.m));
  }
  if (!Number.isFinite(cell) || !(cell > 0)) cell = paperStep / unit;
  // Cell budget: coarsen rather than allocate without bound.
  const MAX_SAMPLES = 1_048_576;
  const span = Math.max(x1 - x0, y1 - y0, cell);
  const need = ((x1 - x0) / cell + 2) * ((y1 - y0) / cell + 2);
  if (need > MAX_SAMPLES) cell = span / Math.sqrt(MAX_SAMPLES) * 1.05;
  // One cell of margin so Catmull-Rom never clamps on a footprint edge.
  x0 -= cell; y0 -= cell; x1 += cell; y1 += cell;
  let gw = Math.max(2, Math.ceil((x1 - x0) / cell) + 1);
  let gh = Math.max(2, Math.ceil((y1 - y0) / cell) + 1);
  // A paper-aligned grid spans the whole sheet whatever the shape's size: a
  // radius-5 circle got the same full-page raster as a radius-36 one, and a
  // per-shape field — times(n, i => deform(fieldOf(i), shape)) — paid that n
  // times over, sized by the paper rather than by the geometry.
  //
  // Clip the raster to where it is actually read. The window is snapped to
  // the full grid's own lattice and padded by PAD cells; the engine's
  // Catmull-Rom reads ix-1 .. ix+2 (modifier.rs `sample`), so PAD >= 2 keeps
  // every stencil inside. Verified by poisoning every sample outside the
  // window on the full-size grid: the ink did not move, so nothing is read
  // out there. Below 4 cells the engine falls back to bilinear, so never
  // clip under that.
  let ci0 = 0;
  let cj0 = 0;
  if (!group[0].aligned) {
    const PAD = 3;
    let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
    for (const u of group) {
      const f = u.shapeFp;
      for (const [px, py] of [[f.x0, f.y0], [f.x1, f.y0], [f.x0, f.y1], [f.x1, f.y1]]) {
        const [fx, fy] = apply(u.m, px, py);
        sx0 = Math.min(sx0, fx); sy0 = Math.min(sy0, fy);
        sx1 = Math.max(sx1, fx); sy1 = Math.max(sy1, fy);
      }
    }
    if (Number.isFinite(sx0) && Number.isFinite(sy0)) {
      const span = (origin: number, lo: number, hi: number, n: number): [number, number] => {
        let a = Math.max(0, Math.floor((lo - origin) / cell) - PAD);
        let b = Math.min(n - 1, Math.ceil((hi - origin) / cell) + PAD);
        if (b - a + 1 < 4) { a = Math.max(0, Math.min(a, n - 4)); b = Math.min(n - 1, a + 3); }
        return [a, b];
      };
      const [i0, i1] = span(x0, sx0, sx1, gw);
      const [j0, j1] = span(y0, sy0, sy1, gh);
      if (i1 - i0 + 1 < gw || j1 - j0 + 1 < gh) {
        // Keep the FULL grid's origin as the lattice reference and offset by
        // whole cells when sampling: rebasing (x0 += i0 * cell, then
        // x0 + i * cell) is a different float from x0 + (i0 + i) * cell.
        ci0 = i0; cj0 = j0;
        gw = i1 - i0 + 1; gh = j1 - j0 + 1;
      }
    }
  }
  // A paper-aligned grid spans the whole sheet whatever the shape's size —
  // a radius-5 circle got the same full-page raster as a radius-36 one, and
  // a per-shape field (times(n, i => deform(fieldOf(i), …))) paid that n
  // times over. Clip the raster to where it is actually sampled.
  //
  // The window is snapped to the FULL grid's own lattice and padded by
  // PAD cells, so the kept samples are a subset of the full grid at
  // identical positions. The engine's Catmull-Rom reads ix-1 … ix+2
  // (modifier.rs `sample`), so PAD >= 2 makes every stencil inside the
  // window resolve to the same four samples it would have on the full
  // grid — the interpolated value, and therefore the ink, is unchanged.
  // Below 4 cells the engine falls back to bilinear, so never clip under
  // that. Sampling further than PAD cells outside the shape's flattened
  // bbox would clamp and differ; the corpus is byte-identical, which is
  // evidence for that bound, not proof of it.
  // Declared origin IS the first sample's coordinate, same expression, so
  // the engine reconstructs the lattice the grid was sampled on.
  const ox = x0 + ci0 * cell;
  const oy = y0 + cj0 * cell;
  return { gw, gh, cell, x0, y0, ci0, cj0, ox, oy };
}

/** Evaluate `fn` on a planned lattice into the engine's grid record
 * (`[w, h, x0, y0, dx, dy, ...samples]`), one field call per sample: a
 * `p01` kind clamps to [0, 1], a `len` kind resolves each sample as a
 * length, a vector kind takes the component (and, with a partner, both
 * components from ONE evaluation). A non-finite sample fails open to 0. */
export function evaluateGrid(
  plan: GridPlan,
  fn: FieldUse['fn'],
  kind: FieldKind,
  withPartner: boolean,
  frameInner: Parameters<typeof resolveLen>[1],
  /** The use's own reading (`FieldUse.toField`) and the affine its lattice
   * is laid out in: a lattice point goes back to the paper and is read
   * where `toField` says. Absent: the lattice point is the field point. */
  reading?: { toField: (px: number, py: number) => [number, number]; m: Mat },
): { first: Float64Array; second: Float64Array | null } {
  const { gw, gh, cell, x0, y0, ci0, cj0, ox, oy } = plan;
  const toPaper = reading ? invert(reading.m) : null;
  const partner = withPartner;
  const first = new Float64Array(6 + gw * gh);
  first[0] = gw; first[1] = gh; first[2] = ox; first[3] = oy; first[4] = cell; first[5] = cell;
  const second = partner ? new Float64Array(6 + gw * gh) : null;
  if (second) {
    second[0] = gw; second[1] = gh; second[2] = ox; second[3] = oy; second[4] = cell; second[5] = cell;
  }
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      let raw: unknown;
      if (reading && toPaper) {
        const [px, py] = apply(toPaper, x0 + (ci0 + i) * cell, y0 + (cj0 + j) * cell);
        const [fx, fy] = reading.toField(px, py);
        raw = Number.isFinite(fx) && Number.isFinite(fy) ? fn(fx, fy) : NaN;
      } else {
        raw = fn(x0 + (ci0 + i) * cell, y0 + (cj0 + j) * cell) as unknown;
      }
      let val: number;
      if (kind === 'p01') val = Math.min(1, Math.max(0, Number(raw)));
      else if (kind === 'len') val = resolveLen(raw as number, frameInner);
      else val = Number((raw as [number, number])?.[kind === 'vx' ? 0 : 1]);
      // Fail open on a non-finite sample: a hand-rolled NaN is
      // fail-soft; the exact edge is within()'s job, shipped as regions.
      first[6 + j * gw + i] = Number.isFinite(val) ? val : 0;
      if (second) {
        const vy = Number((raw as [number, number])?.[1]);
        second[6 + j * gw + i] = Number.isFinite(vy) ? vy : 0;
      }
    }
  }
  return { first, second };
}

/** Build every grid the uses need, assign each use its grid index, and
 * return the concatenated `fieldData` (`[w, h, x0, y0, dx, dy, ...samples]`
 * per grid). `idOf` is the scene's function identity — uses of one field
 * function share one grid per kind. */
export function buildFieldGrids(
  uses: FieldUse[],
  idOf: (fn: object) => number,
  paperW: number,
  paperH: number,
  unit: number,
  frameInner: Parameters<typeof resolveLen>[1],
): Float64Array {
  // ---- Build the grids: one per (unbounded field, kind), over the union
  // of its uses' pulled-back footprints, at the pitch the tightest use
  // needs (paper pitch × the smallest scale any use applies) — a shrunken
  // motif never aliases, a magnified one never wastes cells.
  // Grid chunks are collected as exact-size Float64Arrays and joined once.
  // The old shape pushed every sample into a plain number[] (4.1M pushes on
  // ring) and copied it into a Float64Array at the end.
  const chunks: Float64Array[] = [];
  let fieldLen = 0;
  const pushChunk = (a: Float64Array): void => { chunks.push(a); fieldLen += a.length; };
  const groups = new Map<string, FieldUse[]>();
  // Uses read through different curved readings cannot share a raster: the
  // reading is not an affine the engine can apply per use.
  const readingKey = (u: FieldUse): string => (u.toField ? `:${idOf(u.toField)}` : '');
  for (const u of uses) {
    const key = `${idOf(u.fn)}:${u.kind}${readingKey(u)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(u);
  }
  let gridCount = 0;
  const done = new Set<string>();
  for (const [gkey, group] of groups) {
    if (done.has(gkey)) continue;
    const kind = group[0].kind;
    const vector = kind === 'vx' || kind === 'vy';
    // A vector field's two grids share every use (both components are
    // registered together, same transform, same footprint), so they share
    // the extent and are filled from ONE evaluation per sample — the
    // field is the sketch's own closure and may be expensive.
    const vyKey = `${idOf(group[0].fn)}:vy${readingKey(group[0])}`;
    const partner = kind === 'vx' ? groups.get(vyKey) : undefined;
    if (partner) done.add(vyKey);
    const plan = planGrid(group, vector, paperW, paperH, unit);
    const toField = group[0].toField;
    const { first, second } = evaluateGrid(plan, group[0].fn, kind, partner !== undefined, frameInner, toField ? { toField, m: group[0].m } : undefined);
    pushChunk(first);
    for (const u of group) u.grid = gridCount;
    gridCount++;
    if (partner && second) {
      pushChunk(second);
      for (const u of partner) u.grid = gridCount;
      gridCount++;
    }
  }
  const joinFields = (): Float64Array => {
    const all = new Float64Array(fieldLen);
    let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    return all;
  };
  return joinFields();
}
