/**
 * Field → contours: marching squares over a sampled grid — the bridge from
 * scalar fields to stampable geometry. `t.isolines` turns the result into a
 * material (`levelMaterial`); the plain contour records serve the kernels
 * and tests that read them directly.
 *
 * Semantics: a level is the AREA where `field ≥ at`, and its contours are
 * that area's boundary. Contour orientation is consistent (holes wind
 * opposite their parents), but the supported stamping story is evenodd
 * winding, which never looks at orientation. Deterministic: a pure function
 * of the field, level, and options.
 *
 * Boundary policy: the area stops where the domain does — the edge of the
 * lattice (the drawable, or the box of a `within` bound), and wherever the
 * field is absent (non-finite: outside a `within` bound, or a NaN hole). A
 * region the domain cuts closes along that edge, through every corner it
 * passes on the inside side, so every contour is a ring. The closing edges
 * are marked (`LevelContour.cut`): the level line is everything else.
 *
 * Laziness: the level lines are what `t.isolines` computes. The closing
 * runs — and the halving that finds where an absent field stops — are worked
 * out the first time something reads the area (`levelLines(…).close()`),
 * once for every level of the call, and kept.
 */

import { usableLength } from './guard.js';
import { Material, mintIds } from './material.js';
import type { FieldFn } from './shapes.js';
import type { Space } from './space.js';
import { mm, type L } from './units.js';
import { chainSegments, edgeCells, marchSegments, type SampledGrid } from './marching.js';

export type { SampledGrid, SegmentBuffer } from './marching.js';
export { chainSegments, marchSegments } from './marching.js';

export interface IsoContour {
  pts: [number, number][];
  closed: boolean;
  /** Segment by segment (a closed contour's closing segment last): is it a
   * geodesic of the sketch's space? Absent, every segment is the image of
   * its coordinate segment. A material's `geodesic` edge column says it. */
  geodesic?: readonly boolean[];
}

/** A contour with its edges marked: `cut[k]` is 1 on the edge from point
 * `k` to the next (the last one back to the first on a ring) when that edge
 * closes the region — it lies in a lattice cell at the edge of the domain,
 * along that edge or the step to it — and 0 when it runs along the level
 * through open ground. The 0 edges are the level line an open march
 * draws. */
export interface LevelContour extends IsoContour {
  cut: number[];
}

export interface IsoOpts {
  /** Sampling step (default: max of mm(1) and long-side/256 — crossings
   * are edge-interpolated, so positional error is far below the step). */
  step?: L;
}

/**
 * Which levels to trace — the spelling `occlude/3d` already uses, so the
 * two `isolines` read the same: one level, a list of them, `count` levels
 * spread evenly inside the field's sampled range (`min`/`max` pin that
 * range), or every multiple of `spacing` (shifted by `offset`) that falls
 * inside it. `count` and `spacing` are answered by the same grid the
 * marching reads, so the range is the range the drawing actually has.
 */
export type IsoLevels =
  | number
  | number[]
  | { count: number; min?: number; max?: number }
  | { spacing: number; offset?: number };

/** The two spellings that need the field's own range before they are levels. */
type IsoLevelSpec = Exclude<IsoLevels, number | number[]>;

/** One level with the contours found at it — the shape `t.isolines` turns
 * into a material whose every edge carries its `level`. `contours` are the
 * rings; `lines` and `walls` are the two kinds of piece they are joined
 * from: the level line through open ground (chained and finished exactly
 * as an open march does it, so its ink is that march's), and the runs that
 * close a region where the domain ends. */
export interface IsoLevelContours {
  level: number;
  contours: LevelContour[];
  lines: LevelContour[];
  walls: LevelContour[];
}

/** Environment handed in by the toolkit: drawable bounds and sketch-time
 * length resolution, both in user units, and the run's geometry for the
 * words that measure in it (`t.travelTime`). Absent or Euclidean is the
 * flat plane. The marching grid itself is a chart grid either way. */
export interface IsoEnv {
  bounds: { x: number; y: number; w: number; h: number };
  len(l: L): number;
  space?: Space;
}

/** Where a bound field exists, as the toolkit lowered it: `box` is the part
 * of the drawable its bound can reach, which the lattice covers instead of
 * the whole drawable, and `walls` are the bound's own loops, whose corners
 * a region cut by the bound walks through. */
