import { describe, expect, it } from 'vitest';

import { scanUiControls, shaper } from '../src/index.js';

describe('shaper', () => {
  it('identity through the corners; inputs outside the domain clamp to its ends', () => {
    const s = shaper([[0, 0], [1, 1]]);
    expect(s(0)).toBe(0);
    expect(s(0.5)).toBeCloseTo(0.5, 6);
    expect(s(1)).toBe(1);
    expect(s(-2)).toBe(0);
    expect(s(3)).toBe(1);
    expect(Number.isNaN(s(NaN))).toBe(true);
    expect(s.domain).toEqual([0, 1]);
    expect(s.range).toEqual([0, 1]);
  });

  it('the knots define the area: any domain, any range, output bounded by the knots', () => {
    const wide = shaper([[0, 0], [2, 2]]);
    expect(wide(1.5)).toBeCloseTo(1.5, 6);
    expect(wide(5)).toBe(2);
    const mmCurve = shaper([[0, 0.65], [0.5, 1.2], [1, 3.75]]); // luminance → mm of spacing
    expect(mmCurve(0)).toBeCloseTo(0.65, 6);
    expect(mmCurve(1)).toBeCloseTo(3.75, 6);
    expect(mmCurve.range).toEqual([0.65, 3.75]);
    for (let v = 0; v <= 1; v += 0.01) {
      expect(mmCurve(v)).toBeGreaterThanOrEqual(0.65);
      expect(mmCurve(v)).toBeLessThanOrEqual(3.75);
    }
    const inverting = shaper([[0, 1], [1, 0]]);
    expect(inverting(0.25)).toBeCloseTo(0.75, 6);
  });

  it('passes through its knots and lifts the midtones when the middle knot is raised', () => {
    const s = shaper([[0, 0], [0.5, 0.75], [1, 1]]);
    expect(s(0.5)).toBeCloseTo(0.75, 6);
    expect(s(0.25)).toBeGreaterThan(0.25);
    expect(s(0.9)).toBeGreaterThan(0.9);
    expect(s(0)).toBe(0);
    expect(s(1)).toBe(1);
  });

  it('clips: a flat top stays flat and never exceeds the highest knot', () => {
    const s = shaper([[0, 0], [0.6, 1], [1, 1]]);
    for (let v = 0.6; v <= 1; v += 0.05) expect(s(v)).toBeLessThanOrEqual(1);
    expect(s(0.3)).toBeGreaterThan(0.3);
  });

  it('sorts knots, keeps the points on the value, and honours the method', () => {
    const s = shaper([[1, 1], [0, 0], [0.5, 0.2]], { method: 'linear' });
    expect(s.points.map((p) => p[0])).toEqual([0, 0.5, 1]);
    expect(s.method).toBe('linear');
    expect(s(0.25)).toBeCloseTo(0.1, 6); // linear between (0,0) and (0.5,0.2)
  });

  it('refuses fewer than two knots or non-numeric ones', () => {
    expect(() => shaper([[0, 0]])).toThrow(/two/);
    expect(() => shaper([[0, 0], [1, 'x' as unknown as number]])).toThrow(/numbers/);
  });
});

describe('shaper bounds', () => {
  it('bounds fix the area regardless of the knots', () => {
    const s = shaper([[0, 0], [0.5, 0.4], [1, 0.9]], { bounds: [[0, 0], [2, 2]] });
    expect(s.domain).toEqual([0, 2]);
    expect(s.range).toEqual([0, 2]);
    expect(s(1.5)).toBeCloseTo(0.9, 6); // past the last knot: holds its value
    expect(s(0.5)).toBeCloseTo(0.4, 6);
    expect(() => shaper([[0, 0], [1, 1]], { bounds: [[0, 0], [0, 1]] })).toThrow(/bounds/);
  });
});

describe('shaper knots as a control', () => {
  it('scanUiControls finds the knot literal with its span and label', () => {
    const src = `const tone = shaper([[0, 0], [0.3, 0.15], [1, 1]]);\nconst k = ui(3);`;
    const cs = scanUiControls(src);
    expect(cs).toHaveLength(2);
    const c = cs[0];
    expect(c.kind).toBe('points');
    expect(c.label).toBe('tone');
    expect(c.value).toEqual([[0, 0], [0.3, 0.15], [1, 1]]);
    expect(src.slice(c.valueStart, c.valueEnd)).toBe('[[0, 0], [0.3, 0.15], [1, 1]]');
    expect(cs[1].kind).toBe('number');
  });

  it('carries explicit bounds from the opts literal onto the control', () => {
    const src = `const g = shaper([[0, 0], [1, 1]], { bounds: [[0, 0], [2, 2]], method: 'linear' });`;
    const c = scanUiControls(src)[0];
    expect(c.kind).toBe('points');
    expect(c.opts.bounds).toEqual([[0, 0], [2, 2]]);
    expect(src.slice(c.valueStart, c.valueEnd)).toBe('[[0, 0], [1, 1]]');
  });

  it('reads bounds through a formatter’s trailing comma and line breaks', () => {
    const src = `const gamma = shaper(
    [
      [0, 0],
      [0.676, 0.241],
      [2, 0.702],
    ],
    {
      bounds: [
        [0, 0],
        [2, 2],
      ],
    },
  );`;
    const c = scanUiControls(src)[0];
    expect(c.kind).toBe('points');
    expect(c.opts.bounds).toEqual([[0, 0], [2, 2]]);
    expect(c.value).toEqual([[0, 0], [0.676, 0.241], [2, 0.702]]);
    // ui() with the same formatting.
    const u = scanUiControls(`const k = ui(\n  3,\n  { min: 1, max: 9 },\n);`)[0];
    expect(u.opts).toEqual({ min: 1, max: 9 });
  });

  it('ignores computed knots and shaper calls inside strings or comments', () => {
    const src = `// shaper([[0,0],[1,1]])\nconst a = shaper(pts);\nconst s = 'shaper([[0,0],[1,1]])';\nconst b = shaper([[0, 0], [1, k]]);`;
    expect(scanUiControls(src)).toHaveLength(0);
  });
});
