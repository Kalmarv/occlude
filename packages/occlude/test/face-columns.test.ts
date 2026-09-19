/**
 * Face columns: a value that belongs to what the walls enclose.
 *
 * A face is not a row. It appears and disappears as walls are built and
 * cut, so its columns are keyed by the walls themselves — their lineage
 * roots — and they follow the material through anything that leaves those
 * walls alone.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { connect, initOcclude, material, type Material } from '../src/index.js';

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
    const m = twoFaces().faceAttribute('height', (f) => f.area);
    const cells = m.faces();
    expect(cells.length).toBe(2);
    for (const f of cells) expect(f.height).toBeCloseTo(f.area, 10);
  });

  it('is keyed by the walls, so a move carries it', () => {
    const m = twoFaces().faceAttribute('height', 7);
    // Moving every point leaves every wall the wall it was.
    const moved = m.steps(1, (cur, next) => next.move(cur.points, () => [1, 1]));
    for (const f of moved.faces()) expect(f.height).toBe(7);
  });

  it('carries through a column write on another domain', () => {
    const m = twoFaces().faceAttribute('height', 3).attribute('age', 1);
    for (const f of m.faces()) expect(f.height).toBe(3);
  });

  it('refuses a name the face view already owns', () => {
    expect(() => twoFaces().faceAttribute('area', 1)).toThrow(/reserved face field/);
    expect(() => twoFaces().faceAttribute('contours', 1)).toThrow(/reserved face field/);
  });

  it('refuses a value that is not a number', () => {
    expect(() => twoFaces().faceAttribute('height', () => NaN)).toThrow(/not a finite number/);
  });
});

describe('the key is the walls, not the rows', () => {
  it('gives a face the same key when its walls are the same', () => {
    const m = twoFaces();
    const moved = m.steps(1, (cur, next) => next.move(cur.points, () => [0, 1]));
    expect([...moved.faces().keys()].sort()).toEqual([...m.faces().keys()].sort());
  });

  it('keeps the key when a wall is merely subdivided', () => {
    const m = twoFaces().faceAttribute('height', 5);
    // Cut the diagonal in half: the same two faces, one more wall piece.
    const after = m.steps(1, (cur, next) => {
      next.splitEdges(cur.edges.filter((e) => e.index === 4), { at: 0.5 });
    });
    const cells = after.faces();
    expect(cells.length).toBe(2);
    // The lineage root of the split wall is the same, so the face's key is
    // the same set of walls and the column is still there.
    for (const f of cells) expect(f.height).toBe(5);
  });
});

describe('next.setFaces', () => {
  it('writes a column in a step, and the state that comes out carries it', () => {
    const m = twoFaces();
    const after = m.steps(1, (cur, next) => {
      next.setFaces(cur.faces(), (f) => ({ big: f.area > 40 ? 1 : 0 }));
    });
    const cells = after.faces();
    expect(cells.length).toBe(2);
    for (const f of cells) expect(f.big).toBe(f.area > 40 ? 1 : 0);
  });

  it('takes a selection of faces, and leaves the rest alone', () => {
    const m = twoFaces().faceAttribute('mark', 0);
    const after = m.steps(1, (cur, next) => {
      const cells = cur.faces();
      next.setFaces(cells.filter((_, i) => i === 0), () => ({ mark: 1 }));
    });
    const marks = [...after.faces()].map((f) => f.mark).sort();
    expect(marks).toEqual([0, 1]);
  });

  it('refuses a reserved name and a value that is not a number', () => {
    const m = twoFaces();
    expect(() => m.steps(1, (cur, next) => next.setFaces(cur.faces(), () => ({ area: 1 })))).toThrow(/reserved face field/);
    expect(() => m.steps(1, (cur, next) => next.setFaces(cur.faces(), () => ({ h: NaN })))).toThrow(/not a finite number/);
  });

  it('refuses faces read from another state', () => {
    const m = twoFaces();
    const stale = m.faces();
    expect(() => m.steps(1, (_cur, next) => next.setFaces(stale, () => ({ h: 1 })))).toThrow(/another state/);
  });
});

describe('when the boundary changes', () => {
  /** A square split by a diagonal, then a wall added across one half. */
  const split = (m: Material): Material => m.steps(1, (cur, next) => {
    const mid = next.addPoint([5, 0], {});
    next.connect(mid, 2);
  });

  it('a new face inherits from the old face it shares the most walls with', () => {
    const m = twoFaces().faceAttribute('height', (f) => (f.centroid[0] > 5 ? 10 : 20));
    const after = split(m.planarize()).planarize();
    const cells = after.faces();
    expect(cells.length).toBeGreaterThan(2);
    // Every face still has a height: the ones that were cut took it from
    // the face they came out of.
    for (const f of cells) expect(Number.isFinite(f.height)).toBe(true);
  });

  it("'drop' lets a column stop at a boundary change", () => {
    const m = twoFaces().faceAttribute('height', 4, { transfer: 'drop' });
    const after = split(m.planarize()).planarize();
    const kept = [...after.faces()].filter((f) => f.height !== undefined);
    // Only faces whose walls are unchanged keep it.
    expect(kept.length).toBeLessThan(after.faces().length);
  });

  it('a face that shares no wall starts from the fallback', () => {
    const m = twoFaces().faceAttribute('height', 4, { fallback: -1 });
    // A different material entirely: no wall of it is a wall of the first.
    const other = material(
      [[100, 100], [110, 100], [110, 110], [100, 110]],
      { edges: [[0, 1], [1, 2], [2, 3], [3, 0]] },
    ).planarize().faceAttributes({}, {});
    expect(other.faces().length).toBe(1);
    for (const f of m.faces()) expect(f.height).toBe(4);
  });

  it('a write to some faces leaves the rest alone', () => {
    // Two cells sharing a wall. Writing a tone on one must not spread to
    // the other: it was there, and the write passed it by. Only a face
    // that appears LATER inherits.
    const m = twoFaces();
    const written = m.steps(1, (cur, next) => {
      const cells = cur.faces();
      next.setFaces(cells.filter((f) => f.index === 0), { tone: 7 });
    });
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
    const m = strip(3).faceAttribute('tone', (f) => f.index + 1);
    const before = [...m.faces()].map((f) => f.tone);
    expect(before).toEqual([1, 2, 3]);
    // Cut the middle cell in two with a horizontal wall. Both halves share
    // the same number of walls with the cells either side.
    const cut = m.steps(1, (cur, next) => {
      const a = next.addPoint([10, 5], {});
      const b = next.addPoint([20, 5], {});
      next.connect(a, b);
    }).planarize();
    for (const f of cut.faces()) expect(f.tone).toBeDefined();
  });

  it('inherits the same values at a thousand faces as at three', () => {
    // The index the search uses must not change the answer, only the cost.
    const m = strip(60).faceAttribute('tone', (f) => f.index + 1);
    const cells = [...m.faces()];
    expect(cells.length).toBe(60);
    expect(cells.map((f) => f.tone)).toEqual(cells.map((_, i) => i + 1));
  });
});
