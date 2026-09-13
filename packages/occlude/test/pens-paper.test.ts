/**
 * Paper and pens as explicit sketch dependencies: `paper()`, `pen()`,
 * library models, `inch`, sketch-local names beside the captured library,
 * and what a run snapshots.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_PENS, circle, compileSketch, encodeScene, exportSvg, fill, inch, initOcclude, mm, paper, paperModel, pen, penModel,
  render, sketch,
} from '../src/index.js';

beforeAll(async () => {
  await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url)));
});

describe('paper and pens declared by the sketch', () => {
  it('paper() takes inches or millimetres and resolves to mm once; the sketch\'s paper wins over the host\'s', () => {
    const letter = paper({ width: inch(8.5), height: inch(11), color: '#F5F0E6' });
    expect(letter).toEqual({ w: 215.9, h: 279.4, color: '#F5F0E6' });
    expect(paper({ width: mm(180), height: 240 })).toEqual({ w: 180, h: 240 });
    expect(() => paper({ width: 0, height: 10 })).toThrow(/positive/);
    const def = sketch({ paper: letter, margin: inch(0.5) }, (t) => circle(t.cx, t.cy, 10));
    const exec = compileSketch(def, { paper: { w: 100, h: 100 } });
    expect(exec.paper).toEqual(letter);
    expect(exec.marginPct).toBeCloseTo((12.7 / 215.9) * 100, 9);
    expect(exec.frame.paperW).toBe(215.9);
    const out = render(exec);
    expect(out.paper).toEqual({ w: 215.9, h: 279.4 });
  });

  it('pen() defaults the machine settings; instances of a model are distinct and never mutate it', () => {
    const p = pen({ width: mm(0.8), color: '#D64045', feed: 1800 });
    expect(p).toEqual({ width: 0.8, color: '#D64045', feed: 1800, penDown: 0, penUp: 5, penDelay: 100 });
    expect(() => pen({ width: -1 })).toThrow(/width/);
    const fineliner = penModel({ name: 'fineliner', width: 0.3, color: '#111111', feed: 2500, penDown: 0, penUp: 5, penDelay: 120 });
    const blue = fineliner({ color: '#2457D6' });
    const red = fineliner({ color: '#D64045' });
    expect(blue).not.toBe(red);
    expect(blue.width).toBe(0.3);
    expect(fineliner().color).toBe('#111111');
    expect('name' in blue).toBe(false);
  });

  it('stroke: names resolve through the sketch\'s pens first, then the captured library', () => {
    const fineliner = penModel(DEFAULT_PENS[0]);
    const def = sketch({
      pens: { blue: fineliner({ color: '#2457D6' }), custom: pen({ width: mm(0.8), color: '#D64045' }) },
      seed: 1,
    }, () => [
      circle(30, 50, 15, { stroke: 'blue' }),
      circle(70, 50, 15, { stroke: 'custom', fill: fill('hatch'), fillPen: DEFAULT_PENS[2].name }),
    ]);
    const exec = compileSketch(def, { paper: { w: 200, h: 200 } });
    expect(exec.currentPen).toBe('blue'); // the first declared pen is the default
    expect(exec.pens.get('blue')).toMatchObject({ name: 'blue', color: '#2457D6', width: DEFAULT_PENS[0].width });
    expect(exec.pens.get('custom')).toMatchObject({ name: 'custom', width: 0.8 });
    expect(exec.pens.has(DEFAULT_PENS[2].name)).toBe(true);
    const scene = encodeScene(exec);
    expect(scene.pens.map((p) => p.name)).toEqual(['blue', 'custom', DEFAULT_PENS[2].name]);
    const svg = exportSvg(exec);
    expect(svg).toContain('#2457D6');
    expect(svg).toContain('#D64045');
  });

  it('a declared name shadows a library pen of the same name; unknown names fail loudly', () => {
    const lib = DEFAULT_PENS[0].name;
    const shadow = sketch({ pens: { [lib]: pen({ width: mm(2), color: '#ff0000' }) } }, () => circle(50, 50, 10, { stroke: lib }));
    const exec = compileSketch(shadow, { paper: { w: 200, h: 200 } });
    expect(exec.pens.get(lib)!.width).toBe(2);
    expect(() => compileSketch(sketch({}, () => circle(50, 50, 10, { stroke: 'ghost' })), { paper: { w: 200, h: 200 } })).toThrow(/unknown pen 'ghost'/);
    expect(() => compileSketch(sketch({ pens: { bad: { color: '#000' } as never } }, () => circle(1, 1, 1)))).toThrow(/positive width/);
  });

  it('a paper model gives fresh sheets with overrides', () => {
    const a4 = paperModel({ w: 210, h: 297, color: '#ffffff' });
    const cream = a4({ color: '#F5F0E6' });
    expect(cream).toEqual({ w: 210, h: 297, color: '#F5F0E6' });
    expect(a4()).toEqual({ w: 210, h: 297, color: '#ffffff' });
    expect(a4()).not.toBe(a4());
  });

  it('a run snapshots its inputs: a library edited after the run changes nothing in it', () => {
    const library = DEFAULT_PENS.map((p) => ({ ...p }));
    const exec = compileSketch(sketch({}, () => circle(50, 50, 10)), { paper: { w: 200, h: 200 }, library });
    library[0].width = 99;
    library.length = 0;
    expect(exec.inputs.library[0].width).toBe(DEFAULT_PENS[0].width);
    expect(exec.pens.get(DEFAULT_PENS[0].name)!.width).toBe(DEFAULT_PENS[0].width);
    expect(Object.isFrozen(exec.inputs)).toBe(true);
  });
});
