import { describe, expect, it } from 'vitest';

import { scanUiControls, shaper } from '../src/index.js';

describe('shaper', () => {
  it('identity through the corners, clamped to the unit range', () => {
    const s = shaper([[0, 0], [1, 1]]);
    expect(s(0)).toBe(0);
    expect(s(0.5)).toBeCloseTo(0.5, 6);
    expect(s(1)).toBe(1);
    expect(s(-2)).toBe(0);
    expect(s(3)).toBe(1);
    expect(Number.isNaN(s(NaN))).toBe(true);
  });

  it('passes through its knots and lifts the midtones when the middle knot is raised', () => {
    const s = shaper([[0, 0], [0.5, 0.75], [1, 1]]);
    expect(s(0.5)).toBeCloseTo(0.75, 6);
    expect(s(0.25)).toBeGreaterThan(0.25);
    expect(s(0.9)).toBeGreaterThan(0.9);
    expect(s(0)).toBe(0);
    expect(s(1)).toBe(1);
  });

  it('clips: a flat top stays flat and never exceeds 1', () => {
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

  it('ignores computed knots and shaper calls inside strings or comments', () => {
    const src = `// shaper([[0,0],[1,1]])\nconst a = shaper(pts);\nconst s = 'shaper([[0,0],[1,1]])';\nconst b = shaper([[0, 0], [1, k]]);`;
    expect(scanUiControls(src)).toHaveLength(0);
  });
});
