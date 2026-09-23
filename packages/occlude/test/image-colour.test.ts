import { describe, expect, it } from 'vitest';
import { assetTable } from '../src/index.js';
import { image } from '../src/imageAsset.js';

/** An RGBA image from a function of pixel coordinates. */
const picture = (w: number, h: number, f: (px: number, py: number) => [number, number, number, number]) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
  }
  return assetTable([['t.png', { pixels: { width: w, height: h, data } }]]);
};

const RED: [number, number, number, number] = [255, 0, 0, 255];
const GREEN: [number, number, number, number] = [0, 255, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];
const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const BLACK: [number, number, number, number] = [0, 0, 0, 255];

describe('image colour channels', () => {
  it('reads r, g and b as they are stored', () => {
    const img = image(picture(4, 4, () => [10, 60, 110, 255]), 't.png', { width: 40 });
    expect(img.field('r')(20, 20)).toBeCloseTo(10 / 255, 6);
    expect(img.field('g')(20, 20)).toBeCloseTo(60 / 255, 6);
    expect(img.field('b')(20, 20)).toBeCloseTo(110 / 255, 6);
    // Outside the placed rect every channel is 0, as the others are.
    for (const ch of ['r', 'g', 'b', 'c', 'm', 'y', 'k'] as const) expect(img.field(ch)(-5, -5)).toBe(0);
  });

  it('takes the grey out of c, m, y and k', () => {
    // Pure red is magenta and yellow ink and no black at all.
    const red = image(picture(4, 4, () => RED), 't.png', { width: 40 });
    expect(red.field('r')(20, 20)).toBeCloseTo(1, 6);
    expect(red.field('c')(20, 20)).toBeCloseTo(0, 6);
    expect(red.field('m')(20, 20)).toBeCloseTo(1, 6);
    expect(red.field('y')(20, 20)).toBeCloseTo(1, 6);
    expect(red.field('k')(20, 20)).toBeCloseTo(0, 6);

    // A grey asks for black alone: the three colours share all of their tone.
    const grey = image(picture(4, 4, () => [128, 128, 128, 255]), 't.png', { width: 40 });
    for (const ch of ['c', 'm', 'y'] as const) expect(grey.field(ch)(20, 20)).toBeCloseTo(0, 6);
    expect(grey.field('k')(20, 20)).toBeCloseTo(1 - 128 / 255, 6);

    // Black is all black and no colour; white is nothing at all.
    const black = image(picture(4, 4, () => BLACK), 't.png', { width: 40 });
    expect(black.field('k')(20, 20)).toBeCloseTo(1, 6);
    for (const ch of ['c', 'm', 'y'] as const) expect(black.field(ch)(20, 20)).toBeCloseTo(0, 6);
    const white = image(picture(4, 4, () => WHITE), 't.png', { width: 40 });
    for (const ch of ['c', 'm', 'y', 'k'] as const) expect(white.field(ch)(20, 20)).toBeCloseTo(0, 6);
  });

  it('averages the pixels before separating them, so `area` carries', () => {
    // Left half red, right half green: over the whole rect the average is
    // (0.5, 0.5, 0) — half the yellow gone to black, no cyan and no magenta.
    const img = image(picture(4, 4, (x) => (x < 2 ? RED : GREEN)), 't.png', { width: 40 });
    const over = { area: 25 };
    expect(img.field('r', over)(20, 20)).toBeCloseTo(0.5, 6);
    expect(img.field('k', over)(20, 20)).toBeCloseTo(0.5, 6);
    expect(img.field('c', over)(20, 20)).toBeCloseTo(0, 6);
    expect(img.field('m', over)(20, 20)).toBeCloseTo(0, 6);
    expect(img.field('y', over)(20, 20)).toBeCloseTo(1, 6);
  });

  it('names the channels it knows when given one it does not', () => {
    const img = image(picture(2, 2, () => WHITE), 't.png', { width: 40 });
    expect(() => img.field('hue' as never)).toThrow(/unknown channel .* r, g, b, c, m, y or k/);
  });
});

