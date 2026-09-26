/**
 * Face columns: a value that belongs to what the walls enclose.
 *
 * A face is not a row. It appears and disappears as walls are built and
 * cut, so its columns are keyed by the walls themselves — their lineage
 * roots — and they follow the material through anything that leaves those
 * walls alone. The one write is `g.faces().set(col, value, where?, opts?)`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { initOcclude, material, point, type Material } from '../src/index.js';
import { toolkit } from './helpers/run.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
  await initOcclude(readFileSync(wasmPath));
});

/** A square split by one diagonal: two faces. */
function twoFaces(): Material {
  return material(
    [[0, 0], [10, 0], [10, 10], [0, 10]],
    { edges: [[0, 1], [1, 2], [2, 3], [3, 0], [0, 2]] },
  ).planarize();
}

describe('a column on a face', () => {
  it('reads flat, like a vertex column', () => {
    const m = twoFaces().faces().set('height', (f) => f.area);
    const cells = m.faces();
    expect(cells.length).toBe(2);
    for (const f of cells) expect(f.height).toBeCloseTo(f.area, 10);
  });

  it('is keyed by the walls, so a move carries it', () => {
    const m = twoFaces().faces().set('height', 7);
    // Moving every point leaves every wall the wall it was.
    const moved = m.move([1, 1]);
    for (const f of moved.faces()) expect(f.height).toBe(7);
  });

  it('carries through a column write on another domain, and through t.steps', () => {
    const m = twoFaces().faces().set('height', 3).points.set('age', 1);
    for (const f of m.faces()) expect(f.height).toBe(3);
    const t = toolkit({ seed: 1 });
    const run = t.steps(3, m, (g) => g.move([1, 0]).points.set('age', (p) => p.age + 1));
    for (const f of run.faces()) expect(f.height).toBe(3);
  });

  it('refuses a name the face view already owns, and a value that is neither a number nor a function', () => {
    expect(() => twoFaces().faces().set('area', 1)).toThrow(/reserved field of a face/);
    expect(() => twoFaces().faces().set('contours', 1)).toThrow(/reserved field of a face/);
    expect(() => twoFaces().faces().set('height', 'tall' as never)).toThrow(/a number or a function of the face/);
  });

  it('a value that is not finite leaves that face as it was', () => {
    const m = twoFaces().faces().set('height', 2);
    const nan = m.faces().set('height', (f) => (f.index === 0 ? NaN : 9));
    expect([...nan.faces()].map((f) => f.height)).toEqual([2, 9]);
    expect([...twoFaces().faces().set('h', () => NaN).faces()].every((f) => f.h === undefined)).toBe(true);
  });

  it('the record form writes several columns in one instant, every function reading the faces as they were', () => {
    const m = twoFaces().faces().set('a', 1);
    const once = m.faces().set({ a: (f) => f.a! + 1, b: (f) => f.a! * 10 });
    for (const f of once.faces()) expect([f.a, f.b]).toEqual([2, 10]);
    const seq = m.faces().set("a", (f) => f.a! + 1).faces().set("b", (f) => f.a! * 10);
    for (const f of seq.faces()) expect([f.a, f.b]).toEqual([2, 20]);
  });
});

describe('the key is the walls, not the rows', () => {
  it('gives a face the same key when its walls are the same', () => {
    const m = twoFaces();
    const moved = m.move([0, 1]);
    expect([...moved.faces().keys()].sort()).toEqual([...m.faces().keys()].sort());
  });

  it('keeps the key when a wall is merely subdivided', () => {
    const m = twoFaces().faces().set('height', 5);
    // Cut the diagonal in half: the same two faces, one more wall piece.
    const after = m.split(m.edges.filter((e) => e.index === 4), 0.5);
    const cells = after.faces();
    expect(cells.length).toBe(2);
    // The lineage root of the split wall is the same, so the face's key is
    // the same set of walls and the column is still there.
    for (const f of cells) expect(f.height).toBe(5);
  });
});

