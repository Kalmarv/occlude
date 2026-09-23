/**
 * A pre-stage modifier on a 3D view's strokes. A projected stroke carries
 * its whole source line and the ranges of it that are seen; `deform`,
 * `roughen` and `smooth` move the line before the solve, where a range
 * means nothing, so the seen pieces are cut out first and the modifier
 * takes those. Before this it refused: "strokeRanges requires one polyline
 * without fill or pre-stage modifiers". Also: a field a sketch writes by
 * hand may answer a plain `[dx, dy]` — TypeScript reads that as number[].
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deform, initOcclude, mm, pen, renderAsync, sketch, strokes, type SketchDef } from '../src/index.js';
import { box, grid, instanceOnPoints, perspective, view } from '../src/three/api/index.js';

beforeAll(async () => {
  await initOcclude(readFileSync(fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));
});

const drawing = (field: (x: number, y: number) => number[]) => sketch({ aspect: [1, 1], pens: { ink: pen({ width: mm(0.3), color: '#000000' }) } }, () => {
  const pts = grid({ rows: 2, cols: 2, layers: 2, spacing: 1.2 });
  const boxes = instanceOnPoints(box(), pts.points);
  return view(boxes, { camera: perspective({ eye: [5, 5.3, 2.8], target: [0.6, 0.5, 0], fovDegrees: 45 }) },
    (lines) => deform(field, strokes(lines.visible, { pen: 'ink' })));
}) as SketchDef;

describe('deform on a view\'s strokes', () => {
  it('a plain [dx, dy] field is accepted, and the seen pieces are warped instead of refused', async () => {
    const still = await renderAsync(drawing((x, y) => [0, 0]), { paper: 'Square20' });
    const waved = await renderAsync(drawing((x, y) => [3 * Math.sin(y / 8), 0]), { paper: 'Square20' });
    expect(still.frags.length).toBeGreaterThan(100);
    expect(waved.frags.length).toBeGreaterThan(100);
    const x0 = still.frags.map((f) => f.geom.t === 'line' ? f.geom.x0 : 0).reduce((a, b) => a + b, 0);
    const x1 = waved.frags.map((f) => f.geom.t === 'line' ? f.geom.x0 : 0).reduce((a, b) => a + b, 0);
    expect(Math.abs(x1 - x0)).toBeGreaterThan(1);
  }, 120_000);
});
