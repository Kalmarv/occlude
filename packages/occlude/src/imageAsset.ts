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
   * a modifier's amount. `dark` is `1 − lum`; `area` averages as the
   * samplers do. Outside the placed rect the field is 0. */
  field(channel?: ImageChannel, opts?: { area?: number }): (x: number, y: number) => number;
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

export type ImageChannel = 'lum' | 'dark' | 'a' | 'edge';
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
      if (!(reach > 0)) throw new Error(`image.flow: radius must be a positive length in sketch units, got ${String(opts.radius)}`);
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
      if (!Number.isFinite(area) || area < 0 || area > 1) throw new Error('image.surface: area is a chart-unit half-size in [0,1]');
      if (typeof uv !== 'string' || !uv) throw new Error('image.surface: uv must name a corner column');
      const recipe: ImageRecipe3 = Object.freeze({ kind: 'image', name, pixels: prefilterPixels3(px, area * px.width, area * px.height), channel, origin, wrap, area, uvAttribute: uv });
      return registerToneRecipe3((s: { readonly uv?: readonly [number, number] }) => {
        if (!s.uv) throw new Error(`image.surface: this surface location has no '${uv}' chart coordinates`);
        return imageValue3(s.uv, recipe);
      }, recipe);
    },
    field(channel = 'lum', opts = {}) {
      const area = opts.area;
      switch (channel) {
        case 'lum': return (x, y) => sample(LUM, x, y, area);
        case 'dark': return (x, y) => 1 - sample(LUM, x, y, area);
        case 'a': return (x, y) => sample(3, x, y, area);
        case 'edge': return (x, y) => edge(x, y, area);
        default: throw new Error(`image.field: unknown channel '${String(channel)}' — lum, dark, a or edge`);
      }
    },
  };
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
