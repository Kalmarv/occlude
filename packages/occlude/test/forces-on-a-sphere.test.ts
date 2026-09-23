/**
 * Forces on a sphere (spec 54). The materials page's growth — tension,
 * separation, `points.near` and drift on a 2:1 sheet — ran its neighbour
 * search with one stretch for the whole box: as the growth walked toward
 * a pole of the base row the box's stretch grew (12× by step 190) and every
 * query searched that much wider. The search now widens per query from the
 * query's own row (`bucketChart`), and a query within reach of a pole
 * searches its own band of rows across the grid.
 *
 * The rows below were written from the OLD code (the tree at c626f65,
 * before this change), by the same growth this test runs. The old code
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
const OLD_SUMS: [number, number, number][] = [[30,3000,1500],[30,3000.103873210203,1500.01276872108],[30,3000.2076176572127,1500.01644304335],[30,3000.309709892445,1500.01122186444],[30,3000.40960534601,1499.9974406471374],[30,3000.506828864511,1499.975347132492],[30,3000.6006560581313,1499.9451024614016],[30,3000.69002790384,1499.9068518131344],[30,3000.773601326256,1499.8608085369033],[30,3000.8496381859186,1499.807474438318],[30,3000.9150567201154,1499.7472068784232],[30,3000.966972663338,1499.6799559849253],[31,3100.9411921002607,1541.004253123861],[31,3100.9947011571467,1540.919624328704],[31,3101.0243894222754,1540.8273841408504],[33,3306.3052629630324,1631.778288057607],[35,3506.753494609393,1731.2249660053326],[37,3706.423265805756,1812.6970353318823],[39,3897.4460820432014,1897.8181729816306],[42,4195.00344685909,2059.299609293789]];

/** Every row of state 19 on the sphere, x then y, from the old code. */
const OLD_STATE_19 = [
  110.71740059769745, 110.37335716757278, 110.02931373744812, 109.23376422753192, 107.85003700325184, 106.39160419118032,
  104.5204019385139, 102.55787833127467, 101.24461681571154, 99.1932288032319, 97.54386530772248, 96.35506929575644,
  95.16627328379039, 94.57771694237378, 94.90886794990715, 93.50458638225354, 91.33130960460171, 90.46008171216525,
  90.85594741945388, 91.2518131267425, 90.27763908252594, 90.81864513816977, 91.80585345661319, 93.192898592165,
  94.88808596701939, 96.62647317099025, 96.4525696267799, 95.85214896457103, 95.8313685800727, 97.66147233063437,
  99.37952694493212, 99.81323808732293, 100.80031155020667, 102.15518715825787, 103.26246682084752, 105.09417645987774,
  105.89727969073805, 106.37150578328932, 107.51175301624251, 106.61100417676305, 107.29909192961146, 109.33361649327789,
  50.12916864834668, 51.21332343811633, 52.29747822788598, 53.7437416154733, 55.270333823693306, 56.36221305608132,
  57.14762170969128, 57.55118547231244, 59.303840752311515, 59.77169978546096, 59.24047748286344, 59.21663539424432,
  59.192793305625194, 57.45798483485394, 55.33475155916038, 54.29947033584588, 54.0234323053061, 52.133783446613144,
  51.10093146800753, 50.068079489401924, 48.12029566096074, 46.29554459929463, 44.540162139610054, 44.29647502682897,
  44.637708230697584, 44.336548313734454, 42.4857430195722, 40.977491187564, 39.572309253781526, 38.69737415900212,
  39.08341310084927, 41.57914411625816, 43.28890789323115, 42.192278112257924, 40.03447880531462, 40.207912430686875,
  42.13992654980983, 43.58784419105086, 44.719626359661326, 46.73185327901611, 48.15345586902834, 48.76217084428288,
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
