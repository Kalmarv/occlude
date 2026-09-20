/**
 * Colour as data: sRGB → CIE Lab, and the weighted k-means that turns a
 * picture's pixels into a palette.
 *
 * Nothing here knows about the paper, the placement or the seed — bytes in,
 * numbers out — so `imageAsset.ts` can memo the histogram on the decoded
 * entry beside the summed-area tables and reuse it for every palette the
 * sketch asks for.
 *
 * The pixels are binned before anything is fitted: five bits per channel,
 * so at most 32768 distinct colours, each carrying the weighted mean of the
 * pixels that landed in it rather than the bin's own corner. A photograph of
 * four million pixels and a synthetic image of four therefore cost the fit
 * the same, and the numbers are the same as fitting the pixels themselves to
 * within a bin's width. Alpha is the weight: a transparent pixel is not a
 * colour the picture contains, so it holds no share and pulls no centre.
 *
 * The Lloyd iteration is NOT the one in `points.ts`. That one relaxes points
 * on the sheet against a density field, through a Voronoi diagram of the
 * plane, and its per-site work is an integrated demand over cells; this one
 * is a plain weighted k-means over at most 32768 points of a three
 * dimensional colour space with no geometry at all. The two share the name
 * of the algorithm and no code worth pulling apart.
 */

/** The space distances are measured in. Lab is perceptual: equal distances
 * look about equally different, which is what a palette wants. */
export type ColourSpace = 'lab' | 'rgb';

/** A point in the working space. */
export type ColourPoint = readonly [number, number, number];

const BITS = 5;
const SHIFT = 8 - BITS;
const SIDE = 1 << BITS;
const CELLS = SIDE * SIDE * SIDE;

/** sRGB 0…255 → linear 0…1. */
function linear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

// D65, the white point sRGB is defined against.
const XN = 0.95047;
const YN = 1;
const ZN = 1.08883;
const EPS = 216 / 24389;
const KAPPA = 841 / 108;

const fold = (t: number): number => (t > EPS ? Math.cbrt(t) : KAPPA * t + 4 / 29);

