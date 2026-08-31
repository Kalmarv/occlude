#!/usr/bin/env tsx
/**
 * Toolpath statistics: render sketches headless, export the toolpath plan,
 * and report the numbers that path-optimization passes would change —
 * measured before/after evidence, not guesses.
 *
 *   pnpm --filter occlude plotstats <sketch.ts...> [--seed N] [--paper A4]
 *        [--landscape] [--tolerance 0.025]
 *        [--hop MM=15] [--travel MMPM=6000] [--accel MMS2=1000] [--taccel MMS2=2000]
 *   pnpm --filter occlude plotstats --fit    # learn wall-time correction
 *                                           # coefficients from the plot log
 *
 * Per sketch and in total:
 * - chains (= pen lifts today), pen-down mm, pen-up travel mm, time est
 * - bridgeable: consecutive same-pen gaps ≤ nib/2 (pass 3 would join these)
 * - euler: junction-graph analysis — split chains where endpoints touch
 *   other chains, then the component/odd-node bound gives the minimum
 *   number of strokes WITHOUT double-drawing (pass 4's ceiling)
 * - coincident mm: near-parallel overlapping segments between different
 *   chains of the same pen — ink that would be laid down twice
 */

import { transformSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from 'occlude-core';
import { preloadAssetsFromDisk } from './asset-preload.js';
import * as occlude from '../src/index.js';
import {
  compileSketch, initOcclude, isSketch, paperSize, pensToJson, render,
  setPaperHint, setPenLibrary, type SketchDef,
} from '../src/index.js';

const args = process.argv.slice(2);

// --fit: learn correction coefficients from recorded plots (server log).
// wall ≈ a·drawMs + b·travelMs + c·cycleMs [+ d·commands with enough data].
// Linear in the unknowns → closed-form least squares, no iteration.
if (args.includes('--fit')) {
  const logPath = fileURLToPath(
    new URL('../../occlude-studio/sketches/plots.jsonl', import.meta.url),
  );
  let raw = '';
  try {
    raw = readFileSync(logPath, 'utf8');
  } catch {
    console.error(`no plot log at ${logPath} — plot something first (calibration plots isolate each axis)`);
    process.exit(1);
  }
  const rows = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as {
      wallMs: number;
      estimate: { drawMs: number; travelMs: number; cycleMs: number; commands: number };
      pen?: string; sketch?: string; ts?: string;
    })
    .filter((r) => r.wallMs > 0 && r.estimate);
  if (rows.length < 4) {
    console.error(`${rows.length} usable plot(s) logged — need ≥4 (the calibration plots give one clean axis each)`);
    process.exit(1);
  }
  const useCmds = rows.length >= 8;
  const feats = (r: (typeof rows)[0]): number[] =>
    useCmds
      ? [r.estimate.drawMs, r.estimate.travelMs, r.estimate.cycleMs, r.estimate.commands]
      : [r.estimate.drawMs, r.estimate.travelMs, r.estimate.cycleMs];
  const k = feats(rows[0]).length;
  // Normal equations AᵀA x = Aᵀb, solved by Gaussian elimination.
  const ata = Array.from({ length: k }, () => new Float64Array(k));
  const atb = new Float64Array(k);
  for (const r of rows) {
    const f = feats(r);
    for (let i = 0; i < k; i++) {
      atb[i] += f[i] * r.wallMs;
      for (let j = 0; j < k; j++) ata[i][j] += f[i] * f[j];
    }
  }
  for (let i = 0; i < k; i++) {
    let piv = i;
    for (let r2 = i + 1; r2 < k; r2++) if (Math.abs(ata[r2][i]) > Math.abs(ata[piv][i])) piv = r2;
    [ata[i], ata[piv]] = [ata[piv], ata[i]];
    const t2 = atb[i]; atb[i] = atb[piv]; atb[piv] = t2;
    if (Math.abs(ata[i][i]) < 1e-9) {
      console.error('degenerate system — plots too similar; run the single-primitive calibration plots');
      process.exit(1);
    }
    for (let r2 = i + 1; r2 < k; r2++) {
      const m = ata[r2][i] / ata[i][i];
      for (let c2 = i; c2 < k; c2++) ata[r2][c2] -= m * ata[i][c2];
      atb[r2] -= m * atb[i];
    }
  }
  const x = new Float64Array(k);
  for (let i = k - 1; i >= 0; i--) {
    let s2 = atb[i];
    for (let j = i + 1; j < k; j++) s2 -= ata[i][j] * x[j];
    x[i] = s2 / ata[i][i];
  }
  const names = useCmds ? ['drawMs', 'travelMs', 'cycleMs', 'perCommandMs'] : ['drawMs', 'travelMs', 'cycleMs'];
  console.log(`fit over ${rows.length} recorded plots (coefficient 1.0 = model already exact):`);
  names.forEach((nm, i) => console.log(`  ${nm.padEnd(14)} ×${x[i].toFixed(3)}`));
  let sse = 0; let tot = 0;
  for (const r of rows) {
    const f = feats(r);
    const pred = f.reduce((s3, v, i) => s3 + v * x[i], 0);
    sse += (pred - r.wallMs) ** 2;
    tot += r.wallMs;
  }
  console.log(`  residual rms ${(Math.sqrt(sse / rows.length) / 1000).toFixed(1)}s · mean plot ${(tot / rows.length / 60000).toFixed(1)}min`);
  process.exit(0);
}
const optValues = new Set<number>();
args.forEach((a, i) => {
  if (a.startsWith('--') && ['seed', 'paper', 'tolerance', 'eps', 'hop', 'travel', 'accel', 'taccel'].includes(a.slice(2))) optValues.add(i + 1);
});
const files = args.filter((a, i) => !a.startsWith('--') && !optValues.has(i));
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (files.length === 0) {
  console.error('usage: plotstats <sketch.ts...> [--seed N] [--paper A4] [--landscape] [--tolerance 0.025]');
  process.exit(1);
}

