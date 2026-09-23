/**
 * Spec 68, lazy level sets: `t.isolines` computes the level LINES; the
 * closure — the runs along the drawable, a bound and every hole, joined into
 * rings — is worked out the first time something reads the area, kept on the
 * material, and is exactly what the eager closure was.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { toolkit } from './helpers/run.js';
import { initOcclude, areaLoops, polygon, sdf, space, strokes, type Material } from '../src/index.js';
import { levelContours, levelMaterial, sampleGrid, type IsoLevels } from '../src/isolines.js';
import { edgeCells, marchSegments, wallSegments } from '../src/marching.js';
import { areaMaterial } from '../src/material.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
  await initOcclude(readFileSync(wasmPath));
});

/** A field with a round NaN hole in it, counting its own calls. */
const holed = () => {
  const calls = { n: 0 };
  const f = (x: number, y: number) => {
    calls.n++;
    return Math.hypot(x - 50, y - 50) < 12 ? NaN : Math.sin(x / 9) + Math.cos(y / 7);
  };
  return { f, calls };
};

/** The eager closed material the toolkit used to answer, for the same call. */
const eager = (t: ReturnType<typeof toolkit>, f: (x: number, y: number) => number, at: IsoLevels, step: number): Material => {
  const b = t.bounds();
  return levelMaterial(levelContours({ bounds: { x: b.x, y: b.y, w: b.w, h: b.h }, len: (l) => t.len(l) }, f, at, { step }));
};

describe('t.isolines computes the lines only', () => {
  it('holds the level lines, every edge cut = 0, and asks the field for no wall', () => {
    const t = toolkit({ aspect: [1, 1] });
    const { f, calls } = holed();
    const m = t.isolines(f, [-0.5, 0, 0.5], { step: 2 });
    const sampled = calls.n;
    // One sample per lattice point, no halving toward the hole.
    expect(sampled).toBe(51 * 51);
    expect(m.edges.length).toBeGreaterThan(0);
    expect([...m.edges].every((e) => e.attrs.cut === 0)).toBe(true);
    // The first area ask finds the hole's wall; the second is the kept answer.
    m.contours();
    expect(calls.n).toBeGreaterThan(sampled);
    const afterFirst = calls.n;
    m.contours();
    polygon(m);
    expect(calls.n).toBe(afterFirst);
    expect(areaMaterial(m)).toBe(areaMaterial(m));
  });

  it('the lines are the eager level line, row for row, and the area is the eager area', () => {
    const t = toolkit({ aspect: [1, 1] });
    const { f } = holed();
    const levels = [-0.5, 0, 0.5];
    const m = t.isolines(f, levels, { step: 2 });
    const old = eager(t, f, levels, 2);
    const oldLines = old.edges.filter((e) => e.attrs.cut === 0).extract();
    expect([...m.x]).toEqual([...oldLines.x]);
    expect([...m.y]).toEqual([...oldLines.y]);
    expect([...m.edgeList]).toEqual([...oldLines.edgeList]);
    expect([...m.edgeAttrs.level]).toEqual([...oldLines.edgeAttrs.level]);
    const area = areaMaterial(m);
    expect([...area.x]).toEqual([...old.x]);
    expect([...area.y]).toEqual([...old.y]);
    expect([...area.edgeList]).toEqual([...old.edgeList]);
    expect([...area.edgeAttrs.cut]).toEqual([...old.edgeAttrs.cut]);
    expect(m.contours()).toEqual(old.contours());
  });

  it('strokes of the lines is the old strokes of the level line', () => {
    const t = toolkit({ aspect: [1, 1] });
    const { f } = holed();
    const m = t.isolines(f, [0, 0.5], { step: 2 });
    const old = eager(t, f, [0, 0.5], 2);
    const pts = (tree: unknown) => JSON.stringify(tree, (k, v) => (k === 'id' ? undefined : v));
    expect(pts(strokes(m))).toBe(pts(strokes(old)));
  });
});

describe('the area keeps the lines\' identity', () => {
  it('its level-line rows carry the lines\' ids; its closing rows are new', () => {
    const t = toolkit({ aspect: [1, 1] });
    const m = t.isolines(sdf.circle(0, 0, 30), 0);
    const area = areaMaterial(m);
    const lines = m.edges.in(area);
    expect(lines.length).toBe(m.edges.length);
    expect([...lines].every((e) => e.attrs.cut === 0)).toBe(true);
    const rims = area.edges.filter((e) => e.attrs.cut === 1);
    expect(rims.length).toBe(2);
    for (const e of rims) expect(m.edgeOf(e.id)).toBeUndefined();
    // An edge of the lines knows the faces on its sides: the area's.
    expect(m.edges.at(0).faces).toHaveLength(1);
  });

  it('a selection of the lines, read as an area, is closed by the runs that join its ends', () => {
    const t = toolkit({ aspect: [1, 1] });
    const ground = (x: number, y: number) => Math.sin(x / 17) + Math.cos(y / 13) + x / 80;
    const levels = [-0.6, 0, 0.6, 1.2];
    const m = t.isolines(ground, levels, { step: 2 });
    const old = eager(t, ground, levels, 2);
    for (const level of levels) {
      const now = areaLoops(m.edges.filter((e) => e.level === level), 'test');
      const before = areaLoops(old.edges.filter((e) => e.level === level), 'test');
      expect(now).toEqual(before);
    }
    // Every edge is the whole level set.
    expect(areaLoops(m.edges, 'test')).toEqual(areaLoops(old, 'test'));
  });
});

describe('which verbs carry the area', () => {
  it('the space stamp carries it: a curved sketch still closes along the drawable', () => {
    const t = toolkit({ aspect: [1, 1], space: space.hyperbolic({ radius: 50 }) });
    const b = t.bounds();
    const m = t.isolines(sdf.circle(b.x, b.y, b.w * 0.3), 0);
    expect(m.space).toBe(t.space);
    expect(m.contours()).toHaveLength(1);
    expect(areaMaterial(m).space).toBe(t.space);
  });

  it('a verb that changes geometry reads its own closed chains', () => {
    const t = toolkit({ aspect: [1, 1] });
    const m = t.isolines(sdf.circle(0, 0, 30), 0);
    expect(m.contours()).toHaveLength(1);
    // The quarter arc alone: an open chain, no area of its own.
    expect(m.resample({ spacing: 1 }).contours()).toHaveLength(0);
  });
});

describe('the edge cells are found once', () => {
  it('marching the edge-cell list is the edge half of the full march, at every level', () => {
    const { f } = holed();
    const b = { x: 0, y: 0, w: 100, h: 100 };
    const grid = sampleGrid(f, b, 41, 41);
    const cells = edgeCells(grid);
    for (const level of [-1, -0.3, 0, 0.4, 1.1]) {
      const full = wallSegments(marchSegments(grid, level, true), true);
      const edge = marchSegments(grid, level, true, cells);
      expect(edge.segN).toBe(full.segN);
      expect([...edge.segXY.subarray(0, edge.segN * 4)]).toEqual([...full.segXY.subarray(0, full.segN * 4)]);
      const plain = marchSegments(grid, level, true, 'plain');
      const lines = wallSegments(marchSegments(grid, level, true), false);
      expect([...plain.segXY.subarray(0, plain.segN * 4)]).toEqual([...lines.segXY.subarray(0, lines.segN * 4)]);
    }
  });
});
