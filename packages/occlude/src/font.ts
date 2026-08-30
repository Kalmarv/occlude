/**
 * A single-stroke (open-path) label font for plotters: every glyph is a
 * few polylines, drawn with the pen's own line — no outlines to fill.
 * Digits are seven-segment style; letters are simple stroke forms.
 * Glyphs live in a 0.6×1 box (y down); height scales everything.
 */

import type { ShapeOpts, Tree } from './api.js';
import { path } from './api.js';
import { mm } from './units.js';

type Stroke = [number, number][];

const S: Record<string, Stroke> = {
  A: [[0, 0], [0.6, 0]], B: [[0.6, 0], [0.6, 0.5]], C: [[0.6, 0.5], [0.6, 1]],
  D: [[0, 1], [0.6, 1]], E: [[0, 0.5], [0, 1]], F: [[0, 0], [0, 0.5]],
  G: [[0, 0.5], [0.6, 0.5]],
};
const seg = (...ks: string[]): Stroke[] => ks.map((k) => S[k]);

const GLYPHS: Record<string, Stroke[]> = {
  '0': seg('A', 'B', 'C', 'D', 'E', 'F'),
  '1': [[[0.3, 0], [0.3, 1]]],
  '2': seg('A', 'B', 'G', 'E', 'D'),
  '3': seg('A', 'B', 'G', 'C', 'D'),
  '4': seg('F', 'G', 'B', 'C'),
  '5': seg('A', 'F', 'G', 'C', 'D'),
  '6': seg('A', 'F', 'E', 'D', 'C', 'G'),
  '7': seg('A', 'B', 'C'),
  '8': seg('A', 'B', 'C', 'D', 'E', 'F', 'G'),
  '9': seg('A', 'B', 'C', 'D', 'F', 'G'),
  A: [[[0, 1], [0, 0.35], [0.3, 0], [0.6, 0.35], [0.6, 1]], [[0, 0.6], [0.6, 0.6]]],
  B: [
    [[0, 0], [0, 1]],
    [[0, 0], [0.45, 0], [0.6, 0.15], [0.6, 0.35], [0.45, 0.5], [0, 0.5]],
    [[0.45, 0.5], [0.6, 0.65], [0.6, 0.85], [0.45, 1], [0, 1]],
  ],
  C: [[[0.6, 0.15], [0.45, 0], [0.15, 0], [0, 0.15], [0, 0.85], [0.15, 1], [0.45, 1], [0.6, 0.85]]],
  D: [[[0, 0], [0, 1]], [[0, 0], [0.4, 0], [0.6, 0.2], [0.6, 0.8], [0.4, 1], [0, 1]]],
  E: [[[0.6, 0], [0, 0], [0, 1], [0.6, 1]], [[0, 0.5], [0.45, 0.5]]],
  F: [[[0.6, 0], [0, 0], [0, 1]], [[0, 0.5], [0.45, 0.5]]],
  G: [
    [[0.6, 0.15], [0.45, 0], [0.15, 0], [0, 0.15], [0, 0.85], [0.15, 1], [0.45, 1], [0.6, 0.85], [0.6, 0.55], [0.35, 0.55]],
  ],
  H: [[[0, 0], [0, 1]], [[0.6, 0], [0.6, 1]], [[0, 0.5], [0.6, 0.5]]],
  I: [[[0.3, 0], [0.3, 1]], [[0.1, 0], [0.5, 0]], [[0.1, 1], [0.5, 1]]],
  J: [[[0.6, 0], [0.6, 0.85], [0.45, 1], [0.15, 1], [0, 0.85]]],
  K: [[[0, 0], [0, 1]], [[0.6, 0], [0, 0.5], [0.6, 1]]],
  L: [[[0, 0], [0, 1], [0.6, 1]]],
  M: [[[0, 1], [0, 0], [0.3, 0.45], [0.6, 0], [0.6, 1]]],
  N: [[[0, 1], [0, 0], [0.6, 1], [0.6, 0]]],
  O: [[[0.15, 0], [0.45, 0], [0.6, 0.15], [0.6, 0.85], [0.45, 1], [0.15, 1], [0, 0.85], [0, 0.15], [0.15, 0]]],
  P: [[[0, 1], [0, 0], [0.45, 0], [0.6, 0.15], [0.6, 0.35], [0.45, 0.5], [0, 0.5]]],
  Q: [
    [[0.15, 0], [0.45, 0], [0.6, 0.15], [0.6, 0.85], [0.45, 1], [0.15, 1], [0, 0.85], [0, 0.15], [0.15, 0]],
    [[0.35, 0.7], [0.62, 1.02]],
  ],
  R: [
    [[0, 1], [0, 0], [0.45, 0], [0.6, 0.15], [0.6, 0.35], [0.45, 0.5], [0, 0.5]],
    [[0.3, 0.5], [0.6, 1]],
  ],
  S: [
    [[0.6, 0.12], [0.45, 0], [0.15, 0], [0, 0.12], [0, 0.38], [0.15, 0.5], [0.45, 0.5], [0.6, 0.62], [0.6, 0.88], [0.45, 1], [0.15, 1], [0, 0.88]],
  ],
  T: [[[0, 0], [0.6, 0]], [[0.3, 0], [0.3, 1]]],
  U: [[[0, 0], [0, 0.85], [0.15, 1], [0.45, 1], [0.6, 0.85], [0.6, 0]]],
  V: [[[0, 0], [0.3, 1], [0.6, 0]]],
  W: [[[0, 0], [0.12, 1], [0.3, 0.5], [0.48, 1], [0.6, 0]]],
  X: [[[0, 0], [0.6, 1]], [[0.6, 0], [0, 1]]],
  Y: [[[0, 0], [0.3, 0.45], [0.6, 0]], [[0.3, 0.45], [0.3, 1]]],
  Z: [[[0, 0], [0.6, 0], [0, 1], [0.6, 1]]],
  '-': seg('G'),
  '+': [[[0.05, 0.5], [0.55, 0.5]], [[0.3, 0.25], [0.3, 0.75]]],
  '=': [[[0.05, 0.38], [0.55, 0.38]], [[0.05, 0.62], [0.55, 0.62]]],
  '.': [[[0.25, 1], [0.38, 1]]],
  ',': [[[0.32, 0.92], [0.24, 1.12]]],
  ':': [[[0.26, 0.3], [0.36, 0.3]], [[0.26, 0.75], [0.36, 0.75]]],
  '/': [[[0.6, 0], [0, 1]]],
  '(': [[[0.45, 0], [0.25, 0.2], [0.25, 0.8], [0.45, 1]]],
  ')': [[[0.15, 0], [0.35, 0.2], [0.35, 0.8], [0.15, 1]]],
};