export interface IsoDomain {
  box: { x: number; y: number; w: number; h: number };
  walls: readonly (readonly [number, number])[][];
}

export function isolinesOf(
  env: IsoEnv,
  field: FieldFn,
  at: number,
  opts?: IsoOpts,
): LevelContour[];
export function isolinesOf(
  env: IsoEnv,
  field: FieldFn,
  at: number[] | IsoLevelSpec,
  opts?: IsoOpts,
): LevelContour[][];
export function isolinesOf(
  env: IsoEnv,
  field: FieldFn,
  at: IsoLevels,
  opts?: IsoOpts,
): LevelContour[] | LevelContour[][];
export function isolinesOf(
  env: IsoEnv,
  field: FieldFn,
  at: IsoLevels,
  opts: IsoOpts = {},
): LevelContour[] | LevelContour[][] {
  const found = levelContours(env, field, at, opts);
  if (typeof at === 'number') return found.length > 0 ? found[0].contours : [];
  return found.map((g) => g.contours);
}

/** The level lines of one `t.isolines` call, with the closure still to
 * come: `groups` holds every level in the order asked, each with its level
 * line; `close()` works out the runs that close each level's regions where
 * the domain ends and joins them into rings — the first call does the work
 * for every level at once, and every later call answers the same array. */
export interface LevelLines {
  groups: readonly { level: number; lines: LevelContour[] }[];
  close(): IsoLevelContours[];
}

/**
 * The contours of `field` at every level `at` asks for, each level named by
 * the value it was traced at. One sampling of the field serves them all,
 * and `{ count }` / `{ spacing }` read their range from that same sampling.
 * `isolinesOf` is this without the names. `domain` narrows the lattice to a
 * bound's box and names the walls its regions close along.
 */
export function levelContours(
  env: IsoEnv,
  field: FieldFn,
  at: IsoLevels,
  opts: IsoOpts = {},
  domain?: IsoDomain,
): IsoLevelContours[] {
  return levelLines(env, field, at, opts, domain).close();
}

/**
 * `levelContours` in two halves: the level lines now, the closure when it
 * is asked for. The lines are the plain cells of the march — exactly the
 * open level line — and need neither the pad ring nor the place an absent
 * field stops. The closure reads the same sampling: it finds where the
 * field stops along each lattice edge once, marches the edge cells of
 * every level over that one answer, and lets the grid go.
 */
export function levelLines(
  env: IsoEnv,
  field: FieldFn,
  at: IsoLevels,
  opts: IsoOpts = {},
  domain?: IsoDomain,
): LevelLines {
  checkOpts(opts);
  // A list is the levels themselves, in the order given — a non-finite one
  // keeps its place and draws nothing. A spec has to see the field first.
  const given = typeof at === 'number' ? [at] : Array.isArray(at) ? at : null;
  if (given === null) checkSpec(at as IsoLevelSpec);
  const empty = (): LevelLines => nothingToClose(given === null ? [] : given);
  // A step that is not a positive length draws no contours at all.
  if (!usableLength(opts.step)) return empty();
  const d = env.bounds;
  // The step is the drawable's; the lattice covers only the part of it the
  // field can exist in.
  const stepU =
    opts.step !== undefined
      ? env.len(opts.step)
      : Math.max(env.len(mm(1)), Math.max(d.w, d.h) / 256);
  const b = domain?.box ?? d;
  // A bound that reaches no part of the drawable leaves nothing to trace.
  if (!(b.w > 0) || !(b.h > 0)) return empty();
  const gw = Math.max(2, Math.ceil(b.w / stepU) + 1);
  const gh = Math.max(2, Math.ceil(b.h / stepU) + 1);
  // Grid cells are O(1) samples, not shape repetitions, so the combinator
  // cap doesn't apply — only memory sanity does. 2^24 cells is a 128MB
  // sample buffer (4096², step 0.05mm on 200mm paper — far sub-nib);
  // beyond that is a mid-edit transient, not a sketch.
  const cells = gw * gh;
  // A grid that is not a finite size has no samples to march over.
  if (!Number.isFinite(cells)) return empty();
  if (cells > 16_777_216) {
    throw new Error(
      `isolines: ${Math.floor(cells)} grid cells (step too fine) — capped at 16.7M (~128MB of samples)`,
    );
  }
  const grid = sampleValues(field, b, gw, gh);
  const levels = given ?? resolveLevels(at as IsoLevelSpec, grid);
  // A level that is not a number is skipped; the others still march.
  const groups = levels.map((level) => ({
    level,
    lines: Number.isFinite(level) ? finishContours(chainSegments(marchSegments(grid, level, false, 'plain')), b, false) : [],
  }));
  let held: SampledGrid | null = grid;
  let closed: IsoLevelContours[] | null = null;
  return {
    groups,
    close() {
      if (closed !== null) return closed;
      const g = held!;
      sampleWalls(field, g);
      // A closing edge spans one lattice cell; a walk along a wall between
      // its ends that is longer than a few cells is not the wall between
      // them.
      const walls = domain ? { loops: domain.walls, reach: 4 * Math.hypot(g.sx, g.sy) } : undefined;
      const edge = edgeCells(g);
      closed = groups.map(({ level, lines }) => {
        if (!Number.isFinite(level)) return { level, contours: [], lines, walls: [] };
        const runs = finishContours(chainSegments(marchSegments(g, level, true, edge)), b, true, walls);
        return { level, contours: joinRings(lines, runs), lines, walls: runs };
      });
      held = null;
      return closed;
    },
  };
}

