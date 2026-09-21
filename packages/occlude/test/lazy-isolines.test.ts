import { describe, expect, it } from 'vitest';
import { plane } from '../src/three/api/index.js';
import { isolines3, type IsolineResult3 } from '../src/three/curves/isolines.js';
import type { Mesh } from '../src/three/api/mesh.js';
import type { SurfaceCurveNetwork3 } from '../src/three/curves/network.js';

/** The corner values `isolines` itself builds: one per corner, face order then
 * polygon order. */
const cornerValues = (mesh: Mesh<any, any, any, any>, field: (p: { x: number; y: number; z: number }) => number): Float64Array =>
  Float64Array.from([...mesh.corners], (c: any) => field(c.point));

const centroid = (mesh: Mesh<any, any, any, any>, triangle: number): [number, number, number] => {
  const vs = mesh.surface.triangles[triangle].vertices.map((v) => mesh.surface.points[v].position);
  return [0, 1, 2].map((k) => (vs[0][k] + vs[1][k] + vs[2][k]) / 3) as [number, number, number];
};

interface Row { id: string; chainId: string; a: string; b: string; range: readonly [number, number]; level: number; levelIndex: number; ea: string; eb: string }
const rowsOf = (network: SurfaceCurveNetwork3): Row[] => network.segments.map((s) => ({
  id: s.id, chainId: s.chainId, a: network.nodes[s.a].id, b: network.nodes[s.b].id,
  range: [s.range[0], s.range[1]] as const,
  level: s.attributes.level as number, levelIndex: s.attributes.levelIndex as number,
  ea: network.nodes[s.a].exact.join('/'), eb: network.nodes[s.b].exact.join('/'),
}));

/** Lazy output is the full output with whole records removed: same rows, same
 * fields, same order. Returns the ids the lazy run dropped. */
const dropped = (full: IsolineResult3, lazy: IsolineResult3): string[] => {
  const a = rowsOf(full.network), b = rowsOf(lazy.network);
  const byId = new Map(a.map((r) => [r.id, r]));
  for (const row of b) expect(byId.get(row.id)).toEqual(row);
  const keep = new Set(b.map((r) => r.id));
  expect(a.filter((r) => keep.has(r.id)).map((r) => r.id)).toEqual(b.map((r) => r.id));
  return a.filter((r) => !keep.has(r.id)).map((r) => r.id);
};

