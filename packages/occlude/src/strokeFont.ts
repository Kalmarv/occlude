/**
 * Single-line typography: a stroke font is a set of glyphs drawn with the
 * pen's own line, and `strokeFont(source)` reads one from the text of a
 * font file. Two formats, told apart by what the bytes say rather than by
 * a flag:
 *
 *   - an SVG 1.1 font (`<font>`, `<font-face>`, `<glyph>`, `<hkern>`),
 *     whose `d` data is read by the same path parser `svg()` uses, so a
 *     Bézier stays a Bézier until something asks for points;
 *   - a Hershey `.jhf` file, the ASCII format of the Usenet distribution.
 *
 * A `Font` is a plain record — no class, no marker — and a `Glyph` answers
 * `curves()` like every other chain value in the library. Glyph geometry
 * is in em units with y UP and the baseline at zero, which is what both
 * formats mean by their coordinates and what typography means by its own.
 * Turning that into ink is `t.text(...)`: the toolkit holds the paper, the
 * units and the flattening tolerance, so this module never sees them.
 */

import { material as materialOf, Material } from './material.js';
import type { IsoContour } from './isolines.js';
import { flattenPrim, type Prim } from './prims.js';
import { parsePathData, type Chain, type Seg } from './svgin.js';
import { mm, type L } from './units.js';

/** One glyph: its chains in em units (y up, baseline at 0) and the pen
 * step it asks for, also in em units. Unknown to the font's own art: the
 * chains are what they are in the source, open or closed. */
export interface Glyph {
  /** Pen advance in em units, before kerning and tracking. */
  readonly advance: number;
  /**
   * The glyph's chains in em units, y up, curved portions flattened at
   * `tolerance` (em units; the default is the em over 500, finer than any
   * nib at any size a plotter draws). A closed chain comes back closed and
   * without a repeated seam vertex.
   */
  curves(opts?: { tolerance?: number }): IsoContour[];
}

/**
 * A face: metrics, a glyph per character, and the kerning between a pair.
 * `ascent` and `descent` are in em units with y up, so `descent` is
 * negative, the spelling an SVG `<font-face>` uses. `capHeight` is what a
 * plotter artist measures a letter by and what `t.text`'s `size` means.
 */
export interface Font {
  readonly name: string;
  readonly unitsPerEm: number;
  readonly ascent: number;
  readonly descent: number;
  readonly capHeight?: number;
  readonly xHeight?: number;
  /** The glyph for one character, or `undefined` where the face has none. */
  glyph(ch: string): Glyph | undefined;
  /** The pen step for one character, in em units: the glyph's own advance,
   * the space's where the face has no such glyph, and the face's default
   * advance where it has no space either. */
  advance(ch: string): number;
  /** The kerning between two characters in em units, ADDED to the advance:
   * a pair that tightens comes back negative, which is the opposite sign
   * from an SVG `<hkern k>`. Zero where the face says nothing. */
  kern(a: string, b: string): number;
  has(ch: string): boolean;
}

// ---- glyph geometry -------------------------------------------------------

/** A quadratic raised to the cubic `flattenPrim` knows, so one flattener
 * serves both — the control points of the equivalent cubic. */
function primOf(x0: number, y0: number, seg: Seg): Prim {
  if (seg.op === 'line') return { t: 'line', x0, y0, x1: seg.x, y1: seg.y };
  if (seg.op === 'cubic') {
    return { t: 'cubic', x0, y0, c0x: seg.c0x, c0y: seg.c0y, c1x: seg.c1x, c1y: seg.c1y, x1: seg.x, y1: seg.y };
  }
  return {
    t: 'cubic', x0, y0,
    c0x: x0 + (2 / 3) * (seg.cx - x0), c0y: y0 + (2 / 3) * (seg.cy - y0),
    c1x: seg.x + (2 / 3) * (seg.cx - seg.x), c1y: seg.y + (2 / 3) * (seg.cy - seg.y),
    x1: seg.x, y1: seg.y,
  };
}