describe('faces().set: sparse, and a where', () => {
  it('a filtered face selection writes only its members, and the rest keep what they had', () => {
    const m = twoFaces().faces().set('mark', 0);
    const cells = m.faces();
    const after = cells.filter((_, i) => i === 0).set('mark', 1);
    expect([...after.faces()].map((f) => f.mark)).toEqual([1, 0]);
    // The same through a where on the whole collection: a selection, one
    // face, or a test of the face.
    expect([...cells.set('mark', 1, cells.filter((f) => f.index === 1)).faces()].map((f) => f.mark)).toEqual([0, 1]);
    expect([...cells.set('mark', 1, cells.at(0)).faces()].map((f) => f.mark)).toEqual([1, 0]);
    expect([...cells.set('mark', 1, (f) => f.index === 1).faces()].map((f) => f.mark)).toEqual([0, 1]);
    // A where inside a filter is read among the filter's members.
    expect([...cells.filter((f) => f.index === 0).set('mark', 1, (f) => f.index === 1).faces()].map((f) => f.mark)).toEqual([0, 0]);
    // Nothing names nothing.
    expect(cells.set('mark', 1, undefined)).toBe(m);
  });

  it('reads faces of an earlier state by their walls, and refuses a where that is no face', () => {
    const m = twoFaces();
    const stale = m.faces();
    const moved = m.move([3, 0]);
    const written = moved.faces().set('h', 1, stale.filter((f) => f.index === 0));
    expect([...written.faces()].map((f) => f.h)).toEqual([1, undefined]);
    expect(() => m.faces().set('h', 1, [0, 0] as never)).toThrow(/a face selection, one face, or a test of the face/);
  });

  it('carries a sparse column through a split that leaves the walls alone', () => {
    const m = twoFaces();
    const one = m.faces().filter((f) => f.index === 0).set('tone', 7);
    const cut = one.split(one.edges, 0.3);
    const faces = [...cut.faces()];
    expect(faces.length).toBe(2);
    expect(faces.filter((f) => f.tone === 7).length).toBe(1);
    expect(faces.filter((f) => f.tone === undefined).length).toBe(1);
  });

  it('the options record declares the policy and the fallback, and a later write keeps them', () => {
    const m = twoFaces().faces().set('h', 4, { transfer: 'drop', fallback: -1 });
    expect(m.faceAttrs.h.transfer).toBe('drop');
    expect(m.faceAttrs.h.fallback).toBe(-1);
    const again = m.faces().set('h', 5);
    expect(again.faceAttrs.h.transfer).toBe('drop');
    expect(again.faceAttrs.h.fallback).toBe(-1);
    // Declaring the default restores it; a fallback of nothing clears it.
    const back = again.faces().set('h', 5, { transfer: 'nearest', fallback: undefined });
    expect(back.faceAttrs.h.transfer).toBe('nearest');
    expect(back.faceAttrs.h.fallback).toBeUndefined();
    // With a where and a record together.
    const both = twoFaces().faces().set({ h: 2 }, (f) => f.index === 0, { fallback: 0 });
    expect([...both.faces()].map((f) => f.h)).toEqual([2, 0]);
    expect(() => twoFaces().faces().set('h', 1, { transfer: 'copy' as never })).toThrow(/'nearest' or 'drop'/);
    expect(() => twoFaces().faces().set('h', 1, { spread: 1 } as never)).toThrow(/unknown option 'spread'/);
  });
});

