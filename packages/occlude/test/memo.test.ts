import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { circle, rect, material, mm, w } from '../src/index.js';
import { Execution, bindToolkit, compileSketch, initOcclude, render } from '../src/host.js';
import { sketch, type SketchDef, type Toolkit } from '../src/api.js';
import { beginIds, type Material } from '../src/material.js';
import { MEMO_OPS, MemoStore, contentHash, keyHash, memoMethod, memoised } from '../src/memo.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
  await initOcclude(readFileSync(wasmPath));
});

/** One run: an execution on `paper` reading through `store`, begun, and its
 * toolkit read through the memo, as the api.ts hook hands it to a sketch. */
function run(store: MemoStore | undefined, paper = { w: 210, h: 297 }): { exec: Execution; t: Toolkit } {
  const exec = new Execution({ paper }, { memo: store });
  exec.begin({});
  return { exec, t: memoised(bindToolkit(exec), exec) };
}

/** The next id the run would mint, read the way a sketch would see it: a
 * fresh pure material's first point id. */
const nextId = (): number => material([[0, 0]]).pointIds[0];

describe('keyHash', () => {
  it('keys data by value, -0 apart from 0, records in their key order', () => {
    expect(keyHash([1, 'a', null, undefined, true])).toBe(keyHash([1, 'a', null, undefined, true]));
    expect(keyHash(0)).not.toBe(keyHash(-0));
    expect(keyHash(NaN)).toBe(keyHash(NaN));
    expect(keyHash({ a: 1, b: 2 })).not.toBe(keyHash({ b: 2, a: 1 }));
    expect(keyHash([1, 2])).not.toBe(keyHash([[1, 2]]));
    expect(keyHash('12')).not.toBe(keyHash(12));
    expect(keyHash(new Float64Array([1, 2]))).toBe(keyHash(new Float64Array([1, 2])));
    expect(keyHash(new Float64Array([1, 2]))).not.toBe(keyHash(new Float32Array([1, 2])));
  });

  it('keys a shape tree by its data, lengths included', () => {
    expect(keyHash(circle(50, 50, mm(10)))).toBe(keyHash(circle(50, 50, mm(10))));
    expect(keyHash(circle(50, 50, mm(10)))).not.toBe(keyHash(circle(50, 50, w(10))));
    expect(keyHash(rect(0, 0, 10, 10, { rotate: 5 }))).not.toBe(keyHash(rect(0, 0, 10, 10, { rotate: 6 })));
  });

  it('refuses closures, unknown classes, accessors, symbols and cycles', () => {
    expect(keyHash([1, () => 2])).toBeUndefined();
    expect(keyHash({ field: (x: number) => x })).toBeUndefined();
    expect(keyHash(new Map())).toBeUndefined();
    expect(keyHash(new (class Thing {})())).toBeUndefined();
    expect(keyHash(Object.defineProperty({}, 'x', { get: () => 1, enumerable: true }))).toBeUndefined();
    expect(keyHash({ [Symbol('s')]: 1 })).toBeUndefined();
    const loop: unknown[] = [];
    loop.push(loop);
    expect(keyHash(loop)).toBeUndefined();
    // a shared (not cyclic) value is data twice
    const shared = [1, 2];
    expect(keyHash([shared, shared])).toBe(keyHash([[1, 2], [1, 2]]));
  });

  it('keys geometry by identity and hashes its content by its columns', () => {
    beginIds();
    const a = material([[0, 0], [1, 1]], { edges: [[0, 1]] });
    beginIds();
    const b = material([[0, 0], [1, 1]], { edges: [[0, 1]] });
    expect(keyHash(a)).toBe(keyHash(a));
    expect(keyHash(a)).not.toBe(keyHash(b));
    expect(contentHash(a)).toBe(contentHash(b));
    // ids are content: the same rows minted elsewhere are another value
    const c = material([[0, 0], [1, 1]], { edges: [[0, 1]] });
    expect(contentHash(c)).not.toBe(contentHash(a));
    expect(contentHash(a.points.set('k', 1))).not.toBe(contentHash(a));
  });
});

describe('MemoStore', () => {
  const entry = (bytes: number) => ({ value: {}, minted: 0, ms: 0, bytes });
  it('drops the least recently used entries to stay in its byte budget', () => {
    const store = new MemoStore({ maxBytes: 300 });
    store.set('a', entry(100));
    store.set('b', entry(100));
    store.set('c', entry(100));
    expect(store.get('a')).toBeDefined(); // a is now the most recent
    store.set('d', entry(100));
    expect(store.get('b')).toBeUndefined();
    expect(store.get('a')).toBeDefined();
    expect(store.get('c')).toBeDefined();
    expect(store.size).toEqual({ entries: 3, bytes: 300 });
    expect(store.stats.evicted).toBe(1);
    store.set('huge', entry(1000));
    expect(store.get('huge')).toBeUndefined();
    expect(store.size.entries).toBe(3);
  });
});

