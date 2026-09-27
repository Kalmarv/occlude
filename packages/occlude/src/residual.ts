/**
 * Ink as a budget: a tone surface the drawing pays down.
 *
 * Every tonal recipe in the library is open-loop. A field says how dark a
 * place should be, a word puts marks there, and nothing ever measures what
 * was laid down: the second pass cannot know what the first one already
 * paid, so overlapping passes double the ink and a greedy line has no idea
 * where it is still owed. A residual closes that loop. It is a LATTICE with
 * one column, `owed`: the target darkness on a grid of faces. `spend` (the
 * lattice's word) takes the nib footprint of the marks that were drawn off
 * it and returns the lattice that is left; `faces.sum('owed')` is the debt;
 * `field()` is the debt as a field, so `scatter`, `isolines`, `streamlines`
 * and a decimate amount all read it unchanged.
 *
 * Nothing mutates. A ledger is a sequence of values — `r = r.spend(…)` —
 * and every earlier one still reads what it read, which is what a snapshot
 * used to be for. A spend copies the one column it pays down and shares
 * the rest; Law 3 is untouched: the ledger is a pure function of the
 * seeded sequence of spends.
 *
 * This is a raster, and the "raster-based coverage" refusal in CLAUDE.md is
 * not about this. That refusal is about the engine judging what is HIDDEN:
 * occlusion is exact and stays exact, computed on the strokes this produces
 * like any others. What is rastered here is the TONE the artist is paying
 * down — a bookkeeping surface over the picture, never a decision about
 * visibility.
 */

import type { AreaInput } from './boundary.js';
import { latticeOf, type Lattice, type LatticeEnv } from './lattice.js';
import type { Bounds, FieldFn2 } from './points.js';
import { mm, type L } from './units.js';
import { describe } from './views.js';
// Type-only (erased): a shape is recognised and refused here, never
// lowered — the toolkit does that, where the sketch frame is known.
import type { ShapeValue } from './api.js';

/** Environment handed in by the toolkit: drawable bounds and sketch-time
 * length resolution, both in user units — the pair `isolines` and `lattice`
 * take. */
export interface ResidualEnv extends LatticeEnv {
  bounds: Bounds;
  len(l: L): number;
}

export interface ResidualOpts {
  /** Face size in user units (`mm(0.8)` allowed). Default the grid step
   * `t.isolines` uses: `mm(1)`, or the long side over 256 where that is
   * coarser. */
  spacing?: L;
  /** The area that owes anything, default the drawable. Outside it nothing
   * is owed: the lattice has no face there, so a mark there takes nothing
   * and the field is absent. A shape is lowered by the toolkit, where the
   * sketch frame exists. */
  area?: AreaInput | ShapeValue;
}

/**
 * Build a residual: a lattice whose one column, `owed`, is `field` read at
 * each face's centre and held to 0…1 (a sample that is not a number owes
 * nothing — one bad sample degrades that face, not the drawing). The
 * toolkit's `t.residual` is this with the drawable and the sketch's length
 * resolution filled in; a shape area is already lowered to loops by the
 * time it arrives.
 */
export function residualOf(env: ResidualEnv, field: FieldFn2, opts: ResidualOpts = {}): Lattice {
  if (typeof field !== 'function') {
    throw new Error(
      `residual: the first argument is the target darkness as a field, (x, y) => 0…1 — got ${describe(field)}`,
    );
  }
  const b = env.bounds;
  const spacing = opts.spacing ?? Math.max(env.len(mm(1)), Math.max(b.w, b.h) / 256);
  const owed = (x: number, y: number): number => {
    const v = field(x, y);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  };
  return latticeOf(env, { spacing, area: opts.area, channels: ['owed'] }, owed, 'residual');
}
