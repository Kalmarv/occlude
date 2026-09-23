/**
 * Assets: uploaded files (SVGs, images) referenced from sketches by name.
 * Images are NEVER drawn — placement exists only to map pixel data into
 * sketch coordinates so samples can drive actual plot features (sizes,
 * densities, pen choices, deformations).
 *
 * Sketches are synchronous, so the host (studio runner / headless tools)
 * PRELOADS every asset named by a string literal in `asset('…')` or
 * `image('…')` before the sketch executes, then registers it here. Names
 * must therefore be literals, not computed.
 *
 * Sampling is value-returning, uniform shape `(x, y, area?)`:
 * point samples are bilinear; passing `area` (sketch units) averages over
 * a box of that half-size via summed-area tables — O(1) whatever the size,
 * so "the average over the region this 5mm circle covers" is
 * `img.lum(cx, cy, 2.5)` and costs four lookups.
 */

import {
  colourBins, colourPoint, fitPalette, hexOfRgb, nearest, rgbOfHex, tally,
  type ColourBins, type ColourPoint, type ColourSpace,
} from './colour.js';
import { finishContours, type IsoContour, sampleGrid } from './isolines.js';
import { chainSegments, marchSegments, type SampledGrid } from './marching.js';

export interface AssetPixels {
  width: number;
  height: number;
  /** RGBA, row-major, 0–255. */
  data: Uint8ClampedArray;
}

export interface AssetEntry {
  text?: string;
  pixels?: AssetPixels;
  /** Lazy summed-area tables, keyed by channel. */
  sat?: Map<string, Float64Array>;
  /** Lazy colour histogram per working space — a pure memo of the pixels,
   * like `sat`, so every palette a sketch asks for bins the image once. */
  bins?: Map<ColourSpace, ColourBins>;
}

/** The assets a run captured, by name — an execution input, never a
 * registry. Build one with `assetTable`; a host may keep decoded entries
 * across runs (the summed-area tables an entry caches are a pure memo of
 * its pixels). */
export type AssetTable = ReadonlyMap<string, AssetEntry>;

/** An asset table from named text and image entries. */
export function assetTable(
  entries: Iterable<readonly [string, { text: string } | { pixels: AssetPixels }]> = [],
): AssetTable {
  const out = new Map<string, AssetEntry>();
  for (const [name, e] of entries) out.set(name, 'text' in e ? { text: e.text } : { pixels: e.pixels });
  return out;
}

function entryOf(assets: AssetTable | undefined, name: string): AssetEntry {
  const e = assets?.get(name);
  if (!e) {
    const known = assets ? [...assets.keys()].join(', ') || '(none preloaded)' : '(none preloaded)';
    throw new Error(
      `unknown asset '${name}' — upload it in the Assets panel and reference it by a string literal. Loaded: ${known}`,
    );
  }
  return e;
}

/** Text of an uploaded asset (SVGs etc): `svg(asset('church.svg'), …)`. */
export function asset(assets: AssetTable | undefined, name: string): string {
  const e = entryOf(assets, name);
  if (e.text === undefined) {
    throw new Error(`asset '${name}' is an image — use image('${name}', { … }) to sample it`);
  }
  return e.text;
}

type Channel = 'r' | 'g' | 'b' | 'a' | 'lum';

// A channel as a number: 0–3 is the byte's offset in the RGBA quad, LUM is
// the weighted sum. The samplers carry the code, not the name — a bilinear
// sample reads four pixels and `edge` takes four samples, so a string
// switch per pixel read was sixteen string comparisons per edge query.
const LUM = 4;
const codeOf = (ch: Channel): number =>
  ch === 'r' ? 0 : ch === 'g' ? 1 : ch === 'b' ? 2 : ch === 'a' ? 3 : LUM;

function channelValue(px: AssetPixels, i: number, code: number): number {
  const o = i * 4;
  return code === LUM
    ? 0.2126 * px.data[o] + 0.7152 * px.data[o + 1] + 0.0722 * px.data[o + 2]
    : px.data[o + code];
}

/** (w+1)×(h+1) summed-area table for a channel, built once per asset. */
function satOf(e: AssetEntry, ch: Channel): Float64Array {
  e.sat ??= new Map();
  let t = e.sat.get(ch);
  if (t) return t;
  const px = e.pixels!;
  const { width: w, height: h } = px;
  const data = px.data;
  const code = codeOf(ch);
  const lum = code === LUM;
  const W1 = w + 1;
  t = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    const cur = (y + 1) * W1;
    const prev = y * W1;
    let o = y * w * 4;
    for (let x = 0; x < w; x++, o += 4) {
      row += lum ? 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2] : data[o + code];
      t[cur + x + 1] = t[prev + x + 1] + row;
    }
  }
  e.sat.set(ch, t);
  return t;
}

export interface ImagePlacement {
  /** Top-left of the sampling rect, sketch units. Default 0,0. */
  x?: number;
  y?: number;
  /** Width in sketch units (bare = percent of the drawable's short side).
   * Height follows the image's aspect unless given. Default 100. */
  width?: number;
  height?: number;
}