describe('the memo in a run', () => {
  /** A small body: two roots from shapes, a derivation of one of them, a
   * word that draws in between, and a pure material after, whose ids say
   * where the counter stands. */
  function body(t: Toolkit, count = 40) {
    const ring = t.sample(circle(50, 50, 20), { count });
    const box = t.material(rect(10, 10, 30, 30));
    const cloud = t.scatter({ spacing: 12 });
    const cells = t.voronoi(ring);
    const pick = t.rnd();
    return { ring, box, cloud, cells, pick, after: nextId() };
  }

  it('answers the same values on a second run, and the counter and the draws where a cold run has them', () => {
    const store = new MemoStore();
    const cold = body(run(store).t);
    expect(store.stats).toMatchObject({ hits: 0, misses: 3 });
    const warm = body(run(store).t);
    expect(store.stats).toMatchObject({ hits: 3, misses: 3 });
    expect(warm.ring).toBe(cold.ring);
    expect(warm.box).toBe(cold.box);
    expect(warm.cells).toBe(cold.cells);
    // the draws: a new cloud, the same numbers
    expect(warm.cloud).not.toBe(cold.cloud);
    expect(contentHash(warm.cloud)).toBe(contentHash(cold.cloud));
    expect(warm.pick).toBe(cold.pick);
    expect(warm.after).toBe(cold.after);
    // and a run with an empty memo is the same run
    const fresh = body(run(new MemoStore()).t);
    expect(fresh.after).toBe(cold.after);
    for (const k of ['ring', 'box', 'cloud', 'cells'] as const) expect(contentHash(fresh[k])).toBe(contentHash(cold[k]));
  });

  it('runs as it always did without a memo', () => {
    const { exec } = run(undefined);
    const t = bindToolkit(exec);
    const material = t.material;
    expect(memoised(t, exec)).toBe(t);
    expect(t.material).toBe(material);
  });

  it('misses what an edit reaches, and what a moved counter reaches', () => {
    const store = new MemoStore();
    body(run(store).t, 40);
    const before = store.snapshot();
    body(run(store).t, 41);
    // the ring changed; everything after it mints elsewhere
    expect(store.stats.hits - before.hits).toBe(0);
    body(run(store).t, 40);
    expect(store.stats.hits - before.hits).toBe(3);
  });

  it('misses on another frame', () => {
    const store = new MemoStore();
    body(run(store).t);
    body(run(store, { w: 300, h: 300 }).t);
    expect(store.stats.hits).toBe(0);
  });

  it('never keys a closure', () => {
    const store = new MemoStore();
    for (let i = 0; i < 2; i++) {
      const { t } = run(store);
      t.spacefill(rect(0, 0, 50, 50), { spacing: 5, field: () => 0.5 });
    }
    expect(store.stats).toMatchObject({ hits: 0, misses: 0, unkeyed: 2 });
  });

  it('never stores a call that drew, and never memoises its operation again', () => {
    const store = new MemoStore();
    const draws: number[][] = [];
    for (let i = 0; i < 2; i++) {
      const exec = new Execution({ paper: { w: 210, h: 297 } }, { memo: store });
      exec.begin({});
      const tk = memoised({ material: () => exec.rnd(), sample: (n: number) => n * 2 }, exec);
      draws.push([tk.material(), tk.sample(3), exec.rnd()]);
    }
    expect(draws[1]).toEqual(draws[0]);
    expect(store.drew.has('t.material')).toBe(true);
    expect(store.stats).toMatchObject({ refused: 2, hits: 1, misses: 1 });
  });

  it('reads planarize and thicken through the store their value came from', () => {
    const store = new MemoStore();
    const made = () => run(store).t.material(rect(0, 0, 40, 40), circle(40, 40, 20));
    const first = made().planarize();
    const second = made().planarize();
    expect(second).toBe(first);
    // a keyed radius is a key; a radius that is a function is not
    const ring = () => run(store).t.material(circle(40, 40, 20));
    expect(ring().thicken({ radius: 2 })).toBe(ring().thicken({ radius: 2 }));
    const unkeyed = store.stats.unkeyed;
    expect(ring().thicken({ radius: () => 2 })).not.toBe(ring().thicken({ radius: () => 2 }));
    expect(store.stats.unkeyed).toBe(unkeyed + 2);
    // a value from nowhere memoised computes every time
    const loose = material([[0, 0], [10, 0], [10, 10]], { edges: [[0, 1], [1, 2], [2, 0]] });
    expect(loose.planarize()).not.toBe(loose.planarize());
    // the door itself: a method through the store its value came from
    const calls: number[] = [];
    const counted = (m: Material) => memoMethod(m, 'count', [], () => { calls.push(1); return m.n; });
    counted(made());
    counted(made());
    expect(calls.length).toBe(1);
  });

  it('proves its hits in verify mode', () => {
    const store = new MemoStore({ verify: true });
    body(run(store).t);
    body(run(store).t);
    expect(store.stats).toMatchObject({ hits: 3, misses: 3 });
  });

  it('knows every operation it lists', () => {
    const { exec } = run(undefined);
    const t = bindToolkit(exec) as unknown as Record<string, unknown>;
    for (const op of MEMO_OPS) expect(typeof t[op]).toBe('function');
  });
});

describe('a sketch through the memo', () => {
  const def: SketchDef = sketch({ seed: 3 }, (t) => {
    const ring = t.sample(circle(50, 60, 30), { count: 64 });
    const cells = t.voronoi(t.relax(t.scatter({ spacing: 9 }), { iterations: 2 }));
    return [
      ...ring.points.map((p) => circle(p.x, p.y, 1.5)),
      ...cells.faces.map((f) => circle(f.centroid[0], f.centroid[1], t.rnd(0.5, 2))),
      ...t.material(rect(20, 20, 60, 60)).points.map((p) => circle(p.x, p.y, 3)),
    ];
  });
  /** The ink of one compile: every fragment, in order. */
  const ink = (store: MemoStore | undefined): string => {
    const exec = new Execution({ paper: { w: 210, h: 297 } }, { memo: store });
    compileSketch(sketch(def.config, (t) => def.fn(memoised(t, exec))), exec);
    return JSON.stringify(render(exec).frags.map((f) => f.geom));
  };

  it('draws the same ink warm as cold, and as with no memo', () => {
    const store = new MemoStore();
    const off = ink(undefined);
    const cold = ink(store);
    const warm = ink(store);
    expect(cold).toBe(off);
    expect(warm).toBe(cold);
    expect(store.stats.hits).toBeGreaterThan(0);
  });
});
