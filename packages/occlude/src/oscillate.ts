/**
 * oscillate: swing a chain from side to side as it goes, at a wavelength and
 * an amplitude that may both vary over the page.
 *
 * The result is ordinary Material — the same chains, the same order, with
 * more vertices — so it strokes, resamples, thickens, carries columns and
 * is occluded like anything else. Applied to `rulings()` it is a hatch that
 * darkens by zig-zagging instead of by crowding, which is the cheapest grey
 * a plotter draws: one continuous pen-down stroke per line rather than many.
 * Applied to `t.isolines` it is a tonal contour drawing; applied to a
 * lettering spine it is a scribble. None of those are modes — they are what
 * you get by handing it a different material.
 *
 * `wavelength` and `amplitude` are numbers in the source material's own
 * coordinates, or fields read at each sample, so tone can drive either: a
 * short wavelength where the picture is dark packs more swings into the same
 * run of chain, and a large amplitude makes each swing reach further.
 *
 * Phase is INTEGRATED along the chain, φ(s) = ∫ ds/λ, not computed as s/λ.
 * With a varying wavelength those differ, and only the integral keeps the
 * swings continuous — otherwise the wave jumps wherever λ changes. A closed
 * chain rounds its total to a whole number of cycles (never below one), so
 * the seam meets itself instead of showing a step; an open chain keeps the
 * wavelength it was asked for.
 *
 * `shape` is the waveform, a plain function of phase in [0, 1) returning
 * −1…1. The default is a sine. A triangle, a sawtooth, a square, a clipped
 * sine are all one-liners the caller writes — recipes, not options.
 *
 * Pure and deterministic: no seed, no paper. Lengths are resolved material
 * coordinates, so an unresolved `mm(1)` is refused rather than read against
 * global paper, exactly as `thicken` refuses it.
 */

import { Material, material as makeMaterial, type Station, type TransferPolicy } from './material.js';

/** A number in the source material's coordinates, or a field read at the sample. */
export type OscillateAmount = number | ((x: number, y: number) => number);

export interface OscillateOpts {
  /** Distance along the chain for one whole cycle. Must be positive wherever
   * it is read. */
  wavelength: OscillateAmount;
  /** How far the chain swings to either side. Zero leaves the chain where it
   * is; negative mirrors the waveform. */
  amplitude: OscillateAmount;
  /** The waveform: phase in [0, 1) to −1…1. Default `sin(2πu)`. */
  shape?: (u: number) => number;
  /** Phase at the start of every chain, in cycles. Default 0. */
  phase?: number;
  /** Samples per wavelength (default 16, minimum 4). More is rounder and
   * costs more ink to plot; a triangle wave needs few, a sine wants more. */
  steps?: number;
}

const TAU = Math.PI * 2;

/** Missing and unresolved are different mistakes and get different advice:
 * a length such as `mm(1)` is a real attempt at an answer, and the thing to
 * say is that this operation works in the material's own coordinates. */
function requireAmount(v: unknown, name: string, what: string): void {
  if (v === undefined || v === null) throw new Error(`oscillate: ${name} is required — ${what}`);
  if (typeof v !== 'number' && typeof v !== 'function') throw new Error(`oscillate: ${name} must be a finite number in the material's own coordinates, or a field of them — ${String(v)} is not resolved here (mm(1) and the other lengths need the sketch frame, as for thicken)`);
}

function amountAt(v: OscillateAmount, x: number, y: number, what: string): number {
  const n = typeof v === 'function' ? v(x, y) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`oscillate: ${what} is ${String(n)} at (${x}, ${y}) — it must be a finite number in the material's own coordinates (mm(1) and the other lengths are not resolved here)`);
  return n;
}

/** The swung stations as ordinary Material: the source's own columns and
 * their transfer policies, the chains reconnected in walk order, and rings
 * closed. Deliberately NOT `stationsMaterial`, which also writes `heading`,
 * `s`, `u`, `length` and `chain` as columns for the studio's inspector to
 * colour by — useful there, but station bookkeeping is not part of the
 * drawing, and carrying it would surprise the next operation (planarize
 * asks for a resolver for a `heading` two crossing chains disagree on). */
function chainsMaterial(stations: readonly Station[]): Material {
  if (!stations.length) return makeMaterial([]);
  const pointNames = new Set(stations.flatMap((q) => Object.keys(q.attrs)));
  const edgeNames = new Set(stations.flatMap((q) => Object.keys(q.edgeAttrs)));
  for (const name of edgeNames) {
    if (pointNames.has(name)) throw new Error(`oscillate: '${name}' is both a point and an edge column on the source — rename one before swinging it`);
  }
  const cols: Record<string, Float64Array> = {};
  for (const name of [...pointNames, ...edgeNames]) cols[name] = new Float64Array(stations.length).fill(NaN);
  const policies: Record<string, TransferPolicy> = {};
  const edges: number[] = [];
  let runStart = 0;
  stations.forEach((q, k) => {
    for (const name of Object.keys(q.attrs)) {
      cols[name][k] = q.attrs[name];
      const policy = q.transfers?.[name] ?? 'interpolate';
      if (policy !== 'interpolate') policies[name] = policy;
    }
    for (const name of Object.keys(q.edgeAttrs)) cols[name][k] = q.edgeAttrs[name];
    if (k > 0 && stations[k - 1].chain === q.chain) edges.push(k - 1, k);
    else if (k > 0) runStart = k;
    const last = k === stations.length - 1 || stations[k + 1].chain !== q.chain;
    if (last && q.closed && k > runStart + 1) edges.push(k, runStart);
  });
  return new Material(
    Float64Array.from(stations, (q) => q.x), Float64Array.from(stations, (q) => q.y),
    cols, Uint32Array.from(edges), 0, [], {}, policies,
  );
}