const seed = opt('seed');
const paper = (opt('paper') ?? 'A4') as never;
const landscape = args.includes('--landscape');
const tolerance = parseFloat(opt('tolerance') ?? '0.025');
const eps = parseFloat(opt('eps') ?? '0.05');
if (seed !== undefined) {
  (globalThis as Record<string, unknown>).location = { search: `?seed=${seed}` };
}

const wasmPath = fileURLToPath(
  new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url),
);
await initOcclude(readFileSync(wasmPath));
// Use the studio's shared pen library so sketches naming real pens work.
try {
  const pensPath = fileURLToPath(new URL('../../occlude-studio/sketches/pens.json', import.meta.url));
  setPenLibrary(JSON.parse(readFileSync(pensPath, 'utf8')));
} catch {
  // defaults
}
const size = paperSize({ paper, landscape });
setPaperHint(size.w, size.h);

interface Chain {
  pen: number;
  dot: boolean;
  pts: number[]; // x0,y0,x1,y1,…
}

function parsePlan(plan: Float64Array): Chain[] {
  const chains: Chain[] = [];
  for (let i = 0; i < plan.length; ) {
    const pen = plan[i++];
    const dot = plan[i++] === 1;
    const n = plan[i++];
    chains.push({ pen, dot, pts: Array.from(plan.subarray(i, i + n * 2)) });
    i += n * 2;
  }
  return chains;
}

const dist = (ax: number, ay: number, bx: number, by: number): number =>
  Math.hypot(bx - ax, by - ay);

function chainLength(c: Chain): number {
  let len = 0;
  for (let k = 2; k < c.pts.length; k += 2) {
    len += dist(c.pts[k - 2], c.pts[k - 1], c.pts[k], c.pts[k + 1]);
  }
  return len;
}