/** A parsed chain as points at `tol`, with a chain that returns to its own
 * start reported closed and its repeated seam vertex dropped. */
function flattenChain(chain: Chain, tol: number): IsoContour {
  const pts: [number, number][] = [[chain.x, chain.y]];
  let x = chain.x;
  let y = chain.y;
  for (const seg of chain.segs) {
    const flat = flattenPrim(primOf(x, y, seg), tol);
    for (let i = 1; i < flat.length; i++) pts.push(flat[i]);
    x = seg.x;
    y = seg.y;
  }
  const a = pts[0];
  const z = pts[pts.length - 1];
  const closed = pts.length > 2 && Math.abs(a[0] - z[0]) <= 1e-9 && Math.abs(a[1] - z[1]) <= 1e-9;
  if (closed) pts.pop();
  return { pts, closed };
}

/** A glyph from parsed chains: the flattening is memoized per tolerance,
 * because a line of text asks the same letter for the same points again
 * and again. */
function glyphOf(chains: Chain[], advance: number, defaultTol: number): Glyph {
  const cache = new Map<number, IsoContour[]>();
  return {
    advance,
    curves(opts = {}) {
      const tol = opts.tolerance !== undefined && opts.tolerance > 0 ? opts.tolerance : defaultTol;
      let found = cache.get(tol);
      if (!found) {
        found = chains.map((c) => flattenChain(c, tol));
        cache.set(tol, found);
      }
      return found;
    },
  };
}

/** A straight chain of points, the shape a Hershey stroke arrives in. */
const lineChain = (pts: readonly [number, number][]): Chain => ({
  x: pts[0][0], y: pts[0][1],
  segs: pts.slice(1).map(([x, y]): Seg => ({ op: 'line', x, y })),
});

// ---- the two formats ------------------------------------------------------

interface Parsed {
  name: string;
  unitsPerEm: number;
  glyphs: Map<string, { chains: Chain[]; advance: number }>;
  names: Map<string, string>;
  kerns: Map<string, number>;
  defaultAdvance: number;
  ascent?: number;
  descent?: number;
  capHeight?: number;
  xHeight?: number;
}

const attrOf = (attrs: string, name: string): string | undefined =>
  new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML character references and the five named entities — everything a
 * font's `unicode` attribute uses to spell a character it cannot write. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return ENTITY[body] ?? whole;
  });
}

