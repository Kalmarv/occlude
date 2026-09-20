/**
 * The seventeen wallpaper groups, as placements.
 *
 * `symmetry(group, …)` answers with plain `TransformOp` records — the same
 * `{ translate, rotate, scale, origin }` a `group(…)` takes — one per copy
 * of the motif. The sketch draws the motif once and hands each record to
 * `group`; nothing here draws, and nothing here knows what a motif is.
 *
 * Each record is read as "turn or flip the motif about `origin`, then move
 * it by `translate`", which is exactly the composition `group` applies:
 * `T(translate) · T(origin) · R(rotate) · S(scale) · T(-origin)`.
 *
 * A rotation is `rotate`. A MIRROR is a negative `scale` about the right
 * pivot: reflecting in a line through `origin` at angle φ is
 * `R(2φ) · diag(1, −1)`, which is `{ rotate: 2φ, scale: [1, -1] }` — and
 * where 2φ is 0 or 180 the rotation falls away and the record is a bare
 * `scale: [1, -1]` or `scale: [-1, 1]`. A GLIDE is a mirror whose
 * `translate` carries the half-step along the mirror line.
 *
 * The lattices and the coset representatives are the IUC definitions
 * (International Tables, plane groups 1–17), written in the sketch's own
 * coordinates with the cell's corner on the origin.
 */

import type { TransformOp } from './execution.js';
import { finiteCount } from './guard.js';

/** The seventeen plane groups by IUC name. */
export type PlaneGroup =
  | 'p1' | 'p2' | 'pm' | 'pg' | 'cm' | 'pmm' | 'pmg' | 'pgg' | 'cmm'
  | 'p4' | 'p4m' | 'p4g' | 'p3' | 'p3m1' | 'p31m' | 'p6' | 'p6m';

/** Every group name, in IUC order. */
export const PLANE_GROUPS: readonly PlaneGroup[] = [
  'p1', 'p2', 'pm', 'pg', 'cm', 'pmm', 'pmg', 'pgg', 'cmm',
  'p4', 'p4m', 'p4g', 'p3', 'p3m1', 'p31m', 'p6', 'p6m',
];

export interface SymmetryOptions {
  /** The cell: `[w, h]` for a rectangular or oblique lattice, one length
   * for a hexagonal one. A square group takes either, and refuses a
   * rectangle that is not square. */
  cell: number | readonly [number, number];
  /** How many cells across and down. */
  cols: number;
  rows: number;
}

/** One coset representative: a turn or a flip about `p`, then a shift `s`. */
interface Op {
  /** A rotation's angle, or a mirror line's angle, in degrees. */
  angle: number;
  mirror?: true;
  /** Pivot, in cell coordinates. */
  p?: readonly [number, number];
  /** The glide half-step, in cell coordinates. */
  s?: readonly [number, number];
}

/** A group's lattice and its coset representatives. */
interface Plan {
  /** The first lattice vector, `[ax, 0]`. */
  ax: number;
  /** The second lattice vector's height; its x is `ax / 2` when staggered. */
  by: number;
  /** A centred (rhombic) or hexagonal lattice: odd rows step half across. */
  stagger: boolean;
  ops: Op[];
}

const HEX: readonly PlaneGroup[] = ['p3', 'p3m1', 'p31m', 'p6', 'p6m'];
const SQUARE: readonly PlaneGroup[] = ['p4', 'p4m', 'p4g'];

const rot = (angle: number): Op => ({ angle });
const mir = (angle: number, p?: readonly [number, number], s?: readonly [number, number]): Op => ({ angle, mirror: true, p, s });

/** The cell as the group reads it: one length for hexagonal and square
 * lattices, two for the rest; a mismatch refuses by name. */
function cellOf(group: PlaneGroup, cell: number | readonly [number, number]): [number, number] {
  const pair = Array.isArray(cell) ? (cell as readonly [number, number]) : null;
  if (HEX.includes(group)) {
    if (pair) throw new Error(`symmetry: ${group} has a hexagonal lattice — cell is ONE length, not [w, h]`);
    return [cell as number, cell as number];
  }
  if (SQUARE.includes(group)) {
    if (!pair) return [cell as number, cell as number];
    if (pair[0] !== pair[1]) throw new Error(`symmetry: ${group} has a square lattice — cell is one length, or [w, h] with w === h (got [${pair[0]}, ${pair[1]}])`);
    return [pair[0], pair[1]];
  }
  if (!pair) throw new Error(`symmetry: ${group} has a rectangular lattice — cell is [w, h], not one length`);
  return [pair[0], pair[1]];
}

/**
 * The lattice and the coset representatives of one group.
 *
 * The count of representatives is the order of the group's point group:
 * 1 2 2 2 2 4 4 4 4 4 8 8 3 6 6 6 12, in IUC order.
 */