/** Point → nearest distance to segment ab. */
function pointSegDist(
  px: number, py: number, ax: number, ay: number, bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return dist(px, py, ax + t * dx, ay + t * dy);
}

/** Grid hash of segments for proximity queries. */
class SegGrid {
  private cells = new Map<string, number[]>();
  // seg i = (chain, ptIndex) flattened into parallel arrays
  readonly ax: number[] = [];
  readonly ay: number[] = [];
  readonly bx: number[] = [];
  readonly by: number[] = [];
  readonly owner: number[] = [];
  constructor(private cell: number) {}
  add(chainIdx: number, ax: number, ay: number, bx: number, by: number): void {
    const i = this.ax.length;
    this.ax.push(ax);
    this.ay.push(ay);
    this.bx.push(bx);
    this.by.push(by);
    this.owner.push(chainIdx);
    for (const key of this.keysAround(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by))) {
      const list = this.cells.get(key);
      if (list) list.push(i);
      else this.cells.set(key, [i]);
    }
  }
  private keysAround(x0: number, y0: number, x1: number, y1: number): string[] {
    const keys: string[] = [];
    for (let gx = Math.floor(x0 / this.cell); gx <= Math.floor(x1 / this.cell); gx++) {
      for (let gy = Math.floor(y0 / this.cell); gy <= Math.floor(y1 / this.cell); gy++) {
        keys.push(`${gx},${gy}`);
      }
    }
    return keys;
  }
  near(x: number, y: number): number[] {
    const gx = Math.floor(x / this.cell);
    const gy = Math.floor(y / this.cell);
    const out: number[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = this.cells.get(`${gx + dx},${gy + dy}`);
        if (list) out.push(...list);
      }
    }
    return out;
  }
}

/** Euler bound: split polylines where an endpoint of one touches another
 * (within eps), build the incidence graph, and per connected component the
 * no-double-draw minimum strokes is max(1, oddDegreeNodes/2). */
function eulerBound(chains: Chain[], eps: number): number {
  // Nodes: quantized endpoints plus T-junction touch points.
  const q = eps;
  const nodeId = new Map<string, number>();
  const degree: number[] = [];
  const parent: number[] = [];
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] = parent[parent[r]];
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const idOf = (x: number, y: number): number => {
    const key = `${Math.round(x / q)},${Math.round(y / q)}`;
    let id = nodeId.get(key);
    if (id === undefined) {
      id = degree.length;
      nodeId.set(key, id);
      degree.push(0);
      parent.push(id);
    }
    return id;
  };

  // Segment grid over all strokes for endpoint-touch tests.
  const grid = new SegGrid(1);
  chains.forEach((c, ci) => {
    for (let k = 2; k < c.pts.length; k += 2) {
      grid.add(ci, c.pts[k - 2], c.pts[k - 1], c.pts[k], c.pts[k + 1]);
    }
  });

  // Split points per chain: endpoints of OTHER chains that land on it.
  const cuts: number[][] = chains.map(() => []);
  chains.forEach((c, ci) => {
    if (c.dot) return;
    for (const [ex, ey] of [
      [c.pts[0], c.pts[1]],
      [c.pts[c.pts.length - 2], c.pts[c.pts.length - 1]],
    ]) {
      for (const si of grid.near(ex, ey)) {
        const oi = grid.owner[si];
        if (oi === ci) continue;
        if (
          pointSegDist(ex, ey, grid.ax[si], grid.ay[si], grid.bx[si], grid.by[si]) <= eps
        ) {
          cuts[oi].push(ex, ey);
        }
      }
    }
  });

  // Each chain contributes edges between consecutive node points: its own
  // endpoints plus any touch points (projected order along the chain is
  // approximated by nearest-vertex insertion — fine for a bound).
  chains.forEach((c, ci) => {
    if (c.dot) {
      idOf(c.pts[0], c.pts[1]);
      return;
    }
    const start = idOf(c.pts[0], c.pts[1]);
    const end = idOf(c.pts[c.pts.length - 2], c.pts[c.pts.length - 1]);
    const interior = new Set<number>();
    for (let t = 0; t < cuts[ci].length; t += 2) {
      const id = idOf(cuts[ci][t], cuts[ci][t + 1]);
      if (id !== start && id !== end) interior.add(id);
    }
    // Path start → touches → end: each junction adds 2 to its degree (the
    // stroke passes through), endpoints add 1.
    const seq = [start, ...interior, end];
    for (let i = 1; i < seq.length; i++) {
      degree[seq[i - 1]] += 1;
      degree[seq[i]] += 1;
      union(seq[i - 1], seq[i]);
    }
  });

  // Per component: strokes = max(1, odd/2).
  const odd = new Map<number, number>();
  const seen = new Set<number>();
  degree.forEach((d, i) => {
    if (d === 0) return; // dots and unused
    const root = find(i);
    seen.add(root);
    if (d % 2 === 1) odd.set(root, (odd.get(root) ?? 0) + 1);
  });
  let strokes = 0;
  for (const root of seen) strokes += Math.max(1, (odd.get(root) ?? 0) / 2);
  const dots = chains.filter((c) => c.dot).length;
  return strokes + dots;
}

