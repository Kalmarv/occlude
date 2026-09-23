/**
 * Forces on a sphere (spec 54). The materials page's growth — tension,
 * separation, `points.near` and drift on a 2:1 sheet — ran its neighbour
 * search with one stretch for the whole box: as the growth walked toward
 * a pole of the base row the box's stretch grew (12× by step 190) and every
 * query searched that much wider. The search now widens per query from the
 * query's own row (`bucketChart`), and a query within reach of a pole
 * searches its own band of rows across the grid.
 *
 * The rows below were written from the tree at d40dc87 (after spec 57
 * changed how `t.sample(circle)` lays the seeds in a space), by the same
 * growth this test runs. The old code
 * read an edge's `length` in coordinates, so the rows test splits on the
 * coordinate length to keep the old growth; `e.length` is now the space's
 * own, and the fence as written runs all 210 steps.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toolkit } from './helpers/run.js';
import { circle, docsPaper, force, initOcclude, material, paperSize, spaceOf, type Edge, type Material, type Space } from '../src/index.js';
import { neighbours } from '../src/forces.js';
import { length, mul, sub, sumBy, unit } from '../src/vec.js';

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url));
  await initOcclude(readFileSync(wasmPath));
});

/** materials#44 in `space`, `steps` long; `seen` gets each state before
 * its step, and `coordinates` splits on the coordinate length of an edge,
 * as the old `e.length` read it. */
function growth(space: 'spherical' | undefined, steps: number, seen?: (cur: Material) => void, coordinates = false): Material {
  const t = toolkit({ aspect: [2, 1], seed: 4, ...(space ? { space } : {}) }, { paper: paperSize(docsPaper({})), seed: '42' });
  const posts = material([[40, 24], [100, 16], [160, 28], [44, 76], [104, 84], [160, 72]]);
  const shove = (p: { x: number; y: number }) => sumBy(posts.points.near(p, { radius: 18 }), (q) => {
    const delta = sub(p, q);
    return mul(unit(delta), (18 - length(delta)) * 0.9);
  });
  const wander = force.drift(t.noise, { amount: 0.2 });
  return t.sample(circle(100, 50, 8), { count: 30 }).steps(steps, (cur, next, k) => {
    seen?.(cur);
    const push = force.sum(force.tension(cur, { rest: 2 }), force.separation(cur, { radius: 4.4, excludeConnected: true }), shove, wander);
    next.move(cur.points, (p) => mul(push(p, k), 0.18));
  }, (cur, next) => {
    const long = (e: Edge) => (coordinates ? Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y) : e.length) > 2.2;
    next.splitEdges(cur.edges.filter((e) => long(e) && t.chance(0.3)));
  });
}

const cpuMs = (f: () => void): number => {
  const c0 = process.cpuUsage();
  f();
  const c = process.cpuUsage(c0);
  return (c.user + c.system) / 1000;
};

/** [n, Σx, Σy] of the first 20 states on the sphere, from the old code. */
const OLD_SUMS: [number, number, number][] = [[30,2999.9999999999995,1499.9999999999998],[30,3000.102705291749,1500.0122980919452],[30,3000.205320705808,1500.0154554314367],[30,3000.3063279946105,1500.009645159293],[30,3000.4051856343094,1499.9951816292457],[30,3000.501421623153,1499.9722936302528],[30,3000.594316279878,1499.9411234661557],[30,3000.6828177081493,1499.9017952427137],[30,3000.7655965738195,1499.8544946948346],[30,3000.8408406225954,1499.7997262179128],[30,3000.9055263687833,1499.7378124077813],[30,3000.9567866119455,1499.6686567334357],[31,3100.9325699880396,1541.0039768390839],[31,3100.9858587244535,1540.9174855894296],[31,3101.0153312842426,1540.8230591886984],[33,3306.2819112718626,1631.7675030354535],[35,3504.337870814872,1728.3828209175397],[36,3603.7912909994798,1768.7546078160156],[41,4103.599344520083,2002.51115949541],[42,4205.376940063728,2060.863536541638]];