/** Levels with nothing traced at them: no lines, and nothing to close. */
function nothingToClose(levels: readonly number[]): LevelLines {
  const groups = levels.map((level) => ({ level, lines: [] as LevelContour[] }));
  const closed = groups.map(({ level }) => ({ level, contours: [], lines: [], walls: [] }));
  return { groups, close: () => closed };
}

/** The quantum two pieces' shared end is matched at, as `chainSegments`
 * matches its segments: far below any step, above float noise. */
const JOIN_Q = 1e-6;
const joinKey = (p: readonly [number, number]): string => `${Math.round(p[0] / JOIN_Q)},${Math.round(p[1] / JOIN_Q)}`;

/** The rings the pieces make, end to start: a level line, then the run that
 * closes it along the wall, then the next level line, until the ring comes
 * back. A piece that closed on its own is a ring already. Pieces that meet
 * nothing stay open (a lattice too coarse to close them). */
function joinRings(lines: readonly LevelContour[], runs: readonly LevelContour[]): LevelContour[] {
  const out: LevelContour[] = [];
  const open: LevelContour[] = [];
  for (const c of [...lines, ...runs]) (c.closed ? out : open).push(c);
  const byStart = new Map<string, number[]>();
  open.forEach((c, i) => {
    const k = joinKey(c.pts[0]);
    const at = byStart.get(k);
    if (at) at.push(i);
    else byStart.set(k, [i]);
  });
  const used = new Uint8Array(open.length);
  const next = (k: string): number | undefined => byStart.get(k)?.find((i) => !used[i]);
  for (let i = 0; i < open.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const pts = [...open[i].pts];
    const cut = open[i].cut.slice(0, open[i].pts.length - 1);
    const first = joinKey(pts[0]);
    let closed = false;
    for (;;) {
      const end = joinKey(pts[pts.length - 1]);
      if (end === first && pts.length > 2) {
        closed = true;
        break;
      }
      const n = next(end);
      if (n === undefined) break;
      used[n] = 1;
      const piece = open[n];
      pts.push(...piece.pts.slice(1));
      cut.push(...piece.cut.slice(0, piece.pts.length - 1));
    }
    if (closed) pts.pop();
    out.push({ pts, closed, cut });
  }
  return out;
}

/** The one option there is. `close` was the other: every level set closes
 * now, so asking for it is asking for something that no longer exists. */
function checkOpts(opts: IsoOpts): void {
  if (opts === null || typeof opts !== 'object') return;
  for (const key of Object.keys(opts)) {
    if (key === 'step') continue;
    if (key === 'close') {
      throw new Error(
        'isolines: { close } is gone — every level set is an area and closes along the drawable (or its within bound); ' +
          'the closing edges carry cut = 1, so strokes(m.edges.filter((e) => !e.attrs.cut)) draws the level line alone',
      );
    }
    throw new Error(`isolines: '${key}' is not an option — the options are { step }`);
  }
}

