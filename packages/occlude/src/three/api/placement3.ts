/**
 * An isometry of hyperbolic space as a VALUE — the 3D sibling of the 2D
 * `Placement` (src/placement.ts), with the same verbs: `point`, `then`,
 * `inverse`, and the hand it has in `orientation`.
 *
 * It lives in its own module, not in hyperbolic.ts, because `Mesh` and
 * `CurveGeometry` take one in `transform`, and hyperbolic.ts builds meshes.
 *
 * Under it is the engine's Lorentz record (src/hyperbolicSpace.ts). The
 * record stays private: a sketch holds the four verbs, and `then` and
 * `inverse` are the engine's `compose` and `inverse`, so a chain of them is
 * one matrix and not a chain of closures.
 *
 * `point` works on Klein coordinates. A Lorentz isometry acts on the ball
 * projectively, so a straight Klein chord stays a straight chord: moving
 * the two ends of a wire moves the whole wire exactly.
 */

import { apply, compose, inverse as undo, type Lorentz } from '../../hyperbolicSpace.js';
import type { Vec3 } from '../math.js';

/** An isometry of hyperbolic space, in the Klein ball. */
export interface Placement3 {
  /** −1 when the isometry turns space over — an odd number of
   * reflections — and +1 when it does not. */
  readonly orientation: 1 | -1;
  /** Where this isometry sends a Klein point. A fresh triple out. */
  point(p: Vec3): Vec3;
  /** Apply this, then `next`. */
  then(next: Placement3): Placement3;
  /** The isometry that undoes this one. */
  inverse(): Placement3;
}

const records = new WeakMap<Placement3, Lorentz>();

function recordOf(who: string, value: unknown): Lorentz {
  const record = typeof value === 'object' && value !== null ? records.get(value as Placement3) : undefined;
  if (!record) throw new Error(`placement3.${who}: expected a Placement3 from honeycomb or observer`);
  return record;
}

/** The value over one engine record. Internal: sketches get placements from
 * `honeycomb` and `observer`. */
export function placement3(record: Lorentz): Placement3 {
  const value: Placement3 = Object.freeze({
    orientation: record.mirror ? -1 : 1,
    point: (p: Vec3): Vec3 => apply(record, p),
    // `next` after this: the matrices multiply the other way round.
    then: (next: Placement3): Placement3 => placement3(compose(recordOf('then', next), record)),
    inverse: (): Placement3 => placement3(undo(record)),
  });
  records.set(value, record);
  return value;
}

/** Is this a 3D placement? Structural: it answers `point`, `then` and
 * `inverse`, and it has a hand. A 2D `Placement` answers the same verbs but
 * also carries the `door` of its plane, and is not one. */
export function isPlacement3(v: unknown): v is Placement3 {
  if (typeof v !== 'object' || v === null || 'door' in v) return false;
  const p = v as Partial<Placement3>;
  return (
    typeof p.point === 'function'
    && typeof p.then === 'function'
    && typeof p.inverse === 'function'
    && (p.orientation === 1 || p.orientation === -1)
  );
}