/** Every row of state 19 on the sphere, x then y, from the old code. */
const OLD_STATE_19 = [
  110.83331748923342, 110.49812882231927, 109.88834409158828, 109.12314437737302, 107.86531435357873, 106.40514479518602,
  104.52549092236517, 102.55809725271445, 101.86397129052847, 101.16984532834249, 99.13289115862888, 97.54203159193445,
  95.12484382077204, 94.9596043478492, 95.09119467319368, 94.27784558345064, 92.38038625942235, 90.75484105022676,
  90.21289947601258, 91.30603119337516, 90.29909259471565, 90.8143617064841, 91.78606175646912, 93.26508126968213,
  94.99187050247154, 96.60256530458088, 96.31502075407741, 95.7105698375624, 96.97660641713506, 98.76369121279843,
  99.70185281361863, 99.90247814640013, 101.2079765324741, 102.38231776632007, 103.35767711490703, 104.92767171908854,
  105.8673676424906, 106.4050216606388, 107.51194255420614, 106.61170538517035, 107.26810845925941, 109.19453103508319,
  49.71779989190224, 51.27296290308691, 52.709129104407, 54.026796788572995, 55.285934173218095, 56.37789820397814,
  57.16117580592396, 57.5561640992308, 58.42351772173305, 59.2908713442353, 59.753057811372905, 59.27829463390978,
  59.03868527673316, 57.58282109364072, 55.85587408397686, 54.53094411910216, 54.42319241919318, 53.867006834062096,
  51.872460856092545, 49.99645337906212, 48.04951276133285, 46.28453347598092, 44.510357628448105, 44.14640377517899,
  44.3286023853867, 43.98297019577678, 42.03207488476905, 39.95428717902065, 39.021843346886584, 38.721709523003625,
  39.96721777303142, 42.20029430315965, 43.45021496190873, 42.07694617320537, 40.208835945695775, 40.23416003961783,
  42.12118721543924, 43.56075475315171, 44.68900897324787, 46.72014497490762, 48.121160277620284, 48.46027545143462,
];

describe('forces on a sphere', () => {
  it('the growth keeps the rows it had for the first 20 steps', () => {
    const states: Material[] = [];
    growth('spherical', 20, (cur) => states.push(cur), true);
    expect(states.map((m) => m.n)).toEqual(OLD_SUMS.map((s) => s[0]));
    states.forEach((m, i) => {
      let sx = 0;
      let sy = 0;
      for (let r = 0; r < m.n; r++) {
        sx += m.x[r];
        sy += m.y[r];
      }
      expect(Math.abs(sx - OLD_SUMS[i][1])).toBeLessThan(1e-9);
      expect(Math.abs(sy - OLD_SUMS[i][2])).toBeLessThan(1e-9);
    });
    const last = states[19];
    for (let r = 0; r < last.n; r++) {
      expect(Math.abs(last.x[r] - OLD_STATE_19[r])).toBeLessThan(1e-9);
      expect(Math.abs(last.y[r] - OLD_STATE_19[last.n + r])).toBeLessThan(1e-9);
    }
  });

  it('the fence runs its 210 steps within 3× the flat growth, and the search stays tight', () => {
    const flat = cpuMs(() => growth(undefined, 210));
    let grown: Material | undefined;
    const sphere = cpuMs(() => { grown = growth('spherical', 210); });
    expect(sphere).toBeLessThan(3 * flat);
    // Deterministic: candidates examined per neighbour found. The old
    // box-wide stretch examined 53 per hit at step 190; the flat grid 2.9.
    const stats = { queries: 0, candidates: 0, hits: 0 };
    const near = neighbours(grown!, { radius: 4.4, space: grown!.space, stats });
    for (const p of grown!.points) near(p);
    expect(stats.candidates / stats.hits).toBeLessThan(4);
  }, 60_000);
});

