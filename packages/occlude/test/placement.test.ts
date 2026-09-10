import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  circle, evalPrim, initOcclude, isStations, material, rect, render, setPaperHint, sketch,
  stationsMaterial, type SketchDef, type Station,
} from '../src/index.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(
    new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
  );
  await initOcclude(readFileSync(wasmPath));
  setPaperHint(200, 200);
});

/** A straight spine along y = 50, stations every 20 units from x = 10. */
const spine = material([[10, 50], [30, 50], [50, 50], [70, 50], [90, 50]], {
  edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
});
const stations = spine.along({ spacing: 20 });

function boxOf(def: SketchDef): number[] {
  const out = render(def, { paper: 'Square20' });
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const frag of out.frags) {
    for (const s of [0, 0.5, 1]) {
      const [px, py] = evalPrim(frag.geom, s);
      x0 = Math.min(x0, px);
      y0 = Math.min(y0, py);
      x1 = Math.max(x1, px);
      y1 = Math.max(y1, py);
    }
  }
  return [x0, y0, x1, y1];
}

const placeAll = (fn: (s: Station) => unknown) =>
  sketch({}, () => stations.map((s) => fn(s) as never));

describe('Station.place: put a motif on the spine', () => {
  it('stands the motif at the station, on a straight spine', () => {
    // 5 stations at x = 10…90, a circle of radius 3, user units → 2 mm each.
    expect(boxOf(placeAll((s) => s.place(circle(0, 0, 3))))).toEqual([14, 94, 186, 106]);
  });

  it('offsets in the station frame: +normal moves off the spine, +tangent along it', () => {
    expect(boxOf(placeAll((s) => s.place(circle(0, 0, 3), { offset: [0, 5] })))).toEqual([14, 104, 186, 116]);
    expect(boxOf(placeAll((s) => s.place(circle(0, 0, 3), { offset: [5, 0] })))).toEqual([24, 94, 196, 106]);
  });

  it('mirrors a motif across the spine with a negative scale', () => {
    const motif = rect(-2, 2, 4, 2); // sits above the spine, not on it
    const up = boxOf(placeAll((s) => s.place(motif)));
    const down = boxOf(placeAll((s) => s.place(motif, { scale: [1, -1] })));
    expect(up[1]).toBeCloseTo(104, 6); // y from 52 user units
    expect(down[1]).toBeCloseTo(92, 6); // mirrored: 46 user units
    expect(up[3]).toBeCloseTo(108, 6);
    expect(down[3]).toBeCloseTo(96, 6);
    expect(up[0]).toBeCloseTo(down[0], 6);
    expect(up[2]).toBeCloseTo(down[2], 6);
  });

  it('rotates the motif with the heading it was placed on', () => {
    const vertical = material([[50, 10], [50, 50], [50, 90]], { edges: [[0, 1], [1, 2]] });
    const up = vertical.along({ spacing: 20 });
    for (const s of up) expect(Math.abs(s.heading)).toBeCloseTo(Math.PI / 2, 9);
    // A motif offset along the tangent of a vertical spine moves in y.
    const b = boxOf(sketch({}, () => up.map((s) => s.place(circle(0, 0, 3), { offset: [10, 0] })) as never));
    expect(b[0]).toBeCloseTo(94, 6);
    expect(b[2]).toBeCloseTo(106, 6);
  });

  it('keeps stations plain data: own fields only, and the material they make', () => {
    const first = stations[0];
    expect(isStations(stations)).toBe(true);
    expect(Object.keys(first)).not.toContain('place');
    const roundTrip = JSON.parse(JSON.stringify(first)) as Record<string, unknown>;
    expect(roundTrip.x).toBe(first.x);
    expect(roundTrip.tangent).toEqual(first.tangent);
    expect(roundTrip.attrs).toEqual(first.attrs);
    expect(stationsMaterial(stations).points.length).toBe(stations.length);
    expect(typeof first.place).toBe('function');
  });
});