function planOf(group: PlaneGroup, w: number, h: number): Plan {
  const rect = (ops: Op[]): Plan => ({ ax: w, by: h, stagger: false, ops });
  // cm and cmm are written on their PRIMITIVE cell: the centred rectangle
  // [w, h] staggers by half a step every row, so one lattice point carries
  // the point group once over, not twice.
  const centred = (ops: Op[]): Plan => ({ ax: w, by: h / 2, stagger: true, ops });
  const hex = (ops: Op[]): Plan => ({ ax: w, by: (w * Math.sqrt(3)) / 2, stagger: true, ops });
  const turns = (n: number): Op[] => Array.from({ length: n }, (_, k) => rot((360 / n) * k));
  switch (group) {
    case 'p1': return rect([rot(0)]);
    case 'p2': return rect([rot(0), rot(180)]);
    case 'pm': return rect([rot(0), mir(90)]);
    // A glide: the mirror in x = 0 carried half a cell ALONG itself.
    case 'pg': return rect([rot(0), mir(90, [0, 0], [0, h / 2])]);
    case 'cm': return centred([rot(0), mir(90)]);
    case 'pmm': return rect([rot(0), rot(180), mir(0), mir(90)]);
    // pmg (ITA 7): x,y; -x,-y; -x+½,y; x+½,-y — the half-step across the
    // vertical mirror moves its axis to x = w/4, the one along the
    // horizontal mirror makes that one a glide.
    case 'pmg': return rect([rot(0), rot(180), mir(90, [w / 4, 0]), mir(0, [0, 0], [w / 2, 0])]);
    // pgg (ITA 8): x,y; -x,-y; -x+½,y+½; x+½,-y+½ — both mirrors move and
    // both glide.
    case 'pgg': return rect([rot(0), rot(180), mir(90, [w / 4, 0], [0, h / 2]), mir(0, [0, h / 4], [w / 2, 0])]);
    case 'cmm': return centred([rot(0), rot(180), mir(0), mir(90)]);
    case 'p4': return rect(turns(4));
    case 'p4m': return rect([...turns(4), mir(0), mir(45), mir(90), mir(135)]);
    // p4g (ITA 12): the diagonal mirrors run through the cell's edge
    // midpoints, and the axial lines are glides.
    case 'p4g': return rect([
      ...turns(4),
      mir(45, [w / 2, 0]), mir(135, [w / 2, 0]),
      mir(90, [w / 4, 0], [0, h / 2]), mir(0, [0, h / 4], [w / 2, 0]),
    ]);
    case 'p3': return hex(turns(3));
    // p3m1's mirrors stand ACROSS the lattice vectors (30°, 90°, 150°), so
    // every 3-fold centre sits on one; p31m's run ALONG them (0°, 60°,
    // 120°), and the centres inside the triangles sit on none.
    case 'p3m1': return hex([...turns(3), mir(30), mir(90), mir(150)]);
    case 'p31m': return hex([...turns(3), mir(0), mir(60), mir(120)]);
    case 'p6': return hex(turns(6));
    case 'p6m': return hex([...turns(6), mir(0), mir(30), mir(60), mir(90), mir(120), mir(150)]);
  }
}

/** Degrees folded into [0, 360). */
const turn = (deg: number): number => ((deg % 360) + 360) % 360;

/** One coset representative at one lattice point, as a `TransformOp`. */
function record(op: Op, tx: number, ty: number): TransformOp {
  const translate: readonly [number, number] = [tx + (op.s ? op.s[0] : 0), ty + (op.s ? op.s[1] : 0)];
  const origin: readonly [number, number] = op.p ?? [0, 0];
  if (!op.mirror) {
    const angle = turn(op.angle);
    return angle === 0 ? { translate } : { translate, rotate: angle, origin };
  }
  const twice = turn(op.angle * 2);
  // A reflection in the line through `origin` at φ is R(2φ)·diag(1, −1);
  // at 2φ = 0 and 180 that is a plain flip of one axis, so say so.
  if (twice === 0) return { translate, scale: [1, -1], origin };
  if (twice === 180) return { translate, scale: [-1, 1], origin };
  return { translate, rotate: twice, scale: [1, -1], origin };
}

/** Placements over a block of lattice points, `u0 ≤ u < u1`, `v0 ≤ v < v1`. */
export function placements(group: PlaneGroup, cell: number | readonly [number, number], u0: number, u1: number, v0: number, v1: number): TransformOp[] {
  if (!PLANE_GROUPS.includes(group)) {
    throw new Error(`symmetry: '${String(group)}' is not a plane group — one of ${PLANE_GROUPS.join(' ')}`);
  }
  const [w, h] = cellOf(group, cell);
  // A mid-edit zero or a non-finite cell lays out nothing, the way a zero
  // count does.
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return [];
  const plan = planOf(group, w, h);
  const cols = finiteCount('symmetry', u1 - u0);
  const rows = finiteCount('symmetry', v1 - v0);
  if (cols === 0 || rows === 0) return [];
  finiteCount('symmetry', cols * rows * plan.ops.length);
  const out: TransformOp[] = [];
  for (let v = v0; v < v0 + rows; v++) {
    const ty = v * plan.by;
    // The staggered lattices step half a cell across on odd rows; the
    // half-step is the second lattice vector, folded back by a whole one.
    const stagger = plan.stagger && (v & 1) !== 0 ? plan.ax / 2 : 0;
    for (let u = u0; u < u0 + cols; u++) {
      const tx = u * plan.ax + stagger;
      for (const op of plan.ops) out.push(record(op, tx, ty));
    }
  }
  return out;
}

/**
 * The placements of one wallpaper group over a `cols × rows` block of
 * cells, the first cell's corner on the origin.
 *
 * Hand each record to `group(placement, motif)` and the motif repeats under
 * the group. The count is `cols · rows · n`, where n is the order of the
 * point group: p1 1, p2/pm/pg/cm 2, p3 3, pmm/pmg/pgg/cmm/p4 4, p3m1/p31m/p6
 * 6, p4m/p4g 8, p6m 12.
 *
 * `t.symmetry(group, { cell })` is the same thing with the block sized to
 * cover the drawable.
 */
export function symmetry(group: PlaneGroup, opts: SymmetryOptions): TransformOp[] {
  return placements(group, opts.cell, 0, opts.cols, 0, opts.rows);
}

/** The lattice step of a group's cell: how far one cell reaches across and
 * down, which is what a drawable-sized block is counted in. */
export function cellStep(group: PlaneGroup, cell: number | readonly [number, number]): [number, number] {
  const [w, h] = cellOf(group, cell);
  const plan = planOf(group, w, h);
  return [plan.ax, plan.by];
}
