import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import { clip, evalPrim, group, initOcclude, line, rect, render, setPaperHint, sketch, type ShapeOpts } from '../src/index.js';

beforeAll(async () => {
  await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url)));
  setPaperHint(200, 200);
});

it.each([
  [{ translate: [60, 0] }, [120, 160]],
  [{ rotate: 180, origin: [50, 50] }, [160, 200]],
  [{ scale: 0.5, origin: [50, 50] }, [50, 70]],
] as [ShapeOpts, number[]][])('clip honors its own transform %j without transforming children', (opts, expected) => {
  for (const dx of [0, 5]) {
    const result = render(sketch({ margin: 0, seed: 1 }, () => group({ translate: [dx, 0] },
      clip(rect(0, 0, 20, 100, opts), line(-10, 50, 110, 50)),
    )), { paper: 'Square20' });
    expect(result.frags).toHaveLength(1);
    const xs = [evalPrim(result.frags[0].geom, 0)[0], evalPrim(result.frags[0].geom, 1)[0]].sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(expected[0] + dx * 2, 6);
    expect(xs[1]).toBeCloseTo(Math.min(200, expected[1] + dx * 2), 6);
  }
});
