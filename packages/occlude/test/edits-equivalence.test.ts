/**
 * Edits as values, acceptance 2: a batch is its list of records. For every
 * rule below, landing the batch as `next` left it, landing the list a pass
 * hands back (`return next.edits`), and landing it through a stage of the
 * array form (`[rule, (c, x) => x.edits]`) give the same state to the bit:
 * positions, columns, edges, ids and lineage.
 *
 * The id counter is reset before each run, so a run's minted ids can be
 * compared with another run's. That is why these tests have a file of their
 * own: a reset in the middle of another file would let two live materials
 * share ids.
 */

import { describe, expect, it } from 'vitest';
import { curve, material, resetIds, add, mul, fromAngle, type Material, type Next, type StepRule } from '../src/material.js';
import { force } from '../src/forces.js';

type Rule = (cur: Material, next: Next, k: number) => void;

const bits = (a: Float64Array | Uint32Array): string => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('hex');
const snapshot = (m: Material) => ({
  n: m.n,
  x: bits(m.x),
  y: bits(m.y),
  attrs: Object.fromEntries(m.attrNames.map((name) => [name, bits(m.attrs[name])])),
  edges: bits(m.edgeList),
  edgeAttrs: Object.fromEntries(m.edgeAttrNames.map((name) => [name, bits(m.edgeAttrs[name])])),
  pointIds: bits(m.pointIds),
  edgeIds: bits(m.edgeIds),
  edgeRoots: bits(m.edgeRoots),
  faceAttrs: Object.fromEntries(Object.entries(m.faceAttrs).map(([name, c]) => [name, [...c.values].sort()])),
});

/** The three spellings of one batch, each from a fresh start and a fresh id counter. */
function threeWays(start: () => Material, n: number, rule: () => Rule) {
  const run = (wrap: (r: Rule) => StepRule | StepRule[]) => {
    resetIds();
    const m = start();
    const out = m.steps(n, wrap(rule()) as StepRule);
    return { state: snapshot(out), dropped: out.dropped.length };
  };
  const plain = run((r) => r);
  const returned = run((r) => (c, x, k) => { r(c, x, k); return x.edits; });
  const staged = run((r) => [r, (_c: Material, x: Next) => x.edits]);
  return { plain, returned, staged };
}

/** A seeded stream, as a sketch's `t.stream` would be: one per run. */
const stream = (seed: number) => {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
};
const ring = (r: number, count: number) => curve(Array.from({ length: count }, (_, i) => [50 + r * Math.cos((2 * Math.PI * i) / count), 50 + r * Math.sin((2 * Math.PI * i) / count)] as [number, number]), { closed: true });

