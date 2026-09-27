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
 * run of chain, and a large amplitude makes each swing reach further. In a
 * curved space the wavelength is a length of the material's space: the
 * stations and the phase both measure along the chain in it.
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
 * A waveform may also move ALONG the chain: a pair `[along, across]` is
 * an offset on the tangent and on the normal, both in amplitudes. A circle
 * rolled along the chain, `(u) => [Math.sin(2πu), 1 − Math.cos(2πu)]`, is
 * a coil: the loop leaves the chain, goes round and comes back to it once
 * per wavelength, never crossing it, and the coil is two amplitudes wide.
 *
 * Pure and deterministic: no seed, no paper. Lengths are resolved material
 * coordinates, so an unresolved `mm(1)` is refused rather than read against
 * global paper, exactly as `thicken` refuses it.
 */

import { Material, material as makeMaterial, alongSamples, type ChainSample } from './material.js';
import { PointRows, EdgeRows, rebuild } from './tables.js';
import { at64 } from './column.js';
import { chainsOf } from './curves.js';
import { valueAt } from './guard.js';

/** A number in the source material's coordinates, or a field read at the sample. */
export type OscillateAmount = number | ((x: number, y: number) => number);

export interface OscillateOpts {
  /** Distance along the chain for one whole cycle. Must be positive wherever
   * it is read. */
  wavelength: OscillateAmount;
  /** How far the chain swings to either side. Zero leaves the chain where it
   * is; negative mirrors the waveform. */
  amplitude: OscillateAmount;
  /** The waveform: phase in [0, 1) to −1…1 across the chain, or to a pair
   * `[along, across]` that also moves along it (a coil is a rolled circle).
   * Both in amplitudes. Default `sin(2πu)`. */
  shape?: (u: number) => number | readonly [number, number];
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

/** The amount at one station, or zero where the field does not answer with
 * a finite number — that station keeps still while the rest swing. */
function amountAt(v: OscillateAmount, x: number, y: number): number {
  return valueAt(typeof v === 'function' ? v(x, y) : v, 0);
}

/** The swung stations as ordinary Material: the source's own columns and
 * their transfer policies, the chains reconnected in walk order, and rings
 * closed. Deliberately NOT what `along` answers, which also writes
 * `heading`, `s` and `u` as columns — the place of each point on its chain —
 * but that bookkeeping is not part of the drawing, and carrying it would
 * surprise the next operation (planarize asks for a resolver for a
 * `heading` two crossing chains disagree on).
 *
 * On a network, `junctions` names the stations that ARE a source junction
 * (station index → source row): each junction is one vertex, with its own
 * id, that every chain meeting it joins. A verb that has not said where its
 * junctions are cannot keep them, and says so in its own name. */
export function chainsMaterial(stations: readonly ChainSample[], source: Material, who = 'oscillate', junctions?: ReadonlyMap<number, number>): Material {
  if (!junctions) {
    for (let i = 0; i < source.n; i++) {
      if (source.adjacentRows(i).length > 2) throw new Error(`${who}: vertex ${i} is a junction — ${who} walks chains only`);
    }
  }
  if (!stations.length) return makeMaterial([]);
  // A swing makes the chain LONGER than the chain it came from, so a column
  // that conserves a quantity over the parts of an edge has no length to
  // conserve it over. Refuse it by name rather than carry a number that is
  // no longer what it says.
  for (const name of source.store.edgeAttrNames) {
    if (source.edgeTransfers[name] === 'distribute') {
      throw new Error(`${who}: edge column '${name}' is 'distribute', and ${who} changes the length it would be shared over — copy it, or drop it first`);
    }
  }
  // A row per station, except that the stations at one junction share one,
  // which takes the place and the columns of the last of them.
  const rowOf = new Int32Array(stations.length);
  const junctionRow = new Map<number, number>();
  const sourceOfRow: number[] = [];
  const last: number[] = [];
  for (let k = 0; k < stations.length; k++) {
    const v = junctions?.get(k);
    const had = v === undefined ? undefined : junctionRow.get(v);
    if (had !== undefined) {
      rowOf[k] = had;
      last[had] = k;
      continue;
    }
    rowOf[k] = sourceOfRow.length;
    last.push(k);
    sourceOfRow.push(v ?? -1);
    if (v !== undefined) junctionRow.set(v, rowOf[k]);
  }
  // Every row is new geometry, its columns read where its station lies on
  // the source; a junction keeps its id.
  const points = new PointRows(source, who);
  sourceOfRow.forEach((v, row) => {
    const q = stations[last[row]];
    points.between(q.a, q.b, q.t, q.x, q.y, v < 0 ? NaN : at64(source.store.pointIds, v));
  });
  // An edge column stays an EDGE column. A span takes the value of the
  // source edge its first station lies on, which is what `'copy'` means for
  // a part of an edge; it is a new wall.
  const edges = new EdgeRows(source);
  const span = (from: number, a: number, b: number) => edges.cover(stations[from].copy, a, b, [], 'own');
  let runStart = 0;
  stations.forEach((q, k) => {
    const row = rowOf[k];
    if (k > 0 && stations[k - 1].chain === q.chain) span(k - 1, rowOf[k - 1], row);
    else if (k > 0) runStart = k;
    const end = k === stations.length - 1 || stations[k + 1].chain !== q.chain;
    if (end && q.closed && k > runStart + 1) span(k, row, rowOf[runStart]);
  });
  return rebuild(source, { ...points.done(), ...edges.done() }, { iteration: 0, faceAttrs: {} });
}

/** The samples of one chain, in walk order. */
export function byChain(stations: readonly ChainSample[]): ChainSample[][] {
  const out: ChainSample[][] = [];
  let current: ChainSample[] | null = null;
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
 * touches the source. On a network — a hex field, a tiling, a voronoi — it
 * swings each chain of `curves` on its own, junction to junction: a
 * junction has no single side to swing to, so it stays where it is, one
 * vertex with its own id, and a chain that ends at one fits a whole number
 * of cycles, as a ring does, so the swing arrives there at the phase it
 * left with.
 */
export function oscillate(m: Material, opts: OscillateOpts): Material {
  const source = makeMaterial(m);
  requireAmount(opts?.wavelength, '{ wavelength }', 'the distance along the chain for one whole cycle');
  requireAmount(opts?.amplitude, '{ amplitude }', 'how far the chain swings to either side');
  const shape = opts.shape ?? ((u: number) => Math.sin(TAU * u));
  if (typeof shape !== 'function') throw new Error('oscillate: { shape } must be a function of phase in [0, 1) returning -1…1, or a pair [along, across]');
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
  for (const st of alongSamples(source)) {
    const lam = amountAt(opts.wavelength, st.x, st.y);
    if (lam > 0) shortest = Math.min(shortest, lam);
  }
  // Nowhere to swing at all — an empty material, or a wavelength no station
  // can read: the chains come through straight.
  const chains = chainsOf(source);
  const isJunction = (v: number): boolean => source.adjacentRows(v).length > 2;
  let network = false;
  for (let v = 0; v < source.n && !network; v++) network = isJunction(v);
  // The stations that are a junction: a chain's first, and an open chain's
  // last, when the vertex there is one. A material with none has none.
  const junctionsOf = (stations: readonly ChainSample[]): Map<number, number> | undefined => {
    if (!network) return undefined;
    const at = new Map<number, number>();
    stations.forEach((st, k) => {
      const idx = chains[st.chain].indices;
      const first = k === 0 || stations[k - 1].chain !== st.chain;
      const last = k === stations.length - 1 || stations[k + 1].chain !== st.chain;
      if (first && isJunction(idx[0])) at.set(k, idx[0]);
      else if (last && !st.closed && isJunction(idx[idx.length - 1])) at.set(k, idx[idx.length - 1]);
    });
    return at;
  };
  if (!Number.isFinite(shortest)) {
    const straight = alongSamples(source);
    return chainsMaterial(straight, source, 'oscillate', junctionsOf(straight));
  }
  // The phase is measured in the space the chains are walked in, the one
  // `along` spaces the stations by: a wavelength is a length of the space,
  // as the spacing is.
  const curved = source.space !== undefined && source.space.kind !== 'euclidean' ? source.space : null;
  const gap = (a: ChainSample, b: ChainSample): number =>
    curved ? curved.distance([a.x, a.y], [b.x, b.y]) : Math.hypot(b.x - a.x, b.y - a.y);
  const out: ChainSample[] = [];
  for (const fine of byChain(alongSamples(source, { spacing: shortest / steps }))) {
    if (fine.length < 2) continue;
    // Phase by integration, so a wavelength that changes along the chain
    // still advances the swing continuously.
    const cycles: number[] = [0];
    for (let k = 1; k < fine.length; k++) {
      const a = fine[k - 1];
      const b = fine[k];
      const ds = gap(a, b);
      const lam = (amountAt(opts.wavelength, a.x, a.y) + amountAt(opts.wavelength, b.x, b.y)) / 2;
      // A span with no wavelength on it advances no phase: the swing holds
      // where it was and the span is drawn straight.
      cycles.push(cycles[k - 1] + (lam > 0 ? ds / lam : 0));
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
      const lam = (amountAt(opts.wavelength, a.x, a.y) + amountAt(opts.wavelength, b.x, b.y)) / 2;
      if (lam > 0) span += gap(a, b) / lam;
    }
    // A chain that ends at a junction has to arrive there in step too.
    const idx = chains[fine[0].chain].indices;
    const endsAtJunction = !fine[0].closed && isJunction(idx[idx.length - 1]);
    const fit = (fine[0].closed || endsAtJunction) && span > 0 ? Math.max(1, Math.round(span)) / span : 1;
    for (let k = 0; k < fine.length; k++) {
      const st = fine[k];
      // A junction holds still: every chain that meets it meets it there.
      if ((k === 0 && isJunction(idx[0])) || (k === fine.length - 1 && endsAtJunction)) {
        out.push(st);
        continue;
      }
      const a = amountAt(opts.amplitude, st.x, st.y);
      // A station whose wavelength is not a positive length has no cycle to
      // sit on, and one whose waveform gives no number has no offset: either
      // way it stays where the chain put it.
      const lam = amountAt(opts.wavelength, st.x, st.y);
      if (!(lam > 0)) {
        out.push(st);
        continue;
      }
      const wave = shape((((phase0 + cycles[k] * fit) % 1) + 1) % 1);
      if (Array.isArray(wave)) {
        const along = a * valueAt(wave[0], 0);
        const across = a * valueAt(wave[1], 0);
        out.push({
          ...st,
          x: st.x + st.tangent[0] * along + st.normal[0] * across,
          y: st.y + st.tangent[1] * along + st.normal[1] * across,
        });
        continue;
      }
      const swing = a * valueAt(wave, 0);
      out.push({ ...st, x: st.x + st.normal[0] * swing, y: st.y + st.normal[1] * swing });
    }
  }
  return chainsMaterial(out, source, 'oscillate', junctionsOf(out));
}