export interface ImageSampler {
  /** Placed size in sketch units. */
  readonly width: number;
  readonly height: number;
  /** Luminance 0–1. `area` (sketch units) averages a box of that half-size. */
  lum(x: number, y: number, area?: number): number;
  /** [r, g, b] each 0–1. */
  rgb(x: number, y: number, area?: number): [number, number, number];
  /** Alpha 0–1. */
  a(x: number, y: number, area?: number): number;
  /** Posterized tone: 0 (darkest) … n−1 (lightest). */
  bands(x: number, y: number, n: number, area?: number): number;
  /** Gradient magnitude of luminance, 0–~1 (edges bright). */
  edge(x: number, y: number, area?: number): number;
  /** Gradient direction of luminance, radians (perpendicular = contour). */
  dir(x: number, y: number, area?: number): number;
  /** The direction the picture's structure RUNS, as a vector field over the
   * sheet: along hair, drapery, bark, the edge of a leaf — not across it.
   *
   * `img.dir` is the raw gradient angle at one point, which stumbles wherever
   * the picture is noisy or flat. This is that gradient turned a quarter
   * turn and then made to agree with its neighbours: each cell is replaced by
   * the sum of the cells around it, every one flipped into the same
   * half-plane first (a direction has no sign here), weighted by a kernel
   * that falls off with distance, by how much stronger that neighbour's edge
   * is, and by how much its direction already agrees. Repeat, and flat
   * regions take their direction from the nearest strong edge instead of from
   * noise, so a streamline keeps running ALONG a boundary rather than
   * wandering across it.
   *
   * `radius` is how far that agreement reaches, in sketch units (default the
   * image's width / 64), and `iterations` how many times it is applied (3).
   * There is no separate resolution: the working grid is derived from
   * `radius`, fine enough to resolve it and no finer, because the two are not
   * independent — a finer grid needs a proportionally wider neighbourhood to
   * reach the same distance, so asking for both makes the cost grow with the
   * fourth power of one number. As it stands, halving `radius` quadruples the
   * work; a radius so small that the grid would exceed four million cells is
   * refused rather than attempted. Vectors are unit length, and `[0, 0]`
   * outside the placed rect, so `t.streamlines` stops at the edge of the
   * picture.
   *
   * It is a plain vector field, so `rotate`, `scale`, `within` and
   * `t.streamlines` take it like any other. */
  flow(opts?: { radius?: number; iterations?: number }): (x: number, y: number) => [number, number];
  /** A channel as a scalar field over the sheet, `(x, y) => number`, so an
   * image drives anything a field drives: `t.isolines(img.field('lum'), …)`,
   * `t.scatter(img.field('dark'), …)`, `t.streamlines(curl(img.field('lum')))`,
   * a modifier's amount. `dark` is `1 − lum` inside the picture and 0 outside it; `area` averages as the
   * samplers do. Outside the placed rect the field is 0.
   *
   * `r`, `g` and `b` are the colour channels as they are stored. `c`, `m`,
   * `y` and `k` are the printer's four, with the grey taken out: `k` is how
   * much of the tone all three inks share, and each of the other three is
   * what is left of its own ink once that grey is removed. So a pen per
   * channel prints the picture, and a grey area asks for black alone. */
  field(channel?: ImageChannel, opts?: { area?: number }): (x: number, y: number) => number;
  /**
   * The colours the picture is actually made of, most of the paper first.
   *
   * Given a count, it fits that many colours to the pixels — a weighted
   * k-means in Lab, seeded from the picture itself and not from the sketch's
   * seed, so a file gives the same palette wherever it is read. Given
   * colours of your own — hex strings, or pens — it fits nothing and assigns
   * every pixel to the nearest of them. A picture with fewer distinct
   * colours than were asked for gives fewer entries.
   *
   * Each entry is data: `share` is how much of the picture it holds,
   * `field()` is its membership as an ordinary scalar field (1 at the colour
   * itself, 0.5 halfway to the next nearest, 0 where another colour wins),
   * and `contours(level)` is that field's contours. An entry is an area, so
   * `t.scatter(e.field())` stipples one separation and `polygon(e)`
   * outlines it.
   *
   * Transparent pixels hold no share and belong to no colour.
   */
  palette(colors: PaletteSource, opts?: { space?: ColourSpace }): PaletteEntry[];
  /**
   * The picture as a stack of flat colour areas, lightest first, so drawing
   * them in order lets the dark ones hide the light ones underneath.
   *
   * It is `palette(count)` followed by a sweep for connected patches: a
   * patch smaller than `tolerance` of the picture is absorbed into whatever
   * surrounds it, so a separation is areas and not confetti. `count: 2` is
   * a monochrome trace.
   *
   * Each region answers `contours()`, so `polygon(region, …)` takes it
   * directly, and `share` is the fraction of the picture it covers — the
   * word a palette entry uses; `area` is always a measured size.
   */
  regions(opts?: RegionOpts): ImageRegion[];
  /** The same pixels as a field over surface chart coordinates, for 3D tone,
   * density or attributes: `tone: img.surface({ channel: 'dark' })`. Chart
   * (0,0) is the image's bottom-left by default (v up); `wrap` clamps or
   * repeats outside [0,1]; `area` is a box half-size in chart units, applied
   * as one prefilter so CPU and GPU evaluation sample identical pixels.
   * Luminance is Rec. 709. The placement rectangle plays no part here. */
  surface(opts?: SurfaceImageOptions): (s: { readonly uv?: readonly [number, number] }) => number;
}
export interface SurfaceImageOptions {
  channel?: 'lum' | 'dark' | 'a';
  origin?: 'bottom-left' | 'top-left';
  wrap?: 'clamp' | 'repeat';
  area?: number;
  /** Corner column holding the chart coordinates; default `uv`. */
  uv?: string;
}

