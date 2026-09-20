import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initOcclude } from '../src/index.js';
import { compileRule, hilbertRule, meanderRule, peanoRule, spacefill, type SpacefillEnv, type SpacefillRule } from '../src/spacefill.js';

beforeAll(async () => {
  await initOcclude(readFileSync(fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));
});

const env: SpacefillEnv = { len: (l) => (typeof l === 'number' ? l : l.value) };
const square = (x: number, y: number, s: number): [number, number][][] => [[[x, y], [x + s, y], [x + s, y + s], [x, y + s]]];
const disc = (cx: number, cy: number, r: number, n = 256): [number, number][][] => [
  Array.from({ length: n }, (_, k): [number, number] => [cx + r * Math.cos((k / n) * 2 * Math.PI), cy + r * Math.sin((k / n) * 2 * Math.PI)]),
];
const steps = (m: ReturnType<typeof spacefill>): number[] => {
  const out: number[] = [];
  for (let e = 0; e < m.edgeList.length; e += 2) {
    const a = m.edgeList[e];
    const b = m.edgeList[e + 1];
    out.push(Math.hypot(m.x[a] - m.x[b], m.y[a] - m.y[b]));
  }
  return out;
};

describe('spacefill', () => {
  it('fills a square at the spacing asked for, as one line that never crosses itself', () => {
    // (side / spacing)² cells, one vertex each, one chain, every step the
    // cell size: the uniform Hilbert walk and nothing else.
    const m = spacefill(env, square(10, 10, 64), { spacing: 4 });
    expect(m.n).toBe(256);
    expect(m.curves().length).toBe(1);
    expect(m.curves()[0].closed).toBe(false);
    expect(Math.min(...steps(m))).toBeCloseTo(4, 9);
    expect(Math.max(...steps(m))).toBeCloseTo(4, 9);
    // A crossing would make planarize mint a vertex at the intersection.
    expect(m.planarize().n).toBe(256);
  });

  it('crowds the folds where the tone is dark', () => {
    const dark = (x: number) => (x < 50 ? 1 : 0.1);
    const m = spacefill(env, square(10, 10, 80), { spacing: 2.5, field: (x) => dark(x) });
    let left = 0;
    let right = 0;
    for (let i = 0; i < m.n; i++) (m.x[i] < 50 ? left++ : right++);
    expect(left).toBeGreaterThan(right * 8);
    // Still one line: the walk crosses the tone step without lifting.
    expect(m.curves().length).toBe(1);
  });

  it('stays continuous where the level changes', () => {
    // The load-bearing claim. A cell that stops early sits next to a whole
    // subtree, and the two still meet: no step is longer than the coarser
    // of the two cells across its diagonal.
    const tone = (x: number, y: number) => Math.max(0.05, 1 - Math.hypot(x - 40, y - 40) / 30);
    const m = spacefill(env, square(0, 0, 96), { spacing: 1.5, field: tone });
    expect(m.curves().length).toBe(1);
    const levels = new Set(Array.from(m.attrs.level));
    expect(levels.size).toBeGreaterThan(3);
    // The coarsest cell present, as a length: 96 / 2^level.
    const coarsest = 96 / 2 ** Math.min(...levels);
    expect(Math.max(...steps(m))).toBeLessThanOrEqual(coarsest * Math.SQRT2 + 1e-9);
  });

  it('finds a dark speck in a blank field', () => {
    // A cell is judged by the tone at the centres of the cells under it, not
    // by its own centre alone. A rule that read one centre would see 0 at
    // the middle of the square and draw nothing at all.
    const speck = (x: number, y: number) => (Math.hypot(x - 70, y - 70) < 12 ? 1 : 0);
    const m = spacefill(env, square(0, 0, 96), { spacing: 1.5, field: speck });
    // About the disc's area in finest cells, and nothing anywhere else.
    const cells = (Math.PI * 12 * 12) / (1.5 * 1.5);
    expect(m.n).toBeGreaterThan(cells * 0.6);
    expect(m.n).toBeLessThan(cells * 1.4);
    for (let i = 0; i < m.n; i++) expect(Math.hypot(m.x[i] - 70, m.y[i] - 70)).toBeLessThan(13.5);
  });

  it('turns a corner at a level change, so every step is square', () => {
    // A Hilbert line, or a Peano one, has no diagonal in it. A coarse leaf
    // and a fine one do not meet centre to centre, so the walk goes through
    // an elbow rather than cutting the corner.
    // A side of exactly `spacing · nᴸ`, so no cell falls outside the area
    // and the only thing that could break the chain is an elbow.
    for (const [rule, side] of [[hilbertRule, 128], [peanoRule, 243], [meanderRule, 243]] as const) {
      const tone = (x: number, y: number) => Math.max(0.03, 1 - Math.hypot(x - side * 0.45, y - side * 0.55) / (side * 0.38));
      const m = spacefill(env, square(0, 0, side), { spacing: 1, field: tone, rule });
      expect(new Set(Array.from(m.attrs.level)).size).toBeGreaterThanOrEqual(5);
      // Exact, on the material's own coordinates. Not close to square.
      for (let e = 0; e < m.edgeList.length; e += 2) {
        const a = m.edgeList[e];
        const b = m.edgeList[e + 1];
        expect(m.x[a] === m.x[b] || m.y[a] === m.y[b]).toBe(true);
      }
      // The corners add vertices, never breaks.
      expect(m.curves().length).toBe(1);
    }
  });

  it('takes a rule of the artist\'s own', () => {
    for (const rule of [peanoRule, meanderRule]) {
      const m = spacefill(env, square(0, 0, 81), { spacing: 3, rule });
      expect(m.n).toBe(729);
      expect(m.curves().length).toBe(1);
      // Nine cells per parent, each visited once, consecutive ones touching.
      expect(Math.max(...steps(m))).toBeCloseTo(3, 9);
    }
    // Hilbert and Peano do not fold the same way, even over the same square.
    const a = spacefill(env, square(0, 0, 81), { spacing: 3, rule: peanoRule });
    const b = spacefill(env, square(0, 0, 81), { spacing: 3, rule: meanderRule });
    expect(Array.from(a.x)).not.toEqual(Array.from(b.x));
  });

  it('refuses a rule that is not a curve, by name', () => {
    const short: SpacefillRule = { n: 2, order: [{ cell: [0, 0], turn: 'id' }] };
    expect(() => compileRule(short)).toThrow(/needs 4 entries/);
    const twice: SpacefillRule = { n: 2, order: [{ cell: [1, 1], turn: 'l' }, { cell: [1, 1], turn: 'id' }, { cell: [0, 1], turn: 'id' }, { cell: [1, 0], turn: 'r' }] };
    expect(() => compileRule(twice)).toThrow(/visits cell \[1, 1\] twice/);
    const missing: SpacefillRule = { n: 2, order: [{ cell: [0, 0], turn: 'l' }, { cell: [0, 1], turn: 'id' }, { cell: [1, 1], turn: 'id' }, { cell: [1, 1], turn: 'r' }] };
    expect(() => compileRule(missing)).toThrow(/visits cell \[1, 1\] twice/);
    const jumps: SpacefillRule = { n: 2, order: [{ cell: [0, 0], turn: 'l' }, { cell: [1, 1], turn: 'id' }, { cell: [0, 1], turn: 'id' }, { cell: [1, 0], turn: 'r' }] };
    expect(() => compileRule(jumps)).toThrow(/jumps from cell \[0, 0\] to \[1, 1\]/);
    // Every cell once and every pair touching, but the turns do not carry
    // the line: the children never meet.
    const broken: SpacefillRule = { n: 2, order: [{ cell: [0, 0], turn: 'id' }, { cell: [0, 1], turn: 'id' }, { cell: [1, 1], turn: 'id' }, { cell: [1, 0], turn: 'id' }] };
    expect(() => compileRule(broken)).toThrow(/children meet/);
    const offGrid = { n: 2, order: [{ cell: [0, 2], turn: 'id' }, { cell: [0, 1], turn: 'id' }, { cell: [1, 1], turn: 'id' }, { cell: [1, 0], turn: 'id' }] } as SpacefillRule;
    expect(() => compileRule(offGrid)).toThrow(/not a cell of the 2 by 2 grid/);
    const noSuchTurn = { n: 2, order: [{ cell: [0, 0], turn: 'sideways' }, { cell: [0, 1], turn: 'id' }, { cell: [1, 1], turn: 'id' }, { cell: [1, 0], turn: 'r' }] } as unknown as SpacefillRule;
    expect(() => compileRule(noSuchTurn)).toThrow(/'sideways' is not one of/);
    // The refusal reaches the drawing word too.
    expect(() => spacefill(env, square(0, 0, 10), { spacing: 1, rule: jumps })).toThrow(/spacefill: rule jumps/);
  });

  it('keeps every mark inside the area, and re-enters rarely', () => {
    const m = spacefill(env, disc(50, 50, 40), { spacing: 2.5 });
    for (let i = 0; i < m.n; i++) expect(Math.hypot(m.x[i] - 50, m.y[i] - 50)).toBeLessThanOrEqual(40);
    expect(m.n).toBeGreaterThan(600);
    // A jump is a pen-up. The walk keeps them to a handful of the cells it
    // draws, rather than one per crossing of the outline.
    expect(m.curves().length).toBeLessThan(m.n / 20);
  });

  it('carries the level each cell stopped at', () => {
    const tone = (x: number) => (x < 30 ? 1 : x < 60 ? 0.4 : 0.1);
    const m = spacefill(env, square(0, 0, 96), { spacing: 3, field: (x) => tone(x) });
    expect(m.attrs.level).toBeDefined();
    expect(m.attrs.level.length).toBe(m.n);
    expect(m.transfers.level).toBe('nearest');
    const deep = m.points.filter((p) => p.level === Math.max(...m.attrs.level));
    // The deepest cells are the dark ones, on the left.
    deep.forEach((p) => expect(p.x).toBeLessThan(30));
    // `maxSpacing` puts a ceiling on cell size, so the palest tone folds
    // too: 96 / 2³ is 12, and no cell comes out coarser than that.
    const capped = spacefill(env, square(0, 0, 96), { spacing: 3, maxSpacing: 12, field: (x) => tone(x) });
    expect(Math.min(...m.attrs.level)).toBeLessThan(3);
    expect(Math.min(...capped.attrs.level)).toBeGreaterThanOrEqual(3);
    expect(capped.n).toBeGreaterThan(m.n);
    expect(capped.curves().length).toBe(1);
    // It folds nothing where there is no tone. Half blank stays half blank.
    const half = spacefill(env, square(0, 0, 96), { spacing: 3, maxSpacing: 12, field: (x) => (x < 48 ? 0.3 : 0) });
    for (let i = 0; i < half.n; i++) expect(half.x[i]).toBeLessThan(48);
  });

  it('draws the same line twice', () => {
    const opts = { spacing: 2, field: (x: number, y: number) => Math.abs(Math.sin(x / 9) * Math.cos(y / 7)) };
    const a = spacefill(env, disc(50, 50, 44), opts);
    const b = spacefill(env, disc(50, 50, 44), opts);
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect(Array.from(a.y)).toEqual(Array.from(b.y));
    expect(Array.from(a.attrs.level)).toEqual(Array.from(b.attrs.level));
    expect(Array.from(a.edgeList)).toEqual(Array.from(b.edgeList));
  });

  it('draws nothing rather than throwing on degenerate input', () => {
    expect(spacefill(env, [], { spacing: 4 }).n).toBe(0);
    expect(spacefill(env, square(0, 0, 0), { spacing: 4 }).n).toBe(0);
    expect(spacefill(env, square(0, 0, 64), { spacing: 0 }).n).toBe(0);
    expect(spacefill(env, square(0, 0, 64), { spacing: -4 }).n).toBe(0);
    expect(spacefill(env, square(0, 0, 64), { spacing: 4, field: () => 0 }).n).toBe(0);
    expect(spacefill(env, square(0, 0, 64), { spacing: 4, field: () => Number.NaN }).n).toBe(0);
    // Spacing coarser than the area: one cell, which is a dot and no line.
    const one = spacefill(env, square(0, 0, 4), { spacing: 40 });
    expect(one.n).toBe(1);
    expect(one.edgeList.length).toBe(0);
  });
});
