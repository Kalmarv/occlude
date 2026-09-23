/**
 * `step` (spec 55): every word that samples a field on a lattice takes its
 * step, a length, per element. `t.travelTime({ step })` replaces `spacing`,
 * `t.relax`/`t.settle({ step })` replace the `resolution` count, and the
 * engine's field grids take `step` from the decimate, wobble, roughen and
 * deform records. The grid budget that silently coarsened a fine raster is
 * gone: a step is honoured, or refused when its samples cannot be held.
 *
 * The golden hashes below were written from the OLD code (the tree at
 * c626f65, before this change), by the same expressions these tests run,
 * with the old spellings (`spacing: 0.4`, no `resolution`, no `step`).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { SQ, toolkit } from './helpers/run.js';
import {
  compileSketch, deform, encodeScene, fill, initOcclude, mm, rect, render, sketch, type RenderResult,
} from '../src/index.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
  await initOcclude(readFileSync(wasmPath));
});

const hash = (v: ArrayLike<number>): string =>
  createHash('sha256').update(new Uint8Array(Float64Array.from(v).buffer)).digest('hex').slice(0, 16);

const inkHash = (res: RenderResult): string =>
  hash(res.frags.flatMap((f) => [f.t0, f.t1, ...Object.values(f.geom).filter((v): v is number => typeof v === 'number')]));

/** A wall from the bottom edge up to y = 70, with the seed to its left. */
const wall = (x: number, y: number): number => (x > 45 && x < 55 && y < 70 ? 0 : 1);

describe('t.travelTime: step', () => {
  it('equals the old spacing result bit for bit (golden from the old code)', () => {
    const t = toolkit();
    const T = t.travelTime({ fromPoints: [[20, 50]], speed: wall, step: 0.4 });
    const vals: number[] = [];
    for (let j = 0; j <= 40; j++) for (let i = 0; i <= 40; i++) vals.push(T(i * 2.5 + 0.13, j * 2.5 + 0.07));
    expect(hash(vals.map((v) => (Number.isFinite(v) ? v : -1)))).toBe('1d91d51f5f39386a');
  });

  it('refuses the old name', () => {
    const t = toolkit();
    expect(() => t.travelTime({ fromPoints: [[20, 50]], spacing: 0.4 } as never)).toThrow('travelTime: spacing is now step');
  });
});

describe('t.relax and t.settle: step', () => {
  const run = (step?: number) => {
    const t = toolkit({ aspect: [1, 1], seed: 11 });
    const pts = t.scatter({ spacing: 7 });
    const r = t.relax(pts, { iterations: 2, density: (x: number) => 0.1 + x / 150, step });
    // settle as the run's first draw from the points stream, where the golden
    // was read: a second draw reads a stream of its own.
    const s = toolkit({ aspect: [1, 1], seed: 11 }).settle(pts, { density: (x: number, y: number) => 0.2 + (x * y) / 15000, spacing: 6, iterations: 4, step });
    return { r, s };
  };

  it('the default equals the old resolution default bit for bit (golden from the old code)', () => {
    const { r, s } = run();
    expect(r.n).toBe(130);
    expect(hash([...r.x, ...r.y])).toBe('afffc453196a8163');
    expect(s.n).toBe(153);
    expect(hash([...s.x, ...s.y, ...s.attrs.demand])).toBe('496022ca1b90eb2c');
    // The default pitch, named: the long side over 256 (a 100-unit drawable).
    const named = run(100 / 256);
    expect(hash([...named.r.x, ...named.r.y])).toBe('afffc453196a8163');
    expect(hash([...named.s.x, ...named.s.y, ...named.s.attrs.demand])).toBe('496022ca1b90eb2c');
  });

  it('a step at half the pitch changes the result', () => {
    const { r, s } = run(100 / 512);
    expect(hash([...r.x, ...r.y])).not.toBe('afffc453196a8163');
    expect(hash([...s.x, ...s.y, ...s.attrs.demand])).not.toBe('496022ca1b90eb2c');
  });

  it('refuses the old name, and a step that is not a positive length', () => {
    const t = toolkit({ aspect: [1, 1], seed: 11 });
    const pts = t.scatter({ spacing: 7 });
    expect(() => t.relax(pts, { resolution: 128 } as never)).toThrow('relax: resolution is now step');
    expect(() => t.settle(pts, { density: () => 1, spacing: 6, resolution: 128 } as never)).toThrow('settle: resolution is now step');
    expect(() => t.relax(pts, { step: 0 })).toThrow('relax: step must be a positive finite length');
  });
});