export type ImageChannel = 'lum' | 'dark' | 'a' | 'edge' | 'r' | 'g' | 'b' | 'c' | 'm' | 'y' | 'k';

/** What `img.palette` takes: how many colours to fit, or which colours to
 * use — hex strings, or anything with a `color`, such as a pen. */
export type PaletteSource = number | readonly string[] | readonly { color: string }[];

/** One colour of a picture's palette. */
export interface PaletteEntry {
  /** The colour, as lower-case `#rrggbb`. A colour you named yourself comes
   * back in that spelling, so `pens[entry.color]` is a stable lookup. */
  readonly color: string;
  /** The fraction of the picture's opaque pixels nearest this colour, 0–1. */
  readonly share: number;
  /** Membership as a scalar field: 1 at this colour, 0.5 halfway to the
   * next nearest, below 0.5 where another colour is nearer, 0 outside the
   * placed rect and wherever the picture is transparent. `area` averages
   * the pixels first, as every other image field does. */
  field(opts?: { area?: number }): (x: number, y: number) => number;
  /** The contours of `field()` at `level` — 0.5, the default, is exactly
   * where this colour stops being the nearest one. Closed along the edge of
   * the picture, so the result fills. It is the accessor every area
   * consumer reads, so an entry goes to `polygon` or `t.within` as it is. */
  contours(level?: number): IsoContour[];
}

export interface RegionOpts {
  /** How many colours to separate into. Default 4; `2` is a monochrome
   * trace. */
  count?: number;
  /** A connected patch smaller than this fraction of the picture is
   * absorbed into what surrounds it. Default 0.002. */
  tolerance?: number;
}

/** One flat colour area of a picture. It answers `contours()`, so every
 * area consumer — `polygon`, `t.within`, `t.hatch` — takes it as it is. */
export interface ImageRegion {
  /** The region's colour, as lower-case `#rrggbb`. */
  readonly color: string;
  /** The fraction of the placed rectangle this region covers, 0–1. A
   * transparent part of the picture belongs to no region, so the regions
   * add up to the part the picture actually covers. */
  readonly share: number;
  /** Its closed boundary, outer contours and holes together, for even-odd
   * filling. A call, not a property: it builds a new collection. */
  contours(): IsoContour[];
}
import { imageValue3, prefilterPixels3, registerToneRecipe3, type ImageRecipe3 } from './three/surface/tone.js';

/**
 * A sampler over an uploaded image, mapped into sketch space. Draws
 * nothing. Outside the placed rect every sample is 0.
 */