const CASES: { name: string; start: () => Material; n: number; rule: () => Rule }[] = [
  {
    name: 'extrude and set (the branching tree)',
    start: () => material([[50, 92]], { heading: -Math.PI / 2, tip: 1 }),
    n: 20,
    rule: () => (cur, next, k) => {
      const tips = cur.points.filter((p) => p.tip === 1 && p.y > 10);
      next.extrude(tips, (p) => {
        const fork = k % 5 === 0 ? [p.heading - 0.5, p.heading + 0.5] : [p.heading + Math.sin(p.x / 7 + p.y / 11) * 0.4];
        return fork.map((h) => ({ position: add(p, mul(fromAngle(h), 3.2)), attributes: { heading: h, tip: 1 } }));
      });
      next.set(tips, { tip: 0 });
    },
  },
  {
    name: 'replace (a Koch curve)',
    start: () => ring(40, 3),
    n: 4,
    rule: () => {
      const h = Math.sqrt(3) / 6;
      const motif = material([[0, 0], [1 / 3, 0], [0.5, h], [2 / 3, 0], [1, 0]], { edges: [[0, 1], [1, 2], [2, 3], [3, 4]] });
      return (cur, next, k) => next.replace(cur.edges, motif, { flip: (_e, step) => (step + k) % 2 === 0 });
    },
  },
  {
    name: 'splitEdges (finer and finer)',
    start: () => ring(34, 8).attribute('age', (p) => p.index),
    n: 3,
    rule: () => (cur, next) => next.splitEdges(cur.edges.filter((e) => e.length > 12)),
  },
  {
    name: 'forces, setEdges and split (the growing ring)',
    start: () => ring(8, 24).edgeAttribute('fresh', 0),
    n: 60,
    rule: () => {
      const rnd = stream(6);
      return (cur, next, k) => {
        const push = force.sum(force.tension(cur, { rest: 1.6 }), force.separation(cur, { radius: 4, excludeConnected: true }), force.relax(cur, { amount: 0.4 }));
        next.move(cur.points, (p) => mul(push(p), 0.15));
        const stretched = cur.edges.filter((e) => e.length > 1.8 && rnd() < 0.3);
        next.setEdges(stretched, { fresh: k });
        for (const e of stretched) next.split(e);
      };
    },
  },
  {
    name: 'connect and disconnect (pairs, then a trim)',
    start: () => material(Array.from({ length: 36 }, (_, i) => [10 + (i % 6) * 14 + (i % 3), 10 + Math.floor(i / 6) * 14] as [number, number])),
    n: 2,
    rule: () => (cur, next, k) => {
      if (k === 0) {
        for (const [p, q] of cur.points.pairs(cur.points, (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 16, { radius: 16 })) next.connect(p, q);
      } else {
        next.disconnect(cur.edges.filter((e) => e.a.x < 50 && e.b.x < 50));
      }
    },
  },
  {
    name: 'remove, addPoint and connect (the gapped ring)',
    start: () => ring(34, 36),
    n: 3,
    rule: () => (cur, next, k) => {
      next.remove(cur.points.filter((p) => p.index % 9 === k));
      const hub = next.addPoint([50, 50 + k], {});
      for (const p of cur.points.filter((p) => p.index % 9 === 4)) next.connect(p, hub);
    },
  },
  {
    name: 'move and set by callback (the wavy, ageing ring)',
    start: () => ring(34, 30).attribute('age', 0),
    n: 5,
    rule: () => (cur, next) => {
      next.move(cur.points, (p) => [0, Math.sin(p.x / 4) * 2]);
      next.set(cur.points.filter((p) => p.x > 50), (p) => ({ age: p.age + 1 }));
    },
  },
  {
    name: 'split with overrides and joins to its record (a network)',
    start: () => curve([[10, 10], [90, 10], [90, 90], [10, 90]], { closed: true, active: 0 }).attribute('active', (p) => (p.index === 0 ? 1 : 0)),
    n: 6,
    rule: () => (cur, next, k) => {
      const e = cur.edges.at(k % cur.edgeCount);
      const cut = next.split(e, { at: 0.3 + 0.1 * (k % 3), point: { active: 1 } });
      const tip = next.addPoint([50 + k, 50 - k], { active: 0 });
      next.connect(cut, tip);
      next.set(cur.points.filter((p) => p.active === 1), { active: 0 });
    },
  },
  {
    name: 'setFaces (a column written in a step)',
    start: () => material([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5]], { edges: [[0, 1], [1, 2], [2, 3], [3, 0], [0, 4], [4, 2]] }).planarize(),
    n: 2,
    rule: () => (cur, next, k) => next.setFaces(cur.faces(), (f) => ({ big: f.area > 40 ? k + 1 : 0 })),
  },
];

describe('edits as values: a batch is its list', () => {
  for (const c of CASES) {
    it(`${c.name}: next, a returned list and a stage land bit-identically`, () => {
      const { plain, returned, staged } = threeWays(c.start, c.n, c.rule);
      expect(plain.state.n).toBeGreaterThan(0);
      expect(returned).toEqual(plain);
      expect(staged).toEqual(plain);
    });
  }
});
