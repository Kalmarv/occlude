/**
 * Typography: the two font formats `strokeFont()` reads, the six bundled
 * faces, and what `t.text` does with a string — size as cap height, the
 * pen walk, alignment, leading, and a line set along a chain.
 */
import { describe, expect, it } from 'vitest';
import { circle, material, type Material } from '../src/index.js';
import { strokeFont } from '../src/strokeFont.js';
import {
  hersheySimplex, hersheyDuplex, hersheyTriplex, hersheyScript, hersheyGothic, relief,
} from '../src/fonts/index.js';
import { toolkit } from './helpers/run.js';

/** Two glyphs and one kern pair, the smallest SVG font that says anything. */
const TINY_SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg"><defs>
<font id="tiny" horiz-adv-x="500">
  <font-face font-family="Tiny" units-per-em="1000" ascent="800" descent="-200" x-height="500" cap-height="700" />
  <missing-glyph horiz-adv-x="400" />
  <glyph glyph-name="A" unicode="A" horiz-adv-x="600" d="M0 0L300 700L600 0" />
  <glyph glyph-name="V" unicode="V" horiz-adv-x="600" d="M0 700Q300 350 600 700" />
  <hkern g1="A" u2="V" k="80" />
</font></defs></svg>`;

/** Two Hershey records: a space, and a glyph of two strokes with a pen-up
 * between them. Coordinates are characters offset from `R`. */
const TINY_JHF = [
  '  699  1JZ',
  '  700  6HWJRVR RRMRW',
].join('\n');

const bbox = (m: Material) => ({
  minX: Math.min(...m.x), maxX: Math.max(...m.x),
  minY: Math.min(...m.y), maxY: Math.max(...m.y),
});
const rows = (m: Material) => [...m.x].map((x, i) => [x, m.y[i]] as const);

describe('strokeFont: an SVG 1.1 font', () => {
  const f = strokeFont(TINY_SVG);

  it('reads the metrics, the glyphs and their advances', () => {
    expect(f.name).toBe('Tiny');
    expect(f.unitsPerEm).toBe(1000);
    expect(f.ascent).toBe(800);
    expect(f.descent).toBe(-200);
    expect(f.capHeight).toBe(700);
    expect(f.xHeight).toBe(500);
    expect(f.has('A')).toBe(true);
    expect(f.has('Q')).toBe(false);
    expect(f.glyph('Q')).toBeUndefined();
    expect(f.advance('A')).toBe(600);
    // No glyph and no space in this face: the missing-glyph advance.
    expect(f.advance('Q')).toBe(400);
  });

  it('gives the glyph its chains in em units, y up', () => {
    const [chain] = f.glyph('A')!.curves();
    expect(chain.closed).toBe(false);
    expect(chain.pts).toEqual([[0, 0], [300, 700], [600, 0]]);
  });

  it('keeps a Bézier a Bézier until a tolerance asks for points', () => {
    const coarse = f.glyph('V')!.curves({ tolerance: 200 }).at(0)!.pts;
    const fine = f.glyph('V')!.curves({ tolerance: 0.5 }).at(0)!.pts;
    expect(fine.length).toBeGreaterThan(coarse.length);
    // The quadratic's own midpoint, to prove the curve and not the chord.
    const mid = fine[(fine.length - 1) / 2];
    expect(mid[0]).toBeCloseTo(300, 6);
    expect(mid[1]).toBeCloseTo(525, 6);
  });

  it('reads kerning and hands back what to ADD to the advance', () => {
    expect(f.kern('A', 'V')).toBe(-80);
    expect(f.kern('V', 'A')).toBe(0);
  });
});

describe('strokeFont: a Hershey .jhf file', () => {
  const f = strokeFont(TINY_JHF);

  it('maps records to characters by position from space', () => {
    expect(f.has(' ')).toBe(true);
    expect(f.has('!')).toBe(true);
    expect(f.has('"')).toBe(false);
    expect(f.unitsPerEm).toBe(32);
    // 'J'..'Z' is -8..+8 for the space, 'H'..'W' is -10..+5 for the glyph.
    expect(f.advance(' ')).toBe(16);
    expect(f.advance('!')).toBe(15);
  });

  it('breaks a glyph at every pen-up, y up from the baseline at +9', () => {
    const chains = f.glyph('!')!.curves();
    expect(chains.length).toBe(2);
    expect(chains.map((c) => c.closed)).toEqual([false, false]);
    // 'JRVR' is a horizontal stroke on the baseline; 'RMRW' a vertical one.
    expect(chains[0].pts).toEqual([[2, 9], [14, 9]]);
    expect(chains[1].pts).toEqual([[10, 14], [10, 4]]);
  });

  it('reads a file wrapped at 72 columns the same as one glyph per line', () => {
    const wrapped = TINY_JHF.replace('  700  6HWJRVR RRMRW', '  700  6HWJRVR R\nRMRW');
    expect(strokeFont(wrapped).glyph('!')!.curves()).toEqual(f.glyph('!')!.curves());
  });
});

describe('strokeFont: a source that is neither', () => {
  it('refuses by name', () => {
    expect(() => strokeFont('hello, this is prose')).toThrow(/strokeFont\(\): unrecognised font source/);
    expect(() => strokeFont('')).toThrow(/strokeFont\(\)/);
  });
});

describe('the bundled faces', () => {
  const faces = [
    ['hersheySimplex', hersheySimplex], ['hersheyDuplex', hersheyDuplex],
    ['hersheyTriplex', hersheyTriplex], ['hersheyScript', hersheyScript],
    ['hersheyGothic', hersheyGothic], ['relief', relief],
  ] as const;

  it.each(faces)('%s parses, with lowercase, digits and punctuation', (name, font) => {
    expect(font.name.length).toBeGreaterThan(0);
    for (const ch of 'aeghz AZ09.,-') expect(font.has(ch)).toBe(true);
    expect(font.capHeight!).toBeGreaterThan(0);
    expect(font.xHeight!).toBeLessThan(font.capHeight!);
    expect(font.descent).toBeLessThan(0);
    expect(font.ascent).toBeGreaterThan(font.capHeight!);
    expect(font.glyph('a')!.curves().length).toBeGreaterThan(0);
    expect(name).toBe(name);
  });

  it('gives the Hershey faces the grid they were digitized on', () => {
    expect(hersheySimplex.unitsPerEm).toBe(32);
    expect(hersheySimplex.capHeight).toBe(21);
    expect(hersheySimplex.xHeight).toBe(14);
  });

  it('gives Relief the metrics its font-face declares, and accented glyphs', () => {
    expect(relief.unitsPerEm).toBe(1000);
    expect(relief.capHeight).toBe(680);
    expect(relief.has('é')).toBe(true);
    expect(relief.kern('A', 'V')).toBeLessThan(0);
  });
});

describe('t.text', () => {
  const t = toolkit();

  it('sets the cap height to `size`', () => {
    for (const font of [hersheySimplex, relief]) {
      const box = bbox(t.text('HA', { font, size: 20 }));
      // The baseline is at y = 0 and y counts down the page.
      expect(Math.abs(box.minY)).toBeGreaterThan(20 * 0.99);
      expect(Math.abs(box.minY)).toBeLessThan(20 * 1.01);
      expect(box.maxY).toBeCloseTo(0, 6);
    }
    // Size is the cap height, not the line's extent: Relief's ascender
    // stands 65/680 of an em above its capitals, and still does here.
    const tall = bbox(t.text('Hb', { font: relief, size: 20 }));
    expect(Math.abs(tall.minY)).toBeCloseTo(20 * (745 / 680), 6);
  });

  it('adds `tracking` once per advance', () => {
    const plain = bbox(t.text('AAA', { size: 10 }));
    const spaced = bbox(t.text('AAA', { size: 10, tracking: 2 }));
    expect(spaced.maxX - plain.maxX).toBeCloseTo(4, 9);
    expect(spaced.minX).toBeCloseTo(plain.minX, 9);
  });

  it('anchors the origin where `align` says', () => {
    const left = bbox(t.text('WORD', { size: 10 }));
    const centre = bbox(t.text('WORD', { size: 10, align: 'center' }));
    const right = bbox(t.text('WORD', { size: 10, align: 'right' }));
    const half = left.minX - centre.minX;
    expect(half).toBeGreaterThan(0);
    expect(left.minX - right.minX).toBeCloseTo(2 * half, 9);
    expect(right.maxX).toBeLessThanOrEqual(0);
  });

  it('breaks lines at \\n, one `leading` apart', () => {
    const one = t.text('A', { size: 10 });
    const two = t.text('A\nA', { size: 10, leading: 30 });
    expect(two.n).toBe(2 * one.n);
    const ys = [...two.y].sort((a, b) => a - b);
    expect(ys[ys.length - 1] - ys[0]).toBeCloseTo(30 + (Math.max(...one.y) - Math.min(...one.y)), 6);
    // Default leading is one em at this size.
    const plain = t.text('A\nA', { size: 10 });
    const em = (hersheySimplex.unitsPerEm / hersheySimplex.capHeight!) * 10;
    expect(Math.max(...plain.y) - Math.max(...one.y)).toBeCloseTo(em, 6);
  });

  it('advances a space where the face has no glyph', () => {
    const known = t.text('A A', { size: 10 });
    const unknown = t.text('A€A', { size: 10 });
    expect(rows(unknown)).toEqual(rows(known));
  });

  it('is empty for an empty string, and for a size that resolves to nothing', () => {
    expect(t.text('', { size: 10 }).n).toBe(0);
    expect(t.text('word', { size: 0 }).n).toBe(0);
  });

  it('carries the index into the string on every point', () => {
    const m = t.text('A B', { size: 10 });
    const col = m.attrs.glyph;
    expect(col).toBeDefined();
    expect(col.length).toBe(m.n);
    // 'A' is index 0 and 'B' index 2; the space draws nothing.
    expect(new Set(col)).toEqual(new Set([0, 2]));
    const b = m.points.filter((p) => p.glyph === 2);
    expect(Math.min(...b.map((p) => p.x))).toBeGreaterThan(Math.max(...m.points.filter((p) => p.glyph === 0).map((p) => p.x)));
  });

  it('draws the same ink twice', () => {
    const opts = { font: relief, size: 12, tracking: 0.4, align: 'center' as const };
    expect(rows(t.text('same ink', opts))).toEqual(rows(t.text('same ink', opts)));
  });

  describe('along a chain', () => {
    const ring = t.material(circle(50, 50, 30));
    const radius = (x: number, y: number) => Math.hypot(x - 50, y - 50);

    it('puts every baseline on the tangent', () => {
      // '-' is one horizontal stroke: on a circle its direction must be
      // square to the radius under it, and every copy must sit at the same
      // distance from the centre.
      const m = t.text('----', { size: 6, along: ring });
      const chains = m.curves();
      expect(chains.length).toBe(4);
      const radii: number[] = [];
      for (const c of chains) {
        const [ax, ay] = c.pts[0];
        const [bx, by] = c.pts[c.pts.length - 1];
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        const dot = (bx - ax) * (mx - 50) + (by - ay) * (my - 50);
        expect(Math.abs(dot) / (Math.hypot(bx - ax, by - ay) * radius(mx, my))).toBeLessThan(0.02);
        radii.push(radius(mx, my));
      }
      // The ring is a flattened circle, so the radius under a glyph wobbles
      // by the sagitta of one segment and no more.
      // A flattened circle at 0.05 mm: the radius under a glyph wobbles by
      // the sagitta of one segment (0.025 drawable units here) and no more.
      for (const r of radii) expect(Math.abs(r - radii[0])).toBeLessThan(0.025);
      expect(radii[0]).toBeGreaterThan(25);
      expect(radii[0]).toBeLessThan(35);
    });

    it('walks the chain by arc length, and centres what it is asked to', () => {
      const word = 'occlude';
      const arc = (align: 'left' | 'center' | 'right') =>
        t.text(word, { size: 6, along: ring, align }).x[0];
      // A ring is closed, so left starts at the chain's own start; centre
      // and right each push the same word further round it.
      expect(arc('left')).not.toBeCloseTo(arc('center'), 3);
      expect(arc('center')).not.toBeCloseTo(arc('right'), 3);
      const straight = t.text(word, { size: 6 });
      const curved = t.text(word, { size: 6, along: ring });
      expect(curved.n).toBe(straight.n);
    });

    it('refuses a value that is neither a chain nor a curve', () => {
      expect(() => t.text('x', { size: 6, along: { nope: true } as never })).toThrow(/text: 'along' wants a chain/);
    });

    it('draws nothing for a chain with nothing in it', () => {
      expect(t.text('x', { size: 6, along: material([]) }).n).toBe(0);
    });

    it('refuses `at` and `along` together', () => {
      expect(() => t.text('x', { size: 6, at: [0, 0], along: ring })).toThrow(/give 'at' or 'along', not both/);
    });
  });
});