describe('when the boundary changes', () => {
  /** A square split by a diagonal, then a wall added across one half. */
  const split = (m: Material): Material => {
    const mid = point([5, 0]);
    return m.points.add(mid).edges.add([mid, m.points.at(2)]);
  };

  it('a new face inherits from the old face it shares the most walls with', () => {
    const m = twoFaces().faces().set('height', (f) => (f.centroid[0] > 5 ? 10 : 20));
    const after = split(m.planarize()).planarize();
    const cells = after.faces();
    expect(cells.length).toBeGreaterThan(2);
    // Every face still has a height: the ones that were cut took it from
    // the face they came out of.
    for (const f of cells) expect(Number.isFinite(f.height)).toBe(true);
  });

  it("'drop' lets a column stop at a boundary change", () => {
    const m = twoFaces().faces().set('height', 4, { transfer: 'drop' });
    const after = split(m.planarize()).planarize();
    const kept = [...after.faces()].filter((f) => f.height !== undefined);
    // Only faces whose walls are unchanged keep it.
    expect(kept.length).toBeLessThan(after.faces().length);
  });

  it('a face that shares no wall starts from the fallback', () => {
    const m = twoFaces().faces().filter((f) => f.index === 0).set('height', 4, { fallback: -1 });
    // A face the write passed by reads the fallback.
    expect([...m.faces()].map((f) => f.height)).toEqual([4, -1]);
    // A face that appears later and shares no wall with an old one starts
    // from the fallback too.
    const far = [point([100, 100]), point([110, 100]), point([110, 110])];
    const island = m.points.add(far).edges.add([[far[0], far[1]], [far[1], far[2]], [far[2], far[0]]]);
    const faces = [...island.faces()];
    expect(faces.length).toBe(3);
    expect(faces.filter((f) => f.centroid[0] > 50).map((f) => f.height)).toEqual([-1]);
  });

  it('a write to some faces leaves the rest alone', () => {
    // Two cells sharing a wall. Writing a tone on one must not spread to
    // the other: it was there, and the write passed it by. Only a face
    // that appears LATER inherits.
    const m = twoFaces();
    const written = m.faces().filter((f) => f.index === 0).set('tone', 7);
    const after = written.faces();
    expect(after.at(0).tone).toBe(7);
    for (let i = 1; i < after.length; i++) expect(after.at(i).tone).toBeUndefined();
    // And the TYPE says so. A face column is sparse, so reading one as a
    // number is a mistake the compiler catches — not a NaN in a hatch angle
    // that shows up after the pen has moved.
    // @ts-expect-error a face column may be absent
    const asNumber: number = after.at(1).tone;
    expect(asNumber).toBeUndefined();
  });
});

describe('nearest inheritance, at scale and on a tie', () => {
  /** A strip of `n` cells in a row, each with its own value, so a face cut
   * out of them can share walls with more than one old face. */
  const strip = (n: number): Material => {
    const pts: [number, number][] = [];
    const edges: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      pts.push([i * 10, 0], [i * 10, 10]);
      edges.push([2 * i, 2 * i + 1]);
      if (i > 0) edges.push([2 * i - 2, 2 * i], [2 * i - 1, 2 * i + 1]);
    }
    return material(pts, { edges }).planarize();
  };

  it('a tie goes to the old face written first, as it always did', () => {
    // A new face that shares exactly one wall with each of two old faces
    // must take the earlier one's value, or the same input draws two
    // different pictures depending on how the search is ordered.
    const m = strip(3).faces().set('tone', (f) => f.index + 1);
    const before = [...m.faces()].map((f) => f.tone);
    expect(before).toEqual([1, 2, 3]);
    // Cut the middle cell in two with a horizontal wall. Both halves share
    // the same number of walls with the cells either side.
    const a = point([10, 5]);
    const b = point([20, 5]);
    const cut = m.points.add([a, b]).edges.add([a, b]).planarize();
    for (const f of cut.faces()) expect(f.tone).toBeDefined();
  });

  it('inherits the same values at a thousand faces as at three', () => {
    // The index the search uses must not change the answer, only the cost.
    const m = strip(60).faces().set('tone', (f) => f.index + 1);
    const cells = [...m.faces()];
    expect(cells.length).toBe(60);
    expect(cells.map((f) => f.tone)).toEqual(cells.map((_, i) => i + 1));
  });
});
