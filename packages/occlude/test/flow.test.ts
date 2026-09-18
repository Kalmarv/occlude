import { describe, expect, it } from 'vitest';
import { assetTable } from '../src/index.js';
import { image } from '../src/imageAsset.js';

/** A greyscale image from a function of pixel coordinates, 0…255. */
const picture = (w: number, h: number, f: (px: number, py: number) => number) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = f(x, y);
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
  }
  return assetTable([['t.png', { pixels: { width: w, height: h, data } }]]);
};
const angle = ([dx, dy]: [number, number]) => ((Math.atan2(dy, dx) % Math.PI) + Math.PI) % Math.PI;
/** How far apart two undirected directions are, 0…pi/2. */
const apart = (a: number, b: number) => {
  const d = Math.abs(a - b) % Math.PI;
  return Math.min(d, Math.PI - d);
};

describe('image channels', () => {
  it('every channel stays inside the 0 to 1 it promises', () => {
    // Bilinear weights and summed-area subtraction are exact in principle and
    // a rounding out either way in practice. A sketch that writes
    // `Math.pow(1 - dark, 1.4)` gets NaN from a `dark` of 1.0000000000000004,
    // which is how this was found.
    const img = image(picture(37, 23, (px, py) => ((px * 7 + py * 13) % 256)), 't.png', { x: 3, y: 5, width: 61 });
    for (const channel of ['lum', 'dark', 'a', 'edge'] as const) {
      const f = img.field(channel, { area: 1.3 });
      const g = img.field(channel);
      for (let y = 5; y < 5 + 40; y += 0.7) {
        for (let x = 3; x < 3 + 61; x += 0.9) {
          expect(f(x, y)).toBeGreaterThanOrEqual(0);
          expect(f(x, y)).toBeLessThanOrEqual(1);
          expect(g(x, y)).toBeGreaterThanOrEqual(0);
          expect(g(x, y)).toBeLessThanOrEqual(1);
        }
      }
    }
    // The failure mode is the upper end: `1 - dark` must never be negative,
    // whatever rounding the sampling leaves behind, or a fractional power of
    // it is NaN. A solid black image is the sharp case.
    const black = image(picture(16, 16, () => 0), 't.png', { x: 0, y: 0, width: 20 });
    for (const area of [undefined, 0.4, 2]) {
      const d = black.field('dark', { area })(10, 10);
      expect(d).toBeLessThanOrEqual(1);
      expect(Number.isFinite(Math.pow(1 - d, 1.4))).toBe(true);
    }
    const white = image(picture(16, 16, () => 255), 't.png', { x: 0, y: 0, width: 20 });
    expect(white.field('dark', { area: 2 })(10, 10)).toBeCloseTo(0, 12);
    expect(white.field('lum')(10, 10)).toBeLessThanOrEqual(1);
  });
});

describe('image flow', () => {
  it('runs along an edge, not across it, and is unit length inside the picture', () => {
    // A hard vertical edge: the gradient points along x, so the structure
    // runs along y.
    const img = image(picture(64, 64, (px) => (px < 32 ? 30 : 220)), 't.png', { x: 10, y: 20, width: 40 });
    const flow = img.flow();
    for (const [x, y] of [[30, 40], [30, 50], [30.1, 35]] as [number, number][]) {
      const v = flow(x, y);
      expect(Math.hypot(v[0], v[1])).toBeCloseTo(1, 6);
      expect(apart(angle(v), Math.PI / 2)).toBeLessThan(0.2);
        (0.2);
    }
    // A hard horizontal edge runs along x.
    const flat = image(picture(64, 64, (px, py) => (py < 32 ? 30 : 220)), 't.png', { x: 10, y: 20, width: 40 }).flow();
    expect(apart(angle(flat(30, 40)), 0)).toBeLessThan(0.2);
    // A patch with no structure within reach has no direction to report, and
    // says so with a zero rather than inventing one out of rounding noise.
    expect(flow(20, 40)).toEqual([0, 0]);
    expect(flow(45, 40)).toEqual([0, 0]);
    // Outside the placed rect there is no picture and so no direction.
    expect(flow(5, 40)).toEqual([0, 0]);
    expect(flow(30, 5)).toEqual([0, 0]);
    expect(flow(60, 40)).toEqual([0, 0]);
  });

  it('is calmer than the raw gradient it is built from', () => {
    // A diagonal edge under heavy salt-and-pepper noise. The raw gradient
    // direction is thrown about by the noise; the flow is what agreeing with
    // the neighbourhood is for.
    let s = 9;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const assets = picture(96, 96, (px, py) => (px + py < 96 ? 40 : 210) + (rnd() - 0.5) * 150);
    const img = image(assets, 't.png', { x: 0, y: 0, width: 60 });
    const flow = img.flow({ radius: 5 });
    const raw = (x: number, y: number): [number, number] => {
      const a = img.dir(x, y) + Math.PI / 2;
      return [Math.cos(a), Math.sin(a)];
    };
    // Disagreement between neighbouring samples, measured INSIDE the radius
    // the flow was asked to agree over — outside it there is nothing to
    // expect. Absent samples carry no direction and are not counted.
    const roughness = (f: (x: number, y: number) => [number, number], step = 1) => {
      let acc = 0;
      let n = 0;
      const live = (v: [number, number]) => v[0] !== 0 || v[1] !== 0;
      for (let y = 8; y < 52; y += step) {
        for (let x = 8; x < 52; x += step) {
          const here = f(x, y);
          if (!live(here)) continue;
          for (const there of [f(x + step, y), f(x, y + step)]) {
            if (!live(there)) continue;
            acc += apart(angle(here), angle(there));
            n++;
          }
        }
      }
      return acc / n;
    };
    expect(roughness(flow)).toBeLessThan(roughness(raw) / 3);
    // More agreement passes make it calmer still, never rougher.
    expect(roughness(img.flow({ radius: 5, iterations: 6 }))).toBeLessThanOrEqual(roughness(img.flow({ radius: 5, iterations: 1 })) + 1e-9);
    // Zero passes is the bare turned gradient, and legal.
    expect(Math.hypot(...img.flow({ radius: 5, iterations: 0 })(30, 30))).toBeCloseTo(1, 6);
  });

  it('is deterministic and refuses what it cannot use', () => {
    const img = image(picture(48, 48, (px, py) => (px * py) % 255), 't.png', { x: 0, y: 0, width: 40 });
    const a = img.flow();
    const b = img.flow();
    for (const [x, y] of [[5, 5], [17, 31], [39, 2]] as [number, number][]) expect(a(x, y)).toEqual(b(x, y));
    expect(() => img.flow({ iterations: -1 })).toThrow(/non-negative whole number/);
    expect(() => img.flow({ iterations: 1.5 })).toThrow(/non-negative whole number/);
    // No radius, no neighbourhood to average over: the field has no opinion
    // anywhere, which is the answer it gives outside the picture too.
    expect(img.flow({ radius: 0 })(5, 5)).toEqual([0, 0]);
    expect(img.flow({ radius: -3 })(5, 5)).toEqual([0, 0]);
    // The grid comes from the radius, so a radius small enough to need an
    // absurd grid is refused by name instead of being attempted.
    expect(() => img.flow({ radius: 0.002 })).toThrow(/more than four million cells/);
    expect(() => img.flow({ radius: 0.002 })).toThrow(/ask for a larger radius/);
    // A radius larger than the picture is fine: everything agrees with
    // everything, which is a legitimate thing to ask for.
    expect(Math.hypot(...img.flow({ radius: 200 })(20, 20))).toBeCloseTo(1, 6);
  });
});
