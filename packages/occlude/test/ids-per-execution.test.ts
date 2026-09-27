/**
 * Every run counts its own ids. Two async compiles open at once — the
 * host's entry, `compileSketchAsync` on an `Execution` it made, interleaved
 * at their awaits — never mint one number twice; a run alone mints the
 * same numbers every time, and draws the same ink; a value made outside
 * any run is no row of a value a run made.
 */

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { circle, curve, point, sketch, strokes, type Material, type Toolkit } from '../src/index.js';
import { Execution, compileSketch, compileSketchAsync, initOcclude, render } from '../src/host.js';
import { SQ } from './helpers/run.js';

beforeAll(async () => {
  await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url)));
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** Every id a value holds, points and edges. */
const idsOf = (values: readonly Material[]): number[] => values.flatMap((m) => [...m.pointIds, ...m.edgeIds]);

/**
 * A sketch that makes values from nothing, with the toolkit and from
 * values it holds, on both sides of two awaits. `made` gets every value in
 * the order the sketch made it; `move` is the value a held point moved.
 */
function program(made: Material[], pauses: readonly Promise<void>[] = []) {
  return sketch({ aspect: [1, 1], seed: 7 }, async (t: Toolkit) => {
    const ring = curve([[10, 10], [40, 10], [40, 40], [10, 40]], { closed: true });
    const round = t.sample(circle(70, 30, 15), { count: 24 });
    made.push(ring, round);
    await pauses[0];
    const split = ring.split(ring.edges.at(0));
    const q = point([60, 80]);
    const grown = split.points.add(q).edges.add([q, split.points.at(0)]);
    // A held point names its own row: it moves that point and no other.
    const moved = grown.move([0, 5], q);
    made.push(split, grown, moved);
    await pauses[1];
    const again = t.sample(circle(30, 75, 10), { count: 12 });
    const cut = round.split(round.edges.at(3));
    made.push(again, cut);
    return [strokes(moved), strokes(cut), strokes(again)];
  });
}

describe('ids per execution', () => {
  it('two async compiles interleaved at their awaits mint disjoint ids, and each draws what it draws alone', async () => {
    const a: Material[] = [];
    const b: Material[] = [];
    const [a1, a2, b1, b2] = [gate(), gate(), gate(), gate()];
    // The host's entry: an execution it made, compiled asynchronously.
    const runA = new Execution(SQ);
    const runB = new Execution(SQ);
    const pendingA = compileSketchAsync(program(a, [a1.promise, a2.promise]), runA);
    const pendingB = compileSketchAsync(program(b, [b1.promise, b2.promise]), runB);
    // A, B, A, B: each resumes while the other is open.
    a1.release(); await Promise.resolve(); await Promise.resolve();
    b1.release(); await Promise.resolve(); await Promise.resolve();
    a2.release(); await pendingA;
    b2.release(); await pendingB;

    const idsA = idsOf(a);
    const idsB = new Set(idsOf(b));
    expect(idsA.filter((id) => idsB.has(id))).toEqual([]);
    // No value holds one id twice.
    for (const m of [...a, ...b]) {
      expect(new Set(m.pointIds).size).toBe(m.n);
      expect(new Set(m.edgeIds).size).toBe(m.edgeCount);
    }
    // The held point moved its own row, in both runs.
    for (const made of [a, b]) {
      const [, , , grown, moved] = made;
      for (let i = 0; i < grown.n; i++) expect(moved.points.at(i).y - grown.points.at(i).y).toBe(i === grown.n - 1 ? 5 : 0);
    }

    // The same ink as each program compiled alone.
    const alone = await compileSketchAsync(program([]), new Execution(SQ));
    expect(render(runA).raw.prims).toEqual(render(alone).raw.prims);
    expect(render(runB).raw.prims).toEqual(render(alone).raw.prims);
  });

  it('a run alone mints the same ids and draws the same ink every time', async () => {
    const first: Material[] = [];
    const second: Material[] = [];
    const one = await compileSketchAsync(program(first), new Execution(SQ));
    // A refused run in between leaves nothing open behind it.
    expect(() => compileSketch(sketch({ pens: { ink: 'no-such-pen' } }, () => []), SQ)).toThrow(/unknown pen/);
    const two = await compileSketchAsync(program(second), new Execution(SQ));
    expect(idsOf(second)).toEqual(idsOf(first));
    expect(render(two).raw.prims).toEqual(render(one).raw.prims);
  });

  it('a value made outside any run is no row of a value a run made', async () => {
    const outside = curve([[0, 0], [10, 0], [20, 0]]);
    const made: Material[] = [];
    await compileSketchAsync(sketch({ aspect: [1, 1] }, async () => {
      await Promise.resolve();
      made.push(curve([[0, 0], [10, 0], [20, 0]]), outside.split(outside.edges.at(0)));
      return [];
    }), new Execution(SQ));
    const [inside, grown] = made;
    const outsideIds = new Set(idsOf([outside]));
    expect(idsOf([inside]).filter((id) => outsideIds.has(id))).toEqual([]);
    expect(inside.points.has(outside.points.at(0))).toBe(false);
    expect(() => inside.move([1, 0], outside.points.at(0))).toThrow(/unrelated/);
    // A value the run made FROM the outside one is its lineage, with new ids.
    expect(grown.points.has(outside.points.at(0))).toBe(true);
    expect(new Set(grown.pointIds).size).toBe(grown.n);
    expect(inside.points.has(grown.points.at(grown.n - 1))).toBe(false);
  });
});
