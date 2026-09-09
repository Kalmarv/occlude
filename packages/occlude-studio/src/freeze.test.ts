import { describe, expect, test } from 'vitest';
import { tagDraws } from 'occlude';

import { freeze } from './freeze.js';

describe('freeze', () => {
  test('freeze writes once-run draws back as literals, keeps loop draws, and pins the seed', () => {
    const src = `import { sketch, circle } from 'occlude';
export default sketch({ aspect: [1, 1] }, (t) => {
  const size = t.rnd(1, 5);
  const big = t.chance(0.5);
  const pen = t.pick(['a', 'b', 'c']);
  const legs = t.times(3, () => t.rnd(0, size));
  return circle(50, 50, size);
});`;
    const { sites } = tagDraws(src);
    const id = (text: string) => sites.find((s) => s.text === text)!.id;
    const draws = {
      addrs: [`${id('t.rnd(1, 5)')}:0`, `${id('t.chance(0.5)')}:0`, `${id("t.pick(['a', 'b', 'c'])")}:0`, `${id('t.rnd(0, size)')}:0`, `${id('t.rnd(0, size)')}:1`, `${id('t.rnd(0, size)')}:2`],
      f: [0.5625, 0.2, 0.7, 0.1, 0.4, 0.8],
      values: [3.25, true, 2, 0.5, 1.5, 2.5],
    };
    const r = freeze(src, draws, `9~${id('t.rnd(1, 5)')}.0=0.5625,${id('t.rnd(0, size)')}.1=0.4`);
    expect(r.frozen).toBe(3);
    expect(r.kept).toBe(1);
    expect(r.source).toContain('const size = 3.25;');
    expect(r.source).toContain('const big = true;');
    expect(r.source).toContain("const pen = (['a', 'b', 'c'])[2];");
    expect(r.source).toContain('t.times(3, () => t.rnd(0, size))'); // ran three times: stays a draw
    // the seed is pinned with every draw that stays, at the float it had — the
    // frozen ones left the stream, so position no longer reproduces them
    const loop = id('t.rnd(0, size)');
    expect(r.source).toContain(`sketch({ seed: '9~${loop}.0=0.1,${loop}.1=0.4,${loop}.2=0.8', aspect: [1, 1] }`);
    // an existing seed option is replaced in place; negatives are parenthesised
    const r2 = freeze("export default sketch({ seed: 3, aspect: [1, 1] }, (t) => t.rnd(-2, -1));", { addrs: [`${tagDraws('t.rnd(-2, -1)').sites[0].id}:0`], f: [0.5], values: [-1.5] }, '3');
    expect(r2.source).toBe("export default sketch({ seed: '3', aspect: [1, 1] }, (t) => (-1.5));");
  });
});