/** Rows 0–7 red, 8–11 green, 12–13 blue, 14–15 white: shares 1/2, 1/4, 1/8, 1/8. */
const banded = () =>
  image(picture(16, 16, (_x, y) => (y < 8 ? RED : y < 12 ? GREEN : y < 14 ? BLUE : WHITE)), 't.png', { width: 40 });

describe('img.palette', () => {
  it('fits the colours the picture is made of, most of the paper first', () => {
    const p = banded().palette(4);
    expect(p.map((e) => e.color)).toEqual(['#ff0000', '#00ff00', '#0000ff', '#ffffff']);
    expect(p.map((e) => e.share)).toEqual([0.5, 0.25, 0.125, 0.125]);
  });

  it('gives the same palette every time it is asked', () => {
    const a = banded().palette(4);
    const b = banded().palette(4);
    expect(b.map((e) => [e.color, e.share])).toEqual(a.map((e) => [e.color, e.share]));
  });

  it('gives fewer entries than asked for rather than colours that are not there', () => {
    const img = image(picture(8, 8, (x) => (x < 4 ? BLACK : WHITE)), 't.png', { width: 40 });
    const p = img.palette(5);
    expect(p).toHaveLength(2);
    expect(p.map((e) => e.color).sort()).toEqual(['#000000', '#ffffff']);
    expect(p.reduce((s, e) => s + e.share, 0)).toBeCloseTo(1, 9);
  });

  it('assigns to colours of your own, from hex or from a pen, without fitting', () => {
    const img = banded();
    const hex = img.palette(['#0000ff', '#ff0000']);
    expect(hex.map((e) => e.color)).toEqual(['#ff0000', '#0000ff']); // descending share
    expect(hex.reduce((s, e) => s + e.share, 0)).toBeCloseTo(1, 9);
    // Nothing is fitted: every band goes to whichever of the two is nearer,
    // and only the blue band is nearer to blue.
    expect(hex.map((e) => e.share)).toEqual([0.875, 0.125]);
    const pens = img.palette([{ color: '#0000ff' }, { color: '#ff0000' }]);
    expect(pens.map((e) => e.color)).toEqual(hex.map((e) => e.color));
    // A colour nothing in the picture is near keeps its place, with no share.
    const none = image(picture(4, 4, () => WHITE), 't.png', { width: 40 }).palette(['#ffffff', '#ff00ff']);
    expect(none.map((e) => [e.color, e.share])).toEqual([['#ffffff', 1], ['#ff00ff', 0]]);
    expect(() => img.palette(['nope'])).toThrow(/not a colour/);
    expect(() => img.palette(-1)).toThrow(/non-negative whole number/);
    expect(() => img.palette(2, { space: 'hsl' as never })).toThrow(/lab.*rgb/);
  });

  it('measures in Lab by default and in RGB when asked', () => {
    const img = banded();
    expect(img.palette(4, { space: 'rgb' }).map((e) => e.color)).toEqual(['#ff0000', '#00ff00', '#0000ff', '#ffffff']);
  });

  it("reads membership as an ordinary field: 1 at the colour, 0.5 where the next is as near", () => {
    const p = banded().palette(4);
    const red = p[0].field();
    const green = p[1].field();
    expect(red(20, 10)).toBeCloseTo(1, 6); // inside the red band
    expect(green(20, 10)).toBeLessThan(0.5);
    expect(green(20, 25)).toBeCloseTo(1, 6); // inside the green band
    expect(red(20, 25)).toBeLessThan(0.5);
    expect(red(-5, -5)).toBe(0); // outside the placed rect
  });

  it('answers contours() with the contours of that membership, closed on the picture', () => {
    const p = banded().palette(4);
    const red = p[0].contours();
    expect(red.length).toBeGreaterThan(0);
    expect(red.every((c) => c.closed)).toBe(true);
    // The red band is the top half, so its contour stays in the top half.
    const ys = red.flatMap((c) => c.pts.map(([, y]) => y));
    expect(Math.max(...ys)).toBeLessThan(22);
    expect(p[0].contours(Number.NaN)).toEqual([]);
  });

  it('holds no share for a pixel the picture does not cover', () => {
    // Half opaque red, half fully transparent: one colour, and all of it.
    const img = image(picture(8, 8, (x) => (x < 4 ? RED : [0, 0, 0, 0])), 't.png', { width: 40 });
    const p = img.palette(3);
    expect(p).toHaveLength(1);
    expect(p[0].color).toBe('#ff0000');
    expect(p[0].share).toBe(1);
    expect(p[0].field()(30, 20)).toBe(0); // transparent: no colour at all
  });
});

