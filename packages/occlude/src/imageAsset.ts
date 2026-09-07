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

interface AssetEntry {
  text?: string;
  pixels?: AssetPixels;
  /** Lazy summed-area tables, keyed by channel. */
  sat?: Map<string, Float64Array>;
}

const registry = new Map<string, AssetEntry>();

export function registerTextAsset(name: string, text: string): void {
  registry.set(name, { text });
}

export function registerImageAsset(name: string, pixels: AssetPixels): void {
  registry.set(name, { pixels });
}

export function clearAssets(): void {
  registry.clear();
}

function entryOf(name: string): AssetEntry {
  const e = registry.get(name);
  if (!e) {
    const known = [...registry.keys()].join(', ') || '(none preloaded)';
    throw new Error(
      `unknown asset '${name}' — upload it in the Assets panel and reference it by a string literal. Loaded: ${known}`,
    );
  }
  return e;
}

/** Text of an uploaded asset (SVGs etc): `svg(asset('church.svg'), …)`. */
export function asset(name: string): string {
  const e = entryOf(name);
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
}

/**
 * A sampler over an uploaded image, mapped into sketch space. Draws
 * nothing. Outside the placed rect every sample is 0.
 */
export function image(name: string, place: ImagePlacement = {}): ImageSampler {
  const e = entryOf(name);
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
    return raw / 255;
  };

  return {
    width,
    height,
    lum: (x, y, area) => sample(LUM, x, y, area),
    rgb: (x, y, area) => [sample(0, x, y, area), sample(1, x, y, area), sample(2, x, y, area)],
    a: (x, y, area) => sample(3, x, y, area),
    bands: (x, y, n, area) =>
      Math.min(Math.max(1, Math.floor(n)) - 1, Math.floor(sample(LUM, x, y, area) * n)),
    edge: (x, y, area) => {
      const eps = 1 / sx; // one source pixel, in sketch units
      const gx = sample(LUM, x + eps, y, area) - sample(LUM, x - eps, y, area);
      const gy = sample(LUM, x, y + eps, area) - sample(LUM, x, y - eps, area);
      return Math.hypot(gx, gy) / 2;
    },
    dir: (x, y, area) => {
      const eps = 1 / sx;
      const gx = sample(LUM, x + eps, y, area) - sample(LUM, x - eps, y, area);
      const gy = sample(LUM, x, y + eps, area) - sample(LUM, x, y - eps, area);
      return Math.atan2(gy, gx);
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