describe('neighbours near a pole and across the seam', () => {
  /** A seeded stream, so the points are the same every run. */
  const stream = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

  const brute = (m: Material, sp: Space, p: [number, number], far: number): number[] => {
    const out: number[] = [];
    for (let j = 0; j < m.n; j++) if (sp.distance(p, [m.x[j], m.y[j]]) < far) out.push(j);
    return out;
  };

  it('finds every neighbour a brute-force search finds on the sphere', () => {
    const sp = spaceOf({ curvature: 1 / 2500, center: [100, 50] });
    const ell = sp.radius;
    const poleY = 50 + (Math.PI / 2) * ell;
    const rnd = stream(7);
    const pts: [number, number][] = [];
    // A cap about the pole, a band across the seam (x = 100 ± π·ell), and
    // pairs a sketch wrote past a pole or a turn away.
    for (let i = 0; i < 600; i++) pts.push([100 + (rnd() * 2 - 1) * Math.PI * ell, poleY - rnd() * 12]);
    for (let i = 0; i < 300; i++) pts.push([100 + Math.PI * ell + (rnd() * 2 - 1) * 8, 50 + (rnd() * 2 - 1) * 30]);
    for (let i = 0; i < 100; i++) pts.push([100 + (rnd() * 6 - 3) * Math.PI * ell, 50 + (rnd() * 4 - 2) * Math.PI * ell]);
    const m = material(pts);
    for (const radius of [1.5, 4.4]) {
      const near = neighbours(m, { radius, space: sp });
      for (let i = 0; i < 400; i++) {
        const onPole = i % 2 === 0;
        const q: [number, number] = onPole
          ? [100 + (rnd() * 2 - 1) * Math.PI * ell, poleY - rnd() * radius]
          : [100 + Math.PI * ell + (rnd() * 2 - 1) * 4, 50 + (rnd() * 2 - 1) * 30];
        const reach = i % 3 === 0 ? radius * 2.5 : undefined;
        expect(near(q, reach).sort((a, b) => a - b)).toEqual(brute(m, sp, q, reach ?? radius));
      }
    }
  });

  it('wraps round the seam when no pole is near', () => {
    // No pole in the box: a search that stretches the box and never wraps
    // loses the neighbours just across x = 100 ± π·ell.
    const sp = spaceOf({ curvature: 1 / 2500, center: [100, 50] });
    const seam = 100 + Math.PI * sp.radius;
    const rnd = stream(13);
    const pts: [number, number][] = [];
    // Past the seam a place is written a turn back, as `exp` answers it.
    for (let i = 0; i < 400; i++) {
      const x = seam + (rnd() * 2 - 1) * 10;
      pts.push([x > seam ? x - 2 * Math.PI * sp.radius : x, 50 + (rnd() * 2 - 1) * 20]);
    }
    const m = material(pts);
    const near = neighbours(m, { radius: 4.4, space: sp });
    for (let i = 0; i < 200; i++) {
      const q: [number, number] = [seam - rnd() * 3, 50 + (rnd() * 2 - 1) * 20];
      expect(near(q).sort((a, b) => a - b)).toEqual(brute(m, sp, q, 4.4));
    }
  });

  it('finds every neighbour a brute-force search finds in the disk', () => {
    const sp = spaceOf({ curvature: -4 / 140 ** 2, center: [100, 50] });
    const rnd = stream(11);
    const pts: [number, number][] = [];
    for (let i = 0; i < 800; i++) pts.push([rnd() * 400 - 100, rnd() * 300 - 100]);
    const m = material(pts);
    const near = neighbours(m, { radius: 6, space: sp });
    for (let i = 0; i < 300; i++) {
      const q: [number, number] = [rnd() * 400 - 100, rnd() * 300 - 100];
      const reach = i % 3 === 0 ? 15 : undefined;
      expect(near(q, reach).sort((a, b) => a - b)).toEqual(brute(m, sp, q, reach ?? 6));
    }
  });
});