describe('img.regions', () => {
  it('separates a picture into a stack of areas, lightest first', () => {
    const img = image(picture(16, 16, (x) => (x < 8 ? BLACK : WHITE)), 't.png', { width: 40 });
    const r = img.regions({ count: 2 });
    expect(r.map((e) => e.color)).toEqual(['#ffffff', '#000000']);
    expect(r.map((e) => e.share)).toEqual([0.5, 0.5]);
    for (const region of r) {
      const cs = region.contours();
      expect(cs.length).toBeGreaterThan(0);
      expect(cs.every((c) => c.closed)).toBe(true);
    }
    // The white region is the right half and the black one the left.
    const xs = (i: number) => r[i].contours().flatMap((c) => c.pts.map(([x]) => x));
    expect(Math.min(...xs(0))).toBeGreaterThan(18);
    expect(Math.max(...xs(1))).toBeLessThan(22);
  });

  it('absorbs a patch smaller than the tolerance into what surrounds it', () => {
    const speck = image(
      picture(32, 32, (x, y) => (x >= 15 && x < 17 && y >= 15 && y < 17 ? BLACK : WHITE)),
      't.png',
      { width: 40 },
    );
    // Four cells in 1024 is 0.4% of the picture.
    expect(speck.regions({ count: 2, tolerance: 0 }).map((e) => e.color)).toEqual(['#ffffff', '#000000']);
    const merged = speck.regions({ count: 2, tolerance: 0.02 });
    expect(merged.map((e) => e.color)).toEqual(['#ffffff']);
    expect(merged[0].share).toBe(1);
  });

  it('is a monochrome trace at count 2, and refuses a count that is not one', () => {
    const img = image(picture(16, 16, (_x, y) => (y < 4 ? BLACK : WHITE)), 't.png', { width: 40 });
    expect(img.regions({ count: 2 })).toHaveLength(2);
    expect(img.regions({ count: 1 })).toHaveLength(1);
    expect(img.regions({ count: 0 })).toEqual([]);
    expect(() => img.regions({ count: 2.5 })).toThrow(/whole number/);
    expect(() => img.regions({ tolerance: -1 })).toThrow(/tolerance/);
  });

  it('answers the area protocol, so an area consumer reads it with no wrapper', async () => {
    const { areaLoops } = await import('../src/boundary.js');
    const img = image(picture(16, 16, (x) => (x < 8 ? BLACK : WHITE)), 't.png', { width: 40 });
    const region = img.regions({ count: 2 })[0];
    const loops = areaLoops(region, 'polygon');
    expect(loops).toHaveLength(region.contours().length);
    expect(loops[0].length).toBeGreaterThan(2);
  });

  it('leaves a pixel the picture does not cover out of every region', () => {
    const img = image(picture(16, 16, (x) => (x < 8 ? WHITE : [0, 0, 0, 0])), 't.png', { width: 40 });
    const r = img.regions({ count: 2 });
    expect(r).toHaveLength(1);
    expect(r[0].share).toBeCloseTo(0.5, 6);
  });
});