describe('lazy isolines: certified records keep their topology and skip their coordinates', () => {
  // A 6 x 6 sheet of quads, a field that runs along x, and levels that cut it
  // into open chains crossing the whole sheet.
  // Its vertices sit on multiples of 0.375; these levels miss every one of
  // them, so nothing here is a tie until a test asks for one.
  const sheet = plane(6, 6).subdivide(4) as unknown as Mesh<any, any, any, any>;
  const values = cornerValues(sheet, (p) => p.x);
  const levels = [-1.7, -0.8, 0.1, 1.2, 2.3];
  const full = isolines3(sheet.surface, values, levels);

  it('a predicate that certifies nothing is the default path, row for row', () => {
    const none = isolines3(sheet.surface, values, levels, { hidden: () => false });
    expect(rowsOf(none.network)).toEqual(rowsOf(full.network));
    expect(none.stats.chains).toBe(full.stats.chains);
    expect(none.stats.nodes).toBe(full.stats.nodes);
    expect(none.stats.lazy!.deferred).toBe(0);
    expect(none.stats.lazy!.phasePoints).toBe(0);
    expect(full.stats.lazy).toBeUndefined();
  });

  it('a hidden band of faces: the visible output is the full output, minus the band', () => {
    const band = (t: number) => Math.abs(centroid(sheet, t)[1]) < 1;
    const lazy = isolines3(sheet.surface, values, levels, { hidden: (_l, t) => band(t) });
    const gone = dropped(full, lazy);
    expect(gone.length).toBeGreaterThan(0);
    expect(lazy.stats.lazy!.deferred).toBe(gone.length);
    // Topology is retained: the same chains, the same levels, the same nodes
    // for everything that survives.
    expect(lazy.stats.chains).toBe(full.stats.chains);
    expect(lazy.stats.crossings).toBe(full.stats.crossings);
    // A chain with a survivor is built WHOLE: its certified records are
    // reference geometry, so their nodes exist and the chain's arc length is
    // the one full construction measured. Every chain here crosses the band,
    // so no node is saved — the saving is in what the classifier is handed.
    expect(lazy.stats.nodes).toBe(full.stats.nodes);
    expect(lazy.stats.lazy!.mixedChains).toBeGreaterThan(0);
    expect(lazy.stats.lazy!.hiddenChains).toBe(0);
    expect(lazy.stats.lazy!.referenceRecords).toBe(gone.length);
    // The dropped records are reachable as the reference network, in the full
    // order, so a chain's phase is unchanged.
    expect(lazy.network.reference!.segments.map((r) => r.id)).toEqual(full.network.segments.map((r) => r.id));
    // Every dropped record sits on a certified triangle.
    const byId = new Map(full.network.segments.map((s) => [s.id, s]));
    for (const id of gone) expect(band(byId.get(id)!.supports[0].triangle)).toBe(true);
  });

  it('a chain with no survivor is built nowhere, reference and all', () => {
    // A band across one level alone: that chain is wholly certified, so it
    // emits nothing — no consumer can ask a chain that draws nothing for its
    // arc length — and its nodes are never built.
    const band = (t: number) => Math.abs(centroid(sheet, t)[0] - 0.1) < 0.3;
    const lazy = isolines3(sheet.surface, values, levels, { hidden: (_l, t) => band(t) });
    expect(lazy.stats.lazy!.hiddenChains).toBeGreaterThan(0);
    expect(lazy.stats.lazy!.mixedChains).toBe(0);
    expect(lazy.stats.nodes).toBeLessThan(full.stats.nodes);
    const kept = new Set(lazy.network.reference?.segments.map((r) => r.id) ?? lazy.network.segments.map((r) => r.id));
    for (const row of full.network.segments) {
      if (kept.has(row.id)) continue;
      expect(band(row.supports[0].triangle)).toBe(true);
    }
  });

  it('a chain that enters the band and returns keeps both visible runs and their phase', () => {
    const band = (t: number) => Math.abs(centroid(sheet, t)[1]) < 1;
    const lazy = isolines3(sheet.surface, values, levels, { hidden: (_l, t) => band(t) });
    expect(lazy.stats.lazy!.mixedChains).toBeGreaterThan(0);
    const chains = new Map<string, Row[]>();
    for (const row of rowsOf(lazy.network)) (chains.get(row.chainId) ?? chains.set(row.chainId, []).get(row.chainId)!).push(row);
    const mixed = [...chains.values()].filter((rows) => {
      const fullRows = rowsOf(full.network).filter((r) => r.chainId === rows[0].chainId);
      return fullRows.length > rows.length;
    });
    expect(mixed.length).toBeGreaterThan(0);
    for (const rows of mixed) {
      // Two runs: the ranges are contiguous inside a run and jump across the
      // certified one, exactly the interval full construction would classify.
      const gaps = rows.slice(1).filter((r, i) => r.range[0] > rows[i].range[1]);
      expect(gaps.length).toBe(1);
      const fullRows = rowsOf(full.network).filter((r) => r.chainId === rows[0].chainId);
      for (const row of rows) expect(fullRows.find((r) => r.id === row.id)!.range).toEqual(row.range);
    }
  });

  it('a fully certified run emits nothing and builds no point', () => {
    const lazy = isolines3(sheet.surface, values, levels, { hidden: () => true });
    expect(lazy.network.segments.length).toBe(0);
    expect(lazy.network.nodes.length).toBe(0);
    expect(lazy.stats.lazy!.points).toBe(0);
    expect(lazy.stats.lazy!.phasePoints).toBe(0);
    expect(lazy.stats.lazy!.excludedTies).toBe(0);
    expect(lazy.stats.chains).toBe(full.stats.chains);
    expect(lazy.stats.lazy!.hiddenChains).toBe(full.stats.chains);
    expect(lazy.stats.crossings).toBe(full.stats.crossings);
  });

  it('a fully certified closed loop emits nothing while its neighbours are untouched', () => {
    const radial = cornerValues(sheet, (p) => Math.hypot(p.x, p.y));
    const loops = [1, 2];
    const fullLoops = isolines3(sheet.surface, radial, loops);
    const inner = (t: number) => Math.hypot(...centroid(sheet, t).slice(0, 2) as [number, number]) < 1.5;
    const lazy = isolines3(sheet.surface, radial, loops, { hidden: (_l, t) => inner(t) });
    const gone = dropped(fullLoops, lazy);
    expect(gone.length).toBeGreaterThan(0);
    expect(lazy.stats.lazy!.hiddenChains).toBeGreaterThan(0);
    // The level-1 loop is gone entirely; the level-2 loop is untouched.
    expect(lazy.network.segments.some((s) => s.attributes.level === 1)).toBe(false);
    expect(lazy.network.segments.filter((s) => s.attributes.level === 2).length)
      .toBe(fullLoops.network.segments.filter((s) => s.attributes.level === 2).length);
  });

  it('a vertex tie is never deferred: it is constructed as today', () => {
    // A level ON a grid line: every triangle that crosses it has a corner
    // whose value IS the level.
    const tied = [0.375];
    const fullTied = isolines3(sheet.surface, values, tied);
    const lazy = isolines3(sheet.surface, values, tied, { hidden: () => true });
    expect(lazy.stats.lazy!.excludedTies).toBeGreaterThan(0);
    expect(lazy.stats.lazy!.deferred).toBe(0);
    expect(rowsOf(lazy.network)).toEqual(rowsOf(fullTied.network));
    // A level that misses every vertex defers in the same call shape.
    const clear = isolines3(sheet.surface, values, [0.1], { hidden: () => true });
    expect(clear.stats.lazy!.excludedTies).toBe(0);
    expect(clear.network.segments.length).toBe(0);
  });
});