/** Stations of one chain, in walk order. */
function byChain(stations: readonly Station[]): Station[][] {
  const out: Station[][] = [];
  let current: Station[] | null = null;
  let chain = -1;
  for (const st of stations) {
    if (st.chain !== chain) {
      chain = st.chain;
      current = [];
      out.push(current);
    }
    current!.push(st);
  }
  return out;
}

/**
 * Swing `m`'s chains from side to side. Returns new Material and never
 * touches the source. Chains only: a junction is an error, as it is for
 * `along` and `resample`, because a branch has no single side to swing to.
 */
export function oscillate(m: Material, opts: OscillateOpts): Material {
  const source = makeMaterial(m);
  requireAmount(opts?.wavelength, '{ wavelength }', 'the distance along the chain for one whole cycle');
  requireAmount(opts?.amplitude, '{ amplitude }', 'how far the chain swings to either side');
  const shape = opts.shape ?? ((u: number) => Math.sin(TAU * u));
  if (typeof shape !== 'function') throw new Error('oscillate: { shape } must be a function of phase in [0, 1) returning -1…1');
  const phase0 = opts.phase ?? 0;
  if (!Number.isFinite(phase0)) throw new Error('oscillate: { phase } must be a finite number of cycles');
  const steps = opts.steps ?? 16;
  if (!Number.isInteger(steps) || steps < 4) throw new Error(`oscillate: { steps } must be a whole number of samples per wavelength, at least 4 (got ${String(opts.steps)})`);

  // A first pass over the chains' own vertices finds the shortest wavelength
  // anywhere on the material, which sets how finely it has to be walked: a
  // fixed spacing would either miss swings where the wave is tight or spend
  // vertices where it is loose. One pass, so the whole material is walked at
  // the finest chain's rate.
  let shortest = Infinity;
  for (const st of source.along()) {
    const lam = amountAt(opts.wavelength, st.x, st.y, '{ wavelength }');
    if (!(lam > 0)) throw new Error(`oscillate: { wavelength } is ${lam} at (${st.x}, ${st.y}) — it must be positive everywhere a chain goes`);
    shortest = Math.min(shortest, lam);
  }
  if (!Number.isFinite(shortest)) return makeMaterial([]);
  const out: Station[] = [];
  for (const fine of byChain(source.along({ spacing: shortest / steps }))) {
    if (fine.length < 2) continue;
    // Phase by integration, so a wavelength that changes along the chain
    // still advances the swing continuously.
    const cycles: number[] = [0];
    for (let k = 1; k < fine.length; k++) {
      const a = fine[k - 1];
      const b = fine[k];
      const ds = Math.hypot(b.x - a.x, b.y - a.y);
      const lam = (amountAt(opts.wavelength, a.x, a.y, '{ wavelength }') + amountAt(opts.wavelength, b.x, b.y, '{ wavelength }')) / 2;
      if (!(lam > 0)) throw new Error(`oscillate: { wavelength } is ${lam} on chain ${a.chain} — it must be positive everywhere a chain goes`);
      cycles.push(cycles[k - 1] + ds / lam);
    }
    // A ring must come back to the phase it left, or the seam shows a step.
    // `along` walks a closed chain from the seam and never repeats it, so the
    // stations span L - spacing and the closing segment back to the first is
    // not in `cycles`. Fitting the whole number of cycles to that short span
    // would leave the remainder to fall across the seam as a jump; the loop
    // to fit is the whole loop.
    let span = cycles[cycles.length - 1];
    if (fine[0].closed) {
      const a = fine[fine.length - 1];
      const b = fine[0];
      const lam = (amountAt(opts.wavelength, a.x, a.y, '{ wavelength }') + amountAt(opts.wavelength, b.x, b.y, '{ wavelength }')) / 2;
      span += Math.hypot(b.x - a.x, b.y - a.y) / lam;
    }
    const fit = fine[0].closed && span > 0 ? Math.max(1, Math.round(span)) / span : 1;
    for (let k = 0; k < fine.length; k++) {
      const st = fine[k];
      const a = amountAt(opts.amplitude, st.x, st.y, '{ amplitude }');
      const swing = a * shape((((phase0 + cycles[k] * fit) % 1) + 1) % 1);
      out.push({ ...st, x: st.x + st.normal[0] * swing, y: st.y + st.normal[1] * swing });
    }
  }
  return chainsMaterial(out);
}