export function image(assets: AssetTable | undefined, name: string, place: ImagePlacement = {}): ImageSampler {
  const e = entryOf(assets, name);
  if (!e.pixels) {
    throw new Error(`asset '${name}' is not an image — use asset('${name}') for its text`);
  }
  const px = e.pixels;
  const { x: ox = 0, y: oy = 0, width = 100 } = place;
  const height = place.height ?? (width * px.height) / px.width;
  const sx = px.width / width; // image px per sketch unit
  const sy = px.height / height;

  const W = px.width;
  const bilinear = (code: number, ux: number, uy: number): number => {
    const fx = Math.min(px.width - 1, Math.max(0, ux * sx - 0.5));
    const fy = Math.min(px.height - 1, Math.max(0, uy * sy - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(px.width - 1, x0 + 1);
    const y1 = Math.min(px.height - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    return (
      channelValue(px, y0 * W + x0, code) * (1 - tx) * (1 - ty) +
      channelValue(px, y0 * W + x1, code) * tx * (1 - ty) +
      channelValue(px, y1 * W + x0, code) * (1 - tx) * ty +
      channelValue(px, y1 * W + x1, code) * tx * ty
    );
  };

  // Summed-area tables per channel, held here so the hot path (a scatter
  // asks millions of times) does no map lookup or closure allocation.
  const names: readonly Channel[] = ['r', 'g', 'b', 'a', 'lum'];
  const sats: (Float64Array | undefined)[] = [];
  const boxAvg = (code: number, ux: number, uy: number, area: number): number => {
    const t = sats[code] ?? (sats[code] = satOf(e, names[code]));
    const x0 = Math.max(0, Math.min(W, Math.round((ux - area) * sx)));
    const x1 = Math.max(0, Math.min(W, Math.round((ux + area) * sx)));
    const y0 = Math.max(0, Math.min(px.height, Math.round((uy - area) * sy)));
    const y1 = Math.max(0, Math.min(px.height, Math.round((uy + area) * sy)));
    const n = (x1 - x0) * (y1 - y0);
    if (n <= 0) return bilinear(code, ux, uy);
    const W1 = W + 1;
    return (t[y1 * W1 + x1] - t[y1 * W1 + x0] - t[y0 * W1 + x1] + t[y0 * W1 + x0]) / n;
  };

  const placed = (x: number, y: number): boolean => {
    const ux = x - ox;
    const uy = y - oy;
    return ux >= 0 && uy >= 0 && ux <= width && uy <= height;
  };
  const sample = (code: number, x: number, y: number, area?: number): number => {
    const ux = x - ox;
    const uy = y - oy;
    if (ux < 0 || uy < 0 || ux > width || uy > height) return 0;
    const raw = area && area > 0 ? boxAvg(code, ux, uy, area) : bilinear(code, ux, uy);
    // Every channel is documented as 0 to 1, and a sketch is entitled to
    // believe it: `Math.pow(1 - dark, 1.4)` is NaN if `dark` comes back as
    // 1.0000000000000004. Bilinear weights and summed-area subtraction are
    // exact in principle and a rounding out either way in practice, so the
    // range is enforced here rather than left for every caller to guard.
    const v = raw / 255;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  };

  const edge = (x: number, y: number, area?: number): number => {
    const eps = 1 / sx; // one source pixel, in sketch units
    const gx = sample(LUM, x + eps, y, area) - sample(LUM, x - eps, y, area);
    const gy = sample(LUM, x, y + eps, area) - sample(LUM, x, y - eps, area);
    return Math.hypot(gx, gy) / 2;
  };

  const inside = (x: number, y: number): boolean => {
    const ux = x - ox;
    const uy = y - oy;
    return ux >= 0 && uy >= 0 && ux <= width && uy <= height;
  };

  // The printer's four, with the grey removed: k is the tone all three inks
  // share and comes out of each of them, so the four sum to the tone that is
  // actually printed and a grey area asks for black alone. Outside the placed
  // rect every channel is 0 like every other field — which has to be said
  // here, because "no colour at all" reads as full black before the removal.
  const inkValue = (which: number, x: number, y: number, area?: number): number => {
    if (!inside(x, y)) return 0;
    const c0 = 1 - sample(0, x, y, area);
    const m0 = 1 - sample(1, x, y, area);
    const y0 = 1 - sample(2, x, y, area);
    const k = Math.min(c0, m0, y0);
    if (which === 3) return k;
    if (k >= 1) return 0;
    const v = ((which === 0 ? c0 : which === 1 ? m0 : y0) - k) / (1 - k);
    return v < 0 ? 0 : v > 1 ? 1 : v;
  };

  // One working raster for every area question the sampler answers — the
  // palette's contours and the regions' labels alike. It is the image's own
  // pixels, thinned so the long side is at most CONTOUR_CELLS: a contour
  // traced at photographic resolution is a quarter of a million vertices of
  // staircase, far below the nib, and the plot is the same drawing without
  // them.
  const CONTOUR_CELLS = 384;
  const thin = Math.min(1, CONTOUR_CELLS / Math.max(px.width, px.height));
  const bandCols = Math.max(2, Math.round(px.width * thin));
  const bandRows = Math.max(2, Math.round(px.height * thin));
  const bandW = width / bandCols;
  const bandH = height / bandRows;
  // The lattice sits on the cell centres, so the closing ring the marching
  // adds falls exactly on the edge of the picture.
  const lattice = { x: ox + bandW / 2, y: oy + bandH / 2, w: width - bandW, h: height - bandH };
  const march = (grid: SampledGrid, level: number): IsoContour[] =>
    finishContours(chainSegments(marchSegments(grid, level, true)), lattice, true);

  const binsFor = (space: ColourSpace): ColourBins => {
    e.bins ??= new Map();
    let b = e.bins.get(space);
    if (!b) {
      b = colourBins(px.data, space);
      e.bins.set(space, b);
    }
    return b;
  };

  /** Membership of centre `i`: 1 at that colour, 0.5 where the next nearest
   * is equally close, 0 where the picture is transparent or absent. The
   * ratio is scale free, so it reads the same in Lab and in RGB. */
  const membership = (
    space: ColourSpace,
    centres: readonly ColourPoint[],
    i: number,
    area?: number,
  ) => (x: number, y: number): number => {
    if (!inside(x, y)) return 0;
    const a = sample(3, x, y, area);
    if (a <= 0) return 0;
    const p = colourPoint(space, sample(0, x, y, area) * 255, sample(1, x, y, area) * 255, sample(2, x, y, area) * 255);
    if (centres.length < 2) return a;
    let mine = Infinity;
    let other = Infinity;
    for (let c = 0; c < centres.length; c++) {
      const dx = p[0] - centres[c][0];
      const dy = p[1] - centres[c][1];
      const dz = p[2] - centres[c][2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (c === i) mine = d;
      else if (d < other) other = d;
    }
    const sum = mine + other;
    return sum > 0 ? (other / sum) * a : a;
  };

  return {
    width,
    height,
    lum: (x, y, area) => sample(LUM, x, y, area),
    rgb: (x, y, area) => [sample(0, x, y, area), sample(1, x, y, area), sample(2, x, y, area)],
    a: (x, y, area) => sample(3, x, y, area),
    bands: (x, y, n, area) =>
      Math.min(Math.max(1, Math.floor(n)) - 1, Math.floor(sample(LUM, x, y, area) * n)),
    edge,
    dir: (x, y, area) => {
      const eps = 1 / sx;
      const gx = sample(LUM, x + eps, y, area) - sample(LUM, x - eps, y, area);
      const gy = sample(LUM, x, y + eps, area) - sample(LUM, x, y - eps, area);
      return Math.atan2(gy, gx);
    },
    flow(opts = {}) {
      const iterations = opts.iterations ?? 3;
      if (!Number.isInteger(iterations) || iterations < 0) throw new Error(`image.flow: iterations must be a non-negative whole number, got ${String(opts.iterations)}`);
      const reach = opts.radius ?? width / 64;
      // No radius, no neighbourhood to average over: the field has no
      // opinion anywhere, which is what [0, 0] says here — the same answer
      // it gives outside the picture.
      if (!(reach > 0)) return () => [0, 0];
      // The working grid comes from the radius: CELLS_PER_RADIUS cells across
      // it, so the neighbourhood is the same handful of cells whatever the
      // radius, and the cost grows with the grid alone rather than with the
      // grid times the neighbourhood. Each cell is the average over its own
      // footprint, so the grid is pre-smoothed by construction and there is
      // no separate denoising pass to tune.
      const CELLS_PER_RADIUS = 4;
      const cell = reach / CELLS_PER_RADIUS;
      const cols = Math.max(3, Math.round(width / cell));
      const rows = Math.max(3, Math.round(height / cell));
      if (cols * rows > 4e6) throw new Error(`image.flow: radius ${reach} over a ${width}×${height} picture needs a ${cols}×${rows} grid, more than four million cells — ask for a larger radius (the grid is ${CELLS_PER_RADIUS} cells across it, so halving the radius quadruples the work)`);
      const cw = width / cols;
      const ch = height / rows;
      const lum = new Float64Array(cols * rows);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) lum[j * cols + i] = sample(LUM, ox + (i + 0.5) * cw, oy + (j + 0.5) * ch, Math.max(cw, ch) / 2);
      }
      const at = (i: number, j: number): number => lum[Math.min(rows - 1, Math.max(0, j)) * cols + Math.min(cols - 1, Math.max(0, i))];
      // Sobel, then the quarter turn: the gradient points across an edge, its
      // perpendicular runs along it.
      let vx = new Float64Array(cols * rows);
      let vy = new Float64Array(cols * rows);
      const mag = new Float64Array(cols * rows);
      let peak = 0;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const aa = at(i - 1, j - 1);
          const ba = at(i, j - 1);
          const ca = at(i + 1, j - 1);
          const ab = at(i - 1, j);
          const cb = at(i + 1, j);
          const ac = at(i - 1, j + 1);
          const bc = at(i, j + 1);
          const cc = at(i + 1, j + 1);
          const gx = ca + 2 * cb + cc - aa - 2 * ab - ac;
          const gy = ac + 2 * bc + cc - aa - 2 * ba - ca;
          const k = j * cols + i;
          const m = Math.hypot(gx, gy);
          // Over a flat patch the eight terms cancel, but they cancel in
          // floating point, leaving a residue of the order of the values'
          // own rounding. Dividing by that residue would turn pure noise into
          // a confident unit direction — and because the residue is the same
          // shape everywhere on the patch, into a confident WRONG one, a
          // clean diagonal across the whole region. A response smaller than
          // the rounding error of its own inputs is not a gradient.
          const noise = 8 * Number.EPSILON * Math.max(Math.abs(aa), Math.abs(ba), Math.abs(ca), Math.abs(ab), Math.abs(cb), Math.abs(ac), Math.abs(bc), Math.abs(cc));
          const real = m > noise;
          mag[k] = real ? m : 0;
          if (real && m > peak) peak = m;
          // A cell with no gradient has no opinion yet, and says so with a
          // zero rather than an arbitrary direction — an arbitrary one would
          // be voted for by its neighbours and come out as a grid.
          vx[k] = real ? -gy / m : 0;
          vy[k] = real ? gx / m : 0;
        }
      }
      if (peak > 0) for (let k = 0; k < mag.length; k++) mag[k] /= peak;
      const ri = Math.max(1, Math.round(reach / cw));
      const rj = Math.max(1, Math.round(reach / ch));
      // Jacobi: every neighbour in a pass is read from the previous state, so
      // the result does not depend on the order the cells are visited.
      for (let pass = 0; pass < iterations; pass++) {
        const nx = new Float64Array(cols * rows);
        const ny = new Float64Array(cols * rows);
        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < cols; i++) {
            const k = j * cols + i;
            // Everything in the neighbourhood is flipped into ONE half-plane
            // before it is summed, because a direction here has no head or
            // tail. The reference is this cell's own direction, or — if it
            // has none yet — the strongest edge in reach, which is how a flat
            // region takes its direction from the boundary beside it.
            let rx = vx[k];
            let ry = vy[k];
            if (rx === 0 && ry === 0) {
              let strongest = -1;
              for (let dj = -rj; dj <= rj; dj++) {
                const jj = j + dj;
                if (jj < 0 || jj >= rows) continue;
                for (let di = -ri; di <= ri; di++) {
                  const ii = i + di;
                  if (ii < 0 || ii >= cols) continue;
                  const n = jj * cols + ii;
                  if ((vx[n] !== 0 || vy[n] !== 0) && mag[n] > strongest) {
                    strongest = mag[n];
                    rx = vx[n];
                    ry = vy[n];
                  }
                }
              }
            }
            let ax = 0;
            let ay = 0;
            if (rx !== 0 || ry !== 0) {
              for (let dj = -rj; dj <= rj; dj++) {
                const jj = j + dj;
                if (jj < 0 || jj >= rows) continue;
                for (let di = -ri; di <= ri; di++) {
                  const ii = i + di;
                  if (ii < 0 || ii >= cols) continue;
                  const d = Math.hypot((di * cw) / reach, (dj * ch) / reach);
                  if (d > 1) continue;
                  const n = jj * cols + ii;
                  if (vx[n] === 0 && vy[n] === 0) continue;
                  const dot = rx * vx[n] + ry * vy[n];
                  // A decaying kernel; the neighbour's own edge strength, so a
                  // real boundary outvotes a flat patch; a smooth
                  // magnitude-contrast term; and agreement.
                  const w = (1 - d) * mag[n] * ((1 + Math.tanh(mag[n] - mag[k])) / 2) * Math.abs(dot);
                  const phi = dot < 0 ? -1 : 1;
                  ax += phi * w * vx[n];
                  ay += phi * w * vy[n];
                }
              }
            }
            const len = Math.hypot(ax, ay);
            if (len > 0) {
              nx[k] = ax / len;
              ny[k] = ay / len;
            } else {
              nx[k] = vx[k];
              ny[k] = vy[k];
            }
          }
        }
        vx = nx;
        vy = ny;
      }
      // A direction with no head or tail is a LINE field, and an integrator
      // walking one needs a sign or it turns round and weaves back through
      // itself. So orient the raster once: breadth-first from the strongest
      // cell of each connected patch, flipping every cell to agree with the
      // neighbour that reached it. That is consistent everywhere except at
      // true singularities, which no orientation can fix and which are
      // exactly where a flow genuinely forks.
      {
        const seen = new Uint8Array(cols * rows);
        const order = Array.from({ length: cols * rows }, (_, k) => k)
          .filter((k) => vx[k] !== 0 || vy[k] !== 0)
          .sort((a, b) => mag[b] - mag[a]);
        const queue = new Int32Array(cols * rows);
        for (const start of order) {
          if (seen[start]) continue;
          seen[start] = 1;
          queue[0] = start;
          for (let head = 0, tail = 1; head < tail; head++) {
            const k = queue[head];
            const i = k % cols;
            const j = (k - i) / cols;
            for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
              const ii = i + di;
              const jj = j + dj;
              if (ii < 0 || ii >= cols || jj < 0 || jj >= rows) continue;
              const n = jj * cols + ii;
              if (seen[n] || (vx[n] === 0 && vy[n] === 0)) continue;
              seen[n] = 1;
              if (vx[k] * vx[n] + vy[k] * vy[n] < 0) {
                vx[n] = -vx[n];
                vy[n] = -vy[n];
              }
              queue[tail++] = n;
            }
          }
        }
      }
      return (x: number, y: number): [number, number] => {
        const ux = x - ox;
        const uy = y - oy;
        if (ux < 0 || uy < 0 || ux > width || uy > height) return [0, 0];
        const fx = Math.min(cols - 1, Math.max(0, ux / cw - 0.5));
        const fy = Math.min(rows - 1, Math.max(0, uy / ch - 0.5));
        const i0 = Math.floor(fx);
        const j0 = Math.floor(fy);
        const i1 = Math.min(cols - 1, i0 + 1);
        const j1 = Math.min(rows - 1, j0 + 1);
        const tx = fx - i0;
        const ty = fy - j0;
        // Interpolate in the same half-plane as the first sample, or two
        // opposite directions would average to nothing at a ridge.
        const base = j0 * cols + i0;
        let ax = 0;
        let ay = 0;
        for (const [ii, jj, w] of [[i0, j0, (1 - tx) * (1 - ty)], [i1, j0, tx * (1 - ty)], [i0, j1, (1 - tx) * ty], [i1, j1, tx * ty]] as [number, number, number][]) {
          const n = jj * cols + ii;
          const s = vx[base] * vx[n] + vy[base] * vy[n] < 0 ? -1 : 1;
          ax += w * s * vx[n];
          ay += w * s * vy[n];
        }
        const len = Math.hypot(ax, ay);
        return len > 0 ? [ax / len, ay / len] : [vx[base], vy[base]];
      };
    },
    surface(opts = {}) {
      const channel = opts.channel ?? 'lum', origin = opts.origin ?? 'bottom-left', wrap = opts.wrap ?? 'clamp', area = opts.area ?? 0, uv = opts.uv ?? 'uv';
      if (!['lum', 'dark', 'a'].includes(channel)) throw new Error(`image.surface: unknown channel '${String(channel)}' — lum, dark or a`);
      if (origin !== 'bottom-left' && origin !== 'top-left') throw new Error('image.surface: origin must be bottom-left or top-left');
      if (wrap !== 'clamp' && wrap !== 'repeat') throw new Error('image.surface: wrap must be clamp or repeat');
      if (typeof area !== 'number') throw new Error('image.surface: area is a chart-unit half-size in [0,1]');
      // A half-size outside the chart is read as the nearest size in it.
      const span = Number.isFinite(area) ? Math.min(1, Math.max(0, area)) : 0;
      if (typeof uv !== 'string' || !uv) throw new Error('image.surface: uv must name a corner column');
      const recipe: ImageRecipe3 = Object.freeze({ kind: 'image', name, pixels: prefilterPixels3(px, span * px.width, span * px.height), channel, origin, wrap, area: span, uvAttribute: uv });
      return registerToneRecipe3((s: { readonly uv?: readonly [number, number] }) => {
        if (!s.uv) throw new Error(`image.surface: this surface location has no '${uv}' chart coordinates`);
        return imageValue3(s.uv, recipe);
      }, recipe);
    },
    field(channel = 'lum', opts = {}) {
      const area = opts.area;
      switch (channel) {
        case 'lum': return (x, y) => sample(LUM, x, y, area);
        // Outside the placed picture there is no tone to invert: dark reads 0
        // there, as every other channel does, so a scatter over the sheet does
        // not frame the picture in solid ink.
        case 'dark': return (x, y) => (placed(x, y) ? 1 - sample(LUM, x, y, area) : 0);
        case 'a': return (x, y) => sample(3, x, y, area);
        case 'edge': return (x, y) => edge(x, y, area);
        case 'r': return (x, y) => sample(0, x, y, area);
        case 'g': return (x, y) => sample(1, x, y, area);
        case 'b': return (x, y) => sample(2, x, y, area);
        case 'c': return (x, y) => inkValue(0, x, y, area);
        case 'm': return (x, y) => inkValue(1, x, y, area);
        case 'y': return (x, y) => inkValue(2, x, y, area);
        case 'k': return (x, y) => inkValue(3, x, y, area);
        default: throw new Error(`image.field: unknown channel '${String(channel)}' — lum, dark, a, edge, r, g, b, c, m, y or k`);
      }
    },
    palette(colors, opts = {}) {
      const space = opts.space ?? 'lab';
      if (space !== 'lab' && space !== 'rgb') {
        throw new Error(`image.palette: space is 'lab' or 'rgb', not '${String(space)}'`);
      }
      const bins = binsFor(space);
      let centres: ColourPoint[];
      let colours: string[];
      if (typeof colors === 'number') {
        if (!Number.isInteger(colors) || colors < 0) {
          throw new Error(`image.palette: the count must be a non-negative whole number, got ${String(colors)}`);
        }
        const fitted = fitPalette(bins, colors);
        centres = fitted.map((c) => c.centre);
        colours = fitted.map((c) => hexOfRgb(c.r, c.g, c.b));
      } else if (Array.isArray(colors)) {
        // A colour the artist named stays in the palette even when nothing
        // in the picture is near it: it is a pen they mean to use, and a
        // share of zero says so more usefully than a missing entry.
        colours = (colors as readonly (string | { color: string })[]).map((c, i) => {
          const hex = typeof c === 'string' ? c : c && typeof c === 'object' && typeof c.color === 'string' ? c.color : undefined;
          if (hex === undefined) throw new Error(`image.palette: entry ${i} is neither a colour nor a pen (nothing with a 'color')`);
          return hexOfRgb(...rgbOfHex(hex, 'image.palette'));
        });
        centres = colours.map((hex) => colourPoint(space, ...rgbOfHex(hex, 'image.palette')));
      } else {
        throw new Error(`image.palette: expected a count of colours, hex strings or pens, got ${String(colors)}`);
      }
      const counts = tally(bins, centres);
      const order = centres.map((_, i) => i);
      // Descending share, and by the palette's own order where two colours
      // hold the same amount — nothing here may depend on the run seed.
      order.sort((a, b) => counts[b].weight - counts[a].weight || a - b);
      return order.map((i) => ({
        color: colours[i],
        share: bins.total > 0 ? counts[i].weight / bins.total : 0,
        field: (o: { area?: number } = {}) => membership(space, centres, i, o.area),
        contours: (level = 0.5) =>
          Number.isFinite(level)
            ? march(sampleGrid(membership(space, centres, i), lattice, bandCols, bandRows), level)
            : [],
      }));
    },
    regions(opts = {}) {
      const count = opts.count ?? 4;
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(`image.regions: count must be a non-negative whole number, got ${String(opts.count)}`);
      }
      const tolerance = opts.tolerance ?? 0.002;
      if (!(typeof tolerance === 'number') || !Number.isFinite(tolerance) || tolerance < 0) {
        throw new Error(`image.regions: tolerance is a fraction of the picture, got ${String(opts.tolerance)}`);
      }
      const bins = binsFor('lab');
      const fitted = fitPalette(bins, count);
      if (fitted.length === 0) return [];
      const centres = fitted.map((c) => c.centre);

      // Label the working raster: every cell takes the average of the pixels
      // it covers and the colour nearest to that. A cell the picture does not
      // cover belongs to nothing — NONE, not to whichever colour happens to
      // be nearest to transparent black.
      const NONE = -1;
      const labels = new Int32Array(bandCols * bandRows).fill(NONE);
      const lum = new Float64Array(bandCols * bandRows);
      const half = Math.max(bandW, bandH) / 2;
      for (let j = 0; j < bandRows; j++) {
        const cy = oy + (j + 0.5) * bandH;
        for (let i = 0; i < bandCols; i++) {
          const cx = ox + (i + 0.5) * bandW;
          if (sample(3, cx, cy, half) < 0.5) continue;
          const r = sample(0, cx, cy, half) * 255;
          const g = sample(1, cx, cy, half) * 255;
          const b = sample(2, cx, cy, half) * 255;
          const k = j * bandCols + i;
          labels[k] = nearest(centres, ...colourPoint('lab', r, g, b));
          lum[k] = sample(LUM, cx, cy, half);
        }
      }
      despeckle(labels, bandCols, bandRows, Math.max(0, tolerance) * bandCols * bandRows);

      const covered = new Float64Array(fitted.length);
      const toneSum = new Float64Array(fitted.length);
      for (let k = 0; k < labels.length; k++) {
        const c = labels[k];
        if (c === NONE) continue;
        covered[c]++;
        toneSum[c] += lum[k];
      }
      const cells = bandCols * bandRows;
      const kept = fitted.map((_, c) => c).filter((c) => covered[c] > 0);
      // Lightest first, so drawing them in order lets the dark ones hide the
      // light ones — the stack a separation is.
      kept.sort((a, b) => toneSum[b] / covered[b] - toneSum[a] / covered[a] || a - b);
      return kept.map((c) => ({
        color: hexOfRgb(fitted[c].r, fitted[c].g, fitted[c].b),
        share: covered[c] / cells,
        contours: () => march(maskGrid(labels, bandCols, bandRows, c, lattice), 0.5),
      }));
    },
  };
}

