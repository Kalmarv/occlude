/**
 * spacefill: one line that folds until the folds are the tone.
 *
 * A space-filling curve visits every cell of a subdivided square exactly
 * once, and consecutive cells touch, so the whole visit is a single
 * pen-down line. Fold it finer and the paper goes darker; fold it coarser
 * and it goes lighter. That is the whole instrument: tone is fold density,
 * not a different mark.
 *
 * The RULE is data. A rule says how a cell divides (`n` × `n`), the order
 * its children are visited, and the symmetry each child is drawn with —
 * `{ cell: [i, j], turn }` per child, `n²` of them. `hilbertRule`,
 * `peanoRule` and `meanderRule` are plain objects a sketch can read, edit
 * or replace; there is no `hilbert()` function, because the curve is what
 * the table produces.
 *
 * A turn is named for what it does to the line's heading through the cell,
 * not for a matrix: `id` keeps it, `l` and `r` put it a quarter turn to
 * either side, `flip` reverses it. Which of the eight symmetries of the
 * square that is falls out of the rule's own entry and exit corners, which
 * `compileRule` solves for: a table whose children do not meet is refused
 * by name rather than drawn as a curve with holes in it.
 *
 * That same frame is what keeps an ADAPTIVE fill continuous. A cell that
 * stops early is one point where its neighbour has a whole subtree, and
 * nothing has to be patched: the child's frame is the parent's frame
 * composed with the child's turn, so every subtree already starts at the
 * corner the parent's order implies and ends at the corner the next child
 * expects. Continuity is read off the table, never off a `xy2d` index.
 *
 * One vertex per leaf cell, at its centre, carrying `level` — the depth it
 * stopped at — so a sketch can re-pen or `decimate` by depth. Cells whose
 * centre falls outside the area are skipped and the chain breaks there: a
 * gap is a pen-up, and the ordering keeps them rare.
 *
 * A Hilbert line has no diagonal in it, and neither has this one. Two cells
 * of one size meet centre to centre along an axis, but a coarse cell and a
 * fine one do not, so the walk turns a corner at every level change. The
 * elbow is a real vertex, carrying the coarser cell's level, and its place
 * is forced rather than chosen — see the comment where it is minted.
 */

import { distanceTo } from './distance.js';
import { Material } from './material.js';
import type { L } from './units.js';

/** What a child does to the line's heading, relative to its parent. */
export type SpacefillTurn = 'id' | 'r' | 'l' | 'flip';

export interface SpacefillRule {
  /** Children per side: a cell becomes `n` × `n` of them. */
  n: 2 | 3;
  /** The children in visiting order: `cell` is `[i, j]` in the parent's own
   * frame, `i` across and `j` up, and `turn` the symmetry that child is
   * drawn with. `n²` entries, every cell once, consecutive cells sharing a
   * side. */
  order: readonly { cell: readonly [number, number]; turn: SpacefillTurn }[];
}

export interface SpacefillOpts {
  /** The finest cell, and so the closest two folds ever come. */
  spacing: L;
  /** Tone, 0 to 1. A cell divides while the tone in it is above a threshold
   * that halves every level, so tone 1 reaches `spacing`, tone 0.5 stops one
   * level short, and so on. "In it" is read at cell centres — its own, and
   * the centres of the cells one level down — so a feature smaller than the
   * cell below it may go unread. A leaf is drawn when the tone at its own
   * centre is above 0, and the pen lifts where it is not. Without a field
   * the fill is uniform at `spacing`. */
  field?: (x: number, y: number) => number;
  /** The coarsest cell allowed. No leaf comes out larger than this, so
   * pale tone still folds instead of laying one long chord across the
   * sheet. It divides nothing where the tone is 0: blank paper stays blank
   * and the pen stays up. Unbounded by default, which lets the palest tone
   * open out to the whole square. */
  maxSpacing?: L;
  /** The recursion table (default `hilbertRule`). */
  rule?: SpacefillRule;
}

/** What the toolkit hands the kernel: sketch-time length resolution. */
export interface SpacefillEnv {
  len(l: L): number;
}