/** A spec is one of two spellings, and a key from neither is a mistake the
 * sketch would otherwise never hear about. A count that is not a whole
 * repetition count is a mistake too, whatever the field turns out to hold,
 * so both are caught before the field is sampled. */
function checkSpec(spec: IsoLevelSpec): void {
  if (spec === null || typeof spec !== 'object') {
    throw new Error('isolines: the levels are a number, a list of numbers, { count, min?, max? } or { spacing, offset? }');
  }
  const isCount = 'count' in spec;
  const isSpacing = 'spacing' in spec;
  if (isCount && isSpacing) {
    throw new Error('isolines: a level spec is { count, min?, max? } or { spacing, offset? } — not both');
  }
  if (!isCount && !isSpacing) {
    throw new Error('isolines: a level spec needs count or spacing — { count, min?, max? } or { spacing, offset? }');
  }
  const allowed = isCount ? ['count', 'min', 'max'] : ['spacing', 'offset'];
  for (const key of Object.keys(spec)) {
    if (allowed.includes(key)) continue;
    const where = key === 'step' ? ' — the lattice step goes in the options: t.isolines(field, levels, { step })' : '';
    const spelling = isCount ? '{ count, min?, max? }' : '{ spacing, offset? }';
    throw new Error(`isolines: '${key}' is not a level key — the spec is ${spelling}${where}`);
  }
  if (isCount && !Number.isSafeInteger(spec.count)) {
    throw new Error('isolines count must be a positive integer');
  }
}

/** The levels `{ count }` or `{ spacing }` asks for, read against the range
 * of the sampled field. A flat field, a spacing of zero and a field with no
 * finite samples all resolve to nothing to draw. */