/** A 0/1 lattice of the cells holding one label, ready to march. Built from
 * the labels directly rather than through a field of coordinates: the
 * marching asks for exactly the cell centres, and going out to sketch space
 * and back would be a rounding away from saying so. */
function maskGrid(
  labels: Int32Array,
  cols: number,
  rows: number,
  label: number,
  b: { x: number; y: number; w: number; h: number },
): SampledGrid {
  const pw = cols + 2;
  const vals = new Float64Array(pw * (rows + 2));
  for (let j = 0; j < rows; j++) {
    const row = (j + 1) * pw + 1;
    for (let i = 0; i < cols; i++) vals[row + i] = labels[j * cols + i] === label ? 1 : 0;
  }
  return { vals, absent: new Uint8Array(pw * (rows + 2)), pw, gw: cols, gh: rows, b, sx: b.w / (cols - 1), sy: b.h / (rows - 1) };
}

/**
 * Absorb every connected patch smaller than `minCells` into whatever
 * surrounds it, in place.
 *
 * A photograph quantized to four colours is four areas and a blizzard of
 * single cells along every boundary, and a plotter draws the blizzard at
 * full price. The patches are taken smallest first, so a speck inside a
 * speck is gone before the speck that holds it is judged, and each one goes
 * to the label that holds most of its border — the region it is actually
 * inside, not merely the first neighbour met.
 */