/** Coincident ink: overlap length between near-parallel segments of
 * different chains closer than `lateral`. Each pair counted once. */
function coincidentMm(chains: Chain[], lateral: number): number {
  const grid = new SegGrid(1);
  chains.forEach((c, ci) => {
    if (c.dot) return;
    for (let k = 2; k < c.pts.length; k += 2) {
      grid.add(ci, c.pts[k - 2], c.pts[k - 1], c.pts[k], c.pts[k + 1]);
    }
  });
  let total = 0;
  const counted = new Set<string>();
  for (let i = 0; i < grid.ax.length; i++) {
    const mx = (grid.ax[i] + grid.bx[i]) / 2;
    const my = (grid.ay[i] + grid.by[i]) / 2;
    for (const j of grid.near(mx, my)) {
      if (j <= i || grid.owner[j] === grid.owner[i]) continue;
      const key = `${i}:${j}`;
      if (counted.has(key)) continue;
      // Both endpoints of i lie laterally within `lateral` of segment j —
      // i runs along j, not merely crosses it.
      const dA = pointSegDist(grid.ax[i], grid.ay[i], grid.ax[j], grid.ay[j], grid.bx[j], grid.by[j]);
      const dB = pointSegDist(grid.bx[i], grid.by[i], grid.ax[j], grid.ay[j], grid.bx[j], grid.by[j]);
      if (dA <= lateral && dB <= lateral) {
        counted.add(key);
        total += dist(grid.ax[i], grid.ay[i], grid.bx[i], grid.by[i]);
      }
    }
  }
  return total;
}

interface Stats {
  name: string;
  chains: number;
  drawMm: number;
  travelMm: number;
  minutes: number;
  bridgeable: number;
  bridgeSavedMm: number;
  euler: number;
  coincident: number;
}

const machineOpts = {
  travelFeed: parseFloat(opt('travel') ?? '6000'),
  acceleration: parseFloat(opt('accel') ?? '1000'),
  travelAcceleration: parseFloat(opt('taccel') ?? '2000'),
  junctionDeviation: 0.02,
  minimumCruiseRatio: 0.5,
  quickHopMm: parseFloat(opt('hop') ?? '15'),
};