function resolveLevels(spec: IsoLevelSpec, grid: SampledGrid): number[] {
  const { min, max } = sampledRange(grid);
  if ('count' in spec) {
    const count = spec.count;
    const lo = spec.min ?? min;
    const hi = spec.max ?? max;
    if (count < 1 || !Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return [];
    return Array.from({ length: count }, (_, i) => lo + ((hi - lo) * (i + 1)) / (count + 1));
  }
  const spacing = spec.spacing;
  const offset = spec.offset ?? 0;
  if (!Number.isFinite(spacing) || spacing <= 0 || !Number.isFinite(offset)) return [];
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  const first = Math.ceil((min - offset) / spacing);
  const last = Math.floor((max - offset) / spacing);
  if (last - first > 1_000_000) throw new Error('isolines spacing produces too many levels');
  const out: number[] = [];
  for (let k = first; k <= last; k++) out.push(k * spacing + offset);
  return out;
}

/** The range of the samples that exist: absent samples (a `within()` bound,
 * a NaN hole) and the pad ring are not part of the field. */
function sampledRange(grid: SampledGrid): { min: number; max: number } {
  const { vals, absent, pw, gw, gh } = grid;
  let min = Infinity;
  let max = -Infinity;
  for (let j = 0; j < gh; j++) {
    const row = (j + 1) * pw + 1;
    for (let i = 0; i < gw; i++) {
      if (absent[row + i]) continue;
      const v = vals[row + i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { min, max };
}

/** Halvings that place the domain's edge on a lattice edge: 2^-52 of a step
 * is the last bit of the fraction, so the edge is where the field says it
 * is, not where the grid is. */
const WALL_HALVINGS = 52;

/** Sample `field` on the `gw × gh` lattice over `b`, padded by one ring.
 * Non-finite samples become deeply-outside sentinels so interpolation
 * stays finite and the marching reads them as below every level; they are
 * also marked absent, and where a lattice edge joins a present sample to an
 * absent one, the place the field stops is found along it by halving (see
 * `SampledGrid.wall`), so a region closes there rather than a sample short.
 * `sampleValues` then `sampleWalls`: the level line needs only the first. */
export function sampleGrid(
  field: FieldFn,
  b: { x: number; y: number; w: number; h: number },
  gw: number,
  gh: number,
): SampledGrid {
  return sampleWalls(field, sampleValues(field, b, gw, gh));
}

/** The samples of `sampleGrid` without the walls: where the field stops
 * along an edge is not looked for yet. */
export function sampleValues(
  field: FieldFn,
  b: { x: number; y: number; w: number; h: number },
  gw: number,
  gh: number,
): SampledGrid {
  const sx = b.w / (gw - 1);
  const sy = b.h / (gh - 1);
  // Sample once; every level marches over the same grid. Padded by one ring
  // on every side (stride pw = gw + 2). The ring holds the closing
  // sentinel and is never "absent", so the marching reads samples with a
  // plain indexed load instead of four bounds checks per access — `val`
  // alone was 20% of isolinesOf.
  const pw = gw + 2;
  const ph = gh + 2;
  const vals = new Float64Array(pw * ph);
  // Absent samples (non-finite — a within() bound or a hand-rolled NaN
  // hole) are tracked separately: the domain ends at them.
  const absent = new Uint8Array(pw * ph);
  for (let j = 0; j < gh; j++) {
    const row = (j + 1) * pw + 1;
    for (let i = 0; i < gw; i++) {
      const v = field(b.x + i * sx, b.y + j * sy);
      const fin = Number.isFinite(v);
      vals[row + i] = fin ? v : -1e30;
      absent[row + i] = fin ? 0 : 1;
    }
  }
  return { vals, absent, pw, gw, gh, b, sx, sy };
}

/** Find, once, where the field stops along every lattice edge that joins a
 * present sample to an absent one, and keep it on the grid (`grid.wall`).
 * Every level's closing run reads this one answer. A grid with no absent
 * sample has no walls; a grid that has them already is left as it is. */
export function sampleWalls(field: FieldFn, grid: SampledGrid): SampledGrid {
  if (grid.wall !== undefined) return grid;
  const { absent, pw, gw, gh, b, sx, sy } = grid;
  let anyAbsent = false;
  for (let j = 0; j < gh && !anyAbsent; j++) {
    const row = (j + 1) * pw + 1;
    for (let i = 0; i < gw; i++) {
      if (absent[row + i] === 1) {
        anyAbsent = true;
        break;
      }
    }
  }
  if (!anyAbsent) return grid;
  const h = new Float64Array(gw * gh).fill(NaN);
  const v = new Float64Array(gw * gh).fill(NaN);
  // The fraction of the way from the edge's first sample to its second at
  // which the field stops, the present end being the one that exists.
  const edgeOf = (x0: number, y0: number, dx: number, dy: number, firstPresent: boolean): number => {
    let inside = firstPresent ? 0 : 1;
    let outside = firstPresent ? 1 : 0;
    for (let k = 0; k < WALL_HALVINGS; k++) {
      const mid = (inside + outside) / 2;
      if (Number.isFinite(field(x0 + mid * dx, y0 + mid * dy))) inside = mid;
      else outside = mid;
    }
    return inside;
  };
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const here = absent[(j + 1) * pw + i + 1];
      if (i + 1 < gw && here !== absent[(j + 1) * pw + i + 2]) {
        h[j * gw + i] = edgeOf(b.x + i * sx, b.y + j * sy, sx, 0, here === 0);
      }
      if (j + 1 < gh && here !== absent[(j + 2) * pw + i + 1]) {
        v[j * gw + i] = edgeOf(b.x + i * sx, b.y + j * sy, 0, sy, here === 0);
      }
    }
  }
  grid.wall = { h, v };
  return grid;
}

/** Clamp close-mode points onto the lattice box, walk the closing edges
 * through the corners of `walls.loops` (no further than `walls.reach`),
 * drop duplicate vertices, and merge colinear runs (the clamped border
 * runs collapse to their corners). A contour that carries `cut` marks
 * keeps them edge for edge. */
export function finishContours<C extends IsoContour>(
  contours: C[],
  b: { x: number; y: number; w: number; h: number },
  close: boolean,
  walls?: { loops: IsoDomain['walls']; reach: number },
): C[] {
  const out: C[] = [];
  for (const c of contours) {
    const marks = (c as IsoContour & { cut?: number[] }).cut;
    let pts = c.pts;
    let cut = marks;
    if (close) {
      pts = pts.map(([x, y]) => [
        Math.min(b.x + b.w, Math.max(b.x, x)),
        Math.min(b.y + b.h, Math.max(b.y, y)),
      ]);
    }
    if (walls && walls.loops.length > 0 && cut) [pts, cut] = walkWalls(pts, cut, c.closed, walls.loops, walls.reach);
    // Consecutive duplicates. The edge a dropped point began is the edge
    // the point it duplicates begins now.
    const dedup: [number, number][] = [];
    const dedupCut: number[] = [];
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      const l = dedup[dedup.length - 1];
      if (!l || Math.abs(p[0] - l[0]) > 1e-9 || Math.abs(p[1] - l[1]) > 1e-9) {
        dedup.push(p);
        if (cut) dedupCut.push(cut[k] ?? 0);
      } else if (cut) {
        dedupCut[dedupCut.length - 1] = cut[k] ?? 0;
      }
    }
    if (c.closed && dedup.length > 1) {
      const [f, l] = [dedup[0], dedup[dedup.length - 1]];
      if (Math.abs(f[0] - l[0]) <= 1e-9 && Math.abs(f[1] - l[1]) <= 1e-9) {
        dedup.pop();
        if (cut) dedupCut.pop();
      }
    }
    const merged = mergeColinear(dedup, c.closed, cut ? dedupCut : null);
    if (merged.pts.length >= (c.closed ? 3 : 2)) {
      out.push({ ...c, pts: merged.pts, closed: c.closed, ...(cut ? { cut: merged.cut } : {}) } as C);
    }
  }
  return out;
}

/** A point's place on the walls: which loop, which segment, how far along. */
interface WallSpot {
  loop: number;
  seg: number;
  t: number;
}

/** Where `p` lies on the walls, or null when it is not on one: the nearest
 * segment, if it is within float noise of the point. */
function wallSpot(p: readonly [number, number], walls: IsoDomain['walls'], tol: number): WallSpot | null {
  let best: WallSpot | null = null;
  let bestD = tol;
  for (let l = 0; l < walls.length; l++) {
    const loop = walls[l];
    const n = loop.length;
    for (let s = 0; s < n; s++) {
      const a = loop[s];
      const q = loop[(s + 1) % n];
      const dx = q[0] - a[0];
      const dy = q[1] - a[1];
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
      const d = Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
      if (d <= bestD) {
        bestD = d;
        best = { loop: l, seg: s, t };
      }
    }
  }
  return best;
}

/** The corners of the wall between two spots on one loop, the shorter way
 * round, and that way's length. */
function wallBetween(a: WallSpot, b: WallSpot, loop: readonly (readonly [number, number])[]): { pts: [number, number][]; length: number } {
  const n = loop.length;
  const at = (s: WallSpot): [number, number] => {
    const p = loop[s.seg];
    const q = loop[(s.seg + 1) % n];
    return [p[0] + s.t * (q[0] - p[0]), p[1] + s.t * (q[1] - p[1])];
  };
  const pathLength = (from: [number, number], corners: [number, number][], to: [number, number]): number => {
    let length = 0;
    let prev = from;
    for (const c of [...corners, to]) {
      length += Math.hypot(c[0] - prev[0], c[1] - prev[1]);
      prev = c;
    }
    return length;
  };
  const pa = at(a);
  const pb = at(b);
  // Forward: along the loop's own order, from a's segment end to b's start.
  const forward: [number, number][] = [];
  if (!(a.seg === b.seg && b.t >= a.t)) {
    for (let s = (a.seg + 1) % n, k = 0; k < n; s = (s + 1) % n, k++) {
      forward.push([loop[s][0], loop[s][1]]);
      if (s === b.seg) break;
    }
  }
  // Backward: against it, from a's segment start to b's segment end.
  const backward: [number, number][] = [];
  if (!(a.seg === b.seg && b.t <= a.t)) {
    for (let s = a.seg, k = 0; k < n; s = (s - 1 + n) % n, k++) {
      backward.push([loop[s][0], loop[s][1]]);
      if (s === (b.seg + 1) % n) break;
    }
  }
  const lf = pathLength(pa, forward, pb);
  const lb = pathLength(pa, backward, pb);
  return lf <= lb ? { pts: forward, length: lf } : { pts: backward, length: lb };
}

/** Walk each closing edge whose two ends lie on one wall along that wall,
 * through the corners between them, instead of the chord a lattice cell
 * draws. The corners are closing edges too. */
function walkWalls(
  pts: [number, number][],
  cut: number[],
  closed: boolean,
  walls: IsoDomain['walls'],
  reach: number,
): [[number, number][], number[]] {
  let scale = 0;
  for (const loop of walls) for (const p of loop) scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]));
  const tol = 1e-9 * Math.max(1, scale);
  const spots = new Map<number, WallSpot | null>();
  const spotOf = (k: number): WallSpot | null => {
    if (!spots.has(k)) spots.set(k, wallSpot(pts[k], walls, tol));
    return spots.get(k)!;
  };
  const outPts: [number, number][] = [];
  const outCut: number[] = [];
  const n = pts.length;
  const edges = closed ? n : n - 1;
  for (let k = 0; k < n; k++) {
    outPts.push(pts[k]);
    outCut.push(cut[k] ?? 0);
    if (k >= edges || cut[k] !== 1) continue;
    const a = spotOf(k);
    const b = a ? spotOf((k + 1) % n) : null;
    if (!a || !b || a.loop !== b.loop) continue;
    const between = wallBetween(a, b, walls[a.loop]);
    if (between.pts.length === 0 || !(between.length <= reach)) continue;
    for (const c of between.pts) {
      outPts.push(c);
      outCut.push(1);
    }
  }
  return [outPts, outCut];
}