/** sRGB 0…255 → CIE L*a*b* (D65). */
export function labOf(r: number, g: number, b: number): [number, number, number] {
  const rl = linear(r);
  const gl = linear(g);
  const bl = linear(b);
  const fx = fold((0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / XN);
  const fy = fold((0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl) / YN);
  const fz = fold((0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl) / ZN);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** A colour as a point of the working space. `rgb` keeps the bytes, so the
 * two spaces have comparable magnitudes and one distance formula serves. */
export function colourPoint(space: ColourSpace, r: number, g: number, b: number): [number, number, number] {
  return space === 'lab' ? labOf(r, g, b) : [r, g, b];
}

/** `#rgb`, `#rrggbb` or a pen's `color`, as sRGB 0…255. */
export function rgbOfHex(hex: string, who: string): [number, number, number] {
  const s = String(hex).trim().replace(/^#/, '');
  const full = s.length === 3 ? s[0] + s[0] + s[1] + s[1] + s[2] + s[2] : s;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`${who}: '${String(hex)}' is not a colour — write it as #rrggbb or #rgb`);
  }
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const byte = (v: number): string => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');

/** sRGB 0…255 → `#rrggbb`. */
export function hexOfRgb(r: number, g: number, b: number): string {
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/** The picture's colours, binned. Parallel arrays of length `n`: the mean
 * sRGB in the bin, its point in the working space, and its weight (the sum
 * of the alphas that landed there). */
export interface ColourBins {
  readonly r: Float64Array;
  readonly g: Float64Array;
  readonly b: Float64Array;
  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly pz: Float64Array;
  readonly w: Float64Array;
  readonly n: number;
  /** The weight of every bin together — the picture's opaque pixel count. */
  readonly total: number;
  readonly space: ColourSpace;
}

/** Bin an RGBA buffer. Transparent pixels are skipped: they are not a
 * colour the picture contains. */
export function colourBins(data: Uint8ClampedArray, space: ColourSpace): ColourBins {
  const w = new Float64Array(CELLS);
  const sr = new Float64Array(CELLS);
  const sg = new Float64Array(CELLS);
  const sb = new Float64Array(CELLS);
  let total = 0;
  for (let o = 0; o + 3 < data.length; o += 4) {
    const a = data[o + 3] / 255;
    if (a <= 0) continue;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    const k = ((r >> SHIFT) << (2 * BITS)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);
    w[k] += a;
    sr[k] += r * a;
    sg[k] += g * a;
    sb[k] += b * a;
    total += a;
  }
  let n = 0;
  for (let k = 0; k < CELLS; k++) if (w[k] > 0) n++;
  const out = {
    r: new Float64Array(n),
    g: new Float64Array(n),
    b: new Float64Array(n),
    px: new Float64Array(n),
    py: new Float64Array(n),
    pz: new Float64Array(n),
    w: new Float64Array(n),
    n,
    total,
    space,
  };
  let i = 0;
  for (let k = 0; k < CELLS; k++) {
    if (w[k] <= 0) continue;
    const r = sr[k] / w[k];
    const g = sg[k] / w[k];
    const b = sb[k] / w[k];
    out.r[i] = r;
    out.g[i] = g;
    out.b[i] = b;
    const [x, y, z] = colourPoint(space, r, g, b);
    out.px[i] = x;
    out.py[i] = y;
    out.pz[i] = z;
    out.w[i] = w[k];
    i++;
  }
  return out;
}

/** The weight a set of centres carries, and the mean sRGB of what fell to
 * each — a nearest-centre Voronoi in the working space, no fitting. */
export function tally(
  bins: ColourBins,
  centres: readonly ColourPoint[],
): { weight: number; r: number; g: number; b: number }[] {
  const k = centres.length;
  const out = Array.from({ length: k }, () => ({ weight: 0, r: 0, g: 0, b: 0 }));
  if (k === 0) return out;
  for (let i = 0; i < bins.n; i++) {
    const c = nearest(centres, bins.px[i], bins.py[i], bins.pz[i]);
    const w = bins.w[i];
    const e = out[c];
    e.weight += w;
    e.r += bins.r[i] * w;
    e.g += bins.g[i] * w;
    e.b += bins.b[i] * w;
  }
  for (const e of out) {
    if (e.weight > 0) {
      e.r /= e.weight;
      e.g /= e.weight;
      e.b /= e.weight;
    }
  }
  return out;
}

/** The index of the nearest centre. Ties go to the earlier centre, so the
 * answer never depends on the order the pixels were visited. */
export function nearest(centres: readonly ColourPoint[], x: number, y: number, z: number): number {
  let best = 0;
  let bd = Infinity;
  for (let c = 0; c < centres.length; c++) {
    const dx = x - centres[c][0];
    const dy = y - centres[c][1];
    const dz = z - centres[c][2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

/** A fitted colour: where it sits in the working space, the mean sRGB of
 * the pixels that chose it, and how much of the picture that is. */
export interface ColourCluster {
  centre: [number, number, number];
  r: number;
  g: number;
  b: number;
  weight: number;
}

const MAX_ROUNDS = 32;

/**
 * Weighted k-means over the bins, in descending weight.
 *
 * The centres are seeded from the picture and from nothing else — no run
 * seed reaches here, so the same file gives the same palette in every sketch
 * that reads it. The seeding is the greedy form of k-means++: the heaviest
 * bin first, then, each time, the bin with the largest weight times squared
 * distance to the nearest centre already chosen. That is the quantity
 * k-means++ samples in proportion to, taken at its maximum instead of drawn,
 * which needs no randomness at all and so needs no stream to draw it from.
 *
 * A picture with fewer distinct colours than were asked for returns fewer
 * clusters, and an empty cluster is dropped rather than kept as a colour the
 * picture does not have.
 */
export function fitPalette(bins: ColourBins, k: number): ColourCluster[] {
  const n = bins.n;
  const want = Math.min(k, n);
  if (want <= 0) return [];

  const seeds: number[] = [];
  let heaviest = 0;
  for (let i = 1; i < n; i++) if (bins.w[i] > bins.w[heaviest]) heaviest = i;
  seeds.push(heaviest);
  const near = new Float64Array(n).fill(Infinity);
  while (seeds.length < want) {
    const s = seeds[seeds.length - 1];
    const sx = bins.px[s];
    const sy = bins.py[s];
    const sz = bins.pz[s];
    let pick = -1;
    let score = 0;
    for (let i = 0; i < n; i++) {
      const dx = bins.px[i] - sx;
      const dy = bins.py[i] - sy;
      const dz = bins.pz[i] - sz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < near[i]) near[i] = d;
      const sc = bins.w[i] * near[i];
      if (sc > score) {
        score = sc;
        pick = i;
      }
    }
    // Every remaining bin sits exactly on a centre already chosen: the
    // picture has fewer distinct colours than were asked for.
    if (pick < 0) break;
    seeds.push(pick);
  }

  let centres: [number, number, number][] = seeds.map((i) => [bins.px[i], bins.py[i], bins.pz[i]]);
  const owner = new Int32Array(n).fill(-1);
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const c = nearest(centres, bins.px[i], bins.py[i], bins.pz[i]);
      if (owner[i] !== c) {
        owner[i] = c;
        moved = true;
      }
    }
    if (!moved) break;
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const s = sums[owner[i]];
      const w = bins.w[i];
      s[0] += bins.px[i] * w;
      s[1] += bins.py[i] * w;
      s[2] += bins.pz[i] * w;
      s[3] += w;
    }
    centres = centres.map((c, j) => {
      const s = sums[j];
      return s[3] > 0 ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : c;
    });
  }

  const counts = tally(bins, centres);
  const out: ColourCluster[] = [];
  for (let c = 0; c < centres.length; c++) {
    if (counts[c].weight <= 0) continue;
    out.push({ centre: centres[c], r: counts[c].r, g: counts[c].g, b: counts[c].b, weight: counts[c].weight });
  }
  out.sort((a, b) => b.weight - a.weight);
  return out;
}
