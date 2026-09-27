/**
 * Lineage is a property of identity, not of a number. A run's ids start
 * over every run (so a warm worker shows what a cold render shows), and
 * what is made outside any run counts apart and never starts over: a value
 * at module scope and a value the run built are never one lineage by
 * chance. A value one run made is no row of another run's.
 */

import { describe, expect, it } from 'vitest';
import { curve, sketch, type Material } from '../src/index.js';
import { compileSketch } from '../src/host.js';
import { SQ, toolkit } from './helpers/run.js';

describe('ids and runs', () => {
  it('a value made outside the run is not a row of one made in it', () => {
    const outside = curve([[0, 0], [10, 0], [20, 0]]);
    const t = toolkit();
    const inside = curve([[50, 50], [60, 50], [70, 50]]);
    expect(inside.points.has(outside.points.at(0))).toBe(false);
    expect(() => inside.move([100, 0], outside.points.at(0))).toThrow(/unrelated/);
    // A value made in the run FROM the outside one is its lineage.
    const grown = outside.split(outside.edges.at(0));
    expect(grown.points.has(outside.points.at(0))).toBe(true);
    // And its new rows are new: no id of the outside value is minted again.
    const ids = new Set<number>();
    for (const p of grown.points) ids.add((p as unknown as { id: number }).id);
    expect(ids.size).toBe(grown.n);
    expect(typeof t.rnd()).toBe('number');
  });

  it('two runs of one sketch mint the same ids, and a value of one run is no row of the other', () => {
    const made: Material[] = [];
    const def = sketch({ aspect: [1, 1] }, () => {
      made.push(curve([[0, 0], [10, 0], [20, 0]]));
      return [];
    });
    compileSketch(def, SQ);
    compileSketch(def, SQ);
    const [a, b] = made;
    expect([...a.pointIds]).toEqual([...b.pointIds]);
    expect(b.points.has(a.points.at(0))).toBe(false);
    expect(() => b.move([1, 0], a.points.at(0))).toThrow(/unrelated/);
  });
});
