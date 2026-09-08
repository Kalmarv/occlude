/**
 * The evolution grid's arithmetic, with no DOM: what a variation of a
 * drawing is (the same seed with some draws overridden), how far one
 * strays at a given variation level, and how draws cool as picks confirm
 * them. The page (evolvePage.ts) renders and chooses; this decides.
 */

export interface Candidate {
  seed: string;
  overrides: Record<string, number>;
}

/** The middle drawing's addressed draws: what a variation moves. */
export interface Draws {
  addrs: string[];
  f: Float64Array;
}

/** The page's own randomness: which draws to nudge and by how much. Seeded,
 * so a session replays; never the sketch's stream. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gaussian = (rng: () => number): number => {
  const u = Math.max(1e-12, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const clampUnit = (f: number): number => Math.min(0.999999, Math.max(0, f));

/**
 * One variation of `centre`: `m` of its draws moved, chosen by heat, each
 * either jumped anywhere in its range (probability T) or nudged by a
 * gaussian of width T/4. Pure given the rng.
 */
export function mutate(centre: Candidate, draws: Draws, heat: Map<string, number>, T: number, rng: () => number): Candidate {
  const n = draws.addrs.length;
  if (n === 0) return { seed: centre.seed, overrides: { ...centre.overrides } };
  const m = Math.max(1, Math.min(n, Math.round(n * T * T)));
  // Weighted sample without replacement: the key trick, larger key = picked.
  const keyed = draws.addrs.map((addr, i) => ({ i, key: Math.pow(rng(), 1 / Math.max(0.05, heat.get(addr) ?? 1)) }));
  keyed.sort((a, b) => b.key - a.key);
  const overrides = { ...centre.overrides };
  for (const { i } of keyed.slice(0, m)) {
    const addr = draws.addrs[i];
    const f = draws.f[i];
    overrides[addr] = rng() < T ? clampUnit(rng()) : clampUnit(f + gaussian(rng) * (T / 4));
  }
  return { seed: centre.seed, overrides };
}

/** After a pick: draws the pick changed stay hot, the rest cool. */
export function cool(heat: Map<string, number>, draws: Draws, from: Candidate, picked: Candidate): void {
  for (const addr of draws.addrs) {
    const changed = picked.overrides[addr] !== undefined && picked.overrides[addr] !== from.overrides[addr];
    heat.set(addr, changed ? 1 : Math.max(0.05, (heat.get(addr) ?? 1) * 0.7));
  }
}

