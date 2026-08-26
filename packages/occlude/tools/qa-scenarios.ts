/**
 * QA scenarios: property-based geometric invariants, metamorphic relations,
 * and analytic oracles, run over arbitrary seeds. Each scenario builds a
 * randomized scene, renders it, and returns violations (empty = pass).
 *
 * Shared by `test/qa.test.ts` (a few seeds in CI) and `tools/qa-sweep.ts`
 * (hundreds of seeds on demand). Every rule here encodes a bug class that
 * actually happened — see the sweep tool header for the catalogue.
 */

import {
  circle, decimate, deform, dash, evalPrim, line, mm, modify, polygon, rect,
  render, roughen, sketch, smooth, wobble,
  type Fragment, type RenderResult, type SketchDef, type Tree, type VectorFieldFn,
} from '../src/index.js';

export interface Violation {
  rule: string;
  detail: string;
}

export type Scenario = (seed: number) => Violation[];

// ---- deterministic scenario rng (independent of the sketch seed) ----

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const range = (r: () => number, a: number, b: number): number => a + r() * (b - a);

// ---- geometry helpers ----

function fragLen(f: Fragment): number {
  if (f.dot) return 0;
  if (f.geom.t === 'line') {
    const g = f.geom;
    return Math.hypot(g.x1 - g.x0, g.y1 - g.y0);
  }
  let len = 0;
  let [px, py] = evalPrim(f.geom, 0);
  for (let k = 1; k <= 16; k++) {
    const [x, y] = evalPrim(f.geom, k / 16);
    len += Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  return len;
}

/** Sample fragment geometry into points at roughly `step` mm spacing. */
function fragPts(frags: Fragment[], step = 0.2): Float64Array {
  const pts: number[] = [];
  for (const f of frags) {
    if (f.dot) continue;
    const n = Math.min(128, Math.max(1, Math.ceil(fragLen(f) / step)));
    for (let k = 0; k <= n; k++) {
      const [x, y] = evalPrim(f.geom, k / n);
      pts.push(x, y);
    }
  }
  return new Float64Array(pts);
}

function directedHausdorff(a: Float64Array, b: Float64Array, cap = 2500): number {
  const stride = Math.max(1, Math.floor(a.length / 2 / cap));
  let worst = 0;
  for (let i = 0; i < a.length; i += 2 * stride) {
    const ax = a[i];
    const ay = a[i + 1];
    let best = Infinity;
    for (let j = 0; j < b.length; j += 2) {
      const dx = b[j] - ax;
      const dy = b[j + 1] - ay;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    if (best > worst) worst = best;
  }
  return Math.sqrt(worst);
}

function hausdorff(a: Float64Array, b: Float64Array): number {
  return Math.max(directedHausdorff(a, b), directedHausdorff(b, a));
}

/** Odd-degree chain endpoints. A closed outline's ink forms loops: every
 * vertex has even degree. Odd degrees are chain breaks (mid-chain holes)
 * — the roughen→smooth gap bug class. Exact-coordinate keys work because
 * consecutive chain segments share the same f64s. */
function oddEndpoints(frags: Fragment[]): number {
  const deg = new Map<string, number>();
  for (const f of frags) {
    if (f.dot) continue;
    for (const t of [0, 1]) {
      const [x, y] = evalPrim(f.geom, t);
      const k = `${x}:${y}`;
      deg.set(k, (deg.get(k) ?? 0) + 1);
    }
  }
  let odd = 0;
  for (const v of deg.values()) if (v % 2 === 1) odd++;
  return odd;
}

const byShape = (out: RenderResult, s: number): Fragment[] =>
  out.frags.filter((f) => f.shape === s);

// ---- scenarios ----

/**
 * Pre-stage chains: random closed shapes, random smooth/roughen/deform
 * stacks, laid out without overlap. Invariants: chains stay connected
 * (loops → all-even endpoint degrees), no sub-nib segments emitted, and
 * two renders are byte-identical.
 */
export const preChains: Scenario = (seed) => {
  const r = mulberry(seed ^ 0x51ab);
  const shapes: Tree[] = [];
  const mods = (): ReturnType<typeof smooth>[] => {
    const stack = [];
    const n = 1 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const pick = r();
      if (pick < 0.34) stack.push(smooth(1 + Math.floor(r() * 3)));
      else if (pick < 0.67) stack.push(roughen(mm(range(r, 0.3, 1.5)), mm(range(r, 1, 3))));
      else {
        const [ax, wx, ay, wy] = [range(r, 1, 3), range(r, 15, 35), range(r, 1, 3), range(r, 15, 35)];
        const field: VectorFieldFn = (x, y) => [
          ax * Math.sin(x / wx + y / (wx * 2)),
          ay * Math.cos(y / wy - x / (wy * 2)),
        ];
        stack.push(deform(field));
      }
    }
    return stack;
  };
  let count = 0;
  for (let i = 0; i < 4 && count < 12; i++) {
    for (let j = 0; j < 4 && count < 12; j++) {
      const cx = 12.5 + i * 25;
      const cy = 12.5 + j * 25;
      const kind = r();
      const size = range(r, 3.5, 6.5);
      const shape =
        kind < 0.33
          ? circle(cx, cy, size)
          : kind < 0.66
            ? rect(cx - size, cy - size, size * 2, size * 2, r() < 0.5 ? range(r, 1, 3) : 0)
            : polygon(cx, cy, 3 + Math.floor(r() * 6), size, r() * 360);
      shapes.push(modify(mods(), shape));
      count++;
    }
  }
  const def = sketch({ seed }, () => shapes);
  const out = render(def, { paper: 'Square20' });
  const out2 = render(def, { paper: 'Square20' });
  const v: Violation[] = [];
  const nib = out.pens[0]?.width ?? 0.3;
  for (let s = 0; s < count; s++) {
    const frags = byShape(out, s);
    if (frags.length === 0) {
      v.push({ rule: 'chain-nonempty', detail: `shape ${s} vanished entirely` });
      continue;
    }
    const odd = oddEndpoints(frags);
    if (odd > 0) v.push({ rule: 'chain-connected', detail: `shape ${s}: ${odd} broken endpoints` });
    const short = frags.filter((f) => !f.dot && fragLen(f) < nib - 1e-9).length;
    if (short > 0) v.push({ rule: 'nib-floor', detail: `shape ${s}: ${short} sub-nib segments` });
  }
  if (
    out.raw.frags.length !== out2.raw.frags.length ||
    out.raw.frags.some((x, i) => x !== out2.raw.frags[i])
  ) {
    v.push({ rule: 'deterministic', detail: 'two renders differ' });
  }
  return v;
};

/**
 * Deform convergence: rendering the same smooth field at detail 2mm and
 * 1mm must agree within tolerance — if halving the step moves the curve,
 * the default isn't converged (the long-chord and S-curve bug classes).
 */
export const deformConverge: Scenario = (seed) => {
  const r = mulberry(seed ^ 0xc0de);
  const [ax, wx, ay, wy] = [range(r, 2, 7), range(r, 16, 40), range(r, 2, 7), range(r, 16, 40)];
  const field: VectorFieldFn = (x, y) => [
    ax * Math.sin(x / wx + Math.cos(y / wy) * 1.5),
    ay * Math.cos(y / wy - Math.sin(x / wx) * 1.5),
  ];
  const shape = (): Tree =>
    r() < 0.5
      ? circle(range(r, 25, 75), range(r, 25, 75), range(r, 6, 16))
      : rect(range(r, 15, 55), range(r, 15, 55), range(r, 12, 30), range(r, 12, 30));
  const geom = shape();
  const coarse = render(
    sketch({ seed }, () => deform({ field, detail: mm(2) }, geom)),
    { paper: 'Square20' },
  );
  const fine = render(
    sketch({ seed }, () => deform({ field, detail: mm(1) }, geom)),
    { paper: 'Square20' },
  );
  const d = hausdorff(fragPts(coarse.frags), fragPts(fine.frags));
  if (d > 0.3) {
    return [{ rule: 'deform-converged', detail: `detail 2mm vs 1mm differ by ${d.toFixed(3)}mm` }];
  }
  return [];
};

/**
 * Identity modifiers: decimate(0) and wobble(0) must be byte-identical to
 * no modifier at all; dash(huge) must preserve fragment count and total
 * ink to float precision.
 */
export const identityMods: Scenario = (seed) => {
  const r = mulberry(seed ^ 0x1d);
  const tree = (): Tree[] => {
    const shapes: Tree[] = [];
    for (let i = 0; i < 8; i++) {
      const kind = r();
      if (kind < 0.4) shapes.push(line(range(r, 0, 40), range(r, 0, 100), range(r, 60, 100), range(r, 0, 100)));
      else if (kind < 0.75) shapes.push(circle(range(r, 20, 80), range(r, 20, 80), range(r, 5, 18), { opaque: true }));
      else shapes.push(rect(range(r, 10, 60), range(r, 10, 60), range(r, 10, 30), range(r, 10, 30)));
    }
    return shapes;
  };
  const shapes = tree();
  const plain = render(sketch({ seed }, () => shapes), { paper: 'Square20' });
  const noop = render(
    sketch({ seed }, () => modify([decimate(0), wobble(0)], shapes)),
    { paper: 'Square20' },
  );
  const v: Violation[] = [];
  if (
    plain.raw.frags.length !== noop.raw.frags.length ||
    plain.raw.frags.some((x, i) => x !== noop.raw.frags[i])
  ) {
    v.push({ rule: 'identity-noop', detail: 'decimate(0)+wobble(0) changed the output' });
  }
  const dashed = render(
    sketch({ seed }, () => modify([dash(mm(1e6), mm(0))], shapes)),
    { paper: 'Square20' },
  );
  const inkA = plain.frags.reduce((a, f) => a + fragLen(f), 0);
  const inkB = dashed.frags.reduce((a, f) => a + fragLen(f), 0);
  if (plain.frags.length !== dashed.frags.length || Math.abs(inkA - inkB) > 1e-6 * Math.max(1, inkA)) {
    v.push({
      rule: 'identity-dash',
      detail: `dash(∞): frags ${plain.frags.length}→${dashed.frags.length}, ink ${inkA.toFixed(6)}→${inkB.toFixed(6)}`,
    });
  }
  return v;
};

/**
 * Occlusion exactness: horizontal lines behind opaque circles. The
 * visible length of each line is closed-form (interval union of circle
 * chords, with the engine's nib coalesce/threshold applied to the same
 * intervals). Also: wobbling the OCCLUDERS must not move the lines' cuts
 * at all — post-stage modifiers never change what is hidden.
 */
export const occlusionExact: Scenario = (seed) => {
  const r = mulberry(seed ^ 0x0cc1);
  const NL = 10;
  // Stratified ys: nib-coincident parallel lines legitimately merge in
  // seam dedupe (shared edges draw once), which per-line accounting
  // cannot attribute — keep lines ≥2 user units apart.
  const lines: [number, number, number][] = []; // y, x0, x1 (user units)
  for (let i = 0; i < NL; i++) lines.push([5 + i * 9 + range(r, 0, 7), 2, 98]);
  const discs: [number, number, number][] = [];
  for (let i = 0; i < 5; i++) discs.push([range(r, 20, 80), range(r, 20, 80), range(r, 5, 18)]);
  const build = (wob: boolean): SketchDef =>
    sketch({ seed }, () => [
      lines.map(([y, x0, x1]) => line(x0, y, x1, y)),
      discs.map(([cx, cy, rad]) => {
        const c = circle(cx, cy, rad, { opaque: true });
        return wob ? wobble(mm(1.5), c) : c;
      }),
    ]);
  const out = render(build(false), { paper: 'Square20' });
  const unit = Math.min(out.frame.inner.innerW, out.frame.inner.innerH) / 100;
  const [ox, oy] = [out.frame.offsetX, out.frame.offsetY];
  // Mirror the engine's 0.005mm input snap (lines snap endpoints; circles
  // snap centre and radius) and work in paper mm throughout.
  const snap = (n: number): number => Math.round(n / 0.005) * 0.005;
  const nibU = out.pens[0]?.width ?? 0.3;
  const v: Violation[] = [];
  for (let i = 0; i < NL; i++) {
    const y = snap(oy + lines[i][0] * unit);
    const x0 = snap(ox + lines[i][1] * unit);
    const x1 = snap(ox + lines[i][2] * unit);
    // Hidden intervals in paper mm.
    let hidden: [number, number][] = [];
    for (const disc of discs) {
      const cx = snap(ox + disc[0] * unit);
      const cy = snap(oy + disc[1] * unit);
      const rad = snap(disc[2] * unit);
      const dy = y - cy;
      const h2 = rad * rad - dy * dy;
      if (h2 <= 0) continue;
      const half = Math.sqrt(h2);
      const a = Math.max(x0, cx - half);
      const b = Math.min(x1, cx + half);
      if (a < b) hidden.push([a, b]);
    }
    hidden.sort((p, q) => p[0] - q[0]);
    const merged: [number, number][] = [];
    for (const h of hidden) {
      const last = merged[merged.length - 1];
      if (last && h[0] <= last[1]) last[1] = Math.max(last[1], h[1]);
      else merged.push([...h]);
    }
    // Visible spans, then the engine's nib rule: visible spans separated
    // by a sub-nib hidden gap coalesce; visible spans under a nib drop.
    let spans: [number, number][] = [];
    let cur = x0;
    for (const [a, b] of merged) {
      if (a > cur) spans.push([cur, a]);
      cur = Math.max(cur, b);
    }
    if (cur < x1) spans.push([cur, x1]);
    const coalesced: [number, number][] = [];
    for (const s of spans) {
      const last = coalesced[coalesced.length - 1];
      if (last && s[0] - last[1] < nibU) last[1] = s[1];
      else coalesced.push([...s]);
    }
    const analytic = coalesced
      .filter(([a, b]) => b - a >= nibU)
      .reduce((acc, [a, b]) => acc + (b - a), 0);
    const engine = byShape(out, i).reduce((acc, f) => acc + fragLen(f), 0);
    if (Math.abs(engine - analytic) > 1e-3) {
      v.push({
        rule: 'occlusion-exact',
        detail: `line ${i}: engine ${engine.toFixed(4)}mm vs analytic ${analytic.toFixed(4)}mm`,
      });
    }
  }
  const wob = render(build(true), { paper: 'Square20' });
  for (let i = 0; i < NL; i++) {
    const a = byShape(out, i).map((f) => `${f.origin}:${f.t0}:${f.t1}`).join('|');
    const b = byShape(wob, i).map((f) => `${f.origin}:${f.t0}:${f.t1}`).join('|');
    if (a !== b) {
      v.push({ rule: 'post-preserves-hiding', detail: `line ${i}: cuts moved under occluder wobble` });
      break;
    }
  }
  return v;
};

/**
 * Analytic oracle: a circle through the chord-push swirl, engine deform vs
 * a dense exact evaluation of the same field. The circle's edge keeps
 * clear of the singular core, where the raster cannot represent the field.
 */
export const swirlOracle: Scenario = (seed) => {
  const r = mulberry(seed ^ 0x5717);
  const amp = range(r, 10, 16);
  const reach = range(r, 20, 30);
  const swirl: VectorFieldFn = (x, y) => {
    const dx = x - 50;
    const dy = y - 50;
    const d = Math.hypot(dx, dy) || 1;
    const k = (amp * Math.exp(-d / reach)) / d;
    return [-dy * k, dx * k];
  };
  let cx = 0, cy = 0, rad = 0;
  do {
    cx = range(r, 20, 80);
    cy = range(r, 20, 80);
    rad = range(r, 6, 12);
  } while (Math.abs(Math.hypot(cx - 50, cy - 50) - rad) < 8);
  const out = render(sketch({ seed }, () => deform(swirl, circle(cx, cy, rad))), {
    paper: 'Square20',
  });
  const unit = Math.min(out.frame.inner.innerW, out.frame.inner.innerH) / 100;
  const [ox, oy] = [out.frame.offsetX, out.frame.offsetY];
  const analytic = new Float64Array(2 * 4096);
  for (let i = 0; i < 4096; i++) {
    const a = (i / 4096) * Math.PI * 2;
    const x = cx + rad * Math.cos(a);
    const y = cy + rad * Math.sin(a);
    const [dx, dy] = swirl(x, y);
    analytic[i * 2] = ox + (x + dx) * unit;
    analytic[i * 2 + 1] = oy + (y + dy) * unit;
  }
  const d = hausdorff(fragPts(out.frags), analytic);
  if (d > 0.3) {
    return [{ rule: 'swirl-oracle', detail: `engine vs analytic differ by ${d.toFixed(3)}mm` }];
  }
  return [];
};

export const scenarios: Record<string, Scenario> = {
  preChains,
  deformConverge,
  identityMods,
  occlusionExact,
  swirlOracle,
};
