/**
 * coil: wind a chain into a spring as it goes — a helix seen flat, at a
 * radius and a pitch that may both vary over the page.
 *
 * `oscillate` swings from side to side and crosses the chain twice a
 * cycle. A coil never crosses it: the loop goes round. The offset is
 *
 *     tangent · r · sin(2πφ)  +  normal · r · (1 − cos(2πφ))
 *
 * which is a circle of radius r rolled along the chain, touching it at
 * φ = 0 and reaching 2r to one side at half a turn. So the line leaves the
 * chain, goes round and comes back to it once per turn, and the chain
 * itself stays inside the coil instead of being cut by it. `pitch` is the
 * arc length of one turn, and it is the same `number | (x, y) => number`
 * an amplitude is, so tone can drive it: a short pitch where the picture
 * is dark packs more loops into the same run of chain.
 *
 * The result is ordinary Material — the same chains, the same order, with
 * more vertices — so it strokes, resamples, thickens, carries columns and
 * is occluded like anything else. Over `connect.tour` of a stippling it is
 * a continuous scribble portrait; over `rulings()` it is a curl hatch;
 * over lettering it is a loop-the-loop hand. None of those are modes.
 *
 * Phase is INTEGRATED along the chain, φ(s) = ∫ ds/pitch, not computed as
 * s/pitch. With a varying pitch those differ, and only the integral keeps
 * the loops continuous. A closed chain rounds its total to a whole number
 * of turns (never below one), so the seam meets itself instead of showing
 * a step.
 *
 * Pure and deterministic: no seed, no paper. Lengths are resolved material
 * coordinates, so an unresolved `mm(1)` is refused rather than read against
 * global paper, exactly as `oscillate` and `thicken` refuse it.
 */

import { Material, material as makeMaterial, type Station } from './material.js';
import { valueAt } from './guard.js';
import { chainsMaterial, byChain, type OscillateAmount } from './oscillate.js';

export interface CoilOpts {
  /** How far the loop reaches from the chain: the radius of the rolled
   * circle, so the coil is 2r wide. Zero leaves the chain where it is;
   * negative winds the other way. A number in the material's own
   * coordinates, or a field read at the sample. */
  radius: OscillateAmount;
  /** Arc length of one whole turn. Must be positive wherever it is read;
   * where it is not, the chain runs straight through. */
  pitch: OscillateAmount;
  /** Phase at the start of every chain, in turns. Default 0. */
  phase?: number;
  /** Samples per turn (default 24, minimum 4). A loop is a circle, so it
   * wants more samples than a swing; more is rounder and costs more ink. */
  steps?: number;
}

const TAU = Math.PI * 2;

/** Missing and unresolved are different mistakes and get different advice:
 * a length such as `mm(1)` is a real attempt at an answer, and the thing to
 * say is that this operation works in the material's own coordinates. */
function requireAmount(v: unknown, name: string, what: string): void {
  if (v === undefined || v === null) throw new Error(`coil: ${name} is required — ${what}`);
  if (typeof v !== 'number' && typeof v !== 'function') throw new Error(`coil: ${name} must be a finite number in the material's own coordinates, or a field of them — ${String(v)} is not resolved here (mm(1) and the other lengths need the sketch frame, as for thicken)`);
}

/** The amount at one station, or zero where the field does not answer with
 * a finite number — that station keeps still while the rest wind. */
function amountAt(v: OscillateAmount, x: number, y: number): number {
  return valueAt(typeof v === 'function' ? v(x, y) : v, 0);
}


/**
 * Wind `m`'s chains into a coil. Returns new Material and never touches the
 * source. Chains only: a junction is an error, as it is for `along` and
 * `oscillate`, because a branch has no single side to wind about.
 */
export function coil(m: Material, opts: CoilOpts): Material {
  const source = makeMaterial(m);
  requireAmount(opts?.radius, '{ radius }', 'how far the loop reaches from the chain');
  requireAmount(opts?.pitch, '{ pitch }', 'the arc length of one whole turn');
  const phase0 = opts.phase ?? 0;
  if (!Number.isFinite(phase0)) throw new Error('coil: { phase } must be a finite number of turns');
  const steps = opts.steps ?? 24;
  if (!Number.isInteger(steps) || steps < 4) throw new Error(`coil: { steps } must be a whole number of samples per turn, at least 4 (got ${String(opts.steps)})`);
  // No radius anywhere is no coil: the chains are the chains they were,
  // with the vertices they already had.
  if (typeof opts.radius === 'number' && opts.radius === 0) return chainsMaterial(source.along(), source, 'coil');

  // A first pass over the chains' own vertices finds the shortest pitch
  // anywhere on the material, which sets how finely it has to be walked: a
  // fixed spacing would either miss loops where the winding is tight or
  // spend vertices where it is loose.
  let shortest = Infinity;
  for (const st of source.along()) {
    const p = amountAt(opts.pitch, st.x, st.y);
    if (p > 0) shortest = Math.min(shortest, p);
  }
  // Nowhere to wind at all — an empty material, or a pitch no station can
  // read: the chains come through straight.
  if (!Number.isFinite(shortest)) return chainsMaterial(source.along(), source, 'coil');
  const out: Station[] = [];
  for (const fine of byChain(source.along({ spacing: shortest / steps }))) {
    if (fine.length < 2) continue;
    // Phase by integration, so a pitch that changes along the chain still
    // advances the winding continuously.
    const turns: number[] = [0];
    for (let k = 1; k < fine.length; k++) {
      const a = fine[k - 1];
      const b = fine[k];
      const ds = Math.hypot(b.x - a.x, b.y - a.y);
      const p = (amountAt(opts.pitch, a.x, a.y) + amountAt(opts.pitch, b.x, b.y)) / 2;
      // A span with no pitch on it advances no phase: the winding holds
      // where it was and the span is drawn straight.
      turns.push(turns[k - 1] + (p > 0 ? ds / p : 0));
    }
    // A ring must come back to the phase it left, or the seam shows a step.
    // `along` walks a closed chain from the seam and never repeats it, so
    // the closing segment back to the first station is not in `turns`; the
    // loop to fit is the whole loop.
    let span = turns[turns.length - 1];
    if (fine[0].closed) {
      const a = fine[fine.length - 1];
      const b = fine[0];
      const p = (amountAt(opts.pitch, a.x, a.y) + amountAt(opts.pitch, b.x, b.y)) / 2;
      if (p > 0) span += Math.hypot(b.x - a.x, b.y - a.y) / p;
    }
    const fit = fine[0].closed && span > 0 ? Math.max(1, Math.round(span)) / span : 1;
    for (let k = 0; k < fine.length; k++) {
      const st = fine[k];
      const r = amountAt(opts.radius, st.x, st.y);
      // A station whose pitch is not a positive length has no turn to sit
      // on: it keeps the offset the winding had when it arrived.
      const phi = TAU * (phase0 + turns[k] * fit);
      const along = r * Math.sin(phi);
      const aside = r * (1 - Math.cos(phi));
      out.push({
        ...st,
        x: st.x + st.tangent[0] * along + st.normal[0] * aside,
        y: st.y + st.tangent[1] * along + st.normal[1] * aside,
      });
    }
  }
  return chainsMaterial(out, source, 'coil');
}