function analyze(name: string, chains: Chain[], pens: occlude.PenDef[]): Stats {
  let drawMm = 0;
  let travelMm = 0;
  let minutes = 0;
  let bridgeable = 0;
  let bridgeSavedMm = 0;
  let px = 0;
  let py = 0;
  chains.forEach((c, i) => {
    const pen = pens[c.pen];
    const gap = dist(px, py, c.pts[0], c.pts[1]);
    travelMm += gap;
    drawMm += chainLength(c);
    const prev = chains[i - 1];
    if (prev && prev.pen === c.pen && !c.dot && !prev.dot && gap <= (pen?.width ?? 0.3) / 2) {
      bridgeable += 1;
      bridgeSavedMm += gap;
    }
    px = c.pts[c.pts.length - 2];
    py = c.pts[c.pts.length - 1];
  });
  // Time: THE ground-truth model (the same trapezoid + quick-hop math the
  // EBB driver's ETA uses), parameterized by the CLI's machine flags.
  minutes = occlude.estimatePlanMs(
    chains,
    (pi) => {
      const pd = pens[pi];
      return pd ? { feed: pd.feed, penDelay: pd.penDelay } : undefined;
    },
    machineOpts,
  ).totalMs / 60000;
  // Euler + coincidence are per pen (a pen swap always lifts).
  let euler = 0;
  let coincident = 0;
  for (let p = 0; p < pens.length; p++) {
    const mine = chains.filter((c) => c.pen === p);
    if (mine.length === 0) continue;
    euler += eulerBound(mine, eps);
    coincident += coincidentMm(mine, 0.03);
  }
  return {
    name, chains: chains.length, drawMm, travelMm, minutes,
    bridgeable, bridgeSavedMm, euler, coincident,
  };
}

const rows: Stats[] = [];
for (const file of files) {
  try {
    const js = transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code;
    preloadAssetsFromDisk(js);
    const module = { exports: {} as Record<string, unknown> };
    const requireShim = (name: string): unknown => {
      if (name === 'occlude') return occlude;
      throw new Error(`sketches can only import from 'occlude' (tried '${name}')`);
    };
    new Function('require', 'exports', 'module', js)(requireShim, module.exports, module);
    const exp = module.exports;
    const def = (isSketch(exp.default)
      ? exp.default
      : Object.values(exp).find(isSketch)) as SketchDef | undefined;
    if (!def) throw new Error('no sketch exported');
    compileSketch(def);
    const r = render({ paper, landscape });
    const plan = (core as unknown as {
      wasm_export_toolpath(
        p: Float64Array, f: Float64Array, pens: string, budget: number, tol: number,
      ): Float64Array;
    }).wasm_export_toolpath(r.raw.prims, r.raw.frags, pensToJson(r.pens), 200_000, tolerance);
    rows.push(analyze(basename(file, '.ts'), parsePlan(plan), r.pens));
  } catch (e) {
    console.error(`${basename(file)}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const fmt = (n: number, d = 0): string => n.toFixed(d);
console.log(
  'sketch'.padEnd(20),
  'chains'.padStart(7),
  'draw mm'.padStart(9),
  'travel mm'.padStart(10),
  'est min'.padStart(8),
  'bridge'.padStart(7),
  'euler'.padStart(6),
  'coincident mm'.padStart(14),
);
for (const s of rows) {
  console.log(
    s.name.padEnd(20),
    fmt(s.chains).padStart(7),
    fmt(s.drawMm).padStart(9),
    fmt(s.travelMm).padStart(10),
    fmt(s.minutes, 1).padStart(8),
    fmt(s.bridgeable).padStart(7),
    fmt(s.euler).padStart(6),
    fmt(s.coincident, 1).padStart(14),
  );
}
if (rows.length > 1) {
  const sum = (f: (s: Stats) => number): number => rows.reduce((a, s) => a + f(s), 0);
  console.log(
    'TOTAL'.padEnd(20),
    fmt(sum((s) => s.chains)).padStart(7),
    fmt(sum((s) => s.drawMm)).padStart(9),
    fmt(sum((s) => s.travelMm)).padStart(10),
    fmt(sum((s) => s.minutes), 1).padStart(8),
    fmt(sum((s) => s.bridgeable)).padStart(7),
    fmt(sum((s) => s.euler)).padStart(6),
    fmt(sum((s) => s.coincident), 1).padStart(14),
  );
}