/** Drop a vertex whose two edges run straight on, when both edges are the
 * same kind — a level edge and a closing edge stay apart where they meet. */
function mergeColinear(
  pts: [number, number][],
  closed: boolean,
  cut: number[] | null,
): { pts: [number, number][]; cut: number[] } {
  const n = pts.length;
  if (n < 3) return { pts, cut: cut ?? [] };
  const keep: boolean[] = new Array<boolean>(n).fill(true);
  const lo = closed ? 0 : 1;
  const hi = closed ? n : n - 1;
  for (let k = lo; k < hi; k++) {
    if (cut && cut[(k - 1 + n) % n] !== cut[k]) continue;
    const p = pts[(k - 1 + n) % n];
    const q = pts[k];
    const r = pts[(k + 1) % n];
    const ux = q[0] - p[0];
    const uy = q[1] - p[1];
    const vx = r[0] - q[0];
    const vy = r[1] - q[1];
    const cross = ux * vy - uy * vx;
    const dot = ux * vx + uy * vy;
    if (dot > 0 && Math.abs(cross) <= 1e-9 * Math.hypot(ux, uy) * Math.hypot(vx, vy)) {
      keep[k] = false;
    }
  }
  // A kept point begins the edge it began; a dropped point's edge is the
  // same kind as the one before it, which the kept point already names.
  return { pts: pts.filter((_, k) => keep[k]), cut: cut ? cut.filter((_, k) => keep[k]) : [] };
}