export interface LabelOpts extends ShapeOpts {
  /** 'user' (default): coordinates/height in sketch units. 'mm': physical. */
  unit?: 'user' | 'mm';
  /** Horizontal anchor of x: 'left' (default), 'center', or 'right'. */
  align?: 'left' | 'center' | 'right';
}

/** Advance width of one character at cap height h. */
function advance(ch: string, h: number): number {
  return (ch === '.' || ch === ',' || ch === ':' ? 0.45 : 0.78) * h;
}

/** Rendered width of a string at cap height h (same units as h). */
export function labelWidth(str: string, h: number): number {
  let w = 0;
  for (const ch of str) w += advance(ch, h);
  return w;
}

/**
 * Single-stroke text: `label('0.45', x, y, h)` draws the string with its
 * top-left at (x, y) and cap height h — a few open paths per glyph, so it
 * plots with the pen's own line weight. Unknown characters advance as
 * spaces. Width is roughly 0.75·h per character.
 */
export function label(str: string, x: number, y: number, h: number, opts: LabelOpts = {}): Tree {
  const { unit = 'user', align = 'left', ...shapeOpts } = opts;
  const U = unit === 'mm' ? mm : (n: number): number => n;
  const w = labelWidth(str, h);
  const out: Tree[] = [];
  let cx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  for (const ch of str) {
    const glyph = GLYPHS[ch.toUpperCase()];
    if (glyph) {
      for (const stroke of glyph) {
        const p = path();
        stroke.forEach(([gx, gy], i) => {
          if (i === 0) p.moveTo(U(cx + gx * h * 0.6), U(y + gy * h));
          else p.lineTo(U(cx + gx * h * 0.6), U(y + gy * h));
        });
        out.push(p.build(shapeOpts));
      }
    }
    cx += advance(ch, h);
  }
  return out;
}