/**
 * The classic Hilbert table: a cell divides in four, the first and last
 * children turned to either side so the line enters at one corner of the
 * square and leaves at the next.
 */
export const hilbertRule: SpacefillRule = {
  n: 2,
  order: [
    { cell: [0, 0], turn: 'l' },
    { cell: [0, 1], turn: 'id' },
    { cell: [1, 1], turn: 'id' },
    { cell: [1, 0], turn: 'r' },
  ],
};

/**
 * Peano's table: nine children in a switchback, corner to opposite corner.
 * The folds run in straight columns, so the texture reads as weaving rather
 * than as Hilbert's interlocking hooks.
 */
export const peanoRule: SpacefillRule = {
  n: 3,
  order: [
    { cell: [0, 0], turn: 'id' },
    { cell: [0, 1], turn: 'l' },
    { cell: [0, 2], turn: 'id' },
    { cell: [1, 2], turn: 'r' },
    { cell: [1, 1], turn: 'flip' },
    { cell: [1, 0], turn: 'r' },
    { cell: [2, 0], turn: 'id' },
    { cell: [2, 1], turn: 'l' },
    { cell: [2, 2], turn: 'id' },
  ],
};

/**
 * A meander: nine children, in at one corner and out at the next, the way
 * Hilbert's four are. The walk climbs the first column, crosses the top,
 * comes down the far side and returns through the middle, so the texture is
 * long straight runs caught by hooks. Only one set of turns carries this
 * order, and these are they.
 */
export const meanderRule: SpacefillRule = {
  n: 3,
  order: [
    { cell: [0, 0], turn: 'l' },
    { cell: [0, 1], turn: 'l' },
    { cell: [0, 2], turn: 'id' },
    { cell: [1, 2], turn: 'id' },
    { cell: [2, 2], turn: 'id' },
    { cell: [2, 1], turn: 'flip' },
    { cell: [1, 1], turn: 'r' },
    { cell: [1, 0], turn: 'r' },
    { cell: [2, 0], turn: 'id' },
  ],
};

/**
 * One of the eight symmetries of the square, as `[a, b, c, d]` acting on
 * coordinates measured from the cell's centre. Entries are 0 or ±1, so
 * every corner and every cell index maps exactly.
 */
type Sym = readonly [number, number, number, number];

const ID: Sym = [1, 0, 0, 1];
const FLIP: Sym = [-1, 0, 0, -1];
/** The eight, rotations first. */
const SYMS: readonly Sym[] = [ID, [0, -1, 1, 0], FLIP, [0, 1, -1, 0], [-1, 0, 0, 1], [1, 0, 0, -1], [0, 1, 1, 0], [0, -1, -1, 0]];

/** `s` after `t`: the child's frame is its parent's frame composed with its
 * own turn, which is the whole of the adaptive continuity story. */
const compose = (s: Sym, t: Sym): Sym => [
  s[0] * t[0] + s[1] * t[2],
  s[0] * t[1] + s[1] * t[3],
  s[2] * t[0] + s[3] * t[2],
  s[2] * t[1] + s[3] * t[3],
];

const det = (s: Sym): number => s[0] * s[3] - s[1] * s[2];

/** A corner of the unit square (each coordinate 0 or 1) through `s`. */
const corner = (s: Sym, c: readonly [number, number]): [number, number] => {
  const u = c[0] - 0.5;
  const v = c[1] - 0.5;
  return [s[0] * u + s[1] * v + 0.5, s[2] * u + s[3] * v + 0.5];
};

/** Where cell `[i, j]` of an `n` × `n` grid lands under `s`. */
const cellUnder = (s: Sym, c: readonly [number, number], n: number): [number, number] => {
  const u = (c[0] + 0.5) / n - 0.5;
  const v = (c[1] + 0.5) / n - 0.5;
  return [Math.round((s[0] * u + s[1] * v + 0.5) * n - 0.5), Math.round((s[2] * u + s[3] * v + 0.5) * n - 0.5)];
};