/**
 * The levels as one material: each region's boundary a ring (a chain where
 * the lattice could not close one), separate regions separate, every edge
 * carrying the `level` it was traced at and `cut` — 1 on the edges that
 * close a region where the domain ends, 0 on the level line itself. Both
 * columns copy when an edge is split.
 *
 * The rows of a level are its level lines first, in the order and the
 * direction the open march gives them, then the closing runs, which join
 * the lines' own end rows. So the level line alone,
 * `m.edges.filter((e) => !e.attrs.cut)`, walks and draws exactly as the
 * open level lines did. This is the area `levelSetMaterial` works out when
 * it is asked for.
 */
export function levelMaterial(groups: readonly IsoLevelContours[]): Material {
  const r = levelRows(groups, true);
  return new Material(r.x, r.y, {}, r.edges, levelCarry(r));
}

/**
 * The material `t.isolines` answers: the level lines of every level, each
 * edge carrying its `level` and `cut` = 0, rows in the order
 * `levelMaterial` gives them. Its area — `contours()`, `faces()`, and what
 * `polygon`, `t.within` and every other area consumer read — is
 * `levelMaterial` of the closed levels, worked out the first time it is
 * asked for. The area's level-line rows carry this material's ids, so a
 * selection of the lines is read against the area by id; its closing rows
 * are minted then.
 */
export function levelSetMaterial(set: LevelLines): Material {
  const r = levelRows(set.groups.map(({ level, lines }) => ({ level, lines, walls: [], contours: [] })), false);
  const lines: Material = new Material(r.x, r.y, {}, r.edges, { ...levelCarry(r), area: () => closedArea(set, lines) });
  return lines;
}

