import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  circle, distanceTo, initOcclude, material, mm, polygon, render, setPaperHint,
  sketch, type Face, type SketchDef, type Tree,
} from '../src/index.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(
    new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
  );
  await initOcclude(readFileSync(wasmPath));
  setPaperHint(200, 200);
});

/** Visible fragments — how much ink a sketch actually lays down. */
const ink = (def: SketchDef): number => render(def, { paper: 'Square20' }).stats.fragments;

function aFace(): Face {
  let face: Face | undefined;
  ink(sketch({}, (t) => {
    face = t.voronoi(material([[20, 20], [70, 30], [45, 70]])).faces().at(0);
    return [];
  }));
  if (!face) throw new Error('no face was built');
  return face;
}

describe('an area input: a face and a shape are already areas', () => {
  it("takes a face exactly as it takes that face's contours", () => {
    const face = aFace();
    const asFace = ink(sketch({}, () => polygon(face, { opaque: true })));
    expect(asFace).toBeGreaterThan(0);
    expect(asFace).toBe(ink(sketch({}, () => polygon(face.contours, { opaque: true }))));
  });

  it('takes a shape, lowered through the same lowerer as t.material', () => {
    const direct = ink(sketch({}, () => polygon(circle(30, 30, 15))));
    const viaMaterial = ink(sketch({}, (t) => polygon(t.material(circle(30, 30, 15)))));
    expect(direct).toBeGreaterThan(0);
    expect(direct).toBe(viaMaterial);
  });

  it('still refuses a face COLLECTION, naming the two ways out', () => {
    // Deliberately the wrong input: a collection is several areas, and the
    // refusal is the contract. `as never` states that this call is meant to
    // fail its own type.
    expect(() => ink(sketch({}, (t) => [polygon(t.voronoi(material([[20, 20], [70, 30], [45, 70]])).faces() as never, { opaque: true })])))
      .toThrow(/face collection is several areas .*boundaries\(\)/);
  });

  it('accepts a length in either point spelling, and refuses it where it computes', () => {
    const asObjects: Tree = polygon([{ x: mm(5), y: mm(5) }, { x: 30, y: 5 }, { x: 30, y: 30 }]);
    const asPairs = polygon([[mm(5), mm(5)], [30, 5], [30, 30]]);
    expect(ink(sketch({}, () => [asObjects]))).toBe(ink(sketch({}, () => [asPairs])));
    const loops = [{ x: mm(5), y: mm(5) }, { x: 30, y: 5 }, { x: 30, y: 30 }];
    expect(() => distanceTo(loops)).toThrow(/a length such as mm\(\)/);
  });
});