describe('engine field grids: step', () => {
  // A hatched square whose fill is decimated by a field: the engine samples
  // the field on a paper-aligned grid over the square. On Square20 a user
  // unit is 2 mm, so field units are half a paper millimetre.
  const dec = (x: number, y: number): number => 0.5 + 0.5 * Math.sin(x / 7) * Math.cos(y / 5);
  const hatched = (step?: ReturnType<typeof mm>, field: (x: number, y: number) => number = dec) =>
    sketch({ seed: 3 }, () => rect(10, 10, 80, 80, { fill: fill('hatch', { spacing: mm(1) }), decimate: { stroke: 0, fill: field, step } }));
  /** [gw, gh, x0, y0, dx, dy] of the first grid. */
  const header = (def: ReturnType<typeof hatched>) => Array.from(encodeScene(compileSketch(def, SQ)).fieldData.slice(0, 6));

  it('without step: today\'s pitch, bit for bit (golden from the old code)', () => {
    const def = hatched();
    const scene = encodeScene(compileSketch(def, SQ));
    expect(Array.from(scene.fieldData.slice(0, 6))).toEqual([111, 111, 7.03125, 7.03125, 0.78125, 0.78125]);
    expect(hash(scene.fieldData)).toBe('9e7682d558246b0e');
    const res = render(compileSketch(def, SQ));
    expect(res.frags.length).toBe(95);
    expect(inkHash(res)).toBe('86305839d43b9987');
  });

  it('with step: sampled at that pitch, one field call per sample', () => {
    let calls = 0;
    const counted = (x: number, y: number): number => { calls++; return dec(x, y); };
    const scene = encodeScene(compileSketch(hatched(mm(0.25), counted), SQ));
    const [gw, gh, , , dx, dy] = Array.from(scene.fieldData.slice(0, 6));
    expect(dx).toBe(0.125); // 0.25 paper mm in half-millimetre field units
    expect(dy).toBe(0.125);
    expect(calls).toBe(gw * gh);
    expect(scene.fieldData.length).toBe(6 + gw * gh);
  });

  it('uses of one field that share a grid take the tightest step', () => {
    const both = sketch({ seed: 3 }, () => [
      rect(5, 5, 40, 40, { decimate: { stroke: dec, fill: 0, step: mm(0.25) } }),
      rect(55, 55, 40, 40, { decimate: { stroke: dec, fill: 0 } }),
    ]);
    const scene = encodeScene(compileSketch(both, SQ));
    expect(scene.fieldData[4]).toBe(0.125);
    // A coarser step than the default loses to the default use beside it.
    const coarse = sketch({ seed: 3 }, () => [
      rect(5, 5, 40, 40, { decimate: { stroke: dec, fill: 0, step: mm(4) } }),
      rect(55, 55, 40, 40, { decimate: { stroke: dec, fill: 0 } }),
    ]);
    expect(encodeScene(compileSketch(coarse, SQ)).fieldData[4]).toBe(0.78125);
  });

  it('a vector field takes step too (deform)', () => {
    const field = (x: number, y: number): [number, number] => [Math.sin(y / 9), Math.cos(x / 9)];
    const def = (step?: ReturnType<typeof mm>) => sketch({ seed: 3 }, () => deform({ field, step }, rect(10, 10, 80, 80)));
    expect(header(def())[4]).toBe(0.390625); // 200/256 = 0.78125 paper mm, the vector default on a 200 mm sheet
    expect(header(def(mm(0.25)))[4]).toBe(0.125);
  });

  it('the cap is gone: a step past the old 1,048,576-sample budget is honoured', () => {
    let calls = 0;
    const counted = (x: number, y: number): number => { calls++; return dec(x, y); };
    const scene = encodeScene(compileSketch(hatched(mm(0.1), counted), SQ));
    const [gw, gh, , , dx] = Array.from(scene.fieldData.slice(0, 6));
    expect(dx).toBe(0.05);
    expect(gw * gh).toBeGreaterThan(1_048_576);
    expect(calls).toBe(gw * gh);
  });

  it('refuses a step too fine to allocate, and one that is not a positive length, by name', () => {
    expect(() => encodeScene(compileSketch(hatched(mm(1e-7)), SQ))).toThrow(/^step: a field grid of \d+ × \d+ = \d+ samples does not fit a Float64Array/);
    expect(() => encodeScene(compileSketch(hatched(mm(0)), SQ))).toThrow('decimate: step must be a positive finite length');
    expect(() => encodeScene(compileSketch(hatched(mm(-1)), SQ))).toThrow('decimate: step must be a positive finite length');
    expect(() => encodeScene(compileSketch(hatched(mm(Infinity)), SQ))).toThrow('decimate: step must be a positive finite length');
  });
});