const numOf = (attrs: string, name: string): number | undefined => {
  const v = attrOf(attrs, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** An SVG 1.1 font. Glyphs with a multi-character `unicode` (ligatures) are
 * kept under that string, so they are reachable but never picked by
 * accident: `glyph('ff')` finds one and no single character does. */
function parseSvgFont(source: string): Parsed {
  const fontAttrs = /<font\s([^>]*)>/.exec(source)?.[1] ?? '';
  const faceAttrs = /<font-face\s([^>]*)>/.exec(source)?.[1] ?? '';
  const unitsPerEm = numOf(faceAttrs, 'units-per-em') ?? 1000;
  const defaultAdvance = numOf(fontAttrs, 'horiz-adv-x') ?? unitsPerEm;
  const glyphs = new Map<string, { chains: Chain[]; advance: number }>();
  const names = new Map<string, string>();
  for (const [, attrs] of source.matchAll(/<glyph\s([^>]*)>/g)) {
    const unicode = attrOf(attrs, 'unicode');
    const glyphName = attrOf(attrs, 'glyph-name');
    if (unicode === undefined) continue;
    const ch = decodeEntities(unicode);
    const d = attrOf(attrs, 'd');
    const entry = { chains: d ? parsePathData(decodeEntities(d)) : [], advance: numOf(attrs, 'horiz-adv-x') ?? defaultAdvance };
    glyphs.set(ch, entry);
    if (glyphName !== undefined) names.set(glyphName, ch);
  }
  // `k` is how much an SVG font TAKES OUT of the advance; a Font hands back
  // what to add, so the sign turns here and nowhere else.
  const kerns = new Map<string, number>();
  for (const [, attrs] of source.matchAll(/<hkern\s([^>]*)>/g)) {
    const k = numOf(attrs, 'k');
    if (k === undefined) continue;
    const side = (u: string, g: string): string[] => [
      ...(attrOf(attrs, u)?.split(',') ?? []).filter((s) => s.length > 0).map(decodeEntities),
      ...(attrOf(attrs, g)?.split(',') ?? []).map((n) => names.get(n)).filter((c): c is string => c !== undefined),
    ];
    for (const a of side('u1', 'g1')) for (const b of side('u2', 'g2')) kerns.set(`${a}\u0000${b}`, -k);
  }
  const missing = /<missing-glyph\s([^>]*)>/.exec(source)?.[1];
  const name = attrOf(faceAttrs, 'font-family') ?? attrOf(fontAttrs, 'id') ?? 'SVG font';
  return {
    name, unitsPerEm, glyphs, names, kerns,
    defaultAdvance: (missing !== undefined ? numOf(missing, 'horiz-adv-x') : undefined) ?? defaultAdvance,
    ascent: numOf(faceAttrs, 'ascent'),
    descent: numOf(faceAttrs, 'descent'),
    capHeight: numOf(faceAttrs, 'cap-height'),
    xHeight: numOf(faceAttrs, 'x-height'),
  };
}

/**
 * Hershey `.jhf`. A record is five characters of glyph number, three of
 * vertex count, then `2·count` characters of body: the left and right
 * side-bearing pair first, then `count - 1` coordinate pairs, each
 * character an offset from `R`, with the pair ` R` meaning pen up. The
 * reader walks characters and steps over newlines, so a file wrapped at
 * 72 columns (the original distribution) and one glyph per line (every
 * copy since) both read the same.
 *
 * The mapping from a record to a character is its POSITION: the `.jhf`
 * files are the ASCII-sequence fonts the distribution's `.hmp` translation
 * tables produce, so record 0 is U+0020 and record n is U+0020 + n. The
 * glyph number on each line is the number in Hershey's own repertory and
 * is carried for reference only.
 *
 * Vertical units: y counts DOWNWARD in the file and the baseline sits at
 * +9, so `H` runs from -12 to +9 in every occidental face. The parser
 * turns that into em units with y up, which puts the cap height at 21, the
 * x-height at 14 and a descender at -7 — the grid of 32 units to the em
 * this repertory was digitized on.
 */
const JHF_BASELINE = 9;
const JHF_EM = 32;

function parseJhf(source: string): Parsed {
  const text = source.replace(/\r/g, '');
  const glyphs = new Map<string, { chains: Chain[]; advance: number }>();
  let i = 0;
  // One character of the record, newlines stepped over: a wrapped file and
  // an unwrapped one are the same stream of characters.
  const next = (): string => {
    while (i < text.length && text[i] === '\n') i++;
    return i < text.length ? text[i++] : '';
  };
  const take = (n: number): string => {
    let out = '';
    for (let k = 0; k < n; k++) out += next();
    return out;
  };
  let index = 0;
  while (true) {
    while (i < text.length && text[i] === '\n') i++;
    if (i >= text.length) break;
    const head = take(8);
    if (head.length < 8) break;
    const count = Number(head.slice(5).trim());
    if (!Number.isInteger(count) || count < 1 || !/^\s*\d*\s*$/.test(head.slice(0, 5))) {
      throw new Error(`strokeFont(): malformed Hershey record near '${head.trim()}' — expected a glyph number and a vertex count`);
    }
    const body = take(2 * count);
    const left = body.charCodeAt(0) - 82;
    const right = body.charCodeAt(1) - 82;
    const chains: Chain[] = [];
    let run: [number, number][] = [];
    for (let k = 2; k + 1 < body.length; k += 2) {
      if (body[k] === ' ' && body[k + 1] === 'R') {
        if (run.length > 1) chains.push(lineChain(run));
        run = [];
        continue;
      }
      run.push([body.charCodeAt(k) - 82 - left, JHF_BASELINE - (body.charCodeAt(k + 1) - 82)]);
    }
    if (run.length > 1) chains.push(lineChain(run));
    glyphs.set(String.fromCharCode(32 + index), { chains, advance: right - left });
    index++;
  }
  if (glyphs.size === 0) throw new Error('strokeFont(): a Hershey file with no glyphs in it');
  return {
    name: 'Hershey', unitsPerEm: JHF_EM, glyphs, names: new Map(), kerns: new Map(),
    defaultAdvance: glyphs.get(' ')?.advance ?? JHF_EM / 2,
  };
}

// ---- the door -------------------------------------------------------------

/** The height of the tallest of these, when a face declares no cap height:
 * measured art beats a guess, and every face has at least one of them. */
const CAP_SAMPLE = 'HEILTX';
const X_SAMPLE = 'xnou';

function heightOf(glyphs: Parsed['glyphs'], sample: string, tol: number): number | undefined {
  let top = -Infinity;
  for (const ch of sample) {
    const g = glyphs.get(ch);
    if (!g) continue;
    for (const c of g.chains) for (const [, y] of flattenChain(c, tol).pts) if (y > top) top = y;
  }
  return Number.isFinite(top) ? top : undefined;
}

/**
 * A stroke font from the text of a font file: an SVG 1.1 font or a Hershey
 * `.jhf`, told apart by the content. Hand it a string — a bundled face
 * from `occlude/fonts`, or `t.asset('my-face.svg')` for one of your own —
 * and hand the result to `t.text(...)`, which is where a font becomes ink.
 * A source that is neither format refuses by name.
 */
export function strokeFont(source: string): Font {
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new Error('strokeFont(): expected the text of an SVG font or a Hershey .jhf file, and got nothing');
  }
  const head = source.slice(0, 4096);
  const parsed = /<font[\s>]/.test(head) || /<glyph[\s>]/.test(head)
    ? parseSvgFont(source)
    : /^\s*\d{1,5}\s+\d{1,4}\s*\S/.test(head)
      ? parseJhf(source)
      : undefined;
  if (parsed === undefined) {
    throw new Error(
      "strokeFont(): unrecognised font source — expected an SVG 1.1 font (a <font> element with <glyph unicode d>) " +
      'or a Hershey .jhf file (a glyph number and a vertex count per record)',
    );
  }
  if (parsed.glyphs.size === 0) throw new Error(`strokeFont(): '${parsed.name}' has no glyphs in it`);
  const tol = parsed.unitsPerEm / 500;
  const built = new Map<string, Glyph>();
  for (const [ch, g] of parsed.glyphs) built.set(ch, glyphOf(g.chains, g.advance, tol));
  const capHeight = parsed.capHeight ?? heightOf(parsed.glyphs, CAP_SAMPLE, tol);
  const xHeight = parsed.xHeight ?? heightOf(parsed.glyphs, X_SAMPLE, tol);
  // Where the face declares no ascent or descent, its own art says: the
  // highest and lowest point anything reaches.
  let top = -Infinity;
  let bottom = Infinity;
  if (parsed.ascent === undefined || parsed.descent === undefined) {
    for (const g of parsed.glyphs.values()) for (const c of g.chains) for (const [, y] of flattenChain(c, tol).pts) {
      if (y > top) top = y;
      if (y < bottom) bottom = y;
    }
  }
  const space = parsed.glyphs.get(' ')?.advance;
  return {
    name: parsed.name,
    unitsPerEm: parsed.unitsPerEm,
    ascent: parsed.ascent ?? (Number.isFinite(top) ? top : parsed.unitsPerEm * 0.8),
    descent: parsed.descent ?? (Number.isFinite(bottom) ? Math.min(0, bottom) : -parsed.unitsPerEm * 0.2),
    capHeight,
    xHeight,
    glyph: (ch) => built.get(ch),
    advance: (ch) => parsed.glyphs.get(ch)?.advance ?? space ?? parsed.defaultAdvance,
    kern: (a, b) => parsed.kerns.get(`${a}\u0000${b}`) ?? 0,
    has: (ch) => built.has(ch),
  };
}

// ---- setting a line -------------------------------------------------------

/** What the toolkit hands the setter: length resolution in drawable units,
 * and the face to use when the sketch names none. */
export interface TextEnv {
  len(l: L): number;
  font: Font;
}

/** A chain to set text along: a material, one of its curves, or any value
 * that answers `curves()`. */
export type ChainSource = Material | IsoContour | { curves(): readonly IsoContour[] };

export interface TextOpts {
  /** The face (default: the built-in Hershey roman simplex). */
  font?: Font;
  /** The CAP HEIGHT of the setting — what a plotter artist measures. */
  size: L;
  /** Which end of the line the origin holds (default `'left'`). */
  align?: 'left' | 'center' | 'right';
  /** A length added to every advance: letterspacing, positive or negative. */
  tracking?: L;
  /** The distance between the baselines of the lines `\n` breaks (default:
   * one em at this size). */
  leading?: L;
  /** Set along a chain instead of a straight baseline: each glyph is
   * placed by arc length with its baseline on the tangent there. */
  along?: ChainSource;
  /** The origin: the start of the first baseline (default `[0, 0]`). Not
   * for `along`, which reads position off the chain. */
  at?: readonly [number, number];
  /** Curve flattening, a length (default 0.05 mm) — the tolerance
   * `t.material(shape, { tolerance })` means. */
  tolerance?: L;
}

/** The chains of a `ChainSource`, drawable units. */
function chainsOf(source: ChainSource): readonly IsoContour[] {
  if (typeof (source as { curves?: unknown }).curves === 'function') {
    return (source as { curves(): readonly IsoContour[] }).curves();
  }
  const c = source as IsoContour;
  if (Array.isArray(c.pts)) return [c];
  throw new Error("text: 'along' wants a chain — a material, or one curve of one; this value answers neither curves() nor pts");
}

/** Cumulative arc length of a chain, the seam segment included when it is
 * a ring: the same walk `along()` makes, read at the distances a line of
 * type asks for rather than at even spacing. */
function arcLengths(pts: readonly (readonly [number, number])[], closed: boolean): number[] {
  const segs = closed ? pts.length : pts.length - 1;
  const cum = [0];
  for (let s = 0; s < segs; s++) {
    const a = pts[s];
    const b = pts[(s + 1) % pts.length];
    cum.push(cum[s] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return cum;
}

interface Frame { x: number; y: number; tx: number; ty: number }

/** Position and unit tangent at arc length `s`: wrapped on a ring, and on
 * an open chain carried straight on past either end along the tangent
 * there, so a word longer than its path runs off it instead of piling up
 * at the last vertex. */
function frameAt(pts: readonly (readonly [number, number])[], closed: boolean, cum: number[], s: number): Frame {
  const total = cum[cum.length - 1];
  if (!(total > 0)) return { x: pts[0][0], y: pts[0][1], tx: 1, ty: 0 };
  const d = closed ? ((s % total) + total) % total : Math.min(Math.max(s, 0), total);
  let seg = 0;
  while (seg < cum.length - 2 && cum[seg + 1] <= d) seg++;
  const a = pts[seg];
  const b = pts[(seg + 1) % pts.length];
  const len = cum[seg + 1] - cum[seg];
  const u = len > 0 ? (d - cum[seg]) / len : 0;
  const tx = len > 0 ? (b[0] - a[0]) / len : 1;
  const ty = len > 0 ? (b[1] - a[1]) / len : 0;
  const over = s - d;
  return { x: a[0] + (b[0] - a[0]) * u + tx * over, y: a[1] + (b[1] - a[1]) * u + ty * over, tx, ty };
}

/** One character placed on its line: where the pen was, and which index of
 * the string it came from. */
interface Place { glyph: Glyph | undefined; pen: number; advance: number; index: number }

/**
 * A string as one Material of glyph chains — the pure half of `t.text`,
 * with the paper and the units already resolved by the toolkit. Every
 * point carries a `glyph` column: the index into `str` of the character it
 * was drawn for, so `m.points.where(...)` picks letters out of a word.
 */
export function textOf(env: TextEnv, str: string, opts: TextOpts): Material {
  const font = opts.font ?? env.font;
  const size = env.len(opts.size);
  const capHeight = font.capHeight ?? font.unitsPerEm * 0.7;
  const scale = capHeight > 0 ? size / capHeight : 0;
  // Nothing to set, or a size that resolves to nothing: an empty material,
  // not a failed sketch.
  if (str.length === 0 || !(scale > 0)) return materialOf([]);
  if (opts.at !== undefined && opts.along !== undefined) {
    throw new Error("text: give 'at' or 'along', not both — a chain already says where every glyph goes");
  }
  const tracking = opts.tracking === undefined ? 0 : env.len(opts.tracking);
  const leading = opts.leading === undefined ? font.unitsPerEm * scale : env.len(opts.leading);
  const tolEm = env.len(opts.tolerance ?? mm(0.05)) / scale;
  const align = opts.align ?? 'left';
  const [atX, atY] = opts.at ?? [0, 0];

  // Pass one: the pen walk of every line, in drawable units.
  const lines: { places: Place[]; width: number }[] = [];
  let index = 0;
  for (const raw of str.split('\n')) {
    const chars = [...raw];
    const places: Place[] = [];
    let pen = 0;
    for (let k = 0; k < chars.length; k++) {
      const ch = chars[k];
      const advance = font.advance(ch) * scale;
      places.push({ glyph: font.glyph(ch), pen, advance, index });
      index += ch.length;
      pen += advance;
      if (k < chars.length - 1) pen += tracking + font.kern(ch, chars[k + 1]) * scale;
    }
    lines.push({ places, width: pen });
    index += 1; // the newline itself
  }

  const path = opts.along === undefined ? undefined : (() => {
    const chains = chainsOf(opts.along!).filter((c) => c.pts.length > 1);
    if (chains.length === 0) return undefined;
    const c = chains[0];
    const cum = arcLengths(c.pts, c.closed);
    return { pts: c.pts, closed: c.closed, cum, total: cum[cum.length - 1] };
  })();
  if (opts.along !== undefined && path === undefined) return materialOf([]);

  const pts: [number, number][] = [];
  const edges: [number, number][] = [];
  const column: number[] = [];
  lines.forEach((line, row) => {
    // Alignment is the same rule on a straight baseline and on a chain:
    // where the line starts, measured from the origin or from the start of
    // the chain, with the chain's whole length standing in for the paper.
    const room = path === undefined ? 0 : path.total;
    const start = align === 'center' ? (room - line.width) / 2 : align === 'right' ? room - line.width : 0;
    const base = row * leading;
    for (const place of line.places) {
      if (!place.glyph) continue;
      // The glyph rides the tangent at the middle of its own advance, which
      // is where a letter on a curve wants its baseline; the normal is the
      // tangent turned a quarter turn, so line two sits `leading` to the
      // inside of line one.
      const f = path === undefined
        ? undefined
        : frameAt(path.pts, path.closed, path.cum, start + place.pen + place.advance / 2);
      for (const curve of place.glyph.curves({ tolerance: tolEm })) {
        const first = pts.length;
        for (const [ex, ey] of curve.pts) {
          if (f === undefined) {
            pts.push([atX + start + place.pen + ex * scale, atY + base - ey * scale]);
          } else {
            const u = ex * scale - place.advance / 2;
            const v = base - ey * scale;
            pts.push([f.x + f.tx * u - f.ty * v, f.y + f.ty * u + f.tx * v]);
          }
          column.push(place.index);
          if (pts.length - 1 > first) edges.push([pts.length - 2, pts.length - 1]);
        }
        if (curve.closed && pts.length - first > 2) edges.push([pts.length - 1, first]);
      }
    }
  });
  return materialOf(pts, { edges, glyph: column });
}