/**
 * The four turns as symmetries, for a motif that enters at `entry` and
 * leaves at `exit`.
 *
 * A turn names a heading: `id` keeps the entry-to-exit direction, `flip`
 * reverses it, `l` and `r` put it a quarter turn to the left and to the
 * right. Two of the eight symmetries produce each heading — one rotation
 * and one reflection — so the pair is split the only way that leaves no
 * gap: `id` and `flip` are the rotations, `l` and `r` the reflections.
 * That reading is what lets one four-word vocabulary write both Hilbert
 * (whose children mirror across a diagonal) and Peano (whose children
 * mirror across an axis).
 */
function turnSyms(entry: readonly [number, number], exit: readonly [number, number]): Record<SpacefillTurn, Sym> | null {
  const dx = exit[0] - entry[0];
  const dy = exit[1] - entry[1];
  const reflection = (wx: number, wy: number): Sym | null => {
    for (const s of SYMS) {
      if (det(s) > 0) continue;
      const e = corner(s, entry);
      const x = corner(s, exit);
      if (x[0] - e[0] === wx && x[1] - e[1] === wy) return s;
    }
    return null;
  };
  const l = reflection(-dy, dx);
  const r = reflection(dy, -dx);
  if (!l || !r) return null;
  return { id: ID, flip: FLIP, l, r };
}

/** A rule checked and solved: where each child sits, the symmetry it is
 * drawn with, and the corners the whole motif enters and leaves at. */
export interface CompiledRule {
  n: number;
  cells: readonly (readonly [number, number])[];
  syms: readonly Sym[];
  entry: readonly [number, number];
  exit: readonly [number, number];
}

const TURNS: readonly SpacefillTurn[] = ['id', 'r', 'l', 'flip'];
/** The corners, counter-clockwise from the origin. */
const CORNERS: readonly (readonly [number, number])[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
const say = (c: readonly [number, number]): string => `[${c[0]}, ${c[1]}]`;

/**
 * Check a rule and solve for the corners it enters and leaves at.
 *
 * The entry and exit corners are not written down: they are implied by the
 * table, because the first child's own entry has to be the parent's, the
 * last child's exit has to be the parent's, and each child has to leave
 * where the next one arrives. Every pair of distinct corners is tried and
 * the one that makes all of that true is the rule's frame. A table with no
 * such frame is not a curve, and is refused by name.
 */
export function compileRule(rule: SpacefillRule, who = 'spacefill'): CompiledRule {
  const n = rule.n;
  if (n !== 2 && n !== 3) throw new Error(`${who}: rule n must be 2 or 3 (got ${String(n)})`);
  const order = rule.order ?? [];
  if (order.length !== n * n) throw new Error(`${who}: a rule with n ${n} needs ${n * n} entries, one per cell (got ${order.length})`);
  const seen = new Set<string>();
  for (const entry of order) {
    const c = entry.cell;
    if (!Array.isArray(c) || c.length !== 2 || !Number.isInteger(c[0]) || !Number.isInteger(c[1]) || c[0] < 0 || c[1] < 0 || c[0] >= n || c[1] >= n) {
      throw new Error(`${who}: rule cell ${Array.isArray(c) ? say(c as [number, number]) : String(c)} is not a cell of the ${n} by ${n} grid`);
    }
    if (!TURNS.includes(entry.turn)) throw new Error(`${who}: rule turn '${String(entry.turn)}' is not one of 'id', 'r', 'l', 'flip'`);
    const key = say(c as [number, number]);
    if (seen.has(key)) throw new Error(`${who}: rule visits cell ${key} twice`);
    seen.add(key);
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (!seen.has(say([i, j]))) throw new Error(`${who}: rule never visits cell ${say([i, j])}`);
    }
  }
  for (let k = 1; k < order.length; k++) {
    const a = order[k - 1].cell;
    const b = order[k].cell;
    if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) !== 1) {
      throw new Error(`${who}: rule jumps from cell ${say(a as [number, number])} to ${say(b as [number, number])} — consecutive cells must share a side`);
    }
  }
  // The frame: the one pair of corners that makes every child meet the next.
  for (const entry of CORNERS) {
    for (const exit of CORNERS) {
      if (entry[0] === exit[0] && entry[1] === exit[1]) continue;
      const syms = turnSyms(entry, exit);
      if (!syms) continue;
      const chosen = order.map((o) => syms[o.turn]);
      let at: [number, number] = [entry[0] * n, entry[1] * n];
      let ok = true;
      for (let k = 0; k < order.length && ok; k++) {
        const cell = order[k].cell;
        const e = corner(chosen[k], entry);
        const x = corner(chosen[k], exit);
        if (cell[0] + e[0] !== at[0] || cell[1] + e[1] !== at[1]) ok = false;
        else at = [cell[0] + x[0], cell[1] + x[1]];
      }
      if (ok && at[0] === exit[0] * n && at[1] === exit[1] * n) {
        return { n, cells: order.map((o) => o.cell), syms: chosen, entry, exit };
      }
    }
  }
  throw new Error(`${who}: no entry and exit corner make this rule's children meet — check the turns, a child must leave where the next one arrives`);
}

