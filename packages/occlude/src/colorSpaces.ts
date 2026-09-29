/**
 * Colors as values: one value however it was made — hex, RGB, HSL, HSV,
 * CMYK, OKLab or OKLCH — that reads back in any of those spellings.
 *
 * A color is stored as sRGB, 0…1 per channel, and always inside the sRGB
 * gamut, because the ink is what the pen and the screen can show. An OKLab
 * or OKLCH color outside the gamut keeps its lightness and hue and loses
 * chroma until it fits (the CSS Color 4 idea, by bisection); every other
 * space clamps its inputs to their own ranges, which are all in gamut.
 * Nothing here throws on a number: a value that is not finite reads as 0.
 *
 * Every option that takes a color (`pen`, `paper`, `img.palette`) goes
 * through `hexOf`, so a pen's `color` stays a lower-case `#rrggbb` string
 * and two spellings of one color are one pen.
 *
 * OKLab is Björn Ottosson's (2020, public domain matrices). CMYK is the
 * naive formula with no ink profile: a way to think, not a proof.
 */

/** Any spelling a color option takes: a hex string or a color value. A
 * string that is not hex (a CSS name) passes through unchanged. */
export type ColorLike = string | Color;

const fin = (v: number): number => (Number.isFinite(v) ? v : 0);
const unit = (v: number): number => Math.min(1, Math.max(0, fin(v)));
const wrap = (deg: number): number => ((fin(deg) % 360) + 360) % 360;
const byte = (v: number): string => Math.round(unit(v) * 255).toString(16).padStart(2, '0');

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toGamma = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** OKLab → sRGB 0…1, unclamped (a channel outside 0…1 is out of gamut). */
function srgbOfOklab(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function oklabOfSrgb(r: number, g: number, b: number): [number, number, number] {
  const R = toLinear(r), G = toLinear(g), B = toLinear(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

const EPS = 1e-6;
const inGamut = (c: readonly number[]): boolean => c.every((v) => v >= -EPS && v <= 1 + EPS);

/** OKLCH → an in-gamut sRGB color: the same lightness and hue, with the
 * largest chroma up to the asked one that sRGB can show. */
function fromOklch(L: number, C: number, h: number): Color {
  const l = unit(L);
  const c = Math.max(0, fin(C));
  const rad = (wrap(h) * Math.PI) / 180;
  const at = (chroma: number) => srgbOfOklab(l, chroma * Math.cos(rad), chroma * Math.sin(rad));
  let rgb = at(c);
  if (!inGamut(rgb)) {
    let lo = 0, hi = c;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(at(mid))) lo = mid; else hi = mid;
    }
    rgb = at(lo);
  }
  return new Color(unit(rgb[0]), unit(rgb[1]), unit(rgb[2]));
}

function hueOf(r: number, g: number, b: number, max: number, d: number): number {
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return wrap(h * 60);
}

/** One color. Read it in any space: `c.hex`, `c.rgb`, `c.hsl`, `c.hsv`,
 * `c.cmyk`, `c.oklab`, `c.oklch`. Make one with `color`, `rgb`, `hsl`,
 * `hsv`, `cmyk`, `oklab`, `oklch` or `mix`. A gray has hue 0. */
export class Color {
  /** @internal sRGB 0…1, in gamut. */
  constructor(readonly r: number, readonly g: number, readonly b: number) {
    Object.freeze(this);
  }

  /** Lower-case `#rrggbb`: what a pen, the paper and the exports keep. */
  get hex(): string {
    return `#${byte(this.r)}${byte(this.g)}${byte(this.b)}`;
  }

  /** sRGB, 0–255 per channel, rounded as the hex is. */
  get rgb(): { r: number; g: number; b: number } {
    return { r: Math.round(this.r * 255), g: Math.round(this.g * 255), b: Math.round(this.b * 255) };
  }

  /** Hue in degrees, saturation and lightness 0–1. */
  get hsl(): { h: number; s: number; l: number } {
    const { r, g, b } = this;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const l = (max + min) / 2;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    return { h: hueOf(r, g, b, max, d), s, l };
  }

  /** Hue in degrees, saturation and value 0–1 (p5's HSB). */
  get hsv(): { h: number; s: number; v: number } {
    const { r, g, b } = this;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    return { h: hueOf(r, g, b, max, d), s: max === 0 ? 0 : d / max, v: max };
  }

  /** Cyan, magenta, yellow and black 0–1, by the naive formula. */
  get cmyk(): { c: number; m: number; y: number; k: number } {
    const k = 1 - Math.max(this.r, this.g, this.b);
    if (k >= 1) return { c: 0, m: 0, y: 0, k: 1 };
    return { c: (1 - this.r - k) / (1 - k), m: (1 - this.g - k) / (1 - k), y: (1 - this.b - k) / (1 - k), k };
  }

  /** OKLab: lightness 0–1 and the two opponent axes. */
  get oklab(): { l: number; a: number; b: number } {
    const [l, a, b] = oklabOfSrgb(this.r, this.g, this.b);
    return { l, a, b };
  }

  /** OKLCH: lightness 0–1, chroma, hue in degrees. */
  get oklch(): { l: number; c: number; h: number } {
    const { l, a, b } = this.oklab;
    const c = Math.hypot(a, b);
    return { l, c, h: c < 1e-7 ? 0 : wrap((Math.atan2(b, a) * 180) / Math.PI) };
  }

  toString(): string {
    return this.hex;
  }
}

/** `#rgb`, `#rrggbb` or `#rrggbbaa` (alpha ignored) as a color; a color
 * value as itself. */
export function color(value: ColorLike): Color {
  if (value instanceof Color) return value;
  const rgb = parseHex(value);
  if (!rgb) throw new Error(`color: '${String(value)}' is not a hex color — write it as #rrggbb or #rgb`);
  return new Color(rgb[0], rgb[1], rgb[2]);
}

function parseHex(value: unknown): [number, number, number] | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim().replace(/^#/, '');
  const full = s.length === 3 || s.length === 4 ? s[0] + s[0] + s[1] + s[1] + s[2] + s[2] : s.length === 8 ? s.slice(0, 6) : s;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return undefined;
  const n = parseInt(full, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** sRGB, 0–255 per channel. */
export function rgb(r: number, g: number, b: number): Color {
  return new Color(unit(r / 255), unit(g / 255), unit(b / 255));
}

/** Hue in degrees, saturation and lightness 0–1. */
export function hsl(h: number, s: number, l: number): Color {
  const S = unit(s), L = unit(l);
  const c = (1 - Math.abs(2 * L - 1)) * S;
  return fromChroma(wrap(h), c, L - c / 2);
}

/** Hue in degrees, saturation and value 0–1 (p5's HSB). */
export function hsv(h: number, s: number, v: number): Color {
  const S = unit(s), V = unit(v);
  const c = V * S;
  return fromChroma(wrap(h), c, V - c);
}

/** The hexcone shared by HSL and HSV: hue, chroma and the gray under it. */
function fromChroma(h: number, c: number, m: number): Color {
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return new Color(unit(r + m), unit(g + m), unit(b + m));
}

/** Cyan, magenta, yellow and black 0–1, by the naive formula (no ink
 * profile). */
export function cmyk(c: number, m: number, y: number, k: number): Color {
  const K = unit(k);
  return new Color((1 - unit(c)) * (1 - K), (1 - unit(m)) * (1 - K), (1 - unit(y)) * (1 - K));
}

/** OKLab: lightness 0–1 and the two opponent axes (about ±0.4). Outside
 * the sRGB gamut, the chroma is lowered until it fits. */
export function oklab(l: number, a: number, b: number): Color {
  const A = fin(a), B = fin(b);
  return fromOklch(l, Math.hypot(A, B), (Math.atan2(B, A) * 180) / Math.PI);
}

/** OKLCH: lightness 0–1, chroma (about 0–0.4), hue in degrees. Outside the
 * sRGB gamut, the chroma is lowered until it fits. */
export function oklch(l: number, c: number, h: number): Color {
  return fromOklch(l, c, h);
}

/** The color `t` of the way from `a` to `b`, blended in OKLab, where equal
 * steps look equal. `t` outside 0…1 goes past the ends. */
export function mix(a: ColorLike, b: ColorLike, t: number): Color {
  const p = color(a).oklab, q = color(b).oklab, u = fin(t);
  return oklab(p.l + (q.l - p.l) * u, p.a + (q.a - p.a) * u, p.b + (q.b - p.b) * u);
}

/** What a color option keeps: a color value or a hex string as lower-case
 * `#rrggbb`; any other string (a CSS name) as it is. */
export function hexOf(value: ColorLike, who: string): string {
  if (value instanceof Color) return value.hex;
  if (typeof value !== 'string') throw new Error(`${who}: a color is a hex string or a color value, got ${String(value)}`);
  const rgb = parseHex(value);
  return rgb ? new Color(...rgb).hex : value;
}