/** `levelMaterial` of the closed levels, its line rows under the ids the
 * lines already have. Within each level the line rows come first in both
 * layouts, in the same order, so the k-th line row of the area is the k-th
 * row of the lines. The closing rows are new geometry, minted here. */
function closedArea(set: LevelLines, lines: Material): Material {
  const r = levelRows(set.close(), true);
  const n = r.x.length;
  const m = r.cut.length;
  let rimPoints = 0;
  for (let i = 0; i < n; i++) if (!r.lineRow[i]) rimPoints++;
  let rimEdges = 0;
  for (let e = 0; e < m; e++) if (r.cut[e] !== 0) rimEdges++;
  const freshPoints = mintIds(rimPoints);
  const freshEdges = mintIds(rimEdges);
  const points = new Float64Array(n);
  for (let i = 0, k = 0, f = 0; i < n; i++) points[i] = r.lineRow[i] ? lines.pointIds[k++] : freshPoints[f++];
  const edges = new Float64Array(m);
  const edgeRoots = new Float64Array(m);
  for (let e = 0, k = 0, f = 0; e < m; e++) {
    if (r.cut[e] === 0) {
      edges[e] = lines.edgeIds[k];
      edgeRoots[e] = lines.edgeRoots[k++];
    } else {
      edges[e] = edgeRoots[e] = freshEdges[f++];
    }
  }
  return new Material(r.x, r.y, {}, r.edges, { ...levelCarry(r), ids: { points, edges, edgeRoots }, space: lines.space });
}

/** The rows of levels as one material, lines then (with `rims`) the
 * closing runs, level by level; `lineRow` says which vertex rows the lines
 * made. */
interface LevelRows {
  x: Float64Array;
  y: Float64Array;
  edges: Uint32Array;
  level: Float64Array;
  cut: Float64Array;
  lineRow: Uint8Array;
}

function levelRows(groups: readonly IsoLevelContours[], rims: boolean): LevelRows {
  const x: number[] = [];
  const y: number[] = [];
  const lineRow: number[] = [];
  const edges: number[] = [];
  const level: number[] = [];
  const cut: number[] = [];
  const edgeCount = (c: IsoContour) => (c.closed && c.pts.length > 2 ? c.pts.length : Math.max(0, c.pts.length - 1));
  for (const g of groups) {
    // The end rows of the level lines, by place: a closing run starts and
    // stops at one of them.
    const endRow = new Map<string, number>();
    const add = (c: IsoContour, kind: number, share: boolean) => {
      const m = c.pts.length;
      const rows = c.pts.map((p, k) => {
        const end = !c.closed && (k === 0 || k === m - 1);
        const had = share && end ? endRow.get(joinKey(p)) : undefined;
        if (had !== undefined) return had;
        x.push(p[0]);
        y.push(p[1]);
        lineRow.push(kind === 0 ? 1 : 0);
        if (end) endRow.set(joinKey(p), x.length - 1);
        return x.length - 1;
      });
      for (let k = 0; k < edgeCount(c); k++) {
        const a = rows[k];
        const b = rows[(k + 1) % m];
        // A closing run that starts and stops at one end row — a step of
        // no length along the boundary — is no edge at all: a material
        // cannot join a vertex to itself, and there is nothing to draw.
        if (a === b) continue;
        edges.push(a, b);
        level.push(g.level);
        cut.push(kind);
      }
    };
    for (const c of g.lines) add(c, 0, false);
    if (rims) for (const c of g.walls) add(c, 1, true);
  }
  return {
    x: Float64Array.from(x),
    y: Float64Array.from(y),
    edges: Uint32Array.from(edges),
    level: Float64Array.from(level),
    cut: Float64Array.from(cut),
    lineRow: Uint8Array.from(lineRow),
  };
}

/** What every level material carries: its two edge columns, copied when an
 * edge is split. */
function levelCarry(r: LevelRows) {
  return {
    iteration: 0,
    history: [],
    edgeAttrs: { level: r.level, cut: r.cut },
    transfers: {},
    edgeTransfers: { level: 'copy', cut: 'copy' } as const,
  };
}