/**
 * One folded line over an area.
 *
 * `loops` is the area, already lowered to numbers by the toolkit. The
 * recursion runs over the area's bounding square, grown to a whole number
 * of levels so the finest cell is exactly `spacing`; cells whose centre
 * lies outside the area are dropped, and a dropped run breaks the chain.
 *
 * Degenerate input draws nothing rather than throwing: no area, no
 * spacing, or a square with no side gives an empty material.
 */
export function spacefill(env: SpacefillEnv, loops: readonly (readonly [number, number])[][], opts: SpacefillOpts): Material {
  const compiled = compileRule(opts.rule ?? hilbertRule);
  const spacing = env.len(opts.spacing);
  const coarsest = opts.maxSpacing === undefined ? Infinity : env.len(opts.maxSpacing);
  const empty = (): Material => new Material(new Float64Array(0), new Float64Array(0), {}, new Uint32Array(0));
  if (!(spacing > 0)) return empty();

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const loop of loops) {
    for (const [x, y] of loop) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const span = Math.max(maxX - minX, maxY - minY);
  if (!(span > 0)) return empty();

  const { n, cells, syms } = compiled;
  // Levels enough to reach `spacing`, and a square of exactly that many:
  // the finest cell is the spacing asked for, and the square that makes
  // that true covers the area with room to spare.
  const levels = Math.max(0, Math.ceil(Math.log(span / spacing) / Math.log(n) - 1e-9));
  const side = spacing * n ** levels;
  const x0 = (minX + maxX) / 2 - side / 2;
  const y0 = (minY + maxY) / 2 - side / 2;

  // The cell size at each depth, worked out once. Every cell of a depth
  // then shares one size and one grid, so two cells of the same depth have
  // bit-for-bit equal centres on the axis they share. That is what lets a
  // step be axis-aligned exactly, and not to within a rounding error.
  const sizes: number[] = [side];
  for (let d = 1; d <= levels; d++) sizes.push(sizes[d - 1] / n);

  const field = opts.field;
  // Every leaf the walk reaches, in walk order, marked with whether it is
  // drawn. A skipped leaf is kept as a gap, because the gap is what tells
  // the chain to break rather than to reach across.
  const xs: number[] = [];
  const ys: number[] = [];
  const depths: number[] = [];
  const marks: boolean[] = [];
  const leaf = (cx: number, cy: number, depth: number, drawn: boolean): void => {
    xs.push(cx);
    ys.push(cy);
    depths.push(depth);
    marks.push(drawn);
  };
  /** `ix`, `jy`: the cell's place in the grid of its own depth. */
  const visit = (ix: number, jy: number, sym: Sym, depth: number): void => {
    const size = sizes[depth];
    const x = x0 + ix * size;
    const y = y0 + jy * size;
    const cx = x + size / 2;
    const cy = y + size / 2;
    // Nothing inside the area can live in a cell the area's box misses.
    if (x > maxX || y > maxY || x + size < minX || y + size < minY) {
      leaf(cx, cy, depth, false);
      return;
    }
    const half = depth < levels ? sizes[depth + 1] : size / n;
    // Tone decides both how deep the cell goes and whether it is drawn at
    // all: where the field reads 0, or reads nothing, there is no mark and
    // the line lifts. Without a field every cell is full tone.
    const tone = field ? field(cx, cy) : 1;
    const lit = Number.isFinite(tone) && tone > 0;
    let split = depth < levels;
    if (split && field) {
      // The tone asks for a cell about `spacing / tone` across, so a cell
      // divides while anything in it asks for finer than it is. "Anything
      // in it" is read at the centres the next level would use: judging
      // the cell by its own centre alone would let one pale point in a
      // dark field blank the whole quarter of the picture under it.
      const asks = 2 ** (depth - levels);
      let peak = lit ? tone : 0;
      for (let i = 0; i < n && peak <= asks; i++) {
        for (let j = 0; j < n && peak <= asks; j++) {
          const t = field(x + (i + 0.5) * half, y + (j + 0.5) * half);
          if (Number.isFinite(t) && t > peak) peak = t;
        }
      }
      // `maxSpacing` divides a cell the tone would have left alone, so the
      // palest mark is still a fold. It never divides blank paper: where
      // no tone reaches, there is nothing to fold.
      split = peak > asks || (peak > 0 && size > coarsest * (1 + 1e-9));
    }
    if (!split) {
      leaf(cx, cy, depth, lit);
      return;
    }
    for (let k = 0; k < cells.length; k++) {
      const [i, j] = cellUnder(sym, cells[k], n);
      visit(ix * n + i, jy * n + j, compose(sym, syms[k]), depth + 1);
    }
  };
  visit(0, 0, ID, 0);

  // The area itself, not its box: a skipped centre breaks the line there.
  const inside = distanceTo(loops as [number, number][][]);
  const px: number[] = [];
  const py: number[] = [];
  const level: number[] = [];
  const edges: number[] = [];
  const vertex = (x: number, y: number, depth: number): number => {
    const row = px.length;
    px.push(x);
    py.push(y);
    level.push(depth);
    return row;
  };
  let previous = -1;
  let previousDepth = 0;
  for (let k = 0; k < xs.length; k++) {
    if (!marks[k] || !(inside(xs[k], ys[k]) > 0)) {
      previous = -1;
      continue;
    }
    if (previous >= 0 && xs[k] !== px[previous] && ys[k] !== py[previous]) {
      // A level change. Two cells of one size meet centre to centre along
      // an axis, but a coarse cell and a fine one do not, and the chord
      // between their centres would be a diagonal in a line that has none.
      // So the walk turns a corner instead.
      //
      // The corner is forced, not chosen. The two cells touch along a side,
      // so their centres differ by half of both cells across that side and
      // by less than that along it. Keeping the COARSER cell's coordinate
      // on the axis of the larger difference, and the finer cell's on the
      // other, puts the elbow inside the coarser cell every time. The other
      // elbow lies outside both cells as soon as the levels differ by two.
      const coarseFirst = previousDepth <= depths[k];
      const cxCoarse = coarseFirst ? px[previous] : xs[k];
      const cyCoarse = coarseFirst ? py[previous] : ys[k];
      const cxFine = coarseFirst ? xs[k] : px[previous];
      const cyFine = coarseFirst ? ys[k] : py[previous];
      const across = Math.abs(xs[k] - px[previous]) > Math.abs(ys[k] - py[previous]);
      const elbow = across ? vertex(cxCoarse, cyFine, Math.min(previousDepth, depths[k])) : vertex(cxFine, cyCoarse, Math.min(previousDepth, depths[k]));
      edges.push(previous, elbow);
      previous = elbow;
    }
    const row = vertex(xs[k], ys[k], depths[k]);
    if (previous >= 0) edges.push(previous, row);
    previous = row;
    previousDepth = depths[k];
  }
  if (px.length === 0) return empty();
  return new Material(Float64Array.from(px), Float64Array.from(py), { level: Float64Array.from(level) }, Uint32Array.from(edges), {
    transfers: { level: 'nearest' },
  });
}
