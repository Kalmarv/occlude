import { describe, expect, test } from 'vitest';

import { fuckItUp, rndCallee } from './chaos.js';

describe('fuck it up', () => {
  test('every number becomes a draw around itself; whole numbers stay whole', () => {
    const src = `import { sketch, circle } from 'occlude';
export default sketch({ aspect: [2, 1], margin: 6 }, (t) => {
  const r = 12.5;
  return circle(50, 40, r * 1.5, { pen: 'micron-03' });
});`;
    const out = fuckItUp(src, 0.2);
    expect(out).toContain("import { sketch, circle } from 'occlude';");
    expect(out).toContain('{ aspect: [2, 1], margin: 6 }'); // the sketch's own options are left alone
    expect(out).toContain('const r = t.rnd(10, 15);');
    expect(out).toContain('circle(Math.round(t.rnd(40, 60)), Math.round(t.rnd(32, 48)), r * t.rnd(1.2, 1.8)');
    expect(out).toContain("'micron-03'"); // strings untouched
  });

  test('ui controls, zeros, comments and strings are left alone; negatives keep their sign', () => {
    const src = `export default sketch({}, (t) => {
  const k = ui(0.6, { min: 0, max: 2 }); // 3 things
  const z = 0;
  const neg = -4;
  return [k, z, neg, 'x 7'];
});`;
    const out = fuckItUp(src, 0.5);
    expect(out).toContain('ui(0.6, { min: 0, max: 2 })');
    expect(out).toContain('// 3 things');
    expect(out).toContain('const z = 0;');
    expect(out).toContain("'x 7'");
    expect(out).toContain('const neg = Math.round(t.rnd(-6, -2));');
  });

  test('the draw goes through whatever the sketch calls its toolkit', () => {
    expect(rndCallee('sketch({}, (tk) => 1)')).toBe('tk.rnd');
    expect(rndCallee('sketch({}, ({ rnd, circle }) => 1)')).toBe('rnd');
    expect(rndCallee('sketch({}, ({ circle }) => 1)')).toBe('t.rnd');
    expect(fuckItUp('export default sketch({}, (tk) => tk.times(3, () => 2.5));', 0.1)).toContain('tk.times(Math.round(tk.rnd(2.7, 3.3)), () => tk.rnd(2.25, 2.75))');
  });
});