function despeckle(labels: Int32Array, cols: number, rows: number, minCells: number): void {
  if (!(minCells > 1)) return;
  const n = cols * rows;
  const comp = new Int32Array(n).fill(-1);
  const members: number[][] = [];
  const queue = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (comp[start] !== -1 || labels[start] < 0) continue;
    const id = members.length;
    const label = labels[start];
    const mine: number[] = [];
    comp[start] = id;
    queue[0] = start;
    for (let head = 0, tail = 1; head < tail; head++) {
      const k = queue[head];
      mine.push(k);
      const i = k % cols;
      const j = (k - i) / cols;
      if (i > 0 && comp[k - 1] === -1 && labels[k - 1] === label) { comp[k - 1] = id; queue[tail++] = k - 1; }
      if (i + 1 < cols && comp[k + 1] === -1 && labels[k + 1] === label) { comp[k + 1] = id; queue[tail++] = k + 1; }
      if (j > 0 && comp[k - cols] === -1 && labels[k - cols] === label) { comp[k - cols] = id; queue[tail++] = k - cols; }
      if (j + 1 < rows && comp[k + cols] === -1 && labels[k + cols] === label) { comp[k + cols] = id; queue[tail++] = k + cols; }
    }
    members.push(mine);
  }
  const small = members.map((_m, id) => id).filter((id) => members[id].length < minCells);
  small.sort((a, b) => members[a].length - members[b].length || members[a][0] - members[b][0]);
  for (const id of small) {
    const mine = members[id];
    const own = labels[mine[0]];
    const border = new Map<number, number>();
    for (const k of mine) {
      const i = k % cols;
      const j = (k - i) / cols;
      for (const nb of [i > 0 ? k - 1 : -1, i + 1 < cols ? k + 1 : -1, j > 0 ? k - cols : -1, j + 1 < rows ? k + cols : -1]) {
        if (nb < 0) continue;
        const l = labels[nb];
        if (l < 0 || l === own) continue;
        border.set(l, (border.get(l) ?? 0) + 1);
      }
    }
    let best = -1;
    let most = 0;
    for (const [l, c] of border) if (c > most || (c === most && l < best)) { most = c; best = l; }
    // A patch with no neighbour of another colour is the whole of its
    // region, not a speck in one, and is left exactly as it is.
    if (best < 0) continue;
    for (const k of mine) labels[k] = best;
  }
}

/** Asset names referenced by string literals in sketch source — the host
 * preloads exactly these before execution. */
export function scanAssetNames(source: string): string[] {
  const names = new Set<string>();
  // Matches direct calls AND esbuild-CJS indirect calls: (0, x.image)('n').
  for (const m of source.matchAll(/\b(?:asset|image)\)?\(\s*['"`]([^'"`]+)['"`]/g)) {
    names.add(m[1]);
  }
  return [...names];
}
