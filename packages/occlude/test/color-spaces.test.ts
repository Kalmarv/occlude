/**
 * Colors as values: each space round-trips through the one value, OKLCH
 * out of gamut keeps lightness and hue, and every color option keeps
 * lower-case hex so two spellings of one color are one pen.
 */

import { describe, expect, it } from 'vitest';
import { circle, cmyk, color, hsl, hsv, mix, oklab, oklch, pen, rgb, sketch } from '../src/index.js';
import { compileSketch, encodeScene } from '../src/host.js';

describe('color values', () => {
  it('each space makes the same color and reads it back', () => {
    expect(color('#FF8000').hex).toBe('#ff8000');
    expect(color('#f80').hex).toBe('#ff8800');
    expect(rgb(255, 128, 0).hex).toBe('#ff8000');
    expect(hsl(30, 1, 0.5).hex).toBe('#ff8000');
    expect(hsv(30, 1, 1).hex).toBe('#ff8000');
    expect(cmyk(0, 0.5, 1, 0).hex).toBe('#ff8000');
    const c = color('#1b2a4a');
    for (const back of [oklch(c.oklch.l, c.oklch.c, c.oklch.h), oklab(c.oklab.l, c.oklab.a, c.oklab.b),
      hsl(c.hsl.h, c.hsl.s, c.hsl.l), hsv(c.hsv.h, c.hsv.s, c.hsv.v), cmyk(c.cmyk.c, c.cmyk.m, c.cmyk.y, c.cmyk.k)]) {
      expect(back.hex).toBe('#1b2a4a');
    }
    expect(oklch(1, 0, 0).hex).toBe('#ffffff');
    expect(oklab(0, 0, 0).hex).toBe('#000000');
  });

  it('OKLCH outside sRGB keeps its lightness and hue and loses chroma', () => {
    const c = oklch(0.7, 0.4, 150);
    expect(c.oklch.l).toBeCloseTo(0.7, 2);
    expect(c.oklch.h).toBeCloseTo(150, 0);
    expect(c.oklch.c).toBeLessThan(0.4);
    expect(oklch(NaN, NaN, NaN).hex).toBe('#000000');
  });

  it('mix blends in OKLab and ends on its inputs', () => {
    expect(mix('#1b2a4a', '#e8c170', 0).hex).toBe('#1b2a4a');
    expect(mix('#1b2a4a', '#e8c170', 1).hex).toBe('#e8c170');
    const mid = mix('#000000', '#ffffff', 0.5).oklch.l;
    expect(mid).toBeCloseTo(0.5, 3);
  });

  it('pens take color values; two spellings of one color are one pen', () => {
    expect(pen({ width: 0.5, color: hsl(30, 1, 0.5) }).color).toBe('#ff8000');
    const def = sketch({}, () => [
      circle(30, 30, 10, { pen: pen({ width: 0.5, color: '#FF8000' }) }),
      circle(60, 30, 10, { pen: pen({ width: 0.5, color: rgb(255, 128, 0) }) }),
    ]);
    const names = encodeScene(compileSketch(def, { paper: { w: 200, h: 200 } })).pens.map((p) => p.name);
    expect(names).toEqual(['#ff8000 0.5mm']);
  });
});
